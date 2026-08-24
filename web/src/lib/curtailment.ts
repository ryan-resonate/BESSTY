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
import { lookupEntry, spectrumFor, spectrumForMode } from './catalog';
import { MODE_OFF, sourceModeName } from './modes';
import { evaluateProject, type ReceiverResult } from './solver';
import type { DemRaster } from './dem';
import { limitComparisonFor, resolveLimit } from './limits';
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
  const missingEntry: string[] = [];
  for (const t of turbines) {
    const entry = lookupEntry(project, t);
    if (!entry) { missingEntry.push(t.name); continue; }
    const withoutPower = entry.modes.filter((m) => powerKwAt(m, 10) == null);
    if (withoutPower.length > 0) {
      missingPower.push(`${t.name} (${entry.displayName}: ${withoutPower.map((m) => m.name).join(', ')})`);
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

/// A copy of the project with every source running a definite catalog mode,
/// together with the sound power each one was pinned to.
///
/// Two reasons this is not simply the live project. A source switched Off is
/// dropped from the solve entirely, so its transfer would be missing and it
/// could never be scheduled back on. And the transfer is `Lp − Lw`, so the Lw
/// that produced each Lp has to be known exactly.
///
/// The project and the Lw map are built TOGETHER and returned together. Deriving
/// them separately meant two places encoding the same pinning rule, and a
/// transfer matrix silently offset by the difference if they ever disagreed.
export function projectForTransfer(project: Project): {
  pinned: Project;
  lwBySource: Map<string, Float64Array>;
} {
  const { windSpeed, bandSystem } = project.scenario;
  const lwBySource = new Map<string, Float64Array>();
  const sources = project.sources.map((s) => {
    const entry = lookupEntry(project, s);
    if (!entry) return s;
    const mode = entry.modes.find((m) => m.name === entry.defaultMode) ?? entry.modes[0];
    if (!mode) return s;
    lwBySource.set(s.id, spectrumForMode(mode, bandSystem, windSpeed));
    return { ...s, modeOverride: mode.name };
  });
  return { pinned: { ...project, sources }, lwBySource };
}

/// Solve once and reduce to per-band transfers.
export async function buildTransferMatrix(
  project: Project,
  dem: DemRaster | null,
): Promise<TransferMatrix> {
  const { pinned, lwBySource } = projectForTransfer(project);
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
function energyOf(lw: Float64Array, transfer: Float64Array | undefined, weights: Float64Array): number {
  if (!transfer) return 0;
  let sum = 0;
  for (let b = 0; b < weights.length; b++) {
    const t = transfer[b];
    const w = lw[b];
    if (!Number.isFinite(t) || !Number.isFinite(w)) continue;
    sum += Math.pow(10, (w + t + weights[b]) / 10);
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
  let cap = resolved.db - marginDb;
  if (limitComparisonFor(project) === 'integer') cap += 0.5 - 1e-6;
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
): { cell: CellModel; warnings: string[] } {
  const warnings: string[] = [];
  const bs = project.scenario.bandSystem;
  const weights = weightsFor(bs, weightingFor(project));
  const turbines = project.sources.filter((s) => s.kind === 'wtg');
  const turbineIds = new Set(turbines.map((t) => t.id));

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
      fixedEnergy.set(r.id, (fixedEnergy.get(r.id) ?? 0) + energyOf(lw, byRx?.get(r.id), weights));
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
        use: receivers.map((r) => energyOf(lw, byRx?.get(r.id), weights)),
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
    const worst = blocked
      .map((j) => cell.receivers[j])
      .sort((a, b) => (b.fixedEnergy - b.availableEnergy) - (a.fixedEnergy - a.availableEnergy))[0];
    const overDb = worst
      ? 10 * Math.log10(Math.max(worst.fixedEnergy, Number.MIN_VALUE)) - worst.capDb
      : undefined;
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
  const transfer = await buildTransferMatrix(project, dem);

  const cells: CellResult[] = [];
  const warnings = new Set<string>();
  const total = opts.periods.length * opts.windSpeeds.length;
  let done = 0;

  for (const period of opts.periods) {
    for (const windSpeed of opts.windSpeeds) {
      const { cell, warnings: w } = buildCellModel(
        project, transfer, period, windSpeed, opts.marginDb,
      );
      for (const msg of w) warnings.add(msg);
      const solution = await solveWithHighs(cell.model);
      cells.push(describeCell(cell, solution, period, windSpeed));
      done++;
      onProgress?.(done, total);
    }
  }

  return {
    turbines: turbines.map((t) => ({ id: t.id, name: t.name })),
    cells,
    warnings: [...warnings],
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
