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

import {
  buildCellModel, capDbFor, describeCell, powerKwAt, precheckCurtailment,
  summariseWarnings, transferFromResults,
} from './curtailment';
import type { CellModel } from './curtailment';
import { exceedsLimit } from './limits';
import type { LimitComparison } from './limits';
import type { CatalogEntry, Project, Receiver } from './types';
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
    optionCostKw: [[0]],
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

// -------------------------------------------- power curves that stop at cut-in

/// A V163-shaped catalog entry: spectra from 3 m/s (as the datasheet gives
/// them), and a power curve entered from cut-in upward — which is what a real
/// datasheet carries and what anyone actually types in.
function v163(powerFrom: number, powerTo: number): CatalogEntry {
  const windSpeeds = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const spectra: Record<string, number[]> = {};
  const powerKw: Record<string, number> = {};
  for (const w of windSpeeds) {
    spectra[String(w)] = new Array(10).fill(90);
    if (w >= powerFrom && w <= powerTo) powerKw[String(w)] = Math.min(4500, (w - 2) * 500);
  }
  return {
    id: 'V163', kind: 'wtg', displayName: 'V163 4.5 MW', defaultMode: 'PO4500',
    origin: 'user',
    modes: [{
      name: 'PO4500', bandSystem: 'octave', weighting: 'A',
      frequencies: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
      spectra, windSpeeds, powerKw,
    }],
  } as unknown as CatalogEntry;
}

function farm(entry: CatalogEntry): Project {
  return {
    ...project('exact'),
    localCatalog: [entry],
    sources: [{
      id: 'T1', name: 'WTG-1', kind: 'wtg', latLng: [-33.61, 138.71],
      modelId: entry.id, catalogScope: 'local',
    }],
  } as unknown as Project;
}

test('a power curve that starts at cut-in is accepted, not refused', () => {
  // THE REGRESSION THIS PINS. The precheck used to demand a kW entry at every
  // wind speed the mode has a SPECTRUM for. A V163's spectra start at 3 m/s
  // and its power curve sensibly starts at cut-in, so complete, ordinary data
  // was refused — naming all 55 turbines and blocking the optimiser outright,
  // with no way to tell which speeds it wanted.
  const pre = precheckCurtailment(farm(v163(4, 15)));
  assert.deepEqual(pre.reasons, []);
  assert.equal(pre.ok, true);
});

test('a mode with no power curve at all is still refused, and named', () => {
  // The check that was worth having is untouched: without any kW, the cost of
  // a quieter mode is unknown and a schedule would be invented.
  const pre = precheckCurtailment(farm(v163(99, 99)));   // no keys written
  assert.equal(pre.ok, false);
  assert.ok(pre.reasons.some((r: string) => /no power curve/.test(r)), pre.reasons.join(' | '));
  assert.ok(pre.reasons.some((r: string) => /WTG-1/.test(r)));
});

test('a gap INSIDE the curve is interpolated without complaint', () => {
  // Reading a power curve between its entered points is what a power curve is
  // for. Only the flat hold past an end is an extrapolation.
  const entry = v163(4, 15);
  delete entry.modes[0].powerKw!['9'];
  const pre = precheckCurtailment(farm(entry));
  assert.deepEqual(pre.reasons, []);
  // …and the interpolated value is the honest midpoint of its neighbours:
  // 8 m/s is 3000 kW and 10 m/s is 4000 kW, so 9 reads 3500.
  assert.equal(powerKwAt(entry.modes[0], 8), 3000);
  assert.equal(powerKwAt(entry.modes[0], 10), 4000);
  assert.equal(powerKwAt(entry.modes[0], 9), 3500);
});

// ------------------------------------------------- ties, and how they break

test('when every mode costs the same, the LEAST curtailed one wins', () => {
  // The bug this pins. Below cut-in a turbine's noise-reduced modes are
  // usually identical to its normal one — same spectrum, same power — so every
  // option costs exactly zero and the MILP is free to return any of them. A
  // schedule came back reading "SO3" at 3 m/s, where SO3 is the same as normal
  // and no curtailment is needed at all: correct arithmetic, useless
  // instruction, and it reads as a solver that has gone wrong.
  const entry = {
    id: 'V', kind: 'wtg', displayName: 'V163', defaultMode: 'PO4500', origin: 'user',
    modes: ['PO4500', 'SO1', 'SO2', 'SO3'].map((name) => ({
      name,
      bandSystem: 'octave',
      weighting: 'Z',
      frequencies: [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
      // Identical in every mode, which is the whole point.
      spectra: { 3: new Array(10).fill(80) },
      windSpeeds: [3],
      powerKw: { 3: 100 },
    })),
  } as unknown as CatalogEntry;

  const p = {
    ...project('exact'),
    localCatalog: [entry],
    sources: [{
      id: 'T1', name: 'WTG-1', kind: 'wtg', latLng: [-33.61, 138.71],
      modelId: 'V', catalogScope: 'local',
    }],
    // A limit nothing can breach, so the acoustic constraint is slack and the
    // choice really is a free one.
    receivers: [rx({ limitNightDbA: 200 })],
  } as unknown as Project;

  const { cell } = buildCellModel(p, new Map(), 'night', 3, 0);
  const costs = cell.model.groups[0].options.map((o) => o.cost);
  // Every running mode costs no generation…
  assert.deepEqual(cell.optionCostKw[0].slice(0, 4), [0, 0, 0, 0]);
  // …but the MILP costs are strictly increasing, so there is no tie left for a
  // solver to break arbitrarily, and the default sorts first.
  assert.ok(costs[0] < costs[1] && costs[1] < costs[2] && costs[2] < costs[3], costs.join(','));
  assert.equal(cell.optionModes[0][0], 'PO4500');
  // The separation is far below any real kW difference — it can only ever
  // order genuine ties, never outrank one.
  assert.ok(costs[3] - costs[0] < 1e-4, `tie-break spans ${costs[3] - costs[0]} kW`);
});

test('a real kW difference still outranks the tie-break', () => {
  // The guard on the guard: if the ordering coefficient were large enough to
  // compete with generation, the optimiser would start preferring a louder
  // mode over a cheaper one and the whole objective would be wrong.
  const entry = {
    id: 'V', kind: 'wtg', displayName: 'V163', defaultMode: 'LOUD', origin: 'user',
    modes: [
      { name: 'LOUD', bandSystem: 'octave', weighting: 'Z', frequencies: [63], spectra: { 8: [100] }, windSpeeds: [8], powerKw: { 8: 100 } },
      { name: 'QUIET', bandSystem: 'octave', weighting: 'Z', frequencies: [63], spectra: { 8: [90] }, windSpeeds: [8], powerKw: { 8: 99.9 } },
    ],
  } as unknown as CatalogEntry;
  const p = {
    ...project('exact'),
    localCatalog: [entry],
    sources: [{ id: 'T1', name: 'WTG-1', kind: 'wtg', latLng: [-33.61, 138.71], modelId: 'V', catalogScope: 'local' }],
    receivers: [rx({ limitNightDbA: 200 })],
  } as unknown as Project;
  const { cell } = buildCellModel(p, new Map(), 'night', 8, 0);
  const [loud, quiet] = cell.model.groups[0].options;
  // 0.1 kW apart in reality; the ordering must not close that gap.
  assert.ok(loud.cost < quiet.cost);
  assert.ok(quiet.cost - loud.cost > 0.09, `${quiet.cost - loud.cost}`);
});

// ------------------------------------------------------- warning summaries

test('the same note about 55 turbines collapses to one line', () => {
  // Fifty-five separate warnings is the same as no warnings: nobody reads a
  // wall of text, and the one that mattered is buried in it.
  const many = Array.from({ length: 55 }, (_, i) => ({
    subject: `WTG-${i + 1}`,
    text: 'no power entered at 3 m/s.',
  }));
  const out = summariseWarnings(many);
  assert.equal(out.length, 1);
  assert.match(out[0], /^55 turbines \(WTG-1, WTG-2, …\): no power entered at 3 m\/s\.$/);
});

test('a handful are named outright, and different notes stay separate', () => {
  const out = summariseWarnings([
    { subject: 'WTG-1', text: 'note A' },
    { subject: 'WTG-2', text: 'note A' },
    { subject: 'R1', text: 'note B' },
  ]);
  assert.equal(out.length, 2);
  assert.ok(out.includes('WTG-1, WTG-2: note A'));
  assert.ok(out.includes('R1: note B'));
});
