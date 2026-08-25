// Wind-farm curtailment: which mode each turbine should run in, at each wind
// speed and period, to comply for the least lost generation.
//
// The whole approach rests on one observation. The per-band TRANSFER between a
// turbine and a receiver —
//
//     T[t][r][band] = Lp[band] − Lw[band]
//
// — is a property of geometry, ground, atmosphere and barriers. It does not
// depend on which mode the turbine runs in, nor on the wind speed (wind speed
// only selects which source spectrum is used). So ONE ordinary solve yields the
// entire matrix, and every candidate schedule after that is arithmetic.
//
// That arithmetic is linear in ENERGY, which is what makes an exact optimum
// reachable: summing decibels is not linear, but summing the energies they
// represent is, and a limit is just a cap on that sum. The result is a
// multiple-choice knapsack per (period, wind speed) cell — see `lib/milp.ts`,
// which solves it to a proven optimum without knowing any of this.
//
// Turbines are never clustered in the solve (Barnes-Hut only ever groups them
// for grid cells) and named receivers are exact, so the matrix is not an
// approximation of the solve — it reproduces it.

import type { CatalogEntry, Period, Project, Receiver, Source } from './types';
import { projectDOmegaDb } from './types';
// `lookupEntry` needs the catalog stores; the spectrum maths does not, and it
// comes from the dependency-free leaf so this module's model half stays
// testable without the Firebase SDK.
import { lookupEntry } from './catalog';
import { spectrumFor, spectrumForMode } from './spectra';
import { MODE_OFF, sourceIsOff, sourceModeName } from './modes';
import { evaluateProject, sourceHagl, type ReceiverResult } from './solver';
import type { DemRaster } from './dem';
import { limitComparisonFor, resolveLimit } from './limits';
import { approxDistanceM } from './geo';
import {
  adjustmentAtBand, bearingDeg, directivityAdjustmentDb,
  type DirectivityAdjustment, type DirectivityModel,
} from './directivity';
import { weightingFor, weightsFor } from './weighting';
import { tonalitySettingsFor } from './tonality';
import {
  solveWithHighs, unsatisfiableResources,
  type MilpModel, type MilpSolution,
} from './milp';

/// `T[sourceId][receiverId]` → per-band transfer, or absent when that pair did
/// not contribute (culled by distance).
export type TransferMatrix = Map<string, Map<string, Float64Array>>;

export interface CurtailmentOptions {
  windSpeeds: number[];
  periods: Period[];
  /// Extra headroom below the limit, in dB. 0 = comply exactly.
  marginDb: number;
  /// Wind directions to optimise for, in degrees the wind blows FROM. Empty ⇒
  /// no direction is assumed and no correction is applied, which is the
  /// downwind-to-every-receiver reading ISO 9613-2 takes and what BESSTY does
  /// everywhere else. Each direction is an independent schedule.
  windDirectionsDeg?: number[];
  /// How the correction is computed. Ignored when no directions are swept.
  ///
  /// It applies to WIND TURBINES ONLY, and only inside this optimisation. It is
  /// not a property of the project, it is not an ISO term, and it never reaches
  /// a reported level — see the note at the top of `lib/directivity.ts`.
  directivity?: DirectivityModel;
}

export interface CellReceiver {
  id: string;
  name: string;
  /// Energy the turbines may add, after the fixed sources have taken their
  /// share. Negative ⇒ nothing the optimiser can do will comply.
  availableEnergy: number;
  fixedEnergy: number;
  capDb: number;
}

export interface CellResult {
  period: Period;
  windSpeed: number;
  /// The wind direction this schedule is for (degrees FROM), or undefined when
  /// the run assumed every receiver was downwind.
  windDirectionDeg?: number;
  status: 'optimal' | 'infeasible' | 'error';
  /// sourceId → mode name, or `MODE_OFF`. Empty unless optimal.
  modes: Record<string, string>;
  lostKw: number;
  /// The receiver closest to its cap under the chosen schedule (or the one
  /// that cannot be met, when infeasible).
  bindingReceiverId?: string;
  bindingReceiverName?: string;
  /// Headroom at the binding receiver, dB. Negative when infeasible.
  marginAtBindingDb?: number;
  detail?: string;
}

export interface CurtailmentResult {
  turbines: Array<{ id: string; name: string }>;
  cells: CellResult[];
  /// Non-fatal notes worth showing beside the table — a receiver whose wind
  /// speed fell off its limit table, say.
  warnings: string[];
  /// The margin this run actually enforced.
  ///
  /// Stamped here rather than read off the UI at export time. The margin box
  /// can be edited after a run without invalidating the table on screen, and
  /// the settings sheet was reading that live value — so a study run at 0 dB
  /// could be exported claiming 3 dB of headroom it never had. An evidence file
  /// has to describe the run that produced it, not the state of the form
  /// beside it.
  marginDb: number;
}

// ------------------------------------------------------------------- power

/// Electrical output of one mode at a wind speed, interpolating between the
/// wind speeds the datasheet gives, and holding flat beyond either end.
///
/// Returns null when the mode carries no power curve at all — the caller names
/// the turbine rather than assuming a number, because a guessed power curve
/// produces a confident schedule that is quietly wrong.
export function powerKwAt(mode: { powerKw?: Record<string, number> }, ws: number): number | null {
  const pk = mode.powerKw;
  if (!pk) return null;
  const pts: Array<[number, number]> = [];
  for (const [k, v] of Object.entries(pk)) {
    const w = Number(k);
    if (Number.isFinite(w) && Number.isFinite(v)) pts.push([w, v]);
  }
  if (pts.length === 0) return null;
  pts.sort((a, b) => a[0] - b[0]);
  if (ws <= pts[0][0]) return pts[0][1];
  if (ws >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 1; i < pts.length; i++) {
    if (ws <= pts[i][0]) {
      const [w0, p0] = pts[i - 1];
      const [w1, p1] = pts[i];
      const t = (ws - w0) / (w1 - w0);
      return p0 + (p1 - p0) * t;
    }
  }
  return pts[pts.length - 1][1];
}

// ---------------------------------------------------------------- precheck

export interface Precheck {
  ok: boolean;
  /// Why the optimiser cannot run. Every reason names what is missing and
  /// where, so it can be fixed rather than guessed at.
  reasons: string[];
  turbines: Source[];
  /// Wind speeds every turbine's catalog data covers.
  windSpeeds: number[];
}

/// Can this project be optimised, and over what wind speeds?
export function precheckCurtailment(project: Project): Precheck {
  const reasons: string[] = [];
  const turbines = project.sources.filter((s) => s.kind === 'wtg');
  if (turbines.length === 0) reasons.push('This project has no wind turbines.');
  if (project.receivers.length === 0) reasons.push('This project has no receivers.');

  const covered: number[][] = [];
  const missingPower: string[] = [];
  const partialPower: string[] = [];
  const missingEntry: string[] = [];
  for (const t of turbines) {
    const entry = lookupEntry(project, t);
    if (!entry) { missingEntry.push(t.name); continue; }
    const withoutPower = entry.modes.filter((m) => powerKwAt(m, 10) == null);
    if (withoutPower.length > 0) {
      missingPower.push(`${t.name} (${entry.displayName}: ${withoutPower.map((m) => m.name).join(', ')})`);
    }
    // A curve covering only PART of the mode's wind speeds is worse than none.
    // `powerKwAt` holds flat past either end, so a curve entered for 8–12 m/s
    // prices the mode at its 8 m/s output all the way down to 4 — and the
    // optimiser then reports a confident "least generation given up" that is
    // simply wrong about the generation. The check used to be "at least one
    // finite point anywhere", which such a curve passes.
    const gaps = entry.modes.filter((m) => {
      if (powerKwAt(m, 10) == null) return false;      // already named above
      const pk = m.powerKw ?? {};
      return (m.windSpeeds ?? []).some((w) => !Number.isFinite(pk[String(w)]));
    });
    if (gaps.length > 0) {
      partialPower.push(`${t.name} (${entry.displayName}: ${gaps.map((m) => m.name).join(', ')})`);
    }
    const ws = new Set<number>();
    for (const m of entry.modes) for (const w of m.windSpeeds ?? []) ws.add(Math.round(w));
    covered.push([...ws]);
  }
  if (missingEntry.length > 0) {
    reasons.push(`No catalog entry for: ${missingEntry.join(', ')}.`);
  }
  if (missingPower.length > 0) {
    reasons.push(
      'These modes have no power curve, so the generation they cost is unknown: '
      + `${missingPower.join('; ')}. Add a power row in the catalog editor.`,
    );
  }
  if (partialPower.length > 0) {
    reasons.push(
      'These modes have a power curve that does not cover every wind speed they '
      + `have a spectrum for: ${partialPower.join('; ')}. The missing speeds would be `
      + 'priced at the nearest entered one, which would make the lost-kW figures — and '
      + 'therefore the schedule — wrong without saying so. Fill in the whole kW row.',
    );
  }

  // Wind speeds every turbine can be evaluated at. An intersection, not a
  // union: a speed one turbine has no spectrum for cannot be scheduled.
  let windSpeeds: number[] = [];
  if (covered.length > 0) {
    windSpeeds = covered.reduce((acc, cur) => acc.filter((w) => cur.includes(w)));
    windSpeeds.sort((a, b) => a - b);
  }
  if (windSpeeds.length === 0 && reasons.length === 0) {
    reasons.push('The turbines share no wind speeds in their catalog spectra.');
  }

  return { ok: reasons.length === 0, reasons, turbines, windSpeeds };
}

// --------------------------------------------------------- transfer matrix

/// A copy of the project set up to measure transfers for `period`, together with
/// the sound power each source was measured at.
///
/// TURBINES are pinned to a definite catalog mode. A source switched Off is
/// dropped from the solve entirely, so an Off turbine's transfer would be
/// missing and it could never be scheduled back on — and since the transfer is
/// `Lp − Lw`, the Lw that produced each Lp has to be known exactly.
///
/// EVERYTHING ELSE is left exactly as the project has it. This is the part that
/// used to be wrong: pinning fixed sources On as well put the CONTAINER of a
/// unit that is Off in this period back into the scene, where it screened paths
/// that the compliance solve — which drops an Off source and its box together —
/// leaves open. The optimiser then measured a quieter world than the one it was
/// planning for and under-curtailed, which is the one direction this module's
/// comments promise it will not err in. Turbines never carry a container
/// (`resolveContainer` returns undefined for a WTG), so pinning them costs no
/// geometry at all.
///
/// A fixed source needs no pinning to be measurable: its Lw is simply whatever
/// mode it already resolves to, read through the same `spectrumFor` the solver
/// itself calls, so the two cannot disagree.
///
/// The project and the Lw map are built TOGETHER and returned together. Deriving
/// them separately meant two places encoding the same rule, and a transfer
/// matrix silently offset by the difference if they ever disagreed.
export function projectForTransfer(project: Project, period: Period): {
  pinned: Project;
  lwBySource: Map<string, Float64Array>;
} {
  const { windSpeed, bandSystem } = project.scenario;
  const lwBySource = new Map<string, Float64Array>();
  const sources = project.sources.map((s) => {
    const entry = lookupEntry(project, s);
    if (!entry) return s;
    if (s.kind === 'wtg') {
      const mode = entry.modes.find((m) => m.name === entry.defaultMode) ?? entry.modes[0];
      if (!mode) return s;
      lwBySource.set(s.id, spectrumForMode(mode, bandSystem, windSpeed));
      return { ...s, modeOverride: mode.name };
    }
    const name = sourceModeName(s, entry, period);
    if (name == null) return s;              // Off this period — absent, box and all
    lwBySource.set(s.id, spectrumFor(entry, name, windSpeed, bandSystem));
    return s;
  });
  // The period must travel with the project now that fixed sources resolve
  // against it: leaving the live scenario's period here would read one period's
  // modes while the caller believed it was measuring another's.
  return {
    pinned: { ...project, sources, scenario: { ...project.scenario, period } },
    lwBySource,
  };
}

/// The sources absent from the scene in `period`, as a comparable key.
///
/// Two periods whose absent-set matches have identical geometry and can share
/// one transfer solve. Only a source that is GONE changes what screens what —
/// a source merely running a quieter mode still occupies the same box — so this
/// splits far less often than the mode-based grouping the solver uses. For every
/// project that does not park a fixed unit for part of the day, which is nearly
/// all of them, all three periods share one key and the sweep costs exactly the
/// one solve it always did.
function transferGeometryKey(project: Project, period: Period): string {
  return project.sources
    .filter((s) => s.kind !== 'wtg' && sourceIsOff(s, period))
    .map((s) => s.id)
    .sort()
    .join('|');
}

/// Solve once per distinct geometry and reduce to per-band transfers.
export async function buildTransferMatrix(
  project: Project,
  dem: DemRaster | null,
  period: Period,
): Promise<TransferMatrix> {
  const { pinned, lwBySource } = projectForTransfer(project, period);
  const results = await evaluateProject(pinned, dem, undefined, 'export');
  return transferFromResults(lwBySource, results);
}

/// The pure half of `buildTransferMatrix`, so it can be tested without a solve.
export function transferFromResults(
  lwBySource: Map<string, Float64Array>,
  results: ReceiverResult[],
): TransferMatrix {
  const out: TransferMatrix = new Map();
  for (const res of results) {
    for (const contrib of res.perSource) {
      const lw = lwBySource.get(contrib.sourceId);
      if (!lw || lw.length !== contrib.perBandLp.length) continue;
      const t = new Float64Array(lw.length);
      for (let b = 0; b < lw.length; b++) {
        const lp = contrib.perBandLp[b];
        // A band that did not arrive stays at −Infinity, which is zero energy
        // under any source spectrum — the honest reading of "no contribution".
        t[b] = Number.isFinite(lp) ? lp - lw[b] : -Infinity;
      }
      let byRx = out.get(contrib.sourceId);
      if (!byRx) { byRx = new Map(); out.set(contrib.sourceId, byRx); }
      byRx.set(res.receiverId, t);
    }
  }
  return out;
}

// ------------------------------------------------------------- cell models

/// Weighted energy a source contributes at a receiver, given its sound power.
///
/// `adjust` is the wind-direction correction for this pair — a scalar, or a
/// per-band array for a model that varies with frequency. It rides here rather
/// than being folded into the transfer because the transfer is a property of
/// the geometry alone, and the same matrix is reused across every wind
/// direction in a sweep.
function energyOf(
  lw: Float64Array,
  transfer: Float64Array | undefined,
  weights: Float64Array,
  adjust?: DirectivityAdjustment,
): number {
  if (!transfer) return 0;
  let sum = 0;
  for (let b = 0; b < weights.length; b++) {
    const t = transfer[b];
    const w = lw[b];
    if (!Number.isFinite(t) || !Number.isFinite(w)) continue;
    sum += Math.pow(10, (w + t + weights[b] + adjustmentAtBand(adjust, b)) / 10);
  }
  return sum;
}

/// The decibel cap a receiver's total must stay at or under.
///
/// Everything that sits between "the limit" and "the number the solver may not
/// exceed" is folded in here, so the constraint the optimiser enforces is the
/// same one the compliance badge applies:
///
///  - the user's margin, if any;
///  - `integer` comparison, where a level rounds before it is judged, so
///    anything below limit + 0.5 passes;
///  - DΩ, which the solve adds to every band and therefore to the total;
///  - a tonality penalty, if one could be applied. This is CONSERVATIVE: the
///    penalty depends on the spectrum, which depends on the schedule, so it
///    cannot be known in advance. Assuming it always applies can over-curtail;
///    assuming it never does would hand back a schedule that fails its own
///    assessed check, which is worse.
export function capDbFor(
  project: Project,
  receiver: Receiver,
  period: Period,
  windSpeed: number,
  marginDb: number,
): { capDb: number; clamped: boolean } {
  const resolved = resolveLimit(project, receiver, period, windSpeed);
  // The rounding allowance is a property of the LIMIT, so it is computed from
  // the limit alone and the margin is taken off afterwards.
  //
  // `exceedsLimit` rounds the LEVEL and compares it with the limit as entered:
  // it passes iff `round(L) <= limit`, and since `round(L)` is an integer that
  // is `round(L) <= floor(limit)`, i.e. `L < floor(limit) + 0.5`. Adding 0.5 to
  // the limit itself is only the same thing when the limit is a whole number.
  // At 37.3 dB it produced a cap of 37.8, so the optimiser certified any
  // schedule up to 37.79 as compliant while every badge, contour and export in
  // the app failed it from 37.5 — a schedule shipped as evidence that the app
  // itself contradicts. Fractional limits are ordinary ("background + 5 dB",
  // pasted limit tables keep their decimals), so this was reachable.
  const limitDb = resolved.db;
  let cap = limitComparisonFor(project) === 'integer'
    ? Math.floor(limitDb) + 0.5 - 1e-6
    : limitDb;
  cap -= marginDb;
  cap -= projectDOmegaDb(project);
  const tonality = tonalitySettingsFor(project);
  if (tonality.enabled && tonality.applyPenalty) cap -= tonality.penaltyDb;
  return { capDb: cap, clamped: resolved.source === 'clamped' };
}

export interface CellModel {
  model: MilpModel;
  receivers: CellReceiver[];
  turbineIds: string[];
  /// Mode name per turbine per option index, parallel to the model's groups.
  optionModes: string[][];
}

/// Build the MILP for one (period, wind speed).
export function buildCellModel(
  project: Project,
  transfer: TransferMatrix,
  period: Period,
  windSpeed: number,
  marginDb: number,
  wind?: {
    windDirectionDeg: number;
    model: DirectivityModel;
  },
): { cell: CellModel; warnings: string[] } {
  const warnings: string[] = [];
  const bs = project.scenario.bandSystem;
  const weights = weightsFor(bs, weightingFor(project));
  const turbines = project.sources.filter((s) => s.kind === 'wtg');
  const turbineIds = new Set(turbines.map((t) => t.id));

  // Per (turbine, receiver) wind correction. Bearings come from the real
  // coordinates the project already holds — the standalone tool needs a
  // bearings CSV only because a SoundPlan contribution export carries no
  // geometry.
  //
  // TURBINES ONLY, with no switch to change that. The correction exists to
  // decide wind-turbine curtailment and has no meaning outside it: a BESS runs
  // the same whatever the wind is doing, and crediting one here would quietly
  // relax a cap on the strength of an approximation that was never about it.
  const adjust = (s: Source, r: Receiver): DirectivityAdjustment | undefined => {
    if (!wind || !turbineIds.has(s.id)) return undefined;
    return directivityAdjustmentDb(wind.model, {
      bearingDeg: bearingDeg(s.latLng, r.latLng),
      windFromDeg: wind.windDirectionDeg,
      distanceM: approxDistanceM(s.latLng, r.latLng),
      sourceHeightM: sourceHagl(s, project) ?? 0,
      receiverHeightM: r.heightAboveGroundM,
    });
  };

  // Fixed sources: everything the optimiser cannot switch. Their mode is
  // whatever the project already resolves for this period, Off included.
  const fixedEnergy = new Map<string, number>();
  for (const r of project.receivers) fixedEnergy.set(r.id, 0);
  for (const s of project.sources) {
    if (turbineIds.has(s.id)) continue;
    const entry = lookupEntry(project, s);
    if (!entry) continue;
    const mode = sourceModeName(s, entry, period);
    if (mode == null) continue;                        // off this period
    const lw = spectrumFor(entry, mode, windSpeed, bs);
    const byRx = transfer.get(s.id);
    for (const r of project.receivers) {
      fixedEnergy.set(r.id, (fixedEnergy.get(r.id) ?? 0) + energyOf(lw, byRx?.get(r.id), weights, adjust(s, r)));
    }
  }

  const receivers: CellReceiver[] = project.receivers.map((r) => {
    const { capDb, clamped } = capDbFor(project, r, period, windSpeed, marginDb);
    if (clamped) {
      warnings.push(
        `${r.name}: ${windSpeed} m/s is outside its limit table; the nearest wind speed was used.`,
      );
    }
    const fixed = fixedEnergy.get(r.id) ?? 0;
    return {
      id: r.id,
      name: r.name,
      capDb,
      fixedEnergy: fixed,
      availableEnergy: Math.pow(10, capDb / 10) - fixed,
    };
  });

  const optionModes: string[][] = [];
  const groups = turbines.map((t) => {
    const entry = lookupEntry(project, t);
    const modes = entry?.modes ?? [];
    // The symmetrical warning to the limit-table clamp above. Both spectra and
    // power curves hold flat past the ends of their data, so a wind speed the
    // catalog never covered still produces a full column of confident modes and
    // kW — computed from the nearest speed that WAS covered. Saying so is the
    // difference between an extrapolation and a silent one.
    const coveredSpeeds = new Set<number>();
    for (const m of modes) for (const w of m.windSpeeds ?? []) coveredSpeeds.add(Math.round(w));
    if (coveredSpeeds.size > 0 && !coveredSpeeds.has(Math.round(windSpeed))) {
      const lo = Math.min(...coveredSpeeds);
      const hi = Math.max(...coveredSpeeds);
      warnings.push(
        `${t.name}: ${windSpeed} m/s is outside its catalog data (${lo}–${hi} m/s); `
        + 'the nearest wind speed’s spectrum and power were used.',
      );
    }
    const powers = modes.map((m) => powerKwAt(m, windSpeed) ?? 0);
    const pMax = powers.length > 0 ? Math.max(...powers) : 0;
    const byRx = transfer.get(t.id);
    const names: string[] = [];
    const options = modes.map((m, i) => {
      // By the mode OBJECT, not its name: these come straight off the entry, so
      // there is no name for `spectrumFor`'s first-mode fallback to catch.
      const lw = spectrumForMode(m, bs, windSpeed);
      names.push(m.name);
      return {
        key: `${t.id}::${m.name}`,
        cost: pMax - powers[i],
        use: project.receivers.map((r) => energyOf(lw, byRx?.get(r.id), weights, adjust(t, r))),
      };
    });
    // Off is always on the menu: it costs the turbine's whole output and emits
    // nothing, which is what guarantees a schedule exists at all.
    names.push(MODE_OFF);
    options.push({
      key: `${t.id}::${MODE_OFF}`,
      cost: pMax,
      use: receivers.map(() => 0),
    });
    optionModes.push(names);
    return { key: t.id, options };
  });

  return {
    cell: {
      model: { groups, capacities: receivers.map((r) => r.availableEnergy) },
      receivers,
      turbineIds: turbines.map((t) => t.id),
      optionModes,
    },
    warnings,
  };
}

/// Turn a solved cell into the row the UI and the export show.
export function describeCell(
  cell: CellModel,
  solution: MilpSolution,
  period: Period,
  windSpeed: number,
): CellResult {
  if (solution.status !== 'optimal') {
    // Name the receiver that cannot be met and by how much — that is the whole
    // content of an infeasible answer.
    const blocked = unsatisfiableResources(cell.model);
    // Ranked by how many DECIBELS over the cap each receiver is, not by an
    // energy difference. Energies carry the absolute scale of the cap with
    // them, so `fixed − available` ranked a receiver 0.2 dB over its 40 dB cap
    // above one 10 dB over a 20 dB cap, and the export then reported the 0.2 dB
    // as the exceedance — a cell that is far beyond help presented as nearly
    // solvable.
    const overBy = (r: CellReceiver) =>
      10 * Math.log10(Math.max(r.fixedEnergy, Number.MIN_VALUE)) - r.capDb;
    const worst = blocked
      .map((j) => cell.receivers[j])
      .filter((r): r is CellReceiver => r != null)
      .sort((a, b) => overBy(b) - overBy(a))[0];
    const overDb = worst ? overBy(worst) : undefined;
    return {
      period, windSpeed,
      status: solution.status,
      modes: {},
      lostKw: 0,
      bindingReceiverId: worst?.id,
      bindingReceiverName: worst?.name,
      marginAtBindingDb: overDb == null ? undefined : -overDb,
      detail: solution.detail
        ?? (worst
          ? `${worst.name} is over its limit from sources the optimiser cannot switch.`
          : undefined),
    };
  }

  const modes: Record<string, string> = {};
  cell.turbineIds.forEach((id, i) => { modes[id] = cell.optionModes[i][solution.chosen[i]]; });

  // Binding receiver: the one with the least headroom under this schedule.
  let binding: CellReceiver | undefined;
  let bindingMarginDb = Infinity;
  cell.receivers.forEach((r, j) => {
    const used = cell.model.groups.reduce(
      (acc, g, i) => acc + g.options[solution.chosen[i]].use[j], 0,
    ) + r.fixedEnergy;
    const totalDb = used > 0 ? 10 * Math.log10(used) : -Infinity;
    const headroom = r.capDb - totalDb;
    if (headroom < bindingMarginDb) { bindingMarginDb = headroom; binding = r; }
  });

  return {
    period, windSpeed,
    status: 'optimal',
    modes,
    lostKw: solution.cost,
    bindingReceiverId: binding?.id,
    bindingReceiverName: binding?.name,
    marginAtBindingDb: Number.isFinite(bindingMarginDb) ? bindingMarginDb : undefined,
  };
}

// ------------------------------------------------------------ orchestration

/// Optimise every requested (period, wind speed).
///
/// One solve up front for the transfer matrix, then pure arithmetic and a small
/// MILP per cell. `onProgress` fires after each cell so a long sweep can show
/// its table filling in rather than freezing.
export async function optimiseCurtailment(
  project: Project,
  dem: DemRaster | null,
  opts: CurtailmentOptions,
  onProgress?: (done: number, total: number) => void,
): Promise<CurtailmentResult> {
  const turbines = project.sources.filter((s) => s.kind === 'wtg');

  // One transfer solve per distinct GEOMETRY, not per period. Periods differing
  // only in which mode something runs share a matrix, because the transfer is
  // `Lp − Lw` and does not depend on how loud a source is; periods differing in
  // which sources are PRESENT do not, because an absent unit screens nothing.
  const transferByPeriod = new Map<Period, TransferMatrix>();
  const byGeometry = new Map<string, TransferMatrix>();
  for (const period of opts.periods) {
    const key = transferGeometryKey(project, period);
    let transfer = byGeometry.get(key);
    if (!transfer) {
      transfer = await buildTransferMatrix(project, dem, period);
      byGeometry.set(key, transfer);
    }
    transferByPeriod.set(period, transfer);
  }

  const cells: CellResult[] = [];
  const warnings = new Set<string>();
  // `undefined` means "assume every receiver is downwind" — no direction, no
  // correction, which is the conservative reading and the default.
  const directions: Array<number | undefined> = opts.windDirectionsDeg?.length
    ? opts.windDirectionsDeg
    : [undefined];
  const model = opts.directivity ?? { kind: 'none' as const };
  const total = opts.periods.length * opts.windSpeeds.length * directions.length;
  let done = 0;

  for (const period of opts.periods) {
    for (const windSpeed of opts.windSpeeds) {
      for (const windDirectionDeg of directions) {
        const { cell, warnings: w } = buildCellModel(
          project, transferByPeriod.get(period)!, period, windSpeed, opts.marginDb,
          windDirectionDeg === undefined ? undefined : { windDirectionDeg, model },
        );
        for (const msg of w) warnings.add(msg);
        const solution = await solveWithHighs(cell.model);
        cells.push({
          ...describeCell(cell, solution, period, windSpeed),
          windDirectionDeg,
        });
        done++;
        onProgress?.(done, total);
      }
    }
  }

  return {
    turbines: turbines.map((t) => ({ id: t.id, name: t.name })),
    cells,
    warnings: [...warnings],
    marginDb: opts.marginDb,
  };
}

/// The modes one cell prescribes, as per-period overrides to write onto the
/// project ("Apply modes for ws = X").
///
/// Only the cell's own period is touched: applying a night schedule must not
/// silently rewrite what the turbines do during the day.
export function modeOverridesForCell(cell: CellResult): Array<{ sourceId: string; period: Period; mode: string }> {
  return Object.entries(cell.modes).map(([sourceId, mode]) => ({
    sourceId, period: cell.period, mode,
  }));
}

/// Catalog entries for the turbines, for the UI's mode chips.
export function turbineEntries(project: Project): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const s of project.sources) {
    if (s.kind !== 'wtg') continue;
    const e = lookupEntry(project, s);
    if (e) out.set(s.id, e);
  }
  return out;
}
