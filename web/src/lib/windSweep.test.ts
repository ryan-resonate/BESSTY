// The wind sweep: what gets solved, what gets skipped, and what the table means.
//
// Three failures this file exists to prevent, in order of how bad they'd be:
//
//   1. A wind speed silently not solved — the export would show a compliant
//      project because the binding speed was never run.
//   2. The limit not tracking the wind speed. With limit tables in use, judging
//      every column against one limit is a wrong verdict that looks tidy.
//   3. The live project mutated by a study. A sweep that leaves the scenario at
//      25 m/s quietly redefines what the map has been showing all along.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SWEEP_CANCELLED,
  defaultSweepSpeeds,
  normaliseSpeeds,
  runWindSweep,
  sweepPeriods,
  sweepReceiverRows,
  sweepSolveCount,
  sweepSpeeds,
  type SweepConfig,
  type SweepDeps,
  type SweepResult,
} from './windSweep';
import { GRID_CANCELLED, type GridResult, type ReceiverResult } from './solver';
import type { LimitTable, Period, Project, Receiver, Source } from './types';

// ---------------------------------------------------------------- fixtures

function rx(id: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id, name: id, latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
    limitDayDbA: 45, limitEveningDbA: 42, limitNightDbA: 40,
    ...over,
  } as Receiver;
}

function wtg(id: string, over: Partial<Source> = {}): Source {
  return {
    id, name: id, kind: 'wtg', latLng: [-33.61, 138.71],
    modelId: 'M1', catalogScope: 'local',
    ...over,
  } as Source;
}

function proj(over: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1, name: 'Sweep', description: '', createdAt: '', updatedAt: '',
    owner: 'u',
    scenario: {
      windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave',
    },
    sources: [wtg('T1')],
    barriers: [],
    receivers: [rx('R1')],
    ...over,
  } as Project;
}

const grid: GridResult = {
  cols: 2, rows: 2, bounds: { sw: [-33.7, 138.6], ne: [-33.5, 138.8] },
  dbA: new Float32Array([30, 31, 32, 33]), computedMs: 1,
};

/// A deps stub that records every scoped project it is handed, and answers with
/// a level that depends on the wind speed so the tests can tell columns apart.
function recordingDeps(levelAt: (ws: number, period: Period) => number) {
  const seen: Array<{ windSpeed: number; period: Period; kind: 'rx' | 'grid' }> = [];
  const deps: SweepDeps = {
    async solveReceivers(project) {
      seen.push({
        windSpeed: project.scenario.windSpeed, period: project.scenario.period, kind: 'rx',
      });
      return project.receivers.map((r): ReceiverResult => ({
        receiverId: r.id,
        perBandLp: new Float64Array(10),
        totalDbA: levelAt(project.scenario.windSpeed, project.scenario.period),
        perSource: [],
      }));
    },
    async solveGrid(project) {
      seen.push({
        windSpeed: project.scenario.windSpeed, period: project.scenario.period, kind: 'grid',
      });
      return grid;
    },
  };
  return { deps, seen };
}

const cfg = (over: Partial<SweepConfig> = {}): SweepConfig => ({
  windSpeeds: [8, 10, 12], periods: ['night'], receivers: true, grids: false, ...over,
});

// ------------------------------------------------------------ wind speeds

test('wind speeds are whole, ascending and unique', () => {
  assert.deepEqual(normaliseSpeeds([12, 8, 8, 10.4, 9.6, NaN, Infinity]), [8, 10, 12]);
  // 10.4 rounds to 10, which 10 already covers; 9.6 rounds to 10 as well.
  assert.deepEqual(normaliseSpeeds([3.5, 3.4]), [3, 4]);
});

test('the default speeds are the ones EVERY turbine covers, not the union', () => {
  const p = proj({ sources: [wtg('T1'), wtg('T2', { modelId: 'M2' })] });
  const speeds = defaultSweepSpeeds(p, (s) => (s.id === 'T1' ? [6, 8, 10, 12] : [8, 10, 14]));
  // 6 and 12 belong to T1 alone, 14 to T2 alone. A speed one turbine has no
  // spectrum for cannot honestly be swept.
  assert.deepEqual(speeds, [8, 10]);
});

test('with no turbines the defaults come from the limit tables, then the scenario', () => {
  const table: LimitTable = {
    windSpeeds: [6, 8, 10],
    limits: { day: [45, 46, 47], evening: [42, 43, 44], night: [38, 39, 40] },
  };
  const withTables = proj({
    sources: [],
    receivers: [rx('R1', { limitTable: table })],
    settings: { compliance: { windSpeedLimits: true } } as Project['settings'],
  });
  assert.deepEqual(defaultSweepSpeeds(withTables, () => null), [6, 8, 10]);

  // Nothing wind-dependent at all: offer the scenario's own speed rather than
  // an empty box.
  assert.deepEqual(defaultSweepSpeeds(proj({ sources: [] }), () => null), [10]);
});

// --------------------------------------------------------------- the run

test('every requested wind speed is solved, once, in ascending order', async () => {
  const { deps, seen } = recordingDeps((ws) => 30 + ws);
  const out = await runWindSweep(proj(), null, cfg(), deps);
  assert.deepEqual(seen.map((s) => s.windSpeed), [8, 10, 12]);
  assert.deepEqual(sweepSpeeds(out, 'receivers'), [8, 10, 12]);
  assert.equal(out.states.length, 3);
});

test('periods that resolve to the same modes share ONE solve', async () => {
  const { deps, seen } = recordingDeps(() => 35);
  const out = await runWindSweep(
    proj(), null, cfg({ windSpeeds: [8], periods: ['day', 'evening', 'night'] }), deps,
  );
  // One solve, three states: the project has no per-period modes, so day and
  // night are the same scene and re-solving would burn two thirds of the run.
  assert.equal(seen.length, 1);
  assert.equal(out.states.length, 3);
  assert.deepEqual(sweepPeriods(out, 'receivers'), ['day', 'evening', 'night']);
  // All three read the same level, because they ARE the same solve.
  const levels = out.states.map((s) => s.receivers?.[0].totalDbA);
  assert.deepEqual(levels, [35, 35, 35]);
});

test('a per-period mode splits the solve, and each period gets its own numbers', async () => {
  const p = proj({
    sources: [wtg('T1', { modeOverride: { day: 'NRO0', evening: 'NRO0', night: 'NRO2' } })],
  });
  const { deps, seen } = recordingDeps((_ws, period) => (period === 'night' ? 30 : 40));
  const out = await runWindSweep(
    p, null, cfg({ windSpeeds: [8], periods: ['day', 'evening', 'night'] }), deps,
  );
  // Day+evening share; night is its own scene.
  assert.equal(seen.length, 2);
  assert.equal(sweepSolveCount(p, cfg({ windSpeeds: [8], periods: ['day', 'evening', 'night'] })), 2);
  const byPeriod = new Map(out.states.map((s) => [s.period, s.receivers?.[0].totalDbA]));
  assert.equal(byPeriod.get('day'), 40);
  assert.equal(byPeriod.get('night'), 30);
});

test('the live project is never mutated — the scenario it was opened with survives', async () => {
  const p = proj();
  const before = JSON.stringify(p);
  const { deps } = recordingDeps(() => 35);
  await runWindSweep(p, null, cfg({ windSpeeds: [8, 25], grids: true }), deps);
  assert.equal(JSON.stringify(p), before);
  assert.equal(p.scenario.windSpeed, 10);
  assert.equal(p.scenario.period, 'night');
});

test('the solve count promised before the run is the number actually run', async () => {
  const p = proj();
  for (const c of [
    cfg(),
    cfg({ grids: true }),
    cfg({ receivers: false, grids: true, periods: ['day', 'night'] }),
    cfg({ windSpeeds: [8, 8, 8.4] }),
  ]) {
    const { deps, seen } = recordingDeps(() => 35);
    await runWindSweep(p, null, c, deps);
    assert.equal(seen.length, sweepSolveCount(p, c), JSON.stringify(c));
  }
});

test('a config with nothing to solve is refused rather than run empty', async () => {
  const { deps } = recordingDeps(() => 35);
  await assert.rejects(
    () => runWindSweep(proj(), null, cfg({ receivers: false, grids: false }), deps),
    /receivers, contour grids, or both/,
  );
  await assert.rejects(
    () => runWindSweep(proj(), null, cfg({ windSpeeds: [] }), deps), /at least one wind speed/,
  );
  await assert.rejects(
    () => runWindSweep(proj(), null, cfg({ periods: [] }), deps), /at least one period/,
  );
});

// ------------------------------------------------------------ interruption

test('cancelling stops the sweep and yields nothing — no partial export', async () => {
  let solved = 0;
  const deps: SweepDeps = {
    async solveReceivers(project) {
      solved++;
      return project.receivers.map((r): ReceiverResult => ({
        receiverId: r.id, perBandLp: new Float64Array(10), totalDbA: 35, perSource: [],
      }));
    },
    async solveGrid() { return grid; },
  };
  // Cancel once the second wind speed has been solved.
  await assert.rejects(
    () => runWindSweep(
      proj(), null, cfg({ windSpeeds: [8, 10, 12, 14] }), deps, undefined, () => solved >= 2,
    ),
    (e: Error) => e.message === SWEEP_CANCELLED,
  );
  // Nothing beyond the point of cancellation was started.
  assert.equal(solved, 2);
});

test('another grid stealing the workers is reported as that, not as a cancel', async () => {
  const deps: SweepDeps = {
    async solveReceivers() { return []; },
    async solveGrid() { throw new Error(GRID_CANCELLED); },
  };
  await assert.rejects(
    () => runWindSweep(proj(), null, cfg({ receivers: false, grids: true }), deps),
    // The user did not cancel, so saying "cancelled" would be a lie, and a bare
    // "grid cancelled" tells them nothing they can act on.
    /took over the solver workers/,
  );
});

// ------------------------------------------------------------- the table

/// A finished sweep, without running one.
function sweepOf(
  project: Project,
  levels: Record<number, number>,
  period: Period = 'night',
): SweepResult {
  return {
    config: {
      windSpeeds: Object.keys(levels).map(Number), periods: [period],
      receivers: true, grids: false,
    },
    states: Object.entries(levels).map(([ws, db]) => ({
      period,
      windSpeed: Number(ws),
      receivers: project.receivers.map((r): ReceiverResult => ({
        receiverId: r.id, perBandLp: new Float64Array(10), totalDbA: db, perSource: [],
      })),
      grid: null,
    })),
    warnings: [],
    elapsedMs: 0,
  };
}

test('the limit follows the wind speed, column by column', () => {
  const table: LimitTable = {
    windSpeeds: [6, 8, 10],
    limits: { day: [45, 46, 47], evening: [42, 43, 44], night: [38, 39, 42] },
  };
  const p = proj({
    receivers: [rx('R1', { limitTable: table })],
    settings: { compliance: { windSpeedLimits: true } } as Project['settings'],
  });
  const rows = sweepReceiverRows(p, sweepOf(p, { 6: 40, 8: 40, 10: 40 }), 'night');
  assert.deepEqual(rows[0].cells.map((c) => c.limitDb), [38, 39, 42]);
  // Same level at every speed; the verdict still changes, because the LIMIT
  // moved. This is the whole reason the sweep exists.
  assert.deepEqual(rows[0].cells.map((c) => c.exceeds), [true, true, false]);
  assert.deepEqual(rows[0].failsAt, [6, 8]);
  assert.deepEqual(rows[0].cells.map((c) => c.limitSource), ['table', 'table', 'table']);
});

test('a wind speed off the end of the table is reported as clamped, not passed off as entered', () => {
  const table: LimitTable = {
    windSpeeds: [6, 8],
    limits: { day: [45, 46], evening: [42, 43], night: [38, 39] },
  };
  const p = proj({
    receivers: [rx('R1', { limitTable: table })],
    settings: { compliance: { windSpeedLimits: true } } as Project['settings'],
  });
  const rows = sweepReceiverRows(p, sweepOf(p, { 6: 30, 14: 30 }), 'night');
  assert.deepEqual(rows[0].cells.map((c) => c.limitSource), ['table', 'clamped']);
  assert.equal(rows[0].cells[1].limitDb, 39);
});

test('the worst wind speed is the least margin, and a tie takes the lower speed', () => {
  const p = proj();
  const rows = sweepReceiverRows(p, sweepOf(p, { 8: 30, 10: 39, 12: 39 }), 'night');
  assert.equal(rows[0].worst?.windSpeed, 10);
  assert.equal(rows[0].worst?.marginDb, 1);
  // 39 dB against a 40 dB night limit passes at every speed…
  assert.deepEqual(rows[0].failsAt, []);
});

test('the margin is against the ASSESSED level, so a tonality penalty is not lost', () => {
  const p = proj();
  const sweep = sweepOf(p, { 10: 38 });
  sweep.states[0].receivers![0].assessedDbA = 43;      // 38 + a 5 dB penalty
  const rows = sweepReceiverRows(p, sweep, 'night');
  assert.equal(rows[0].cells[0].levelDb, 43);
  assert.equal(rows[0].cells[0].marginDb, -3);
  assert.equal(rows[0].cells[0].exceeds, true);
});

test('a receiver with no result reads as no result, not as compliant', () => {
  const p = proj({ receivers: [rx('R1'), rx('R2')] });
  const sweep = sweepOf(p, { 10: 30 });
  // Drop R2 from the solved set, as a solve that skipped it would.
  sweep.states[0].receivers = sweep.states[0].receivers!.filter((r) => r.receiverId === 'R1');
  const rows = sweepReceiverRows(p, sweep, 'night');
  const r2 = rows.find((r) => r.id === 'R2')!;
  assert.equal(r2.cells[0].levelDb, null);
  assert.equal(r2.cells[0].marginDb, null);
  assert.equal(r2.worst, null);
  assert.deepEqual(r2.failsAt, []);
});

// ------------------------------------------------------------- warnings

test('a project nothing wind-dependent in says so, rather than showing ten identical columns', async () => {
  const p = proj({ sources: [] });
  const { deps } = recordingDeps(() => 35);
  const out = await runWindSweep(p, null, cfg(), deps);
  assert.ok(
    out.warnings.some((w) => /Nothing in this project varies with wind speed/.test(w)),
    out.warnings.join(' | '),
  );
});

test('turbines present and no warning about identical columns', async () => {
  const { deps } = recordingDeps((ws) => 30 + ws);
  const out = await runWindSweep(proj(), null, cfg(), deps);
  assert.ok(!out.warnings.some((w) => /varies with wind speed/.test(w)));
});

// ---------------------------------------------------- review-driven guards

test('a non-positive wind speed is dropped, not swept', () => {
  // A typed "-3" would otherwise solve at the lowest spectrum the catalog has
  // and write an honestly-named grid_ws-3_night.tif describing a wind that does
  // not exist.
  assert.deepEqual(normaliseSpeeds([-3, 0, 8, 10]), [8, 10]);
  assert.deepEqual(normaliseSpeeds([-1, -0.4]), []);
});

test('a swept speed outside a turbine’s catalog data is disclosed as an extrapolation', async () => {
  // The symmetrical warning to the limit-table clamp. Spectra hold flat past
  // either end of their data, so 16 m/s on a 6–12 catalog returns the 12 m/s
  // sound power dressed as a 16 m/s level.
  const { deps } = recordingDeps(() => 35);
  const out = await runWindSweep(
    proj(), null, cfg({ windSpeeds: [4, 8, 16] }),
    { ...deps, windSpeedsFor: () => [6, 8, 10, 12] },
  );
  const note = out.warnings.find((w) => w.includes('outside its catalog data'));
  assert.ok(note, out.warnings.join(' | '));
  assert.match(note!, /4, 16 m\/s/);
  assert.match(note!, /6–12 m\/s/);
});

test('speeds inside the catalog raise no extrapolation note', async () => {
  const { deps } = recordingDeps(() => 35);
  const out = await runWindSweep(
    proj(), null, cfg({ windSpeeds: [8, 10] }),
    { ...deps, windSpeedsFor: () => [6, 8, 10, 12] },
  );
  assert.ok(!out.warnings.some((w) => w.includes('outside its catalog data')));
});

test('a ragged limit table is not counted as wind-dependent', async () => {
  // `resolveLimit` ignores an unusable table and falls back to the scalar
  // limit, so counting one as "the limit varies" suppressed the warning
  // written for exactly that case.
  const ragged = { windSpeeds: [6, 8, 10], limits: { night: [38, 39] } } as unknown as LimitTable;
  const p = proj({
    receivers: [rx('R1', { limitTable: ragged })],
    settings: { compliance: { windSpeedLimits: true } } as Project['settings'],
  });
  const { deps } = recordingDeps(() => 35);
  const out = await runWindSweep(p, null, cfg(), deps);
  assert.ok(
    out.warnings.some((w) => /no receiver has a usable limit table/.test(w)),
    out.warnings.join(' | '),
  );
});

test('cancelling between the receivers and the grid does not still run the grid', async () => {
  // The flag used to be polled once per (speed, period) iteration, so a cancel
  // during a receiver solve went unseen until after the following grid — which
  // on a real site is minutes of exactly the wait being cancelled.
  let receiverSolves = 0;
  let gridSolves = 0;
  const deps: SweepDeps = {
    async solveReceivers() { receiverSolves++; return []; },
    async solveGrid() { gridSolves++; return grid; },
  };
  await assert.rejects(
    () => runWindSweep(
      proj(), null, cfg({ windSpeeds: [8, 10], grids: true }), deps, undefined,
      () => receiverSolves >= 1,
    ),
    (e: Error) => e.message === SWEEP_CANCELLED,
  );
  assert.equal(receiverSolves, 1);
  assert.equal(gridSolves, 0, 'the grid after the cancelled receiver solve must not run');
});
