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
/// barrier at the sample's local-frame XY with its top at the ABSOLUTE ground
/// elevation (matching the absolute z passed for source/receiver). Returns the
/// `packBarriers` layout (ax, ay, bx, by, topZ per barrier).
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
  const samples = topo?.pathSamples ?? 12;
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
    out.push(ax, ay, bx, by, groundZ);
  }
  return new Float64Array(out);
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
  sourcesFlat: Float64Array;       // GridEvaluator source pack
  srcLatLng: Array<[number, number]>;
  srcIsReal: boolean[];
  topo: TopoSettings | undefined;
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
    barCount += tb.length / 5;
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
    rxHeightAboveGround, userBarriers, sourcesFlat, srcLatLng, srcIsReal, topo, bounds } = job;
  const stride = 6 + nBands;
  const nS = srcLatLng.length;
  const srcLocal: Array<[number, number]> = [];
  const srcZAbs: number[] = [];
  for (let i = 0; i < nS; i++) {
    srcLocal.push([sourcesFlat[i * stride + 1], sourcesFlat[i * stride + 2]]);
    srcZAbs.push(sourcesFlat[i * stride + 3]);
  }
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const evaluator = new GridEvaluator(
    sourcesFlat, nBands, g, userBarriers,
    env.tC, env.rh, env.pKpa, env.barConv, env.dzCap,
  );
  const dbA = new Float32Array(cols * rows);
  try {
    for (let row = 0; row < rows; row++) {
      const n = (row - (rows - 1) / 2) * dyM;
      const lat = origin[0] + (n / R) * (180 / Math.PI);
      for (let col = 0; col < cols; col++) {
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
        const total = evaluator.eval_cell_dba(e, n, rxZAbs, rxZ, cutoffM, offsets, barriers);
        dbA[row * cols + col] = total > -119.9 ? total + dOmegaDb : -120;
      }
    }
  } finally {
    evaluator.free();
  }
  return { cols, rows, bounds, dbA, computedMs: performance.now() - t0 };
}
