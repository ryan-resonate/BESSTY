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
import { lookupEntry, sourceHeightFor, spectrumFor } from './catalog';
import { type DemRaster, type DemRegion, captureDemRegion } from './dem';
import {
  concatBarriers,
  effectiveSourcesFor,
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
function packLen(bs: 'octave' | 'oneThirdOctave'): number {
  const n = bandCount(bs);
  return n + n * 3;
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

/// Source **absolute** z = local ground elevation (from the DEM) + HAG. This is
/// what divergence + barrier geometry consume, and what the source-position
/// gradient is taken w.r.t. (so the Taylor delta during a drag is in the
/// absolute frame). Without a DEM, ground is 0 → abs z = HAG. See A1 in
/// `docs/solver-review-2026-06.md`.
function sourceAbsZ(source: Source, project: Project, dem: DemRaster | null): number | null {
  const h = sourceHagl(source, project);
  if (h == null) return null;
  const ground = dem ? dem.elevation(source.latLng[0], source.latLng[1]) : 0;
  return (Number.isFinite(ground) ? ground : 0) + h;
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
  // Solver z convention (A1 fix): the engine takes BOTH an absolute z and a
  // height-above-ground (HAG) for source and receiver. Absolute z (= DEM
  // ground elevation + HAG) drives divergence + barrier diffraction geometry,
  // which must share a datum with the (absolute) barrier tops. HAG drives the
  // Table-3 ground shape functions. Conflating the two — the previous
  // "pass HAG as the only z" workaround — made Adiv drop the source↔receiver
  // ground-elevation difference and put barrier geometry in a mixed datum
  // (barriers looked ~ground-elevation metres too tall). See
  // `docs/solver-review-2026-06.md` A1/A2.
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
    // sourceHeightFor() centralises the WTG fallback chain
    // (sourceHeightM > hubHeights[0] > 100 m) so the catalog's
    // library default is honoured.
    const hubHeight = source.hubHeight ?? sourceHeightFor(entry);
    const hubZ = hubHeight;              // hub HAG
    const hubZAbs = groundSrc + hubZ;    // hub absolute z
    // Topography barriers use ABSOLUTE z (the DEM ridge profile is sampled in
    // the absolute frame, now consistent with the source/receiver z below).
    const topoBars = topographyBarriers(
      project.settings?.topography, source.latLng,
      [se, sn, hubZAbs],
      rxLatLng, [re, rn, rxZAbs], origin, dem,
    );
    const allBars = concatBarriers(barriersFlat, topoBars);
    const rotorD = source.rotorDiameterM ?? entry.rotorDiameterM ?? 120;
    // Annex D.5 concave-ground criterion (A3), evaluated from the DEM along
    // this hub→receiver path.
    const concave = concaveCorrectionMet(source.latLng, hubZAbs, rxLatLng, rxZAbs, hubZ, rxZ, dem);
    const snap = evaluate_wtg_with_grad_src_octave(
      lw, se, sn, hubZAbs, hubZ, re, rn, rxZAbs, rxZ, g, allBars,
      rotorD, concave,
      env.tC, env.rh, env.pKpa, env.barConv,
    );
    // srcAbsXyz is the ABSOLUTE source position — the gradient is taken w.r.t.
    // it, so extrapolation deltas must be in the same frame.
    return { snapshot: snap, srcAbsXyz: [se, sn, hubZAbs] };
  }
  // BESS / Aux: library-defined source height (sourceHeightM) plus
  // the per-source elevation delta. Falls back to the kind default
  // (1.5 m) when the catalog entry doesn't pin a sourceHeightM, so
  // older projects + seed catalog entries keep their existing
  // numbers.
  const sourceZ = sourceHeightFor(entry) + (source.elevationOffset ?? 0); // HAG
  const sourceZAbs = groundSrc + sourceZ;                                 // absolute z
  // Topography barriers consume absolute z (DEM-aware ridge sampling).
  const topoBars = topographyBarriers(
    project.settings?.topography, source.latLng,
    [se, sn, sourceZAbs],
    rxLatLng, [re, rn, rxZAbs], origin, dem,
  );
  const allBars = concatBarriers(barriersFlat, topoBars);
  const snap = evaluate_general_with_grad_src_octave(
    lw, se, sn, sourceZAbs, sourceZ, re, rn, rxZAbs, rxZ, g, allBars,
    env.tC, env.rh, env.pKpa, env.barConv, env.dzCap,
  );
  return { snapshot: snap, srcAbsXyz: [se, sn, sourceZAbs] };
}

/// Snapshot for a synthetic cluster (an EffectiveSource of kind 'cluster').
// Note: snapshotClusterPair was removed when the receiver path stopped
// using Barnes-Hut clustering. Clusters now only appear in the grid
// snapshot path, which builds + evaluates them inline (see snapshotGrid).

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
  const barriersFlat = packBarriers(project.barriers, origin, dem);
  const aw = aWeights(project.scenario.bandSystem);

  const pairs = new Map<string, { snapshot: Float64Array; srcAbsXyz: [number, number, number] }>();
  const srcAbsAtSnapshot = new Map<string, [number, number, number]>();
  const rxAbsAtSnapshot = new Map<string, [number, number, number]>();

  const n = bandCount(project.scenario.bandSystem);
  // Point receivers always solve every source directly — no Barnes-Hut
  // clustering. Per-source contribution rows in the receiver export need
  // real source IDs (not "cluster-N" aggregates), and there are typically
  // few enough named receivers (~5–500) that the O(R × S) cost is fine.
  // Distance cutoff + topography barriers still apply via snapshotPair.
  // The Barnes-Hut tree only kicks in for the dense grid path below.
  const cutoffM = propagationSettings(project).maxContributionDistanceM;
  const results: ReceiverResult[] = project.receivers.map((rx) => {
    // Skip receivers whose coords are non-finite (busted import / glitched
    // group drag). They still appear in the receiver list with a "—"
    // result, but we don't try to call into WASM with NaN inputs because
    // that returns NaN per band and corrupts downstream sums.
    if (!Number.isFinite(rx.latLng[0]) || !Number.isFinite(rx.latLng[1])) {
      return { receiverId: rx.id, perBandLp: new Float64Array(n), totalDbA: -Infinity, perSource: [] };
    }
    const [re, rn] = latLngToLocalMetres(rx.latLng, origin);
    const rxGround = dem ? dem.elevation(rx.latLng[0], rx.latLng[1]) : 0;
    rxAbsAtSnapshot.set(rx.id, [re, rn, rxGround + rx.heightAboveGroundM]);

    const perSource: ReceiverResult['perSource'] = [];
    for (const src of project.sources) {
      if (!Number.isFinite(src.latLng[0]) || !Number.isFinite(src.latLng[1])) continue;
      // Distance cutoff: skip sources that are over the project's max
      // contribution distance from this receiver.
      if (cutoffM > 0) {
        const d = approxDistanceM(rx.latLng, src.latLng);
        if (d > cutoffM) continue;
      }
      try {
        const { snapshot, srcAbsXyz } = snapshotPair(
          src, rx.latLng, rx.heightAboveGroundM, project, barriersFlat, dem, origin,
        );
        pairs.set(`${src.id}|${rx.id}`, { snapshot, srcAbsXyz });
        srcAbsAtSnapshot.set(src.id, srcAbsXyz);
        const perBandLp = new Float64Array(n);
        for (let i = 0; i < n; i++) perBandLp[i] = Number.isFinite(snapshot[i]) ? snapshot[i] : -Infinity;
        perSource.push({ sourceId: src.id, perBandLp });
      } catch (e) {
        console.warn(`snapshot pair ${src.id}|${rx.id} failed:`, e);
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

  const nb = bandCount(project.scenario.bandSystem);
  const results = project.receivers.map((rx) => {
    const perSource: ReceiverResult['perSource'] = [];
    let totalSnapshotEnergy = 0;
    // Walk every cached pair for this receiver — both real-source pairs
    // (extrapolated against current source position) AND cluster pairs
    // (frozen at snapshot value, since clusters have no individual
    // gradient to follow).
    for (const [pairKey, cached] of snapshot.pairs) {
      const sep = pairKey.indexOf('|');
      if (sep < 0) continue;
      const sourceKey = pairKey.slice(0, sep);
      const rxKey = pairKey.slice(sep + 1);
      if (rxKey !== rx.id) continue;
      const here = srcAbsNow.get(sourceKey);
      let lp: Float64Array;
      if (here) {
        // Real source — extrapolate against current position.
        const r = extrapolateLpClamped(cached.snapshot, cached.srcAbsXyz, here, capPerBand);
        lp = r.lp;
        if (r.stale) stale = true;
      } else {
        // Cluster (or source no longer in project) — use snapshot values
        // verbatim.
        lp = new Float64Array(nb);
        for (let i = 0; i < nb; i++) lp[i] = cached.snapshot[i];
      }
      perSource.push({ sourceId: sourceKey, perBandLp: lp });
      for (let i = 0; i < nb; i++) {
        totalSnapshotEnergy += Math.pow(10, (cached.snapshot[i] + aw[i] + (projectDOmegaDb(project))) / 10);
      }
    }
    if (perSource.length === 0) {
      return { receiverId: rx.id, perBandLp: new Float64Array(nb), totalDbA: -Infinity, perSource };
    }
    const summed = energySumPerBand(perSource);
    const total = aWeightedTotal(summed, aw, projectDOmegaDb(project));
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
// (GridResult is defined in ./gridCore and re-exported above.)

export interface GridSnapshot {
  cols: number;
  rows: number;
  bounds: { sw: [number, number]; ne: [number, number] };
  /// Effective-source ids in slot order: a mix of real source ids and
  /// `cluster-…` synthetic ids. Used by `extrapolateGrid` to decide which
  /// slots track current source positions vs. stay frozen.
  sourceIds: string[];
  /// True for slots backed by a real Source, false for clusters. Frozen
  /// slots skip the per-source-position delta math during extrapolation.
  realSourceFlags: Uint8Array;
  srcAbsAtSnapshot: Float32Array;       // length sources × 3
  /// Per (cell, source): n Lp values + 3n gradients (n bands × 3 axes).
  /// Layout: cellIdx · sources · packLen + sourceIdx · packLen + (band|grad slot)
  cells: Float32Array;
  /// Per-cell precomputed origin-frame coords.
  cellEnZ: Float32Array;                // cellIdx · 3 (e, n, z including DEM)
  computedMs: number;
}

/// Build the per-grid effective source list (cutoff + clustering applied
/// once at the grid centre). The list mixes real Sources and synthetic
/// clusters; clusters are immobile and don't track source moves.
function effectiveSourcesForGrid(
  project: Project,
  ca: NonNullable<Project['calculationArea']>,
): EffectiveSource[] {
  // Synthesise a "centre receiver" — used purely as the reference point for
  // cutoff + cluster decisions. Real per-cell distance varies, but for a
  // typical 5–10 km grid the difference is small relative to the cluster
  // distance (1.5 km default). Bumping the cutoff by half the grid diagonal
  // captures sources that contribute to a far corner.
  const radius = Math.sqrt(ca.widthM * ca.widthM + ca.heightM * ca.heightM) / 2;
  const cfg = propagationSettings(project);
  // Clone settings with cutoff widened so corner cells aren't accidentally
  // starved of sources at the edge of the cutoff sphere.
  const widened: Project = {
    ...project,
    settings: {
      ...project.settings!,
      propagation: {
        ...cfg,
        maxContributionDistanceM: cfg.maxContributionDistanceM > 0
          ? cfg.maxContributionDistanceM + radius
          : 0,
      },
    },
  };
  const proxy = {
    id: '__grid_centre__',
    name: '__grid_centre__',
    latLng: ca.centerLatLng,
    heightAboveGroundM: project.settings?.general.defaultReceiverHeight ?? 1.5,
    limitDayDbA: 0, limitEveningDbA: 0, limitNightDbA: 0,
  };
  return effectiveSourcesFor(
    widened, proxy, project.scenario.bandSystem, project.scenario.windSpeed,
  );
}

/// Memory estimate for a hypothetical grid snapshot, in bytes. Lets the
/// caller decide whether to use the full `snapshotGrid` (with gradients
/// for fast drag extrapolation) or the lightweight `evaluateGrid` (no
/// gradients, smaller memory). The biggest single allocation is the
/// gradient cells buffer — `cellCount × effective_sources × PACK × 4`.
export function estimateGridMemoryBytes(
  project: Project,
  spacingM: number,
): { snapshotBytes: number; evalBytes: number; cells: number; effectiveSources: number } {
  const ca = project.calculationArea;
  if (!ca) return { snapshotBytes: 0, evalBytes: 0, cells: 0, effectiveSources: 0 };
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const cellCount = cols * rows;
  const eff = effectiveSourcesForGrid(project, ca);
  const PACK = packLen(project.scenario.bandSystem);
  return {
    snapshotBytes: cellCount * eff.length * PACK * 4,
    // Eval-only mode keeps just one Float32 per cell (the summed dB(A)).
    // The cellEnZ helper buffer adds ~12 B/cell — still negligible.
    evalBytes: cellCount * 4 + cellCount * 12,
    cells: cellCount,
    effectiveSources: eff.length,
  };
}

/// Soft budget for the gradient-pack snapshot. Above this, callers should
/// fall back to `evaluateGrid` (eval-only) — the grid still renders, but
/// drag-time extrapolation degrades to "drop the marker, recompute the
/// grid". Picked at 600 MB to leave headroom for the rest of the heap.
export const GRID_SNAPSHOT_BUDGET_BYTES = 600 * 1024 * 1024;

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
  // Cell-centred sampling: `cols` cells of width `ca.widthM / cols`, with
  // the cell-centre formula `(col - (cols-1)/2) * dxM` placing cell 0
  // half-a-pixel inside the SW corner and cell (cols-1) half-a-pixel
  // inside the NE corner. The overall bounds [sw, ne] still enclose the
  // calc-area rectangle exactly. This matches the convention used by the
  // GeoTIFF exporter (RasterPixelIsArea) and how Leaflet positions
  // canvas pixels inside `imageOverlay` bounds — without it, the rendered
  // raster and contours sat half-a-pixel NE of the actual data because
  // the corner-sampled values were being treated as centre-sampled by
  // every downstream consumer.
  const cols = Math.max(2, Math.round(ca.widthM / spacingM));
  const rows = Math.max(2, Math.round(ca.heightM / spacingM));
  const dxM = ca.widthM / cols;
  const dyM = ca.heightM / rows;

  const R = 6371008.8;
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
  const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
  const sw: [number, number] = [origin[0] - dLat, origin[1] - dLng];
  const ne: [number, number] = [origin[0] + dLat, origin[1] + dLng];

  const userBarriers = packBarriers(project.barriers, origin, dem);
  const g = project.settings?.ground.defaultG ?? 0.5;
  const cutoffM = propagationSettings(project).maxContributionDistanceM;
  const env = solverEnv(project);

  const eff = effectiveSourcesForGrid(project, ca);
  const sourceIds = eff.map((es) => es.id);
  const realSourceFlags = new Uint8Array(eff.length);
  const srcLocal: Array<[number, number]> = [];
  const srcHagl: number[] = [];   // height above local ground (ground attenuation)
  const srcZAbs: number[] = [];   // absolute z (geometry + gradient frame)
  for (let i = 0; i < eff.length; i++) {
    const es = eff[i];
    realSourceFlags[i] = es.kind === 'real' ? 1 : 0;
    srcLocal.push(latLngToLocalMetres(es.latLng, origin));
    const groundRaw = dem ? dem.elevation(es.latLng[0], es.latLng[1]) : 0;
    const ground = Number.isFinite(groundRaw) ? groundRaw : 0;
    const hagl = es.kind === 'real'
      ? (sourceHagl(es.source!, project) ?? 0)
      : (es.zAboveGround ?? 1.5); // cluster: HAG mean by construction
    srcHagl.push(hagl);
    srcZAbs.push(ground + hagl);
  }
  // Snapshot positions are ABSOLUTE — the source-position gradient is taken
  // w.r.t. (e, n, z_abs), so extrapolation deltas must match this frame.
  const srcAbsAtSnapshot = new Float32Array(eff.length * 3);
  for (let i = 0; i < eff.length; i++) {
    srcAbsAtSnapshot[i * 3] = srcLocal[i][0];
    srcAbsAtSnapshot[i * 3 + 1] = srcLocal[i][1];
    srcAbsAtSnapshot[i * 3 + 2] = srcZAbs[i];
  }

  const cellCount = cols * rows;
  const PACK = packLen(project.scenario.bandSystem);
  // Pre-flight memory check. The cells buffer is by far the largest
  // allocation in the app (cellCount × effective_sources × PACK floats).
  // If it would exceed the budget, throw a friendly error pointing the
  // user at the four levers that drive the size — instead of letting the
  // browser blow up with a generic "Array buffer allocation failed".
  // Budget chosen at 1.2 GB: most desktop browsers cap a single typed
  // array around 1–2 GB, and we still need headroom for everything else.
  const cellsBytes = cellCount * eff.length * PACK * 4;
  const HARD_LIMIT_BYTES = 1.2 * 1024 * 1024 * 1024;
  if (cellsBytes > HARD_LIMIT_BYTES) {
    throw new Error(
      `Grid would need ${(cellsBytes / 1024 / 1024 / 1024).toFixed(2)} GB of memory ` +
      `(${cellCount.toLocaleString()} cells × ${eff.length} sources × ${PACK} floats). ` +
      `Try a coarser spacing, smaller calc area, octave (not ⅓-octave) bands, ` +
      `or a higher Barnes-Hut θ to cluster more aggressively.`,
    );
  }
  let cells: Float32Array;
  try {
    cells = new Float32Array(cellCount * eff.length * PACK);
  } catch (e) {
    // Even under the hard limit the OS / browser may refuse if heap is
    // fragmented or a previous huge buffer is still live. Re-throw with
    // the same actionable hints.
    throw new Error(
      `Browser couldn't allocate the ${(cellsBytes / 1024 / 1024).toFixed(0)} MB grid buffer. ` +
      `Close other tabs, then try a coarser spacing / smaller area / octave bands. (${String(e)})`,
    );
  }
  const cellEnZ = new Float32Array(cellCount * 3);

  // Pre-compute per-source metadata once (was previously looked up inside
  // the per-cell loop, which is equivalent to N_cells × N_sources catalog
  // lookups for no good reason).
  type EffMeta = { lw: Float64Array; isWtg: boolean; rotorD: number } | null;
  const effMeta: EffMeta[] = eff.map((es): EffMeta => {
    if (es.kind === 'real') {
      const entry = lookupEntry(project, es.source!);
      if (!entry) return null;
      const modeName = es.source!.modeOverride ?? entry.defaultMode;
      const lw = spectrumFor(entry, modeName, project.scenario.windSpeed, project.scenario.bandSystem);
      // Per-source rotorDiameterM override beats the catalog entry.
      const rotorD = es.source!.rotorDiameterM ?? entry.rotorDiameterM ?? 120;
      return { lw, isWtg: es.source!.kind === 'wtg', rotorD };
    }
    return { lw: es.lwOverride!, isWtg: false, rotorD: 120 };
  });

  for (let row = 0; row < rows; row++) {
    const n = (row - (rows - 1) / 2) * dyM;
    const lat = origin[0] + (n / R) * (180 / Math.PI);
    for (let col = 0; col < cols; col++) {
      const cellIdx = row * cols + col;
      const e = (col - (cols - 1) / 2) * dxM;
      const lng = origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI);
      const groundZRaw = dem ? dem.elevation(lat, lng) : 0;
      const groundZ = Number.isFinite(groundZRaw) ? groundZRaw : 0;
      const rxZ = rxHeightAboveGround;      // receiver HAG
      const rxZAbs = groundZ + rxZ;         // receiver absolute z
      cellEnZ[cellIdx * 3] = e;
      cellEnZ[cellIdx * 3 + 1] = n;
      cellEnZ[cellIdx * 3 + 2] = rxZAbs;

      for (let si = 0; si < eff.length; si++) {
        const meta = effMeta[si];
        if (!meta) continue;
        const es = eff[si];
        const [se, sn] = srcLocal[si];
        // Per-cell distance cutoff: cheap pre-filter before the WASM call.
        if (cutoffM > 0) {
          const dx = se - e;
          const dy = sn - n;
          if (dx * dx + dy * dy > cutoffM * cutoffM) continue;
        }
        // Per-cell topography barriers (DEM-derived ridges between source
        // and this cell), in the ABSOLUTE frame — now consistent with the
        // absolute source/receiver z passed below. Clusters skip topo.
        const allBars = es.kind === 'real'
          ? concatBarriers(
              userBarriers,
              topographyBarriers(
                project.settings?.topography, es.source!.latLng,
                [se, sn, srcZAbs[si]],
                [lat, lng], [e, n, rxZAbs], origin, dem,
              ),
            )
          : userBarriers;

        const { lw, isWtg, rotorD } = meta;
        const concave = isWtg
          && concaveCorrectionMet(es.latLng, srcZAbs[si], [lat, lng], rxZAbs, srcHagl[si], rxZ, dem);
        const snap = isWtg
          ? evaluate_wtg_with_grad_src_octave(
              lw, se, sn, srcZAbs[si], srcHagl[si], e, n, rxZAbs, rxZ, g, allBars, rotorD, concave,
              env.tC, env.rh, env.pKpa, env.barConv,
            )
          : evaluate_general_with_grad_src_octave(
              lw, se, sn, srcZAbs[si], srcHagl[si], e, n, rxZAbs, rxZ, g, allBars,
              env.tC, env.rh, env.pKpa, env.barConv, env.dzCap,
            );
        const base = (cellIdx * eff.length + si) * PACK;
        for (let k = 0; k < PACK; k++) cells[base + k] = snap[k];
      }
    }
  }

  return {
    cols, rows, bounds: { sw, ne },
    sourceIds, realSourceFlags, srcAbsAtSnapshot, cells, cellEnZ,
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
  const dOmegaDb = projectDOmegaDb(project);
  const cols = snapshot.cols;
  const rows = snapshot.rows;
  const cellCount = cols * rows;
  const dbA = new Float32Array(cellCount);
  const capPerBand = project.settings?.extrapolation?.capPerBandDb ?? 6;
  const capTotal = project.settings?.extrapolation?.capTotalDbA ?? 3;
  let stale = false;

  const ca = project.calculationArea!;
  const origin = ca.centerLatLng;
  // The snapshot's effective source list contains a mix of real sources
  // (which we extrapolate against current latLng) and clusters (frozen at
  // snapshot value). For each slot, compute the position delta — clusters
  // get a zero delta so the predicted value equals the baseline.
  const sourcesInSnap = snapshot.sourceIds.length;
  const slotDelta = new Float32Array(sourcesInSnap * 3);
  const realById = new Map<string, Source>();
  for (const s of project.sources) realById.set(s.id, s);
  for (let slot = 0; slot < sourcesInSnap; slot++) {
    const isReal = snapshot.realSourceFlags?.[slot] === 1;
    if (!isReal) continue;     // cluster: zero delta (already set)
    const s = realById.get(snapshot.sourceIds[slot]);
    if (!s) continue;          // source deleted since snapshot — leave at baseline
    const [se, sn] = latLngToLocalMetres(s.latLng, origin);
    const z = sourceAbsZ(s, project, dem) ?? 0;
    slotDelta[slot * 3] = se - snapshot.srcAbsAtSnapshot[slot * 3];
    slotDelta[slot * 3 + 1] = sn - snapshot.srcAbsAtSnapshot[slot * 3 + 1];
    slotDelta[slot * 3 + 2] = z - snapshot.srcAbsAtSnapshot[slot * 3 + 2];
  }

  const PACK = packLen(project.scenario.bandSystem);
  const NB = bandCount(project.scenario.bandSystem);
  for (let cellIdx = 0; cellIdx < cellCount; cellIdx++) {
    let aSum = 0;
    let aSumBaseline = 0;
    for (let slot = 0; slot < sourcesInSnap; slot++) {
      const base = (cellIdx * sourcesInSnap + slot) * PACK;
      const dx = slotDelta[slot * 3];
      const dy = slotDelta[slot * 3 + 1];
      const dz = slotDelta[slot * 3 + 2];
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
        aSum += Math.pow(10, (lp + aw[band] + dOmegaDb) / 10);
        aSumBaseline += Math.pow(10, (baseline + aw[band] + dOmegaDb) / 10);
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
    const region = dem ? captureDemRegion(
      dem, ...sourcePaddedBounds(job),
    ) : null;
    return await runGridJobOnWorker(job, region);
  } catch (e) {
    console.warn('[BESSTY] grid worker unavailable, running inline:', e);
    return runBatchedGrid(job, dem);
  }
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
