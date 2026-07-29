// Worker-safe grid core. This module is deliberately free of any dependency
// on the catalog / Firebase / source-tree code, so the grid Web Worker
// (`grid.worker.ts`) can import it without dragging firebase (which expects a
// `window`) into the worker bundle. It holds: geo helpers, the topography
// virtual-barrier sampler, and the batched primal grid evaluator core shared
// by the main thread (`evaluateGrid`) and the worker.

import { GridEvaluator } from '../wasm/iso9613_wasm.js';
import type { DemRaster } from './dem';

// Geo helpers now live in `./geo` (wasm-free, so the scene builder and the
// terrain sampler can share them). Re-exported here for existing importers.
export { latLngToLocalMetres, approxDistanceM } from './geo';

/// Topography settings subset needed for ridge sampling — passed explicitly
/// (not the whole `project`) so this runs in a worker.
export interface TopoSettings {
  /// @deprecated Sampling is automatic at DEM resolution now; ignored.
  pathSamples?: number;
  /// Min ridge prominence (m) — keep a silhouette edge only if it rises this
  /// far above the chord of its neighbours. Default 2.
  virtualBarrierMinHeightM?: number;
  /// Peak-preserving DEM despike (Hampel) strength. Default 'low'.
  despikeStrength?: 'off' | 'low' | 'medium';
}

// Profile sampling bounds. Spacing tracks the DEM's native cell size, but we
// clamp so a tiny path isn't oversampled and a huge path can't explode the
// per-cell cost.
const TOPO_MIN_SPACING_M = 8;
const TOPO_MAX_SAMPLES = 256;
const TERRAIN_WING_M = 50;

/// Median of a numeric array (lower-middle for even length).
function medianOf(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/// Hampel despike: replace a sample with its window median ONLY when it is a
/// statistical outlier (> t·MAD from that median) AND off by a real margin
/// (≥1 m). Peak-preserving — a genuine crest sits on its slope so it isn't an
/// outlier, but a single-cell DEM blunder is. Returns a new array.
function despikeProfile(z: number[], strength: 'off' | 'low' | 'medium'): number[] {
  if (strength === 'off' || z.length < 5) return z;
  const k = strength === 'medium' ? 3 : 2;       // half-window
  const t = strength === 'medium' ? 2.5 : 3.5;   // MAD multiples
  const MIN_ABS_M = 1.0;                          // ignore sub-metre wobble
  const out = z.slice();
  for (let i = 0; i < z.length; i++) {
    const lo = Math.max(0, i - k);
    const hi = Math.min(z.length - 1, i + k);
    const win: number[] = [];
    for (let j = lo; j <= hi; j++) win.push(z[j]);
    const med = medianOf(win);
    const mad = medianOf(win.map((v) => Math.abs(v - med)));
    const sigma = Math.max(1.4826 * mad, 0.3);    // floor so clean-flat ≠ everything an outlier
    const dev = Math.abs(z[i] - med);
    if (dev > MIN_ABS_M && dev > t * sigma) out[i] = med;
  }
  return out;
}

interface ProfilePt { x: number; z: number; idx: number }  // idx < 0 → S/R anchor

/// Andrew's monotone-chain UPPER hull over points pre-sorted by x. Mirrors the
/// solver's `upper_hull_select` turn test so this JS pre-reduction agrees with
/// the engine's own hull.
function upperHull(pts: ProfilePt[]): ProfilePt[] {
  const h: ProfilePt[] = [];
  for (const p of pts) {
    while (h.length >= 2) {
      const a = h[h.length - 2];
      const b = h[h.length - 1];
      const cross = (b.x - a.x) * (p.z - b.z) - (b.z - a.z) * (p.x - b.x);
      if (cross >= 0) h.pop(); else break;
    }
    h.push(p);
  }
  return h;
}

/// Drop interior hull vertices whose vertical rise above the chord of their
/// neighbours is < prominence, least-prominent first, until every survivor
/// clears the bar. S/R anchors (first/last) are fixed. "Prominence" here is the
/// extra diffraction height the edge actually contributes.
function simplifyByProminence(hull: ProfilePt[], promM: number): ProfilePt[] {
  const pts = hull.slice();
  while (pts.length > 2) {
    let minDev = Infinity;
    let minAt = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const c = pts[i + 1];
      const span = c.x - a.x;
      const zChord = span > 1e-9 ? a.z + (c.z - a.z) * ((b.x - a.x) / span) : a.z;
      const dev = b.z - zChord;                    // upper hull → b sits above the chord
      if (dev < minDev) { minDev = dev; minAt = i; }
    }
    if (minAt < 0 || minDev >= promM) break;
    pts.splice(minAt, 1);
  }
  return pts;
}

/// Build virtual terrain barriers along the source→receiver line.
///
/// Pipeline (task #15):
///   1. Sample the DEM ground profile at its NATIVE resolution along the path
///      (not a fixed count), capped so long paths stay bounded.
///   2. Hampel despike — remove isolated DEM blunders, keep real crests.
///   3. Upper convex hull in the (distance, height) plane, with the source and
///      receiver acoustic centres as end anchors → the diffracting silhouette
///      (the engine re-hulls this together with any man-made barriers).
///   4. Prominence-simplify: keep every silhouette edge that adds ≥ the
///      prominence knob of extra path height; drop the rest.
///   5. Emit survivors as thin virtual walls whose top IS the ground elevation.
///
/// Returns the wall pack `(ax, ay, bx, by, base_z_a, base_z_b, height)` per
/// barrier — here `base_z_a = base_z_b = groundZ` and `height = 0`.
export function topographyBarriers(
  topo: TopoSettings | undefined,
  sourceLatLng: [number, number],
  sourceXyz: [number, number, number],
  receiverLatLng: [number, number],
  receiverXyz: [number, number, number],
  origin: [number, number],
  dem: DemRaster | null,
): Float64Array {
  if (!dem) return new Float64Array(0);
  const promM = topo?.virtualBarrierMinHeightM ?? 2;
  const despike = topo?.despikeStrength ?? 'low';

  const dxPath = receiverXyz[0] - sourceXyz[0];
  const dyPath = receiverXyz[1] - sourceXyz[1];
  const pathLen = Math.sqrt(dxPath * dxPath + dyPath * dyPath);
  if (pathLen < 1) return new Float64Array(0);

  // DEM-resolution sample count, clamped.
  const spacing = Math.max(TOPO_MIN_SPACING_M, dem.resolutionM ?? 20);
  let n = Math.ceil(pathLen / spacing);
  if (n > TOPO_MAX_SAMPLES) n = TOPO_MAX_SAMPLES;
  if (n < 2) n = 2;

  const perpX = -dyPath / pathLen;
  const perpY = dxPath / pathLen;

  const srcLat = sourceLatLng[0];
  const srcLng = sourceLatLng[1];
  const rxLat = receiverLatLng[0];
  const rxLng = receiverLatLng[1];

  // ----- 1. Sample the ground profile (interior points; S/R added later at
  // their acoustic-centre heights so the hull screens against the sightline).
  const xs: number[] = [];
  const zs: number[] = [];
  const lats: number[] = [];
  const lngs: number[] = [];
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const lat = srcLat + (rxLat - srcLat) * t;
    const lng = srcLng + (rxLng - srcLng) * t;
    const g = dem.elevation(lat, lng);
    if (!Number.isFinite(g)) continue;
    xs.push(t * pathLen);
    zs.push(g);
    lats.push(lat);
    lngs.push(lng);
  }
  if (xs.length === 0) return new Float64Array(0);

  // ----- 2. Despike.
  const zsD = despikeProfile(zs, despike);

  // ----- 3. Upper hull with S/R as fixed anchors at their absolute heights.
  const pts: ProfilePt[] = [];
  pts.push({ x: 0, z: sourceXyz[2], idx: -1 });
  for (let i = 0; i < xs.length; i++) pts.push({ x: xs[i], z: zsD[i], idx: i });
  pts.push({ x: pathLen, z: receiverXyz[2], idx: -1 });
  const hull = upperHull(pts);

  // ----- 4. Prominence simplify.
  const kept = simplifyByProminence(hull, promM);

  // ----- 5. Emit survivors (interior hull vertices only).
  const out: number[] = [];
  for (const p of kept) {
    if (p.idx < 0) continue;
    const lat = lats[p.idx];
    const lng = lngs[p.idx];
    const gz = zsD[p.idx];
    const [e, north] = latLngToLocalMetres([lat, lng], origin);
    const ax = e + perpX * TERRAIN_WING_M;
    const ay = north + perpY * TERRAIN_WING_M;
    const bx = e - perpX * TERRAIN_WING_M;
    const by = north - perpY * TERRAIN_WING_M;
    out.push(ax, ay, bx, by, gz, gz, 0);
  }
  return new Float64Array(out);
}

/// Annex D.5 concave-ground criterion (A3): apply the −3 dB ground-reflection
/// correction when the mean height of the straight source→receiver line above
/// the terrain is ≥ 1.5·(hS+hR)/2 — i.e. the ground dips away under the path
/// (concave), enhancing the reflection. `srcZAbs`/`rxZAbs` are absolute z;
/// `hS`/`hR` are heights above ground. Returns false without a DEM.
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

/// Atmosphere + barrier-convention parameters threaded to every WASM call.
export interface SolverEnv { tC: number; rh: number; pKpa: number; barConv: number; dzCap: number; c0: number; }

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
/// single virtual source while near tiles keep them all. `srcLatLng` and
/// `srcIsReal` accompany the pack because topography sampling needs lat/lng and
/// the real/cluster split (positions in metres + z come from `sourcesFlat`).
export interface GridTile {
  col0: number; row0: number;   // top-left cell (inclusive)
  cols: number; rows: number;   // tile size in cells
  sourcesFlat: Float64Array;    // GridEvaluator source pack for this tile
  srcLatLng: Array<[number, number]>;
  srcIsReal: boolean[];
}

/// Fully-resolved, serializable description of a grid computation — produced on
/// the main thread (catalog + DEM resolution) and runnable either inline or in
/// a Web Worker. Everything here is a typed array or plain data.
export interface GridJob {
  cols: number; rows: number; dxM: number; dyM: number;
  origin: [number, number];
  bounds: { sw: [number, number]; ne: [number, number] };
  nBands: number;
  g: number; cutoffM: number; dOmegaDb: number;
  env: SolverEnv;
  rxHeightAboveGround: number;
  userBarriers: Float64Array;
  topo: TopoSettings | undefined;
  /// The grid partitioned into tiles, each with its own adaptively-clustered
  /// source set. Union of tiles covers the whole grid exactly once.
  tiles: GridTile[];
}

/// Build the per-source topography-barrier offsets + flattened pack for one
/// grid cell, in the layout `GridEvaluator.eval_cell_dba` expects. Empty
/// offsets ⇒ "no topo at all" (no DEM). Only real sources within the cutoff
/// get ridge analysis; clusters are skipped.
function cellTopoPack(
  srcLatLng: Array<[number, number]>,
  srcIsReal: boolean[],
  srcLocal: Array<[number, number]>,
  srcZAbs: number[],
  topo: TopoSettings | undefined,
  origin: [number, number],
  dem: DemRaster | null,
  cellLat: number, cellLng: number,
  cellE: number, cellN: number, cellZAbs: number,
  cutoffM: number,
): { offsets: Uint32Array; barriers: Float64Array } {
  if (!dem) return { offsets: new Uint32Array(0), barriers: new Float64Array(0) };
  const nS = srcLatLng.length;
  const offsets = new Uint32Array(nS + 1);
  const chunks: number[] = [];
  let barCount = 0;
  for (let si = 0; si < nS; si++) {
    offsets[si] = barCount;
    if (!srcIsReal[si]) continue;
    const [se, sn] = srcLocal[si];
    if (cutoffM > 0) {
      const dx = se - cellE, dy = sn - cellN;
      if (dx * dx + dy * dy > cutoffM * cutoffM) continue;
    }
    const tb = topographyBarriers(
      topo, srcLatLng[si], [se, sn, srcZAbs[si]],
      [cellLat, cellLng], [cellE, cellN, cellZAbs], origin, dem,
    );
    for (let j = 0; j < tb.length; j++) chunks.push(tb[j]);
    barCount += tb.length / 7; // wall pack stride (a_e,a_n,b_e,b_n,base_a,base_b,height)
  }
  offsets[nS] = barCount;
  return { offsets, barriers: new Float64Array(chunks) };
}

/// Run a `GridJob` against a DEM (the real one on the main thread, a region
/// snapshot in the worker). Identical batched-primal logic in both — one
/// `GridEvaluator.eval_cell_dba` per cell, all sources energy-summed in Rust.
/// This is the single source of truth for the contour grid.
export function runBatchedGrid(job: GridJob, dem: DemRaster | null): GridResult {
  const t0 = performance.now();
  const { cols, rows, dxM, dyM, origin, nBands, g, cutoffM, dOmegaDb, env,
    rxHeightAboveGround, userBarriers, topo, bounds, tiles } = job;
  const stride = 6 + nBands;
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dbA = new Float32Array(cols * rows);

  const NO_CONCAVE = new Uint8Array(0);
  for (const tile of tiles) {
    const { srcLatLng, srcIsReal } = tile;
    const nS = srcLatLng.length;
    // Derive metre positions + absolute z + WTG flag + HAG from the pack.
    const srcLocal: Array<[number, number]> = [];
    const srcZAbs: number[] = [];
    const srcIsWtg: boolean[] = [];
    const srcHagl: number[] = [];
    let tileHasWtg = false;
    for (let i = 0; i < nS; i++) {
      srcLocal.push([tile.sourcesFlat[i * stride + 1], tile.sourcesFlat[i * stride + 2]]);
      srcZAbs.push(tile.sourcesFlat[i * stride + 3]);
      srcHagl.push(tile.sourcesFlat[i * stride + 4]);
      const wtg = tile.sourcesFlat[i * stride] !== 0;
      srcIsWtg.push(wtg);
      if (wtg) tileHasWtg = true;
    }
    const evaluator = new GridEvaluator(
      tile.sourcesFlat, nBands, g, userBarriers,
      env.tC, env.rh, env.pKpa, env.barConv, env.dzCap, env.c0,
      // Lateral edges not yet packed from the web (Phase 1); empty preserves
      // current behaviour. See docs/iso9613-solver-phase01-execution.md.
      new Float64Array(0),
    );
    try {
      const rowEnd = Math.min(tile.row0 + tile.rows, rows);
      const colEnd = Math.min(tile.col0 + tile.cols, cols);
      for (let row = tile.row0; row < rowEnd; row++) {
        const n = (row - (rows - 1) / 2) * dyM;
        const lat = origin[0] + (n / R) * (180 / Math.PI);
        for (let col = tile.col0; col < colEnd; col++) {
          const e = (col - (cols - 1) / 2) * dxM;
          const lng = origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI);
          const groundZRaw = dem ? dem.elevation(lat, lng) : 0;
          const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : 0;
          const rxZ = rxHeightAboveGround;
          const rxZAbs = groundZ + rxZ;
          const { offsets, barriers } = cellTopoPack(
            srcLatLng, srcIsReal, srcLocal, srcZAbs, topo, origin, dem,
            lat, lng, e, n, rxZAbs, cutoffM,
          );
          // Annex D.5 concave flags per WTG source (A3). Skipped entirely for
          // tiles with no turbines (the common BESS case → zero overhead).
          let concaveFlags = NO_CONCAVE;
          if (tileHasWtg && dem) {
            concaveFlags = new Uint8Array(nS);
            for (let i = 0; i < nS; i++) {
              if (srcIsWtg[i] && concaveCorrectionMet(
                srcLatLng[i], srcZAbs[i], [lat, lng], rxZAbs, srcHagl[i], rxZ, dem,
              )) concaveFlags[i] = 1;
            }
          }
          const total = evaluator.eval_cell_dba(e, n, rxZAbs, rxZ, cutoffM, offsets, barriers, concaveFlags);
          dbA[row * cols + col] = total > -119.9 ? total + dOmegaDb : -120;
        }
      }
    } finally {
      evaluator.free();
    }
  }
  return { cols, rows, bounds, dbA, computedMs: performance.now() - t0 };
}
