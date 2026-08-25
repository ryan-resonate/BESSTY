// The plumbing between "transfer matrix" and "LP model" — the part the review
// found had no tests, and where both of its real defects were living.
//
// The invariant that matters most is the first one below: the cap the optimiser
// enforces and the verdict the compliance badge reaches must be the SAME rule.
// When they drift, the study exports a schedule as compliant that the app's own
// map then marks red, and nothing in the type system or the existing tests
// notices.

import test from 'node:test';
import assert from 'node:assert/strict';

import { capDbFor, describeCell, powerKwAt, transferFromResults } from './curtailment';
import type { CellModel } from './curtailment';
import { exceedsLimit } from './limits';
import type { LimitComparison } from './limits';
import type { Project, Receiver } from './types';
import type { ReceiverResult } from './solver';

function rx(over: Partial<Receiver> = {}): Receiver {
  return {
    id: 'R1', name: 'R1', latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
    limitDayDbA: 45, limitEveningDbA: 42, limitNightDbA: 40,
    ...over,
  } as Receiver;
}

function project(comparison: LimitComparison): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
    sources: [], barriers: [], receivers: [rx()],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: comparison,
    } as Project['settings'],
  } as Project;
}

// -------------------------------------------------- the cap IS the verdict

test('the cap the optimiser enforces admits exactly what the badge passes', () => {
  // Fractional limits are ordinary — "background + 5 dB" and pasted limit
  // tables both produce them — and they are where the two rules came apart.
  // `exceedsLimit` rounds the LEVEL and compares with the limit as entered, so
  // a 37.3 dB limit passes up to 37.49 and fails from 37.5. Adding the half-
  // decibel to the limit itself instead gave a cap of 37.8, certifying
  // schedules the map marks red.
  for (const comparison of ['integer', 'exact'] as LimitComparison[]) {
    const p = project(comparison);
    for (const limit of [40, 37.3, 37.5, 37.9, 35.05, 0, -0.5]) {
      const r = rx({ limitNightDbA: limit });
      const { capDb } = capDbFor(p, r, 'night', 10, 0);
      // Walk a fine grid across the cap and require agreement at every point.
      for (let d = -1.2; d <= 1.2; d += 0.05) {
        const level = Number((capDb + d).toFixed(4));
        const admitted = level <= capDb;
        const passes = !exceedsLimit(level, limit, comparison);
        assert.equal(
          admitted, passes,
          `${comparison} limit ${limit}: level ${level} admitted=${admitted} but badge passes=${passes} (cap ${capDb})`,
        );
      }
    }
  }
});

test('the margin comes off the cap, not off the limit before rounding', () => {
  // A 2 dB margin must move the admitted level down by exactly 2 dB, whatever
  // the rounding rule is doing.
  const p = project('integer');
  const r = rx({ limitNightDbA: 37.3 });
  const none = capDbFor(p, r, 'night', 10, 0).capDb;
  const two = capDbFor(p, r, 'night', 10, 2).capDb;
  assert.ok(Math.abs((none - two) - 2) < 1e-9, `${none} − ${two} should be 2`);
});

// ------------------------------------------- naming the blocking receiver

/// A minimal infeasible cell: two receivers, both already over their caps by
/// different amounts, and a single turbine whose only option is silent.
function blockedCell(): CellModel {
  const receivers = [
    // 0.21 dB over a 40 dB cap, but a LARGE absolute energy.
    { id: 'hi', name: 'R_hi', capDb: 40, fixedEnergy: 1.05e4, availableEnergy: 1e4 - 1.05e4 },
    // 10 dB over a 20 dB cap — far worse — but a small absolute energy.
    { id: 'lo', name: 'R_lo', capDb: 20, fixedEnergy: 1e3, availableEnergy: 1e2 - 1e3 },
  ];
  return {
    model: {
      groups: [{ key: 't1', options: [{ key: 't1::off', cost: 0, use: [0, 0] }] }],
      capacities: receivers.map((r) => r.availableEnergy),
    },
    receivers,
    turbineIds: ['t1'],
    optionModes: [['__off']],
  };
}

test('an infeasible cell names the receiver that is worst in DECIBELS', () => {
  // Ranking on an energy difference put the 0.21 dB receiver first, because its
  // cap — and therefore its energies — were four orders of magnitude larger.
  // The export then reported a cell that is 10 dB beyond help as a 0.2 dB
  // problem, which is the difference between "add a margin" and "this layout
  // cannot work".
  const out = describeCell(
    blockedCell(), { status: 'infeasible', chosen: [], cost: 0 }, 'night', 10,
  );
  assert.equal(out.bindingReceiverName, 'R_lo');
  assert.ok(out.marginAtBindingDb != null && out.marginAtBindingDb < -9,
    `expected about −10 dB, got ${out.marginAtBindingDb}`);
});

// ------------------------------------------------------------ power curves

test('a power curve holds flat past its ends and never invents a value', () => {
  const m = { powerKw: { 8: 1000, 10: 2000, 12: 2500 } };
  assert.equal(powerKwAt(m, 4), 1000);          // below the first point
  assert.equal(powerKwAt(m, 8), 1000);
  assert.equal(powerKwAt(m, 9), 1500);          // interpolated
  assert.equal(powerKwAt(m, 25), 2500);         // above the last
  assert.equal(powerKwAt({}, 10), null);        // no curve at all
  assert.equal(powerKwAt({ powerKw: {} }, 10), null);
  // A single point is a flat curve, not an error.
  assert.equal(powerKwAt({ powerKw: { 10: 900 } }, 4), 900);
  // Unsorted and non-numeric keys survive.
  assert.equal(powerKwAt({ powerKw: { 12: 2500, 8: 1000, x: 5 } as never }, 12), 2500);
});

// ------------------------------------------------------ transfer semantics

test('a band that did not arrive stays at −Infinity, which is zero energy', () => {
  const lw = new Float64Array([100, 100, 100]);
  const results: ReceiverResult[] = [{
    receiverId: 'R1',
    perBandLp: new Float64Array(3),
    totalDbA: 0,
    perSource: [{ sourceId: 'S1', perBandLp: new Float64Array([50, -Infinity, 40]) }],
  }];
  const t = transferFromResults(new Map([['S1', lw]]), results)!.get('S1')!.get('R1')!;
  assert.equal(t[0], -50);
  // NOT 0 dB, which would be an enormous transfer rather than an absent one.
  assert.equal(t[1], -Infinity);
  assert.equal(t[2], -60);
});

test('a source whose Lw length disagrees with the solve is dropped, not mixed', () => {
  // A band-system change between pinning and solving would otherwise subtract
  // arrays of different lengths and produce silent nonsense.
  const results: ReceiverResult[] = [{
    receiverId: 'R1',
    perBandLp: new Float64Array(3),
    totalDbA: 0,
    perSource: [{ sourceId: 'S1', perBandLp: new Float64Array([50, 40, 30]) }],
  }];
  const t = transferFromResults(new Map([['S1', new Float64Array([100, 100])]]), results);
  assert.equal(t.get('S1'), undefined);
});
