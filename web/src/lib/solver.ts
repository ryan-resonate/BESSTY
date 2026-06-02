// Wraps the Rust + WASM solver into a typed, project-shaped API.
//
// Both outputs (point receivers and the contour grid) use the PRIMAL solver
// path — a direct exact evaluation per source→receiver pair (points) or one
// batched `GridEvaluator.eval_cell_dba` per cell (grid, on a Web Worker). The
// solve is fast enough that source drags simply re-evaluate.
//
// The Rust crate still carries the forward-mode automatic-differentiation
// (dual-number) gradient path and its WASM exports (`evaluate_*_with_grad_*`),
// but the front end no longer wires them in: there is no snapshot / Taylor-
// extrapolation layer here anymore. The AD feature is retained in the solver
// for possible future use; it is simply not called from the app.

import init, {
  evaluate_general_octave,
  evaluate_wtg_octave,
  octave_a_weighting,
  octave_centres,
} from '../wasm/beesty_solver.js';

import type {
  Barrier,
  Source,
  Project,
} from './types';
import { lookupEntry, sourceHeightFor, spectrumFor } from './catalog';
import { type DemRaster, type DemRegion, captureDemRegion } from './dem';
import {
  concatBarriers,
  propagationSettings,
  type EffectiveSource,
} from './propagation';
import { buildSourceTree, walkSourceTreeForRegion } from './sourceTree';
import {
  approxDistanceM,
  latLngToLocalMetres,
  topographyBarriers,
  concaveCorrectionMet,
  runBatchedGrid,
  type GridJob,
  type GridTile,
  type GridResult,
  type SolverEnv,
} from './gridCore';

// Re-export so downstream consumers (contourLines, exporters) keep importing
// these from './solver'.
export type { GridResult, GridJob } from './gridCore';
export { latLngToLocalMetres } from './gridCore';

// Atmosphere + barrier-convention parameters threaded through to every
// WASM call. Atmosphere defaults match `Atmosphere::iso_reference()` in
// the Rust solver (10 °C, 70 % RH, 101.325 kPa). Barrier convention
// defaults to the simpler-bookkeeping variant (`Dz − max(Agr, 0)`) since
// it's numerically equivalent to strict ISO Eq 16/17 in every case and
// matches what the team's reference tools produce.
function solverEnv(project: Project): SolverEnv {
  const atm = project.settings?.atmosphere;
  const tC = atm?.temperatureC ?? 10;
  const rh = atm?.relativeHumidityPct ?? 70;
  const pKpa = atm?.pressureKpa ?? 101.325;
  // 1 = DzMinusMaxAgr0 (recommended); 0 = strict ISO Eq16. Default to 1
  // when the project hasn't pinned a value.
  const barConv = project.settings?.barrierConvention === 'iso-eq16' ? 0 : 1;
  // Diffraction Dz cap. Sentinel −1.0 = "no override, use the standard
  // ISO §7.4 caps (20 dB single edge / 25 dB multi-edge)". A finite
  // non-negative value (e.g. 2) overrides those caps for general
  // (non-WTG) sources. WTG sources use `annexD.barrierAbarCapDb`
  // independently (default 3 dB) and aren't affected by this field.
  const userCap = project.settings?.barrierDiffractionCapDb;
  const dzCap = userCap != null && Number.isFinite(userCap) && userCap >= 0 ? userCap : -1;
  return { tC, rh, pKpa, barConv, dzCap };
}

/// Project-wide DΩ correction (dB). Defaults to 0 dB (strict ISO 9613-2
/// / IEC 61400-11), which matches SoundPlan-style validation tools.
/// Override per-project to +3 dB when the source catalog reports
/// un-weighted Lw and you want the +3 dB hemispherical ground-reflection
/// boost added on top. Centralised so every site that adds DΩ uses
/// the same fallback.
export function projectDOmegaDb(project: Project): number {
  return project.settings?.dOmegaDb ?? 0;
}

/// Band count for the solver, given a scenario's band system.
/// Matches the Rust crate's `OCTAVE_CENTRES_HZ.len()` (10) and
/// `ONE_THIRD_OCTAVE_CENTRES_HZ.len()` (31).
export function bandCount(bs: 'octave' | 'oneThirdOctave'): number {
  return bs === 'oneThirdOctave' ? 31 : 10;
}
// A-weighting convention used throughout BESSTY:
//
//   - The Rust solver always works in Z-weighted (un-weighted) per-band
//     space. Catalog `LwA per band` data is converted to `Lw per band`
//     by `lib/catalog::spectrumFor` BEFORE the WASM call (see the
//     `weighting` field on `CatalogModeData`).
//   - Per-band Lp out of the solver is therefore Z-weighted; we apply
//     the IEC 61672-1 A-weighting offsets here when energy-summing into
//     a total LpA in dB(A).

/// A-weighting offsets per IEC 61672-1 — separate tables for the two band
/// systems so we don't hand the wrong-length weights to a downstream sum.
const OCTAVE_AW = new Float64Array([-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1]);
const THIRD_OCT_AW = new Float64Array([
  -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
  -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
  -3.2,  -1.9,  -0.8,   0.0,   0.6,   1.0,   1.2,   1.3,   1.2,
   1.0,   0.5,  -0.1,  -1.1,  -2.5,
]);
function aWeights(bs: 'octave' | 'oneThirdOctave'): Float64Array {
  return bs === 'oneThirdOctave' ? THIRD_OCT_AW : OCTAVE_AW;
}

let initialized: Promise<void> | null = null;

export function ensureSolverReady(): Promise<void> {
  // Wrap in an explicit `Promise<void>` rather than relying on the chained
  // `.then(() => undefined)` to settle the type. When CI couldn't resolve
  // the WASM module (because the artefacts hadn't been generated yet),
  // `init()`'s inferred return type collapsed to `unknown`, and the
  // resulting `unknown.then(...)` was no longer a `Promise<void>`. The
  // explicit `Promise.resolve(init()).then(...)` keeps the type pinned.
  if (!initialized) {
    initialized = Promise.resolve(init()).then(() => undefined);
  }
  return initialized;
}

export interface ReceiverResult {
  receiverId: string;
  perBandLp: Float64Array;
  totalDbA: number;
  perSource: Array<{ sourceId: string; perBandLp: Float64Array }>;
}

/// Longest barrier sub-segment (m). A drawn barrier polyline is broken into
/// pieces no longer than this so each piece follows the terrain (its base is
/// the DEM ground under its own short span) instead of a single linear
/// interpolation across the whole length. Each piece is a terrain-following
/// `WallBarrier`: it carries the absolute ground elevation under each endpoint
/// plus the height-above-ground; the solver interpolates the top at the
/// diffraction crossing. No DEM → ground 0 → top = height (flat-ground
/// behaviour unchanged).
const MAX_BARRIER_SEGMENT_M = 10;

function packBarriers(
  barriers: Barrier[],
  originLatLng: [number, number],
  dem: DemRaster | null,
): Float64Array {
  const out: number[] = [];
  const groundAt = (lat: number, lng: number): number => {
    if (!dem) return 0;
    const g = dem.elevation(lat, lng);
    return Number.isFinite(g) ? g : 0;
  };
  for (const b of barriers) {
    const poly = b.polylineLatLng;
    if (poly.length < 2) continue;
    const h0 = b.topHeightsM[0] ?? 0;
    // Walk every polyline edge (not just the first), subdividing each into
    // ≤ MAX_BARRIER_SEGMENT_M pieces.
    for (let v = 0; v + 1 < poly.length; v++) {
      const p0 = poly[v];
      const p1 = poly[v + 1];
      const hStart = b.topHeightsM[v] ?? h0;
      const hEnd = b.topHeightsM[v + 1] ?? h0;
      const segLen = approxDistanceM(p0, p1);
      const nSub = Math.max(1, Math.ceil(segLen / MAX_BARRIER_SEGMENT_M));
      for (let k = 0; k < nSub; k++) {
        const t0 = k / nSub;
        const t1 = (k + 1) / nSub;
        const lat0 = p0[0] + (p1[0] - p0[0]) * t0;
        const lng0 = p0[1] + (p1[1] - p0[1]) * t0;
        const lat1 = p0[0] + (p1[0] - p0[0]) * t1;
        const lng1 = p0[1] + (p1[1] - p0[1]) * t1;
        const aXY = latLngToLocalMetres([lat0, lng0], originLatLng);
        const cXY = latLngToLocalMetres([lat1, lng1], originLatLng);
        // Top height interpolated at the piece midpoint (constant per piece;
        // negligible variation over ≤10 m). Handles a sloping top if the
        // barrier carries per-vertex heights.
        const tm = (t0 + t1) / 2;
        const height = hStart + (hEnd - hStart) * tm;
        out.push(
          aXY[0], aXY[1], cXY[0], cXY[1],
          groundAt(lat0, lng0), groundAt(lat1, lng1), height,
        );
      }
    }
  }
  return new Float64Array(out);
}

/// Source **height above local ground** (HAG) — the machine height fed to the
/// ground-attenuation shape functions. Independent of terrain elevation.
///
/// Returns null if the catalog entry is missing.
function sourceHagl(source: Source, project: Project): number | null {
  const entry = lookupEntry(project, source);
  if (source.kind === 'wtg') {
    // Per-source `hubHeight` REPLACES the library default (it's the
    // explicit hub-height field, not a delta). Falls back to the
    // catalog's sourceHeightM, then hubHeights[0], then 100 m.
    return source.hubHeight ?? sourceHeightFor(entry);
  }
  // BESS / Aux: library height + per-source elevation delta.
  return sourceHeightFor(entry) + (source.elevationOffset ?? 0);
}

/// Energy-sum Z-weighted per-band Lp values into one total LpA in dB(A),
/// applying the IEC 61672-1 A-weighting offsets at sum time. Per-band Lp
/// out of the WASM solver is Z-weighted — see the A-weighting note above.
/// `dOmegaDb` (default 0) is added uniformly to every band as a frequency-
/// independent solid-angle correction — see ProjectSettings.dOmegaDb.
function aWeightedTotal(perBandLp: Float64Array, aw: Float64Array, dOmegaDb: number = 0): number {
  let aSum = 0;
  const n = Math.min(perBandLp.length, aw.length);
  for (let i = 0; i < n; i++) {
    if (isFinite(perBandLp[i])) aSum += Math.pow(10, (perBandLp[i] + aw[i] + dOmegaDb) / 10);
  }
  return aSum > 0 ? 10 * Math.log10(aSum) : -Infinity;
}

function energySumPerBand(perSource: Array<{ perBandLp: Float64Array }>): Float64Array {
  const n = perSource[0]?.perBandLp.length ?? 10;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (const { perBandLp } of perSource) acc += Math.pow(10, perBandLp[i] / 10);
    out[i] = acc > 0 ? 10 * Math.log10(acc) : -Infinity;
  }
  return out;
}

// ============== Receiver-point evaluation (primal) ==============

/// Exact per-band Lp (Z-weighted, length = band count) for one source →
/// receiver pair via the primal WASM solver. Mirrors the geometry the old
/// gradient snapshot used (A1 z-datum split: absolute z for divergence +
/// barrier geometry, height-above-ground for the Table-3 ground functions),
/// minus the dual-number gradient. No DEM → ground 0 → abs z = HAG.
function evaluatePair(
  source: Source,
  rxLatLng: [number, number],
  rxHeightAboveGround: number,
  project: Project,
  barriersFlat: Float64Array,
  dem: DemRaster | null,
  origin: [number, number],
): Float64Array {
  const [se, sn] = latLngToLocalMetres(source.latLng, origin);
  const [re, rn] = latLngToLocalMetres(rxLatLng, origin);
  const g = project.settings?.ground.defaultG ?? 0.5;
  const groundSrcRaw = dem ? dem.elevation(source.latLng[0], source.latLng[1]) : 0;
  const groundRxRaw = dem ? dem.elevation(rxLatLng[0], rxLatLng[1]) : 0;
  const groundSrc = Number.isFinite(groundSrcRaw) ? groundSrcRaw : 0;
  const groundRx = Number.isFinite(groundRxRaw) ? groundRxRaw : 0;
  const rxZ = rxHeightAboveGround;        // receiver HAG
  const rxZAbs = groundRx + rxZ;          // receiver absolute z

  const entry = lookupEntry(project, source);
  if (!entry) {
    throw new Error(`Catalog entry not found: ${source.catalogScope}/${source.modelId}`);
  }
  const modeName = source.modeOverride ?? entry.defaultMode;
  const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
  const env = solverEnv(project);

  if (source.kind === 'wtg') {
    const hubHeight = source.hubHeight ?? sourceHeightFor(entry);
    const hubZ = hubHeight;              // hub HAG
    const hubZAbs = groundSrc + hubZ;    // hub absolute z
    const topoBars = topographyBarriers(
      project.settings?.topography, source.latLng,
      [se, sn, hubZAbs], rxLatLng, [re, rn, rxZAbs], origin, dem,
    );
    const allBars = concatBarriers(barriersFlat, topoBars);
    const rotorD = source.rotorDiameterM ?? entry.rotorDiameterM ?? 120;
    const concave = concaveCorrectionMet(source.latLng, hubZAbs, rxLatLng, rxZAbs, hubZ, rxZ, dem);
    return evaluate_wtg_octave(
      lw, se, sn, hubZAbs, hubZ, re, rn, rxZAbs, rxZ, g, allBars,
      rotorD, concave, env.tC, env.rh, env.pKpa, env.barConv,
    );
  }
  const sourceZ = sourceHeightFor(entry) + (source.elevationOffset ?? 0); // HAG
  const sourceZAbs = groundSrc + sourceZ;                                 // absolute z
  const topoBars = topographyBarriers(
    project.settings?.topography, source.latLng,
    [se, sn, sourceZAbs], rxLatLng, [re, rn, rxZAbs], origin, dem,
  );
  const allBars = concatBarriers(barriersFlat, topoBars);
  return evaluate_general_octave(
    lw, se, sn, sourceZAbs, sourceZ, re, rn, rxZAbs, rxZ, g, allBars,
    env.tC, env.rh, env.pKpa, env.barConv, env.dzCap,
  );
}

/// Exact point-receiver solve. Every receiver sums every (in-cutoff) source
/// directly — no Barnes-Hut clustering (per-source contribution rows need real
/// source ids, and there are typically few named receivers). Replaces the old
/// snapshot + Taylor-extrapolation path: the solve is fast enough to re-run on
/// every settled source drag.
export async function evaluateProject(
  project: Project,
  dem: DemRaster | null,
): Promise<ReceiverResult[]> {
  await ensureSolverReady();

  const origin = project.calculationArea?.centerLatLng
    ?? project.receivers[0]?.latLng
    ?? project.sources[0]?.latLng
    ?? [0, 0];
  const barriersFlat = packBarriers(project.barriers, origin, dem);
  const aw = aWeights(project.scenario.bandSystem);
  const n = bandCount(project.scenario.bandSystem);
  const cutoffM = propagationSettings(project).maxContributionDistanceM;

  return project.receivers.map((rx) => {
    // Non-finite receiver coords (busted import / glitched group drag): show a
    // "—" row rather than feeding NaN into WASM (which poisons downstream sums).
    if (!Number.isFinite(rx.latLng[0]) || !Number.isFinite(rx.latLng[1])) {
      return { receiverId: rx.id, perBandLp: new Float64Array(n), totalDbA: -Infinity, perSource: [] };
    }
    const perSource: ReceiverResult['perSource'] = [];
    for (const src of project.sources) {
      if (!Number.isFinite(src.latLng[0]) || !Number.isFinite(src.latLng[1])) continue;
      if (cutoffM > 0 && approxDistanceM(rx.latLng, src.latLng) > cutoffM) continue;
      try {
        const raw = evaluatePair(src, rx.latLng, rx.heightAboveGroundM, project, barriersFlat, dem, origin);
        const perBandLp = new Float64Array(n);
        for (let i = 0; i < n; i++) perBandLp[i] = Number.isFinite(raw[i]) ? raw[i] : -Infinity;
        perSource.push({ sourceId: src.id, perBandLp });
      } catch (e) {
        console.warn(`eval pair ${src.id}|${rx.id} failed:`, e);
      }
    }
    const summed = energySumPerBand(perSource);
    return {
      receiverId: rx.id,
      perBandLp: summed,
      totalDbA: aWeightedTotal(summed, aw, projectDOmegaDb(project)),
      perSource,
    };
  });
}

// ============== Batched grid evaluation (S2) ==============

/// Per-source data packed for `GridEvaluator`: one row per source as
/// `[is_wtg, e, n, z_abs, hagl, rotor_d, lw_0 … lw_{nb-1}]`. Sources whose
/// catalog entry is missing are dropped (so the returned `eff`/`srcLocal`/
/// `srcZAbs` stay index-aligned with the evaluator's internal source order
/// and with `cellTopoPack`).
interface GridSourcePack {
  eff: EffectiveSource[];
  srcLocal: Array<[number, number]>;
  srcZAbs: number[];
  sourcesFlat: Float64Array;
  nBands: number;
}

function buildGridSourcePack(
  project: Project,
  dem: DemRaster | null,
  origin: [number, number],
  effRaw: EffectiveSource[],
): GridSourcePack {
  const nBands = bandCount(project.scenario.bandSystem);
  const stride = 6 + nBands;
  const eff: EffectiveSource[] = [];
  const rows: number[][] = [];
  const srcLocal: Array<[number, number]> = [];
  const srcZAbs: number[] = [];
  for (const es of effRaw) {
    let isWtg = false;
    let hagl: number;
    let rotorD = 120;
    let lw: Float64Array | null;
    if (es.kind === 'real') {
      const entry = lookupEntry(project, es.source!);
      if (!entry) continue; // missing catalog → drop (matches old `if (!meta) continue`)
      const modeName = es.source!.modeOverride ?? entry.defaultMode;
      lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
      isWtg = es.source!.kind === 'wtg';
      hagl = sourceHagl(es.source!, project) ?? 0;
      rotorD = es.source!.rotorDiameterM ?? entry.rotorDiameterM ?? 120;
    } else {
      lw = es.lwOverride!;
      hagl = es.zAboveGround ?? 1.5;
    }
    if (!lw) continue;
    const [se, sn] = latLngToLocalMetres(es.latLng, origin);
    const groundRaw = dem ? dem.elevation(es.latLng[0], es.latLng[1]) : 0;
    const ground = Number.isFinite(groundRaw) ? groundRaw : 0;
    const zAbs = ground + hagl;
    const row = new Array<number>(stride);
    row[0] = isWtg ? 1 : 0;
    row[1] = se; row[2] = sn; row[3] = zAbs; row[4] = hagl; row[5] = rotorD;
    for (let b = 0; b < nBands; b++) row[6 + b] = lw[b] ?? 0;
    eff.push(es);
    rows.push(row);
    srcLocal.push([se, sn]);
    srcZAbs.push(zAbs);
  }
  const sourcesFlat = new Float64Array(rows.length * stride);
  for (let i = 0; i < rows.length; i++) sourcesFlat.set(rows[i], i * stride);
  return { eff, srcLocal, srcZAbs, sourcesFlat, nBands };
}

/// Resolve a project into a serializable `GridJob` (catalog + per-source
/// geometry done here, on the main thread). The DEM is consumed for source
/// absolute-z only; cell-by-cell terrain is sampled later in `runBatchedGrid`.
function buildGridJob(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): GridJob {
  const ca = project.calculationArea;
  if (!ca) throw new Error('calculationArea not set; cannot compute grid');
  const origin = ca.centerLatLng;
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / cols;
  const dyM = ca.heightM / rows;
  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
  const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
  const bounds = {
    sw: [origin[0] - dLat, origin[1] - dLng] as [number, number],
    ne: [origin[0] + dLat, origin[1] + dLng] as [number, number],
  };
  const cfg = propagationSettings(project);
  const cutoffM = cfg.maxContributionDistanceM;
  const theta = cfg.treeAcceptanceTheta;

  // Adaptive per-tile clustering. The Barnes-Hut tree is built once; each
  // tile then decides its OWN clustering from the tile footprint (via
  // `walkSourceTreeForRegion`). Tiles far from a group of sources collapse it
  // to a single virtual source; tiles near it keep every source. (The old code
  // walked the tree once at the grid centre and reused that verdict for every
  // cell, so far cells never got to cluster — `θ` had no effect when the grid
  // sat on top of the sources.)
  const tree = buildSourceTree(project, project.scenario.bandSystem, project.scenario.windSpeed);
  const TILE = 16; // cells per tile edge
  const cellLat = (row: number) =>
    origin[0] + (((row - (rows - 1) / 2) * dyM) / R) * (180 / Math.PI);
  const cellLng = (col: number) =>
    origin[1] + (((col - (cols - 1) / 2) * dxM) / (R * Math.cos(lat0))) * (180 / Math.PI);
  const marginLat = ((dyM / 2) / R) * (180 / Math.PI);
  const marginLng = ((dxM / 2) / (R * Math.cos(lat0))) * (180 / Math.PI);

  const tiles: GridTile[] = [];
  for (let row0 = 0; row0 < rows; row0 += TILE) {
    const trows = Math.min(TILE, rows - row0);
    const latLo = cellLat(row0);
    const latHi = cellLat(row0 + trows - 1);
    for (let col0 = 0; col0 < cols; col0 += TILE) {
      const tcols = Math.min(TILE, cols - col0);
      const lngLo = cellLng(col0);
      const lngHi = cellLng(col0 + tcols - 1);
      const region = {
        minLat: Math.min(latLo, latHi) - marginLat,
        maxLat: Math.max(latLo, latHi) + marginLat,
        minLng: Math.min(lngLo, lngHi) - marginLng,
        maxLng: Math.max(lngLo, lngHi) + marginLng,
      };
      const tileEff = tree ? walkSourceTreeForRegion(tree, region, theta, cutoffM) : [];
      const pack = buildGridSourcePack(project, dem, origin, tileEff);
      tiles.push({
        col0, row0, cols: tcols, rows: trows,
        sourcesFlat: pack.sourcesFlat,
        srcLatLng: pack.eff.map((es) => es.latLng),
        srcIsReal: pack.eff.map((es) => es.kind === 'real'),
      });
    }
  }

  return {
    cols, rows, dxM, dyM, origin, bounds,
    nBands: bandCount(project.scenario.bandSystem),
    g: project.settings?.ground.defaultG ?? 0.5,
    cutoffM,
    dOmegaDb: projectDOmegaDb(project),
    env: solverEnv(project),
    rxHeightAboveGround,
    userBarriers: packBarriers(project.barriers, origin, dem),
    topo: project.settings?.topography,
    tiles,
  };
}

// ============== Compatibility: exact grid evaluation ==============

/// Compute the grid exactly without snapshotting. Batched primal path (S2):
/// one `GridEvaluator.eval_cell_dba` call per cell — all sources energy-summed
/// inside Rust — instead of one JS↔WASM call per (cell, source). This is the
/// default contour path (primal-only, no gradient tensor).
export async function evaluateGrid(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): Promise<GridResult> {
  await ensureSolverReady();
  return runBatchedGrid(buildGridJob(project, dem, spacingM, rxHeightAboveGround), dem);
}

// ============== Worker offload (S1) ==============

/// Run the contour grid in a Web Worker so the main thread stays responsive
/// (S1). The worker reconstructs the DEM from a transferable region snapshot
/// and runs the SAME `runBatchedGrid` core. Falls back to the synchronous path
/// on any worker error (unsupported environment, init failure, etc.) so the
/// grid always renders.
export async function evaluateGridViaWorker(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): Promise<GridResult> {
  await ensureSolverReady();
  const job = buildGridJob(project, dem, spacingM, rxHeightAboveGround);
  try {
    // The DEM region must cover the calc area AND every (real) source, because
    // ridge sampling walks the whole source→cell line. Expand the snapshot
    // bounds to the union of the calc-area rectangle and the source positions,
    // with a small margin, so the worker's region DEM never reads outside its
    // coverage (which would return 0 / sea level). Resolution is scaled to keep
    // roughly the source-tile density across the (possibly larger) extent.
    //
    // Cached by (DEM identity + region bounds + resolution): a recompute that
    // doesn't move geometry (e.g. wind speed / G / atmosphere change, or a
    // re-run of the same area) reuses the sampled terrain instead of
    // re-sampling ~10⁶ DEM points on the main thread each time.
    const region = dem ? captureDemRegionCached(dem, sourcePaddedBounds(job)) : null;
    return await runGridJobOnWorker(job, region);
  } catch (e) {
    console.warn('[BESSTY] grid worker unavailable, running inline:', e);
    return runBatchedGrid(job, dem);
  }
}

/// One-entry DEM-region cache. The region is structure-cloned (not transferred)
/// to the worker, so the cached copy stays valid across runs.
let demRegionCache: { key: string; region: DemRegion } | null = null;

function captureDemRegionCached(
  dem: DemRaster,
  bounds: [[number, number], [number, number], number, number],
): DemRegion {
  const [sw, ne, nx, ny] = bounds;
  const key = `${dem.bounds.sw}|${dem.bounds.ne}|${dem.tilesLoaded}|${sw}|${ne}|${nx}|${ny}`;
  if (demRegionCache && demRegionCache.key === key) return demRegionCache.region;
  const region = captureDemRegion(dem, sw, ne, nx, ny);
  demRegionCache = { key, region };
  return region;
}

/// SW/NE/nx/ny for a DEM region covering the grid bounds + all sources, sized
/// to ~30 m/sample and capped so the snapshot stays small.
function sourcePaddedBounds(job: GridJob): [[number, number], [number, number], number, number] {
  let minLat = Math.min(job.bounds.sw[0], job.bounds.ne[0]);
  let maxLat = Math.max(job.bounds.sw[0], job.bounds.ne[0]);
  let minLng = Math.min(job.bounds.sw[1], job.bounds.ne[1]);
  let maxLng = Math.max(job.bounds.sw[1], job.bounds.ne[1]);
  for (const tile of job.tiles) {
    for (let i = 0; i < tile.srcLatLng.length; i++) {
      if (!tile.srcIsReal[i]) continue; // clusters skip topo, so don't widen for them
      const [la, ln] = tile.srcLatLng[i];
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
    }
  }
  const mLat = (maxLat - minLat) * 0.05 + 0.002;
  const mLng = (maxLng - minLng) * 0.05 + 0.002;
  const sw: [number, number] = [minLat - mLat, minLng - mLng];
  const ne: [number, number] = [maxLat + mLat, maxLng + mLng];
  // ~111 km per degree latitude; target ≈ 30 m/sample, clamp to [128, 1024].
  const spanLatM = (ne[0] - sw[0]) * 111_000;
  const spanLngM = (ne[1] - sw[1]) * 111_000 * Math.cos((minLat * Math.PI) / 180);
  const ny = Math.max(128, Math.min(1024, Math.round(spanLatM / 30)));
  const nx = Math.max(128, Math.min(1024, Math.round(spanLngM / 30)));
  return [sw, ne, nx, ny];
}

/// Pool of one reusable grid worker. Created lazily; survives across grid runs.
let gridWorker: Worker | null = null;
let gridWorkerSeq = 0;

function getGridWorker(): Worker {
  if (!gridWorker) {
    gridWorker = new Worker(new URL('./grid.worker.ts', import.meta.url), { type: 'module' });
  }
  return gridWorker;
}

function runGridJobOnWorker(job: GridJob, region: DemRegion | null): Promise<GridResult> {
  const worker = getGridWorker();
  const id = ++gridWorkerSeq;
  return new Promise<GridResult>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('grid worker timed out'));
    }, 60000);
    const onMessage = (ev: MessageEvent) => {
      const data = ev.data as { id: number; ok: boolean; result?: GridResult; error?: string };
      if (data.id !== id) return;
      cleanup();
      if (data.ok && data.result) resolve(data.result);
      else reject(new Error(data.error ?? 'grid worker failed'));
    };
    // A worker module-load / runtime error fires 'error' (not a message).
    // Drop the worker so the next call rebuilds it, and reject fast so the
    // caller falls back to the inline path without waiting for the timeout.
    const onError = (e: ErrorEvent) => {
      cleanup();
      gridWorker = null;
      reject(new Error(`grid worker error: ${e.message || 'load failed'}`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    worker.postMessage({ id, job, region });
  });
}

export { octave_centres, octave_a_weighting };
