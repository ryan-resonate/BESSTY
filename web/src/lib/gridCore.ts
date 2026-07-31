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

export function runBatchedGrid(
  job: GridJob,
  dem: DemRaster | null,
  onProgress?: GridProgress,
): GridResult {
  const t0 = performance.now();
  const {
    cols, rows, dxM, dyM, origin, nBands, cutoffM, dOmegaDb, rxHeightAboveGround,
    barriers, settings, terrain, includeContainers, roofOffsetM, bounds, tiles,
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
    for (let row = tile.row0; row < rowEnd; row++) {
      const n = (row - (rows - 1) / 2) * dyM;
      const lat = origin[0] + (n / R) * (180 / Math.PI);
      for (let col = tile.col0; col < colEnd; col++) {
        const e = (col - (cols - 1) / 2) * dxM;
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
        barriers,
        dem,
        terrain,
        settings,
        includeContainers,
        roofOffsetM,
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
