// Wind-speed sweep: solve the project at a series of wind speeds and hold every
// result for export.
//
// A turbine's sound power is a function of wind speed, and so — once wind-speed
// limits are in play — is the limit it is judged against. "Does this project
// comply?" therefore has no single answer; it has one per wind speed, and the
// binding one is rarely the loudest. Picking the wind speed by hand, re-running,
// and copying numbers out is how that gets done today, which is slow and leaves
// no record of what was run.
//
// This is deliberately NOT the curtailment optimiser's trick. That reduces a
// solve to a transfer matrix and does the rest as arithmetic, which is exact
// only because the geometry is fixed and the sound power is the only thing
// moving. Here the whole scene is re-solved at every wind speed: it costs N
// solves instead of one, and in exchange every number in the export came out of
// the engine rather than out of a model of the engine. For a sweep whose whole
// purpose is a defensible compliance table, that is the right trade.
//
// Two economies are taken, both of them exact:
//
//   - Periods that resolve to the same modes share a solve (`groupPeriodsBySolve`).
//     A project not using per-period modes costs one solve per wind speed, not
//     three.
//   - Receivers and grids are each optional, because a contour set is minutes of
//     work per wind speed and a compliance table is seconds.

import type { ContourLineSet } from './contourLines';
import type { CustomContourLine, Period, Project } from './types';
import type { DemRaster } from './dem';
import type { GridResult, ReceiverResult, SolveChannel } from './solver';
import type { LimitSource } from './limitTable';

import { Diagnostics } from './diagnostics';
import { traceForExport } from './contourLines';
import { GRID_CANCELLED, evaluateGridViaWorker, evaluateProject } from './solver';
import { groupPeriodsBySolve } from './modes';
import { assessedLevel, exceedsLimit, limitComparisonFor, resolveLimit } from './limits';
import { isUsableTable, windSpeedLimitsEnabled } from './limitTable';

/// What to run. At least one of `receivers` / `grids` must be set, or there is
/// nothing to solve.
export interface SweepConfig {
  /// Ascending, de-duplicated by the caller (`normaliseSpeeds`).
  windSpeeds: number[];
  periods: Period[];
  receivers: boolean;
  grids: boolean;
}

/// One solved (period, wind speed).
///
/// `grid` and `receivers` are SHARED between the periods of a solve group when
/// those periods resolve to the same modes — they are read-only results, and
/// copying them would only mean holding three identical rasters.
export interface SweepState {
  period: Period;
  windSpeed: number;
  receivers: ReceiverResult[] | null;
  grid: GridResult | null;
}

export interface SweepResult {
  config: SweepConfig;
  /// Ordered wind speed then period.
  states: SweepState[];
  /// Things the reader of the export needs to know about the run, e.g. that
  /// nothing in the project actually varies with wind speed.
  warnings: string[];
  /// What the grids were solved at, for the settings sheet. Absent when grids
  /// were not run.
  gridSpacingM?: number;
  receiverHeightM?: number;
  /// Wall-clock, for the settings sheet — a sweep is long enough that "how long
  /// did this take" is a real question when it is repeated.
  elapsedMs: number;
}

/// Thrown (as an Error message) when the user cancels. Callers should treat it
/// as "no result", not as a failure to report.
export const SWEEP_CANCELLED = 'wind sweep cancelled';

export interface SweepProgress {
  /// Solves finished, out of `total`.
  done: number;
  total: number;
  /// What is being solved right now — "Night · 10 m/s · contour grid".
  label: string;
  /// Tile progress within the current grid solve, when one is running.
  tiles?: { done: number; total: number };
}

/// The two solves a sweep needs, injected so the runner can be tested without
/// the wasm engine or a Web Worker. `liveSweepDeps` is the real one.
export interface SweepDeps {
  solveReceivers(project: Project, dem: DemRaster | null): Promise<ReceiverResult[]>;
  solveGrid(
    project: Project,
    dem: DemRaster | null,
    onTile?: (done: number, total: number) => void,
  ): Promise<GridResult>;
  /// The wind speeds a source's catalog entry actually holds spectra for, or
  /// null when there is no entry. Supplied so the run can say when a swept
  /// speed lies outside them; omit it and that check is simply not made.
  windSpeedsFor?(source: Project['sources'][number]): number[] | null;
}

/// The real solves. `spacingM` and `receiverHeightM` come from the screen, so a
/// sweep's contours are computed at the same resolution and height as the grid
/// the user is looking at — an export at a different spacing to the one on
/// screen would be a quiet trap.
export function liveSweepDeps(
  spacingM: number,
  receiverHeightM: number,
  /// The catalog lookup, injected for the same reason `defaultSweepSpeeds` takes
  /// one: this module stays out of the Firebase-backed catalog. Omit it and the
  /// coverage warning is not raised.
  windSpeedsFor?: SweepDeps['windSpeedsFor'],
  channel: SolveChannel = 'study',
): SweepDeps {
  return {
    solveReceivers: (project, dem) =>
      evaluateProject(project, dem, new Diagnostics(), channel).then((s) => s.results),
    solveGrid: (project, dem, onTile) =>
      evaluateGridViaWorker(project, dem, spacingM, receiverHeightM, onTile),
    windSpeedsFor,
  };
}

/// Ascending, integer-binned, de-duplicated. Wind speeds address catalog
/// spectra and limit-table columns, both of which are keyed by whole m/s, so a
/// sweep at 8.5 would silently be a second sweep at 8 or 9.
export function normaliseSpeeds(raw: readonly number[]): number[] {
  const seen = new Set<number>();
  for (const v of raw) {
    if (!Number.isFinite(v)) continue;
    const w = Math.round(v);
    // Non-positive speeds are dropped, not swept. A typed "-3" would otherwise
    // solve at the lowest spectrum the catalog has and write an honestly
    // labelled `grid_ws-3_night.tif` describing a wind that does not exist.
    if (w <= 0) continue;
    seen.add(w);
  }
  return [...seen].sort((a, b) => a - b);
}

/// The wind speeds to offer before the user edits them.
///
/// In priority order, because each answers "what is this sweep for?":
///
///   1. The speeds every turbine's catalog covers — the intersection, since a
///      speed one turbine has no spectrum for would silently be solved at the
///      nearest one it does have.
///   2. Failing that (no turbines), the speeds the receivers' limit tables name:
///      a BESS project with a wind-dependent limit curve is a real assessment,
///      and the limit is the only thing moving.
///   3. Failing both, just the scenario's own wind speed, so the dialog opens
///      with something rather than empty.
///
/// `lookupWindSpeeds` is injected because the catalog import drags Firebase in,
/// and this module is on the export path. The UI passes the real lookup.
export function defaultSweepSpeeds(
  project: Project,
  lookupWindSpeeds: (source: Project['sources'][number]) => number[] | null,
): number[] {
  const covered: number[][] = [];
  for (const s of project.sources) {
    if (s.kind !== 'wtg') continue;
    const ws = lookupWindSpeeds(s);
    if (ws && ws.length > 0) covered.push(normaliseSpeeds(ws));
  }
  if (covered.length > 0) {
    const shared = covered.reduce((acc, cur) => acc.filter((w) => cur.includes(w)));
    if (shared.length > 0) return shared;
  }
  const fromLimits = new Set<number>();
  if (windSpeedLimitsEnabled(project)) {
    for (const r of project.receivers) {
      for (const w of r.limitTable?.windSpeeds ?? []) fromLimits.add(Math.round(w));
    }
  }
  if (fromLimits.size > 0) return [...fromLimits].sort((a, b) => a - b);
  return normaliseSpeeds([project.scenario.windSpeed]);
}

/// How many solves a config will run. Shown before the user commits to it —
/// a 10-speed × 3-period grid sweep is 30 full grids, and that is worth
/// knowing in advance rather than discovering.
export function sweepSolveCount(project: Project, config: SweepConfig): number {
  const groups = groupPeriodsBySolve(project, config.periods).length;
  const per = (config.receivers ? 1 : 0) + (config.grids ? 1 : 0);
  return normaliseSpeeds(config.windSpeeds).length * groups * per;
}

/// Does anything in this project actually depend on wind speed?
///
/// A BESS-only project has one 'broadband' spectrum per mode, so every wind
/// speed in the sweep re-solves the same scene and produces the same number.
/// That is not an error — the limit may still vary with wind speed, which is a
/// perfectly good reason to sweep — but a table of ten identical columns looks
/// like a bug unless it says why it isn't one.
function windDependence(project: Project): { sources: boolean; limits: boolean } {
  return {
    sources: project.sources.some((s) => s.kind === 'wtg'),
    // `isUsableTable`, not "has some wind speeds" — that is the same test
    // `resolveLimit` applies before it will read a table at all. A ragged or
    // half-filled table (a hand-edited document, a partial import) has wind
    // speeds but is silently ignored in favour of the scalar limit, so counting
    // it as wind-dependent suppressed the warning written for precisely that
    // case, and on a turbine-less project actively claimed the limit was what
    // varied across the sweep when nothing did.
    limits: windSpeedLimitsEnabled(project)
      && project.receivers.some((r) => isUsableTable(r.limitTable)),
  };
}

/// Swept speeds that lie outside a turbine's catalog data.
///
/// The symmetrical disclosure to the limit-table clamp. `pickWindSpeed` holds
/// the end spectrum flat past either end of the data, so sweeping 14 m/s on a
/// catalog covering 6–12 reports a level computed from the 12 m/s sound power —
/// and sweeping 3 m/s reports the 6 m/s spectrum for a turbine that is not
/// turning. Both come back as ordinary-looking columns.
///
/// The default speed list is already the intersection of what every turbine
/// covers, precisely so this cannot happen by accident; but the speeds box is
/// free text, and editing it reopened the hole in silence. Saying so costs one
/// line in the notes and is the difference between an extrapolation and a
/// hidden one.
function coverageWarnings(
  project: Project,
  windSpeeds: readonly number[],
  windSpeedsFor: SweepDeps['windSpeedsFor'],
): string[] {
  if (!windSpeedsFor) return [];
  const out: string[] = [];
  for (const s of project.sources) {
    if (s.kind !== 'wtg') continue;
    const covered = normaliseSpeeds(windSpeedsFor(s) ?? []);
    if (covered.length === 0) continue;
    const outside = windSpeeds.filter((w) => w < covered[0] || w > covered[covered.length - 1]);
    if (outside.length === 0) continue;
    out.push(
      `${s.name}: ${outside.join(', ')} m/s ${outside.length === 1 ? 'is' : 'are'} outside its `
      + `catalog data (${covered[0]}–${covered[covered.length - 1]} m/s). The nearest wind `
      + 'speed’s spectrum was used, so those columns are an extrapolation.',
    );
  }
  return out;
}

/// Run the sweep.
///
/// Sequential by design: the grid pool is shared and newest-wins, so two grids
/// in flight is not "twice as fast", it is one grid killed.
///
/// `isCancelled` is polled between solves. Cancelling DURING a grid needs
/// `cancelGridRun()` from the caller as well — the tile loop has no yield point
/// — and that arrives here as a `GRID_CANCELLED` rejection, which is why the
/// two are distinguished below.
export async function runWindSweep(
  project: Project,
  dem: DemRaster | null,
  config: SweepConfig,
  deps: SweepDeps,
  onProgress?: (p: SweepProgress) => void,
  isCancelled?: () => boolean,
): Promise<SweepResult> {
  const windSpeeds = normaliseSpeeds(config.windSpeeds);
  if (windSpeeds.length === 0) throw new Error('Pick at least one wind speed.');
  if (config.periods.length === 0) throw new Error('Pick at least one period.');
  if (!config.receivers && !config.grids) {
    throw new Error('Pick receivers, contour grids, or both — otherwise there is nothing to solve.');
  }

  const started = Date.now();
  const groups = groupPeriodsBySolve(project, config.periods);
  const perState = (config.receivers ? 1 : 0) + (config.grids ? 1 : 0);
  const total = windSpeeds.length * groups.length * perState;
  const states: SweepState[] = [];
  let done = 0;

  const stop = () => {
    if (isCancelled?.()) throw new Error(SWEEP_CANCELLED);
  };
  const report = (label: string, tiles?: { done: number; total: number }) => {
    onProgress?.({ done, total, label, tiles });
  };

  for (const windSpeed of windSpeeds) {
    for (const group of groups) {
      stop();
      // A COPY. The live project must never be mutated by a study — the map,
      // the badges and the autosave are all reading it, and a sweep that left
      // the scenario at 25 m/s would silently redefine what the user is
      // looking at.
      const scoped: Project = {
        ...project,
        scenario: { ...project.scenario, windSpeed, period: group[0] },
      };
      const stem = `${labelFor(group)} · ${windSpeed} m/s`;

      let receivers: ReceiverResult[] | null = null;
      if (config.receivers) {
        report(`${stem} · receivers`);
        receivers = await guard(
          () => deps.solveReceivers(scoped, dem),
          isCancelled,
        );
        done++;
      }

      let grid: GridResult | null = null;
      if (config.grids) {
        // Polled HERE, not only at the top of the loop. A cancel raised while
        // the receivers were solving would otherwise go unseen until the next
        // iteration — after this grid had run to completion, which on a large
        // site is minutes of exactly the wait the user asked to end.
        stop();
        report(`${stem} · contour grid`);
        grid = await guard(
          () => deps.solveGrid(scoped, dem, (d, t) => report(`${stem} · contour grid`, { done: d, total: t })),
          isCancelled,
        );
        done++;
      }
      stop();

      for (const period of group) states.push({ period, windSpeed, receivers, grid });
      report(`${stem} · done`);
    }
  }
  stop();

  const dep = windDependence(project);
  const warnings: string[] = [];
  if (!dep.sources && !dep.limits) {
    warnings.push(
      'Nothing in this project varies with wind speed — there are no wind turbines, and '
      + 'no wind-speed limit tables are in use — so every wind speed in this sweep solved '
      + 'the same scene against the same limits. The columns are identical by construction, '
      + 'not by coincidence.',
    );
  } else if (!dep.sources) {
    warnings.push(
      'This project has no wind turbines, so the LEVELS are the same at every wind speed. '
      + 'What varies across the sweep is the limit, from the wind-speed limit tables.',
    );
  }
  if (dep.sources && !dep.limits && windSpeedLimitsEnabled(project)) {
    warnings.push(
      'Wind-speed limits are switched on but no receiver has a usable limit table, so every '
      + 'receiver was judged against its scalar per-period limit at every wind speed.',
    );
  }
  warnings.push(...coverageWarnings(project, windSpeeds, deps.windSpeedsFor));

  // Order the states as the exports read them: wind speed ascending, then
  // period in the canonical order, rather than in solve-group order.
  states.sort((a, b) => a.windSpeed - b.windSpeed || periodRank(a.period) - periodRank(b.period));

  return {
    config: { ...config, windSpeeds },
    states,
    warnings,
    elapsedMs: Date.now() - started,
  };
}

/// Await a solve, turning the two ways it can be interrupted into messages a
/// caller can act on.
///
/// A grid rejection with `GRID_CANCELLED` while the user has NOT cancelled means
/// something else posted a grid job and terminated the pool — a live regrid
/// after an edit, or a manual "Run grid". Reporting that as a generic failure
/// would be a lie, and silently returning a partial sweep would be worse: the
/// export would be missing wind speeds nobody asked it to skip.
async function guard<T>(run: () => Promise<T>, isCancelled?: () => boolean): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (isCancelled?.()) throw new Error(SWEEP_CANCELLED);
    if (String(e instanceof Error ? e.message : e).includes(GRID_CANCELLED)) {
      throw new Error(
        'Another contour grid started and took over the solver workers, so the sweep '
        + 'stopped. Nothing was kept. Let the map finish its grid, then run the sweep again.',
      );
    }
    throw e;
  }
}

const PERIOD_ORDER: Period[] = ['day', 'evening', 'night'];
function periodRank(p: Period): number {
  return PERIOD_ORDER.indexOf(p);
}

function labelFor(group: Period[]): string {
  return group.map((p) => p[0].toUpperCase() + p.slice(1)).join('/');
}

// ----------------------------------------------------------- reading it back

/// One receiver at one wind speed.
export interface SweepReceiverCell {
  windSpeed: number;
  /// Assessed level — the solved level plus any tonality penalty, i.e. the
  /// number the pass/fail verdict is actually made on. Null when the receiver
  /// did not solve.
  levelDb: number | null;
  /// The limit AT THIS WIND SPEED. With limit tables in use this is a different
  /// number in each column, which is half the reason the sweep exists.
  limitDb: number;
  limitSource: LimitSource;
  /// `limitDb − levelDb`. Negative means over. Null when there is no level.
  marginDb: number | null;
  /// Judged with the project's own limit-comparison rule, so a sweep cell and
  /// the map badge can never disagree.
  exceeds: boolean;
}

export interface SweepReceiverRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heightAboveGroundM: number;
  cells: SweepReceiverCell[];
  /// The worst cell — least margin — and the wind speed it happened at. This is
  /// the answer to the question the sweep was run to ask. Null when nothing
  /// solved.
  worst: SweepReceiverCell | null;
  /// Wind speeds this receiver fails at, ascending. Empty means compliant right
  /// across the sweep.
  failsAt: number[];
}

/// Reduce a sweep to the per-period table the UI draws and the XLSX writes.
///
/// One function, two consumers, on purpose: a summary table on screen that
/// disagrees with the spreadsheet exported from the same run is the sort of
/// thing that gets noticed in a hearing.
export function sweepReceiverRows(
  project: Project,
  sweep: SweepResult,
  period: Period,
): SweepReceiverRow[] {
  const comparison = limitComparisonFor(project);
  const states = sweep.states
    .filter((s) => s.period === period && s.receivers != null)
    .sort((a, b) => a.windSpeed - b.windSpeed);

  return project.receivers.map((rx) => {
    const cells: SweepReceiverCell[] = states.map((state) => {
      const r = state.receivers!.find((x) => x.receiverId === rx.id) ?? null;
      const levelDb = assessedLevel(r);
      const limit = resolveLimit(project, rx, period, state.windSpeed);
      return {
        windSpeed: state.windSpeed,
        levelDb,
        limitDb: limit.db,
        limitSource: limit.source,
        marginDb: levelDb == null ? null : limit.db - levelDb,
        exceeds: exceedsLimit(levelDb, limit.db, comparison),
      };
    });
    // Least margin wins. Ties keep the LOWER wind speed — first past the post in
    // an ascending list — so a plateau reports the speed it starts at.
    let worst: SweepReceiverCell | null = null;
    for (const c of cells) {
      if (c.marginDb == null) continue;
      if (worst?.marginDb == null || c.marginDb < worst.marginDb) worst = c;
    }
    return {
      id: rx.id,
      name: rx.name,
      lat: rx.latLng[0],
      lng: rx.latLng[1],
      heightAboveGroundM: rx.heightAboveGroundM,
      cells,
      worst,
      failsAt: cells.filter((c) => c.exceeds).map((c) => c.windSpeed),
    };
  });
}

/// One state's traced contours, tagged with the state that produced them.
///
/// The tag is the point of the whole grid half of the sweep: a shapefile of
/// forty overlapping contour sets is useless unless each feature says which wind
/// speed and period it belongs to.
export interface SweepContourLayer {
  period: Period;
  windSpeed: number;
  sets: ContourLineSet[];
}

/// Trace every grid in the sweep at the display levels, on the contour worker,
/// one at a time.
///
/// Sequential rather than `Promise.all`: the worker holds ONE cached raster, so
/// interleaved requests would ship each grid repeatedly and race the cache. It
/// also keeps `onProgress` meaningful — a sweep of thirty grids takes long
/// enough that a frozen dialog would read as a hang.
export async function traceSweepContours(
  sweep: SweepResult,
  thresholds: readonly number[],
  custom: readonly CustomContourLine[] | undefined,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<SweepContourLayer[]> {
  const states = sweep.states.filter((s) => s.grid != null);
  const out: SweepContourLayer[] = [];
  for (const state of states) {
    if (isCancelled?.()) throw new Error(SWEEP_CANCELLED);
    out.push({
      period: state.period,
      windSpeed: state.windSpeed,
      sets: await traceForExport(state.grid!, thresholds, custom),
    });
    onProgress?.(out.length, states.length);
  }
  return out;
}

/// Periods a sweep actually holds results for, in canonical order.
export function sweepPeriods(sweep: SweepResult, kind: 'receivers' | 'grid'): Period[] {
  return PERIOD_ORDER.filter((p) => sweep.states.some(
    (s) => s.period === p && (kind === 'receivers' ? s.receivers != null : s.grid != null),
  ));
}

/// Wind speeds a sweep holds results for, ascending.
export function sweepSpeeds(sweep: SweepResult, kind: 'receivers' | 'grid'): number[] {
  const seen = new Set<number>();
  for (const s of sweep.states) {
    if (kind === 'receivers' ? s.receivers != null : s.grid != null) seen.add(s.windSpeed);
  }
  return [...seen].sort((a, b) => a - b);
}
