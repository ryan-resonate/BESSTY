// Worker-safe grid core. Deliberately free of any dependency on the catalog /
// Firebase / source-tree code, so the grid Web Worker (`grid.worker.ts`) can
// import it without dragging firebase (which expects a `window`) into the worker
// bundle. It holds the Annex D.5 concave test and the batched grid evaluator
// shared by the main thread (`evaluateGrid`) and the worker.
//
// One `WasmSession` per tile: the tile's Scene (its own adaptively-clustered
// source set, the user's barriers, and the terrain raster) is decomposed ONCE,
// then every cell in the tile is solved as a batch of receivers. That replaces
// the old per-cell JS↔WASM call, and with it the per-cell synthetic terrain
// barriers — the engine now screens against the DEM raster itself.

import { WasmSession } from '../wasm/iso9613_wasm.js';
import type { DemRaster } from './dem';
import type { Barrier } from './types';
import {
  buildScene, groupReceiversByConcave, withConcave,
  type ResolvedSource, type SceneHeightfield, type SceneReceiver, type SceneResults,
  type SceneSettings,
} from './sceneBuilder';

// Geo helpers now live in `./geo` (wasm-free, so the scene builder and the
// terrain sampler can share them). Re-exported here for existing importers.
export { latLngToLocalMetres, approxDistanceM } from './geo';
import { latLngToLocalMetres } from './geo';

/// Topography settings. Sampling resolution and ridge selection are the
/// engine's job now — all that survives is the DEM cleanup knob.
export interface TopoSettings {
  /// @deprecated The engine samples the terrain raster itself; ignored.
  pathSamples?: number;
  /// @deprecated Ridge selection is the engine's hull, not a web-side filter.
  virtualBarrierMinHeightM?: number;
  /// Peak-preserving DEM despike (Hampel) strength, applied when the elevation
  /// raster is built. Default 'low'.
  despikeStrength?: 'off' | 'low' | 'medium';
}

/// Annex D.5 concave-ground criterion (A3): apply the −3 dB ground-reflection
/// correction when the mean height of the straight source→receiver line above
/// the terrain is ≥ 1.5·(hS+hR)/2 — i.e. the ground dips away under the path
/// (concave), enhancing the reflection. `srcZAbs`/`rxZAbs` are absolute z;
/// `hS`/`hR` are heights above ground. Returns false without a DEM.
///
/// This stays a web-side test because it is a per source→RECEIVER condition,
/// while the Scene carries `apply_concave` per source — see
/// `groupReceiversByConcave`.
export function concaveCorrectionMet(
  srcLatLng: [number, number], srcZAbs: number,
  rxLatLng: [number, number], rxZAbs: number,
  hS: number, hR: number,
  dem: DemRaster | null,
  samples = 12,
): boolean {
  if (!dem) return false;
  let sum = 0;
  let count = 0;
  for (let k = 1; k < samples; k++) {
    const t = k / samples;
    const lat = srcLatLng[0] + (rxLatLng[0] - srcLatLng[0]) * t;
    const lng = srcLatLng[1] + (rxLatLng[1] - srcLatLng[1]) * t;
    const ground = dem.elevation(lat, lng);
    if (!Number.isFinite(ground)) continue;
    const lineZ = srcZAbs + (rxZAbs - srcZAbs) * t;
    sum += lineZ - ground;
    count++;
  }
  if (count === 0) return false;
  const hm = sum / count;
  return hm >= 1.5 * (hS + hR) / 2;
}

export interface GridResult {
  cols: number;
  rows: number;
  bounds: { sw: [number, number]; ne: [number, number] };
  dbA: Float32Array;
  computedMs: number;
}

/// A rectangular block of grid cells with its OWN clustered source set. Each
/// tile's clustering is decided adaptively from the tile's footprint (see
/// `walkSourceTreeForRegion`), so far tiles collapse a group of sources to a
/// single virtual source while near tiles keep them all.
export interface GridTile {
  col0: number; row0: number;   // top-left cell (inclusive)
  cols: number; rows: number;   // tile size in cells
  /// Sources for this tile, catalog already resolved on the main thread.
  sources: ResolvedSource[];
  /// P5 — barriers that could screen ANY source→cell path in this tile,
  /// culled on the main thread. Absent ⇒ use the job's full list.
  ///
  /// The engine tests every wall segment against every source→receiver pair,
  /// and segments scale with drawn length (a polyline is densified to ≤10 m so
  /// its crest follows the terrain; each container adds four). Measured, a
  /// 16×16 tile with 50 sources spent 67% of its time on 1000 fence segments
  /// that could never screen anything. Per-wall rejection inside the engine
  /// cannot fix that — it is the pairs × walls product — so the cull happens
  /// ONCE per tile here, the same trick Barnes-Hut plays for sources.
  barriers?: Barrier[];
}

/// Fully-resolved, serializable description of a grid computation — produced on
/// the main thread (catalog + DEM resolution) and runnable either inline or in
/// a Web Worker. Everything here is plain structured-cloneable data.
export interface GridJob {
  cols: number; rows: number; dxM: number; dyM: number;
  origin: [number, number];
  bounds: { sw: [number, number]; ne: [number, number] };
  nBands: number;
  cutoffM: number; dOmegaDb: number;
  rxHeightAboveGround: number;
  /// Drawn barriers, mapped to Wall obstacles per tile scene.
  barriers: Barrier[];
  /// Standard, ground, atmosphere and caps for the Scene.
  settings: SceneSettings;
  topo: TopoSettings | undefined;
  /// Elevation raster for engine-side terrain screening. Built on whichever
  /// thread owns the DEM; `null` = flat ground.
  terrain: SceneHeightfield | null;
  /// Model source containers as screening boxes in the grid.
  includeContainers: boolean;
  roofOffsetM: number;
  /// I7 — calculation-area rotation, clockwise from north. Cells are generated
  /// in the BOX frame and rotated about the centre before projection, so they
  /// stay aligned with a rotated box rather than forming an axis-aligned grid
  /// that merely covers it.
  rotationDeg?: number;
  /// I18 — emit reflecting facades for this grid, and the requested specular
  /// order. Degraded per tile if the reflector count would exceed the engine's
  /// path-enumeration guard.
  includeReflections?: boolean;
  maxReflectionOrder?: number;
  /// The grid partitioned into tiles, each with its own adaptively-clustered
  /// source set. Union of tiles covers the whole grid exactly once.
  tiles: GridTile[];
}

/// A-weighting offsets per IEC 61672-1, indexed by band count.
const OCTAVE_AW = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];
const THIRD_OCT_AW = [
  -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
  -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
  -3.2, -1.9, -0.8, 0.0, 0.6, 1.0, 1.2, 1.3, 1.2,
  1.0, 0.5, -0.1, -1.1, -2.5,
];

/// Energy-sum the Z-weighted per-source band levels reaching one cell into a
/// single dB(A) total, applying A-weighting at sum time. `bands` arrives per
/// source; contributions beyond the cutoff are already gone.
///
/// `DΩ` is deliberately NOT included here — it is added after the floor test in
/// the caller, because the −120 dB display floor is applied to the un-corrected
/// level (otherwise a +3 dB `DΩ` would lift cells that should read as floor).
function totalDbaFor(contributions: number[][], aw: number[]): number {
  let aSum = 0;
  for (const bands of contributions) {
    const n = Math.min(bands.length, aw.length);
    for (let i = 0; i < n; i++) {
      const v = bands[i];
      if (typeof v === 'number' && Number.isFinite(v)) {
        aSum += Math.pow(10, (v + aw[i]) / 10);
      }
    }
  }
  return aSum > 0 ? 10 * Math.log10(aSum) : -Infinity;
}

/// Run a `GridJob` against a DEM (the real one on the main thread, a region
/// snapshot in the worker). This is the single source of truth for the contour
/// grid.
///
/// Per tile: build the Scene once, then solve its cells as receiver batches
/// (one batch per Annex D.5 concave group — a single batch whenever the tile has
/// no turbines, which is the common case). The engine caches the obstacle and
/// terrain decomposition across `set_receivers`, so the expensive geometry work
/// happens once per tile instead of once per cell.
/// Called after each tile completes (I12). Runs on whichever thread the solve
/// is on, so it must be cheap — the worker just forwards a postMessage.
export type GridProgress = (tilesDone: number, tilesTotal: number) => void;

// ============== P2: tile sharding across a worker pool ==============
//
// Tiles are independent — each writes a disjoint block of cells — so a grid can
// be split across workers and stitched back together exactly. These two are
// pure so the stitching can be tested without spinning up workers.

/// Deal tiles round-robin into at most `n` shards, dropping empty ones.
///
/// Round-robin rather than contiguous blocks: cost per tile varies hugely with
/// distance from the sources (near tiles keep every source individually, far
/// tiles collapse to one cluster), so contiguous blocks would hand one worker
/// the whole expensive middle of the site while the others idled.
export function shardTiles(tiles: GridTile[], n: number): GridTile[][] {
  const shards: GridTile[][] = Array.from({ length: Math.max(1, n) }, () => []);
  tiles.forEach((t, i) => shards[i % shards.length].push(t));
  return shards.filter((s) => s.length > 0);
}

/// Copy one shard's computed cells into the combined grid. Only the cells the
/// shard's own tiles cover are touched, so shards cannot overwrite each other —
/// that is what makes the merge exact rather than a max/blend heuristic.
export function mergeShard(
  into: Float32Array, from: Float32Array, tiles: GridTile[], cols: number, rows: number,
): void {
  for (const t of tiles) {
    const rowEnd = Math.min(t.row0 + t.rows, rows);
    const colEnd = Math.min(t.col0 + t.cols, cols);
    for (let r = Math.max(0, t.row0); r < rowEnd; r++) {
      const base = r * cols;
      for (let c = Math.max(0, t.col0); c < colEnd; c++) into[base + c] = from[base + c];
    }
  }
}

export function runBatchedGrid(
  job: GridJob,
  dem: DemRaster | null,
  onProgress?: GridProgress,
): GridResult {
  const t0 = performance.now();
  const {
    cols, rows, dxM, dyM, origin, nBands, cutoffM, dOmegaDb, rxHeightAboveGround,
    barriers, settings, terrain, includeContainers, roofOffsetM, bounds, tiles,
    includeReflections, maxReflectionOrder, rotationDeg,
  } = job;
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dbA = new Float32Array(cols * rows).fill(-120);
  const aw = nBands === 31 ? THIRD_OCT_AW : OCTAVE_AW;

  let tilesDone = 0;
  for (const tile of tiles) {
    // Empty tiles still count toward progress — otherwise a sparse job appears
    // to stall, then jump.
    if (tile.sources.length === 0) { onProgress?.(++tilesDone, tiles.length); continue; }

    // Cells of this tile, as receivers. `id` is the flat grid index so results
    // map straight back regardless of grouping or engine ordering.
    const cells: Array<{
      id: string; idx: number; latLng: [number, number];
      e: number; n: number; zAbs: number;
    }> = [];
    const rowEnd = Math.min(tile.row0 + tile.rows, rows);
    const colEnd = Math.min(tile.col0 + tile.cols, cols);
    // I7: cells are generated in the BOX frame and rotated about the centre
    // before projection, so they stay aligned with a rotated calculation area
    // instead of forming an axis-aligned grid that merely covers it. `rot` is 0
    // for an unrotated box, where this collapses to the original arithmetic.
    const rot = ((rotationDeg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    for (let row = tile.row0; row < rowEnd; row++) {
      const nBox = (row - (rows - 1) / 2) * dyM;
      for (let col = tile.col0; col < colEnd; col++) {
        const eBox = (col - (cols - 1) / 2) * dxM;
        // Box frame → world frame. Bearing is clockwise from north, and the
        // world y axis points north, so this is the standard clockwise rotation.
        const e = eBox * cosR + nBox * sinR;
        const n = -eBox * sinR + nBox * cosR;
        const lat = origin[0] + (n / R) * (180 / Math.PI);
        const lng = origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI);
        const groundRaw = dem ? dem.elevation(lat, lng) : 0;
        const ground = Number.isFinite(groundRaw) ? groundRaw : 0;
        cells.push({
          id: String(row * cols + col),
          idx: row * cols + col,
          latLng: [lat, lng],
          e,
          n,
          zAbs: ground + rxHeightAboveGround,
        });
      }
    }
    if (cells.length === 0) { onProgress?.(++tilesDone, tiles.length); continue; }

    // Annex D.5 is a per source→receiver condition but the Scene carries
    // `apply_concave` per source, so cells that disagree can't share a solve.
    // No turbines in the tile ⇒ exactly one group ⇒ no extra cost.
    const groups = groupReceiversByConcave(tile.sources, cells, (s, cell) => {
      const ground = dem ? dem.elevation(s.latLng[0], s.latLng[1]) : 0;
      const srcZAbs = (Number.isFinite(ground) ? ground : 0) + s.heightAglM;
      return concaveCorrectionMet(
        s.latLng, srcZAbs, cell.latLng, cell.zAbs, s.heightAglM, rxHeightAboveGround, dem,
      );
    });

    for (const group of groups) {
      // The Scene's receivers are replaced per group via `set_receivers`, so
      // build it with an empty receiver list.
      const scene = buildScene({
        origin,
        sources: withConcave(tile.sources, group.concaveBySourceId),
        receivers: [],
        barriers: tile.barriers ?? barriers,
        dem,
        terrain,
        settings,
        includeContainers,
        roofOffsetM,
        includeReflections,
        maxReflectionOrder,
        // The Scene is built with no receivers (cells arrive via
        // `set_receivers`), so the facade cull needs to know where they WILL
        // be — otherwise every reflector is dropped and contours lose their
        // reflections entirely while point receivers keep theirs.
        cullReceiversLatLng: cells.map((c) => c.latLng),
      });

      let session: WasmSession;
      try {
        session = new WasmSession(JSON.stringify(scene));
      } catch (e) {
        console.error('grid scene rejected:', e instanceof Error ? e.message : e);
        continue;
      }
      try {
        // Positions are already in the scene's local-metres frame, so the cells
        // go straight to the engine without another projection.
        const receivers: SceneReceiver[] = group.receivers.map((c) => ({
          id: c.id,
          position: [c.e, c.n, c.zAbs],
          height_agl: rxHeightAboveGround,
        }));
        session.set_receivers(JSON.stringify(receivers));
        const solved = JSON.parse(session.solve()) as SceneResults;

        const byId = new Map(group.receivers.map((c) => [c.id, c]));
        const srcById = new Map(tile.sources.map((s) => [s.id, s]));
        for (const rr of solved.per_receiver) {
          const cell = byId.get(rr.receiver_id);
          if (!cell) continue;
          // The contribution cutoff stays a per source→cell rule: the engine
          // solves the whole tile batch, and sources too far from THIS cell are
          // dropped before summing.
          const kept: number[][] = [];
          for (const c of rr.per_source) {
            const s = srcById.get(c.source_id);
            if (!s) continue;
            if (cutoffM > 0) {
              const [se, sn] = latLngToLocalMetres(s.latLng, origin);
              const dx = se - cell.e;
              const dy = sn - cell.n;
              if (dx * dx + dy * dy > cutoffM * cutoffM) continue;
            }
            kept.push(c.bands);
          }
          // Floor first, THEN apply DΩ — the same order as the previous engine,
          // so a cell that reads as floor doesn't get lifted off it by DΩ.
          const total = totalDbaFor(kept, aw);
          dbA[cell.idx] = total > -119.9 ? total + dOmegaDb : -120;
        }
      } catch (e) {
        console.error('grid solve failed:', e instanceof Error ? e.message : e);
      } finally {
        session.free();
      }
    }
    onProgress?.(++tilesDone, tiles.length);
  }
  return { cols, rows, bounds, dbA, computedMs: performance.now() - t0 };
}

// ============== P4: incremental regrid ==============
//
// A regrid usually changes only part of the model. Tiles whose effective source
// list is byte-for-byte what it was last time must produce the same cells, so
// they can be copied from the previous result instead of re-solved.
//
// The whole feature rests on the fingerprint being COMPLETE: a missed input
// means stale cells, and stale contours look exactly like fresh ones. So the
// job-level digest covers every field of `GridJob` except `tiles`, and any
// change to it forces a full regrid; only then are per-tile digests consulted.
//
// Exact bit-level mixing of doubles, not rounded strings — a source nudged by a
// millimetre must register.

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);

function mixNumber(h: number, v: number): number {
  _f64[0] = v;
  let x = h ^ _u32[0];
  x = Math.imul(x, 16777619);
  x ^= _u32[1];
  x = Math.imul(x, 16777619);
  return x >>> 0;
}

function mixString(h: number, s: string): number {
  let x = h;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return x >>> 0;
}

/// Fold an arbitrary JSON-shaped value into the digest. Object keys are sorted
/// so property order can never change the result.
function mixValue(h: number, v: unknown): number {
  let x = h;
  if (v === null || v === undefined) return mixString(x, v === null ? '\u0000null' : '\u0000undef');
  if (typeof v === 'number') return mixNumber(x, v);
  if (typeof v === 'boolean') return mixNumber(x, v ? 1 : 0);
  if (typeof v === 'string') return mixString(x, v);
  if (Array.isArray(v)) {
    x = mixNumber(x, v.length);
    for (const el of v) x = mixValue(x, el);
    return x;
  }
  if (ArrayBuffer.isView(v)) {
    const arr = v as unknown as ArrayLike<number>;
    x = mixNumber(x, arr.length);
    for (let i = 0; i < arr.length; i++) x = mixNumber(x, arr[i]);
    return x;
  }
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj).sort()) {
    x = mixString(x, k);
    x = mixValue(x, obj[k]);
  }
  return x;
}

/// Two independently-seeded 32-bit digests, so a collision needs both to
/// coincide. Returned as a string for easy comparison and logging.
function digest(v: unknown): string {
  const a = mixValue(2166136261, v);
  const b = mixValue(0x9e3779b9, v);
  return `${a.toString(36)}.${b.toString(36)}`;
}

/// Digest of everything in a job EXCEPT its tiles. Any change here invalidates
/// the whole cached grid — geometry, obstacles, terrain, settings and the
/// output raster's own dimensions all move every cell.
export function gridJobFingerprint(job: GridJob): string {
  const { tiles: _tiles, ...rest } = job;
  return digest(rest);
}

/// Digest of one tile: its cell block and its fully-resolved source list.
export function gridTileFingerprint(t: GridTile): string {
  return digest([t.col0, t.row0, t.cols, t.rows, t.sources]);
}

export interface GridCacheEntry {
  jobKey: string;
  tileKeys: string[];
  dbA: Float32Array;
  cols: number;
  rows: number;
}

export interface IncrementalPlan {
  /// Tiles that must actually be solved.
  dirty: GridTile[];
  /// Cells to seed the new grid with, or null for a full solve.
  reuse: { from: Float32Array; tiles: GridTile[] } | null;
  /// Fingerprints for the entry this run will store.
  jobKey: string;
  tileKeys: string[];
}

/// Decide which tiles a run has to solve, given the previous run's cache.
///
/// Conservative by construction: any mismatch in the job digest, the tile
/// count or the raster dimensions falls back to solving everything.
export function planIncrementalGrid(job: GridJob, cache: GridCacheEntry | null): IncrementalPlan {
  const jobKey = gridJobFingerprint(job);
  const tileKeys = job.tiles.map(gridTileFingerprint);
  const usable = cache !== null
    && cache.jobKey === jobKey
    && cache.cols === job.cols
    && cache.rows === job.rows
    && cache.tileKeys.length === tileKeys.length
    && cache.dbA.length === job.cols * job.rows;
  if (!usable) return { dirty: job.tiles, reuse: null, jobKey, tileKeys };

  const dirty: GridTile[] = [];
  const clean: GridTile[] = [];
  for (let i = 0; i < job.tiles.length; i++) {
    if (cache!.tileKeys[i] === tileKeys[i]) clean.push(job.tiles[i]);
    else dirty.push(job.tiles[i]);
  }
  return { dirty, reuse: { from: cache!.dbA, tiles: clean }, jobKey, tileKeys };
}

// ============== P5: per-tile barrier culling ==============
//
// A wall can only screen a source→cell path if it crosses that path, and every
// such path lies inside the bounding box of (the tile's cells ∪ its sources).
// So a wall whose segment misses that box can be dropped for the whole tile —
// once, on the main thread, instead of being re-tested for every one of the
// tile's (cells × sources) pairs.
//
// This is exactly the trick Barnes-Hut plays for sources, applied to walls.
// It is conservative by construction: a wall that could screen anything in the
// tile always survives, so the culled grid is identical to the unculled one.

/// Does segment `p→q` intersect the axis-aligned box, or lie inside it?
/// Liang–Barsky against the box, in plan.
export function segmentHitsBox(
  p: [number, number], q: [number, number],
  minX: number, minY: number, maxX: number, maxY: number,
): boolean {
  // Trivial accept: either endpoint inside.
  if ((p[0] >= minX && p[0] <= maxX && p[1] >= minY && p[1] <= maxY)
    || (q[0] >= minX && q[0] <= maxX && q[1] >= minY && q[1] <= maxY)) return true;
  const dx = q[0] - p[0];
  const dy = q[1] - p[1];
  let t0 = 0;
  let t1 = 1;
  const edges: Array<[number, number]> = [
    [-dx, p[0] - minX], [dx, maxX - p[0]],
    [-dy, p[1] - minY], [dy, maxY - p[1]],
  ];
  for (const [den, num] of edges) {
    if (den === 0) {
      if (num < 0) return false;
      continue;
    }
    const t = num / den;
    if (den < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

/// Barriers that could screen any source→cell path in a tile whose cells and
/// sources span `[minLat, maxLat] × [minLng, maxLng]`.
///
/// `marginDeg` guards the edges: a barrier just outside the box can still be
/// crossed by a path to a cell ON the boundary, and the engine's own lateral
/// (around-the-end) diffraction reaches a little further still.
export function barriersForRegion(
  barriers: Barrier[],
  minLat: number, maxLat: number, minLng: number, maxLng: number,
  marginDeg: number,
): Barrier[] {
  const lo0 = minLat - marginDeg;
  const hi0 = maxLat + marginDeg;
  const lo1 = minLng - marginDeg;
  const hi1 = maxLng + marginDeg;
  return barriers.filter((b) => {
    const poly = b.polylineLatLng ?? [];
    for (let i = 0; i + 1 < poly.length; i++) {
      if (segmentHitsBox(poly[i], poly[i + 1], lo0, lo1, hi0, hi1)) return true;
    }
    // A single-vertex (degenerate) barrier can't screen, but keep it rather
    // than silently changing what the engine is given.
    return poly.length < 2;
  });
}
