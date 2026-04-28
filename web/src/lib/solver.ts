// Wraps the Rust + WASM solver into a typed, project-shaped API.
//
// Two evaluation modes per output (point receivers and contour grid):
//
//   1. *Snapshot* — exact evaluation that ALSO returns ∂Lp/∂(src.{e,n,z})
//      per source-receiver pair via forward-mode dual numbers in the Rust
//      crate. Cached for fast extrapolation.
//
//   2. *Extrapolate* — given a cached snapshot, produce updated Lp values
//      by first-order Taylor: Lp_new = Lp + ∇Lp·Δsrc. No WASM call needed —
//      pure JS arithmetic over the cached gradients, fast enough to run on
//      every drag tick. Refresh the snapshot in the background once the
//      drag settles.

import init, {
  evaluate_general_octave,
  evaluate_wtg_octave,
  evaluate_general_with_grad_src_octave,
  evaluate_wtg_with_grad_src_octave,
  octave_a_weighting,
  octave_centres,
} from '../wasm/beesty_solver.js';

import type {
  Barrier,
  Source,
  Project,
} from './types';
import { lookupEntry, spectrumFor } from './catalog';
import type { DemRaster } from './dem';

/// Band count for the solver, given a scenario's band system.
/// Matches the Rust crate's `OCTAVE_CENTRES_HZ.len()` (10) and
/// `ONE_THIRD_OCTAVE_CENTRES_HZ.len()` (31).
export function bandCount(bs: 'octave' | 'oneThirdOctave'): number {
  return bs === 'oneThirdOctave' ? 31 : 10;
}
function packLen(bs: 'octave' | 'oneThirdOctave'): number {
  const n = bandCount(bs);
  return n + n * 3;
}

/// A-weighting offsets per IEC 61672-1 — separate tables for the two band
/// systems so we don't hand the wrong-length weights to a downstream sum.
const OCTAVE_AW = new Float64Array([-56.4, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1]);
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
  if (!initialized) initialized = init().then(() => undefined);
  return initialized;
}

export interface ReceiverResult {
  receiverId: string;
  perBandLp: Float64Array;
  totalDbA: number;
  perSource: Array<{ sourceId: string; perBandLp: Float64Array }>;
}

function packBarriers(barriers: Barrier[], originLatLng: [number, number]): Float64Array {
  const out: number[] = [];
  for (const b of barriers) {
    if (b.polylineLatLng.length < 2) continue;
    const [a, c] = b.polylineLatLng;
    const aXY = latLngToLocalMetres(a, originLatLng);
    const cXY = latLngToLocalMetres(c, originLatLng);
    const topZ = b.topHeightsM[0] ?? 0;
    out.push(aXY[0], aXY[1], cXY[0], cXY[1], topZ);
  }
  return new Float64Array(out);
}

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

/// Compute per-band Lp + per-source-axis gradient at one source-receiver
/// pair, returning a length-32 Float64Array shaped:
///   [0..8]  : per-band Lp
///   [8..32] : per-band gradient — 3 axes (e, n, z) per band
///
/// Returns the absolute source xyz used in the snapshot (caller stores it
/// to compute Δ during extrapolation).
/// Source absolute Z under the project's DEM. Hub height for WTG, base + 1.5 m
/// for everything else. Returns null if the catalog entry is missing.
function sourceAbsZ(
  source: Source,
  project: Project,
  dem: DemRaster | null,
): number | null {
  const groundSrc = dem ? dem.elevation(source.latLng[0], source.latLng[1]) : 0;
  if (source.kind === 'wtg') {
    const entry = lookupEntry(project, source);
    const hubHeight = source.hubHeight ?? entry?.hubHeights?.[0] ?? 100;
    return groundSrc + hubHeight;
  }
  return groundSrc + (source.elevationOffset ?? 0) + 1.5;
}

function snapshotPair(
  source: Source,
  rxLatLng: [number, number],
  rxHeightAboveGround: number,
  project: Project,
  barriersFlat: Float64Array,
  dem: DemRaster | null,
  origin: [number, number],
): { snapshot: Float64Array; srcAbsXyz: [number, number, number] } {
  const [se, sn] = latLngToLocalMetres(source.latLng, origin);
  const [re, rn] = latLngToLocalMetres(rxLatLng, origin);
  const g = project.settings?.ground.defaultG ?? 0.5;
  const groundSrc = dem ? dem.elevation(source.latLng[0], source.latLng[1]) : 0;
  const groundRx = dem ? dem.elevation(rxLatLng[0], rxLatLng[1]) : 0;
  const rxZ = groundRx + rxHeightAboveGround;

  const entry = lookupEntry(project, source);
  if (!entry) {
    throw new Error(`Catalog entry not found: ${source.catalogScope}/${source.modelId}`);
  }
  const modeName = source.modeOverride ?? entry.defaultMode;
  const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);

  if (source.kind === 'wtg') {
    const hubHeight = source.hubHeight ?? entry.hubHeights?.[0] ?? 100;
    const hubZ = groundSrc + hubHeight;
    const snap = evaluate_wtg_with_grad_src_octave(
      lw, se, sn, hubZ, re, rn, rxZ, g, barriersFlat,
      entry.rotorDiameterM ?? 120, false,
    );
    return { snapshot: snap, srcAbsXyz: [se, sn, hubZ] };
  }
  const sourceZ = groundSrc + (source.elevationOffset ?? 0) + 1.5;
  const snap = evaluate_general_with_grad_src_octave(
    lw, se, sn, sourceZ, re, rn, rxZ, g, barriersFlat,
  );
  return { snapshot: snap, srcAbsXyz: [se, sn, sourceZ] };
}

/// Linear Taylor extrapolation with a per-band clamp. Returns the new Lp
/// values plus a `stale` flag set when any band's predicted change exceeded
/// `capPerBandDb` — the orchestrator should schedule an exact re-snapshot
/// for the affected pair before the displayed value drifts further.
function extrapolateLpClamped(
  snapshot: Float64Array,
  srcAbsAtSnapshot: [number, number, number],
  srcAbsNow: [number, number, number],
  capPerBandDb: number,
): { lp: Float64Array; stale: boolean } {
  const dx = srcAbsNow[0] - srcAbsAtSnapshot[0];
  const dy = srcAbsNow[1] - srcAbsAtSnapshot[1];
  const dz = srcAbsNow[2] - srcAbsAtSnapshot[2];
  // Pack layout is `n primal + n × 3 gradient`, so `snapshot.length = n + 3n = 4n`.
  const n = snapshot.length / 4;
  const out = new Float64Array(n);
  let stale = false;
  for (let band = 0; band < n; band++) {
    const gIdx = n + band * 3;
    const baseline = snapshot[band];
    const predicted = baseline
      + snapshot[gIdx] * dx
      + snapshot[gIdx + 1] * dy
      + snapshot[gIdx + 2] * dz;
    const delta = predicted - baseline;
    if (Math.abs(delta) > capPerBandDb) {
      out[band] = baseline + Math.sign(delta) * capPerBandDb;
      stale = true;
    } else {
      out[band] = predicted;
    }
  }
  return { lp: out, stale };
}

function aWeightedTotal(perBandLp: Float64Array, aw: Float64Array): number {
  let aSum = 0;
  const n = Math.min(perBandLp.length, aw.length);
  for (let i = 0; i < n; i++) {
    if (isFinite(perBandLp[i])) aSum += Math.pow(10, (perBandLp[i] + aw[i]) / 10);
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

// ============== Receiver-point snapshot + extrapolation ==============

export interface PointSnapshot {
  /// `${sourceId}|${rxId}` → snapshot data for that pair.
  pairs: Map<string, { snapshot: Float64Array; srcAbsXyz: [number, number, number] }>;
  /// Source absolute positions at snapshot time, by id.
  srcAbsAtSnapshot: Map<string, [number, number, number]>;
  origin: [number, number];
  barriersFlat: Float64Array;
  dem: DemRaster | null;
  rxAbsAtSnapshot: Map<string, [number, number, number]>;
}

/// Exact evaluation that also captures ∂Lp/∂src for fast Taylor extrapolation
/// on subsequent source moves. Use this on initial load and when re-snapping
/// after a drag settles.
export async function snapshotProject(
  project: Project,
  dem: DemRaster | null,
): Promise<{ results: ReceiverResult[]; snapshot: PointSnapshot }> {
  await ensureSolverReady();

  const origin = project.calculationArea?.centerLatLng
    ?? project.receivers[0]?.latLng
    ?? project.sources[0]?.latLng
    ?? [0, 0];
  const barriersFlat = packBarriers(project.barriers, origin);
  const aw = aWeights(project.scenario.bandSystem);

  const pairs = new Map<string, { snapshot: Float64Array; srcAbsXyz: [number, number, number] }>();
  const srcAbsAtSnapshot = new Map<string, [number, number, number]>();
  const rxAbsAtSnapshot = new Map<string, [number, number, number]>();

  const results: ReceiverResult[] = project.receivers.map((rx) => {
    const [re, rn] = latLngToLocalMetres(rx.latLng, origin);
    const rxGround = dem ? dem.elevation(rx.latLng[0], rx.latLng[1]) : 0;
    rxAbsAtSnapshot.set(rx.id, [re, rn, rxGround + rx.heightAboveGroundM]);

    const perSource: ReceiverResult['perSource'] = [];
    for (const src of project.sources) {
      const { snapshot, srcAbsXyz } = snapshotPair(
        src, rx.latLng, rx.heightAboveGroundM, project, barriersFlat, dem, origin,
      );
      pairs.set(`${src.id}|${rx.id}`, { snapshot, srcAbsXyz });
      srcAbsAtSnapshot.set(src.id, srcAbsXyz);
      const n = bandCount(project.scenario.bandSystem);
      const perBandLp = new Float64Array(n);
      for (let i = 0; i < n; i++) perBandLp[i] = snapshot[i];
      perSource.push({ sourceId: src.id, perBandLp });
    }

    const summed = energySumPerBand(perSource);
    return { receiverId: rx.id, perBandLp: summed, totalDbA: aWeightedTotal(summed, aw), perSource };
  });

  return {
    results,
    snapshot: { pairs, srcAbsAtSnapshot, origin, barriersFlat, dem, rxAbsAtSnapshot },
  };
}

/// Apply Taylor extrapolation to obtain receiver results from the cached
/// snapshot under the project's current (possibly moved) source positions.
/// Returns a `stale` flag if any per-band or per-receiver-total change
/// exceeded the configured caps — the orchestrator should re-snapshot.
export function extrapolateProject(
  project: Project,
  snapshot: PointSnapshot,
): { results: ReceiverResult[]; stale: boolean } {
  const aw = aWeights(project.scenario.bandSystem);
  const origin = snapshot.origin;
  const capPerBand = project.settings?.extrapolation?.capPerBandDb ?? 6;
  const capTotal = project.settings?.extrapolation?.capTotalDbA ?? 3;

  const dem = snapshot.dem;
  const srcAbsNow = new Map<string, [number, number, number]>();
  for (const s of project.sources) {
    const [se, sn] = latLngToLocalMetres(s.latLng, origin);
    const z = sourceAbsZ(s, project, dem) ?? 0;
    srcAbsNow.set(s.id, [se, sn, z]);
  }

  let stale = false;

  const results = project.receivers.map((rx) => {
    const perSource: ReceiverResult['perSource'] = [];
    let totalSnapshotEnergy = 0;
    for (const src of project.sources) {
      const cached = snapshot.pairs.get(`${src.id}|${rx.id}`);
      const here = srcAbsNow.get(src.id);
      if (!cached || !here) continue;
      const { lp, stale: pairStale } = extrapolateLpClamped(
        cached.snapshot, cached.srcAbsXyz, here, capPerBand,
      );
      if (pairStale) stale = true;
      perSource.push({ sourceId: src.id, perBandLp: lp });
      const nb = bandCount(project.scenario.bandSystem);
      for (let i = 0; i < nb; i++) {
        totalSnapshotEnergy += Math.pow(10, (cached.snapshot[i] + aw[i]) / 10);
      }
    }
    if (perSource.length === 0) {
      return { receiverId: rx.id, perBandLp: new Float64Array(bandCount(project.scenario.bandSystem)), totalDbA: -Infinity, perSource };
    }
    const summed = energySumPerBand(perSource);
    const total = aWeightedTotal(summed, aw);
    const snapshotTotal = totalSnapshotEnergy > 0 ? 10 * Math.log10(totalSnapshotEnergy) : -Infinity;
    if (isFinite(total) && isFinite(snapshotTotal) && Math.abs(total - snapshotTotal) > capTotal) {
      stale = true;
    }
    return { receiverId: rx.id, perBandLp: summed, totalDbA: total, perSource };
  });

  return { results, stale };
}

/// Compatibility wrapper — kept for any callers that just want results
/// without managing a snapshot. Internally still does a full snapshot.
export async function evaluateProject(
  project: Project,
  dem: DemRaster | null,
): Promise<ReceiverResult[]> {
  return (await snapshotProject(project, dem)).results;
}

// ============== Grid snapshot + extrapolation ==============

export interface GridResult {
  cols: number;
  rows: number;
  bounds: { sw: [number, number]; ne: [number, number] };
  dbA: Float32Array;
  computedMs: number;
}

export interface GridSnapshot {
  cols: number;
  rows: number;
  bounds: { sw: [number, number]; ne: [number, number] };
  /// Source absolute positions at snapshot time, ordered by sourceIds.
  sourceIds: string[];
  srcAbsAtSnapshot: Float32Array;       // length sources × 3
  /// Per (cell, source): 8 Lp values + 24 gradients (8 bands × 3 axes).
  /// Layout: cellIdx · sources · 32 + sourceIdx · 32 + (band|grad slot)
  cells: Float32Array;
  /// Per-cell precomputed origin-frame coords.
  cellEnZ: Float32Array;                // cellIdx · 3 (e, n, z including DEM)
  computedMs: number;
}

/// Exact grid evaluation that also captures per-cell-per-source gradients.
export async function snapshotGrid(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): Promise<GridSnapshot> {
  await ensureSolverReady();
  const t0 = performance.now();

  const ca = project.calculationArea;
  if (!ca) throw new Error('calculationArea not set; cannot compute grid');

  const origin = ca.centerLatLng;
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / (cols - 1);
  const dyM = ca.heightM / (rows - 1);

  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
  const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
  const sw: [number, number] = [origin[0] - dLat, origin[1] - dLng];
  const ne: [number, number] = [origin[0] + dLat, origin[1] + dLng];

  const barriersFlat = packBarriers(project.barriers, origin);
  const g = project.settings?.ground.defaultG ?? 0.5;

  const sources = project.sources;
  const sourceIds = sources.map((s) => s.id);
  const srcAbsAtSnapshot = new Float32Array(sources.length * 3);
  const srcLocal: Array<[number, number]> = sources.map((s) => latLngToLocalMetres(s.latLng, origin));
  const srcZ = sources.map((s) => sourceAbsZ(s, project, dem) ?? 0);
  for (let i = 0; i < sources.length; i++) {
    srcAbsAtSnapshot[i * 3] = srcLocal[i][0];
    srcAbsAtSnapshot[i * 3 + 1] = srcLocal[i][1];
    srcAbsAtSnapshot[i * 3 + 2] = srcZ[i];
  }

  const cellCount = cols * rows;
  const PACK = packLen(project.scenario.bandSystem);
  const cells = new Float32Array(cellCount * sources.length * PACK);
  const cellEnZ = new Float32Array(cellCount * 3);

  for (let row = 0; row < rows; row++) {
    const n = (row - (rows - 1) / 2) * dyM;
    const lat = origin[0] + (n / R) * (180 / Math.PI);
    for (let col = 0; col < cols; col++) {
      const cellIdx = row * cols + col;
      const e = (col - (cols - 1) / 2) * dxM;
      const lng = origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI);
      const groundZ = dem ? dem.elevation(lat, lng) : 0;
      const rxZ = groundZ + rxHeightAboveGround;
      cellEnZ[cellIdx * 3] = e;
      cellEnZ[cellIdx * 3 + 1] = n;
      cellEnZ[cellIdx * 3 + 2] = rxZ;

      for (let si = 0; si < sources.length; si++) {
        const src = sources[si];
        const [se, sn] = srcLocal[si];
        const entry = lookupEntry(project, src);
        if (!entry) continue;
        const modeName = src.modeOverride ?? entry.defaultMode;
        const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
        const snap = src.kind === 'wtg'
          ? evaluate_wtg_with_grad_src_octave(
              lw, se, sn, srcZ[si], e, n, rxZ, g, barriersFlat,
              entry.rotorDiameterM ?? 120, false,
            )
          : evaluate_general_with_grad_src_octave(
              lw, se, sn, srcZ[si], e, n, rxZ, g, barriersFlat,
            );
        const base = (cellIdx * sources.length + si) * PACK;
        for (let k = 0; k < PACK; k++) cells[base + k] = snap[k];
      }
    }
  }

  return {
    cols, rows, bounds: { sw, ne },
    sourceIds, srcAbsAtSnapshot, cells, cellEnZ,
    computedMs: performance.now() - t0,
  };
}

/// Build a fresh GridResult by Taylor-extrapolating the cached snapshot
/// against the current source positions. Returns a `stale` flag if the
/// extrapolated dB(A) at any cell drifted past the configured cap from the
/// snapshot baseline — same semantics as `extrapolateProject`.
export function extrapolateGrid(
  project: Project,
  snapshot: GridSnapshot,
  dem: DemRaster | null,
): { grid: GridResult; stale: boolean } {
  const t0 = performance.now();
  const aw = aWeights(project.scenario.bandSystem);
  const cols = snapshot.cols;
  const rows = snapshot.rows;
  const cellCount = cols * rows;
  const dbA = new Float32Array(cellCount);
  const capPerBand = project.settings?.extrapolation?.capPerBandDb ?? 6;
  const capTotal = project.settings?.extrapolation?.capTotalDbA ?? 3;
  let stale = false;

  const ca = project.calculationArea!;
  const origin = ca.centerLatLng;
  const sources = project.sources;
  const srcSlotById = new Map<string, number>();
  for (let i = 0; i < snapshot.sourceIds.length; i++) {
    srcSlotById.set(snapshot.sourceIds[i], i);
  }
  const srcDelta = new Float32Array(sources.length * 3);
  const srcSlot = new Int32Array(sources.length);
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const slot = srcSlotById.get(s.id) ?? -1;
    srcSlot[i] = slot;
    if (slot < 0) continue;
    const [se, sn] = latLngToLocalMetres(s.latLng, origin);
    const z = sourceAbsZ(s, project, dem) ?? 0;
    srcDelta[i * 3] = se - snapshot.srcAbsAtSnapshot[slot * 3];
    srcDelta[i * 3 + 1] = sn - snapshot.srcAbsAtSnapshot[slot * 3 + 1];
    srcDelta[i * 3 + 2] = z - snapshot.srcAbsAtSnapshot[slot * 3 + 2];
  }

  const sourcesInSnap = snapshot.sourceIds.length;
  const PACK = packLen(project.scenario.bandSystem);
  const NB = bandCount(project.scenario.bandSystem);
  for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
    let aSum = 0;
    let aSumBaseline = 0;
    for (let i = 0; i < sources.length; i++) {
      const slot = srcSlot[i];
      if (slot < 0) continue;
      const base = (cellIdx * sourcesInSnap + slot) * PACK;
      const dx = srcDelta[i * 3];
      const dy = srcDelta[i * 3 + 1];
      const dz = srcDelta[i * 3 + 2];
      for (let band = 0; band < NB; band++) {
        const gIdx = base + NB + band * 3;
        const baseline = snapshot.cells[base + band];
        const predicted = baseline
          + snapshot.cells[gIdx] * dx
          + snapshot.cells[gIdx + 1] * dy
          + snapshot.cells[gIdx + 2] * dz;
        const delta = predicted - baseline;
        let lp: number;
        if (Math.abs(delta) > capPerBand) {
          lp = baseline + Math.sign(delta) * capPerBand;
          stale = true;
        } else {
          lp = predicted;
        }
        aSum += Math.pow(10, (lp + aw[band]) / 10);
        aSumBaseline += Math.pow(10, (baseline + aw[band]) / 10);
      }
    }
    const totalNew = aSum > 0 ? 10 * Math.log10(aSum) : -120;
    const totalBaseline = aSumBaseline > 0 ? 10 * Math.log10(aSumBaseline) : -120;
    if (Math.abs(totalNew - totalBaseline) > capTotal) stale = true;
    dbA[cellIdx] = totalNew;
  }

  return {
    grid: {
      cols: snapshot.cols, rows: snapshot.rows, bounds: snapshot.bounds,
      dbA, computedMs: performance.now() - t0,
    },
    stale,
  };
}

// ============== Compatibility: exact grid evaluation ==============

/// Compute the grid exactly without snapshotting (legacy path; prefer
/// `snapshotGrid()` if you'll subsequently want to extrapolate).
export async function evaluateGrid(
  project: Project,
  dem: DemRaster | null,
  spacingM: number,
  rxHeightAboveGround: number,
): Promise<GridResult> {
  await ensureSolverReady();
  const t0 = performance.now();

  const ca = project.calculationArea;
  if (!ca) throw new Error('calculationArea not set; cannot compute grid');

  const origin = ca.centerLatLng;
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / (cols - 1);
  const dyM = ca.heightM / (rows - 1);

  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
  const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
  const sw: [number, number] = [origin[0] - dLat, origin[1] - dLng];
  const ne: [number, number] = [origin[0] + dLat, origin[1] + dLng];

  const barriersFlat = packBarriers(project.barriers, origin);
  const aw = aWeights(project.scenario.bandSystem);
  const srcLocal = project.sources.map((s) => latLngToLocalMetres(s.latLng, origin));

  const dbA = new Float32Array(cols * rows);

  for (let row = 0; row < rows; row++) {
    const n = (row - (rows - 1) / 2) * dyM;
    const lat = origin[0] + (n / R) * (180 / Math.PI);
    for (let col = 0; col < cols; col++) {
      const e = (col - (cols - 1) / 2) * dxM;
      const lng = origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI);
      const groundZ = dem ? dem.elevation(lat, lng) : 0;
      const rxZ = groundZ + rxHeightAboveGround;

      let aSum = 0;
      const g = project.settings?.ground.defaultG ?? 0.5;
      for (let si = 0; si < project.sources.length; si++) {
        const src = project.sources[si];
        const [se, sn] = srcLocal[si];
        const entry = lookupEntry(project, src);
        if (!entry) continue;
        const modeName = src.modeOverride ?? entry.defaultMode;
        const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
        const srcZ = sourceAbsZ(src, project, dem) ?? 0;
        const lp = src.kind === 'wtg'
          ? evaluate_wtg_octave(lw, se, sn, srcZ, e, n, rxZ, g, barriersFlat, entry.rotorDiameterM ?? 120, false)
          : evaluate_general_octave(lw, se, sn, srcZ, e, n, rxZ, g, barriersFlat);
        for (let i = 0; i < lp.length; i++) aSum += Math.pow(10, (lp[i] + aw[i]) / 10);
      }
      dbA[row * cols + col] = aSum > 0 ? 10 * Math.log10(aSum) : -120;
    }
  }

  return { cols, rows, bounds: { sw, ne }, dbA, computedMs: performance.now() - t0 };
}

export { octave_centres, octave_a_weighting };
