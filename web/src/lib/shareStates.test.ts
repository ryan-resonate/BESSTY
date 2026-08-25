// What a share offers to publish, and what the publisher's ticks assemble.
//
// The failure that matters here is a state reaching a public URL that the
// publisher did not tick — or, just as bad, one they DID tick silently not
// making it, so a reader switches to a wind speed and sees another one's
// levels under its label.

import test from 'node:test';
import assert from 'node:assert/strict';

import { collectShareStates, estimateBytes, shareStatesFor } from './shareStates';
import type { GridResult, ReceiverResult } from './solver';
import type { LimitTable, Period, Project, Receiver } from './types';
import type { SweepResult } from './windSweep';

function rx(id: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id, name: id, latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
    limitDayDbA: 45, limitEveningDbA: 42, limitNightDbA: 40,
    ...over,
  } as Receiver;
}

function project(over: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1, name: 'Site A', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
    sources: [], barriers: [], receivers: [rx('R1'), rx('R2')],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: 'exact',
    } as Project['settings'],
    ...over,
  } as Project;
}

/// A realistically-sized raster. Size relationships are part of what these
/// tests assert, and a toy 4×4 grid is smaller than two receiver records —
/// which would invert the very comparison the publish dialog is built around.
const grid: GridResult = {
  cols: 30, rows: 30, bounds: { sw: [-33.7, 138.6], ne: [-33.5, 138.8] },
  dbA: new Float32Array(900).fill(35.4), computedMs: 1,
};

function result(id: string, db: number): ReceiverResult {
  return { receiverId: id, perBandLp: new Float64Array(10), totalDbA: db, perSource: [] };
}

function sweepOf(entries: Array<[Period, number]>): SweepResult {
  return {
    config: { windSpeeds: entries.map((e) => e[1]), periods: entries.map((e) => e[0]), receivers: true, grids: true },
    states: entries.map(([period, windSpeed]) => ({
      period, windSpeed,
      receivers: [result('R1', 30 + windSpeed), result('R2', 35)],
      grid,
    })),
    warnings: [], elapsedMs: 1,
  };
}

test('the state on screen is offered, and it is offered first', () => {
  const states = collectShareStates({
    project: project(), results: [result('R1', 38), result('R2', 35)], grid, sweep: null,
  });
  assert.equal(states.length, 1);
  assert.equal(states[0].origin, 'current');
  assert.equal(states[0].period, 'night');
  assert.equal(states[0].windSpeed, 10);
  assert.match(states[0].label, /on screen/);
});

test('nothing computed means nothing offered — not an empty state', () => {
  // A state with no levels and no raster renders as a blank map under a period
  // heading, which a reader cannot tell apart from a compliant one.
  assert.deepEqual(
    collectShareStates({ project: project(), results: null, grid: null, sweep: null }),
    [],
  );
  assert.deepEqual(
    collectShareStates({ project: project(), results: [], grid: null, sweep: null }),
    [],
  );
});

test('sweep states are offered too, and the on-screen duplicate is not listed twice', () => {
  const states = collectShareStates({
    project: project(),
    results: [result('R1', 38), result('R2', 35)],
    grid,
    // 10 m/s night is what the screen already shows.
    sweep: sweepOf([['night', 8], ['night', 10], ['night', 12]]),
  });
  assert.deepEqual(
    states.map((s) => `${s.origin}:${s.windSpeed}`),
    ['current:10', 'sweep:8', 'sweep:12'],
  );
  // Keys are unique, or a tick would toggle two rows.
  assert.equal(new Set(states.map((s) => s.key)).size, states.length);
});

test('each state carries the limit that applied AT ITS OWN wind speed', () => {
  // With limit tables in use the limit differs per state, so it has to travel
  // with the state — a viewer switching wind speed must see the limit that
  // was applied, not the one from whichever state happened to be published
  // first.
  const table: LimitTable = {
    windSpeeds: [8, 10, 12],
    limits: { day: [45, 46, 47], evening: [42, 43, 44], night: [36, 38, 45] },
  };
  const p = project({
    receivers: [rx('R1', { limitTable: table })],
    settings: {
      ...project().settings,
      compliance: { windSpeedLimits: true },
    } as Project['settings'],
  });
  const states = collectShareStates({
    project: p, results: null, grid: null, sweep: sweepOf([['night', 8], ['night', 12]]),
  });
  const byWs = new Map(states.map((s) => [s.windSpeed, s.receivers[0]]));
  assert.equal(byWs.get(8)!.limitDb, 36);
  assert.equal(byWs.get(12)!.limitDb, 45);
  // …and the verdict follows that limit rather than one fixed number: the
  // level RISES with wind speed (38 dB at 8, 42 at 12) and the receiver still
  // goes from failing to passing, because the limit rose faster. Judging both
  // against a single limit would invert the 12 m/s verdict.
  assert.equal(byWs.get(8)!.exceeds, true, '38 dB against a 36 dB limit');
  assert.equal(byWs.get(12)!.exceeds, false, '42 dB against a 45 dB limit');
});

test('a receiver that did not solve is null, never zero and never absent', () => {
  const states = collectShareStates({
    project: project(), results: [result('R1', 38)], grid, sweep: null,
  });
  const r2 = states[0].receivers.find((r) => r.id === 'R2')!;
  assert.equal(r2.levelDb, null);
  assert.equal(r2.assessedDb, null);
  // Absence is not exceedance; the viewer shows a dash.
  assert.equal(r2.exceeds, false);
  // Still present in the list, so the viewer draws the marker rather than
  // silently omitting a receiver from the map.
  assert.equal(states[0].receivers.length, 2);
});

test('only ticked states are assembled, and the grid rides along only when asked', () => {
  const states = collectShareStates({
    project: project(), results: null, grid: null,
    sweep: sweepOf([['night', 8], ['night', 10], ['day', 8]]),
  });
  const picked = new Set([states[0].key, states[2].key]);

  const withGrid = shareStatesFor(states, picked, true, new Map());
  assert.equal(withGrid.length, 2);
  assert.deepEqual(withGrid.map((s) => `${s.period}:${s.windSpeed}`), ['night:8', 'day:8']);
  assert.ok(withGrid.every((s) => s.grid != null));

  const without = shareStatesFor(states, picked, false, new Map());
  assert.ok(without.every((s) => s.grid === undefined));
  // Nothing that was not ticked appears, whatever the flags.
  assert.ok(!without.some((s) => s.period === 'night' && s.windSpeed === 10));
});

test('contours attach to the state they were traced from', () => {
  const states = collectShareStates({
    project: project(), results: null, grid: null,
    sweep: sweepOf([['night', 8], ['night', 12]]),
  });
  const all = new Set(states.map((s) => s.key));
  const contours = new Map([
    [states[1].key, [{ threshold: 35, lines: [[[-27, 152] as [number, number]]] }]],
  ]);
  const out = shareStatesFor(states, all, false, contours);
  // Only the 12 m/s state had contours traced, and only it carries them.
  assert.equal(out.find((s) => s.windSpeed === 8)!.contours, undefined);
  assert.equal(out.find((s) => s.windSpeed === 12)!.contours!.length, 1);
});

test('the estimate tracks the ticks and the grid toggle', () => {
  const states = collectShareStates({
    project: project(), results: null, grid: null,
    sweep: sweepOf([['night', 8], ['night', 10]]),
  });
  const one = new Set([states[0].key]);
  const both = new Set(states.map((s) => s.key));
  assert.ok(estimateBytes(states, both, true) > estimateBytes(states, one, true));
  assert.ok(estimateBytes(states, both, true) > estimateBytes(states, both, false));
  assert.equal(estimateBytes(states, new Set(), true), 0);
  // The raster is the expensive half — the reason the dialog offers to drop it.
  assert.ok(states[0].gridBytes > states[0].receiverBytes);
});
