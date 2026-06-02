// Worker-safe grid core. This module is deliberately free of any dependency
// on the catalog / Firebase / source-tree code, so the grid Web Worker
// (`grid.worker.ts`) can import it without dragging firebase (which expects a
// `window`) into the worker bundle. It holds: geo helpers, the topography
// virtual-barrier sampler, and the batched primal grid evaluator core shared
// by the main thread (`evaluateGrid`) and the worker.

import { GridEvaluator } from '../wasm/beesty_solver.js';
import type { DemRaster } from './dem';

/// Local east/north metres of `latLng` relative to `origin` (equirectangular
/// approximation — exact enough over a project's few-km extent).
export function latLngToLocalMetres(
  latLng: [number, number],
  origin: [number, number],
): [number, number] {
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = ((latLng[0] - origin[0]) * Math.PI) / 180;
  const dLng = ((latLng[1] - origin[1]) * Math.PI) / 180;
  const n = R * dLat;
  const e = R * dLng * Math.cos(lat0);
  return [e, n];
}

/// Great-circle distance (equirectangular approx) in metres.
export function approxDistanceM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const lat0 = (a[0] * Math.PI) / 180;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const e = R * dLng * Math.cos(lat0);
  const n = R * dLat;
  return Math.sqrt(e * e + n * n);
}

/// Topography settings subset needed for ridge sampling — passed explicitly
/// (not the whole `project`) so this runs in a worker.
export interface TopoSettings {
  pathSamples?: number;
  virtualBarrierMinHeightM?: number;
}

/// Sample the DEM along the (source → receiver) line; where the ground pokes
/// above the straight-line path by more than `minHeightM`, emit a thin virtual
/// barrier whose top IS the absolute ground elevation at that sample (a terrain
/// ridge has zero height-above-ground — its "top" is the ground itself).
/// Returns the wall pack layout `(ax, ay, bx, by, base_z_a, base_z_b, height)`
/// per barrier — here `base_z_a = base_z_b = groundZ` and `height = 0`.
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
  const samples = topo?.pathSamples ?? 48;
  const minH = topo?.virtualBarrierMinHeightM ?? 2;
  if (samples <= 0) return new Float64Array(0);

  const out: number[] = [];
  const dxPath = receiverXyz[0] - sourceXyz[0];
  const dyPath = receiverXyz[1] - sourceXyz[1];
  const pathLen = Math.sqrt(dxPath * dxPath + dyPath * dyPath);
  if (pathLen < 1) return new Float64Array(0);
  const perpX = -dyPath / pathLen;
  const perpY = dxPath / pathLen;
  const wing = 50;

  const srcLat = sourceLatLng[0];
  const srcLng = sourceLatLng[1];
  const rxLat = receiverLatLng[0];
  const rxLng = receiverLatLng[1];

  for (let k = 1; k < samples; k++) {
    const t = k / samples;
    const lat = srcLat + (rxLat - srcLat) * t;
    const lng = srcLng + (rxLng - srcLng) * t;
    const groundZ = dem.elevation(lat, lng);
    if (!Number.isFinite(groundZ)) continue;
    const lineZ = sourceXyz[2] + (receiverXyz[2] - sourceXyz[2]) * t;
    const protrusion = groundZ - lineZ;
    if (protrusion < minH) continue;

    const [e, n] = latLngToLocalMetres([lat, lng], origin);
    const ax = e + perpX * wing;
    const ay = n + perpY * wing;
    const bx = e - perpX * wing;
    const by = n - perpY * wing;
    out.push(ax, ay, bx, by, groundZ, groundZ, 0);
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
export interface SolverEnv { tC: number; rh: number; pKpa: number; barConv: number; dzCap: number; }

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
      env.tC, env.rh, env.pKpa, env.barConv, env.dzCap,
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
