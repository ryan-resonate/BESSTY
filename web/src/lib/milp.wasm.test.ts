// HiGHS against exhaustive enumeration, on random problems.
//
// The reason for taking an external solver was that it is trusted to be
// correct. That is only worth anything if the LP TEXT we generate means what we
// intend — a mis-scaled row or a mangled variable name produces a confident,
// provably-optimal answer to the wrong question. So the real solver runs here,
// against a brute-force reference, on problems small enough to enumerate.
//
// Costs are compared, never assignments: equal-cost schedules are common (two
// identical turbines curtailed either way round) and which one comes back is
// arbitrary. What must hold is that the cost matches the true optimum and that
// the returned assignment is actually legal.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  isFeasible,
  minimumUse,
  resourceUse,
  setHighsLoader,
  solveByEnumeration,
  solveWithHighs,
  toLpFormat,
  totalCost,
  unsatisfiableResources,
  type MilpModel,
} from './milp';

// The bundled test runs from a temp dir, so `highs` is resolved against the
// real project root the runner hands us.
const root = process.env.BEESTY_WEB_ROOT;
const require = createRequire(join(root ?? process.cwd(), 'package.json'));

setHighsLoader(async () => {
  const loader = require('highs');
  return loader({ locateFile: () => require.resolve('highs/runtime') });
});

/// Deterministic PRNG — a failing case must be reproducible from its seed.
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/// A random farm-shaped model: every group has a zero-cost loud option (running
/// at full power) and progressively quieter, costlier ones, plus an Off that
/// costs the most and uses nothing. Capacities are set from a fraction of the
/// all-loud use, so some problems are comfortable and some are tight.
function randomModel(seed: number, groups: number, opts: number, resources: number, tightness: number): MilpModel {
  const r = rng(seed);
  const gs = [];
  for (let g = 0; g < groups; g++) {
    const loud = Array.from({ length: resources }, () => 0.5 + r() * 10);
    const options = [{ key: 'full', cost: 0, use: loud.slice() }];
    for (let k = 1; k < opts - 1; k++) {
      const f = 1 - k / opts;               // quieter as k rises
      options.push({
        key: `nro${k}`,
        cost: Math.round(k * (20 + r() * 80)),
        use: loud.map((v) => v * f),
      });
    }
    options.push({
      key: '__off',
      cost: Math.round(100 + r() * 400),
      use: loud.map(() => 0),
    });
    gs.push({ key: `t${g}`, options });
  }
  // All-loud use per resource, scaled down to make the constraint bite.
  const allLoud = gs.reduce(
    (acc, g) => acc.map((v, j) => v + g.options[0].use[j]),
    new Array<number>(resources).fill(0),
  );
  return { groups: gs, capacities: allLoud.map((v) => v * tightness) };
}

test('HiGHS matches exhaustive enumeration on random farms', async () => {
  // 4 turbines x 4 modes x 3 receivers = 256 combinations per case — trivial to
  // enumerate, and wide enough that a scaling or naming bug shows up.
  let checked = 0;
  let curtailed = 0;
  for (let seed = 1; seed <= 24; seed++) {
    // Down to a fifth of the all-loud energy: deep curtailment, but always
    // reachable, because Off is on the menu for every turbine.
    const tightness = 0.2 + (seed % 5) * 0.18;
    const model = randomModel(seed, 4, 4, 3, tightness);
    const truth = solveByEnumeration(model);
    const got = await solveWithHighs(model);

    assert.equal(got.status, 'optimal', `seed ${seed}: status`);
    assert.equal(truth.status, 'optimal', `seed ${seed}: reference status`);
    assert.ok(
      Math.abs(got.cost - truth.cost) < 1e-6,
      `seed ${seed}: HiGHS cost ${got.cost} but the true optimum is ${truth.cost}`,
    );
    assert.ok(isFeasible(model, got.chosen), `seed ${seed}: returned an infeasible assignment`);
    assert.equal(totalCost(model, got.chosen), got.cost, `seed ${seed}: cost disagrees with assignment`);
    checked++;
    if (got.cost > 0) curtailed++;
  }
  assert.equal(checked, 24);
  assert.ok(curtailed >= 12, `only ${curtailed} cases actually required curtailment`);
});

test('HiGHS finds the optimum on a farm too large to enumerate', async () => {
  // 12 turbines x 5 modes is 244 million combinations. Enumeration refuses; the
  // MILP must still return a proven optimum, and it must be legal and no worse
  // than a sensible greedy schedule.
  const model = randomModel(7, 12, 5, 4, 0.45);
  assert.equal(solveByEnumeration(model).status, 'error', 'this must be beyond enumeration');

  const got = await solveWithHighs(model);
  assert.equal(got.status, 'optimal');
  assert.ok(isFeasible(model, got.chosen), 'returned an infeasible assignment');

  // Greedy: quieten the worst offender until every capacity is met. Any valid
  // optimum is at most as expensive as this.
  const greedy = model.groups.map(() => 0);
  for (let iter = 0; iter < 200 && !isFeasible(model, greedy); iter++) {
    let worst = -1;
    let worstUse = -Infinity;
    model.groups.forEach((g, i) => {
      if (greedy[i] >= g.options.length - 1) return;
      const u = g.options[greedy[i]].use.reduce((a, b) => a + b, 0);
      if (u > worstUse) { worstUse = u; worst = i; }
    });
    if (worst < 0) break;
    greedy[worst]++;
  }
  if (isFeasible(model, greedy)) {
    assert.ok(
      got.cost <= totalCost(model, greedy) + 1e-6,
      `MILP cost ${got.cost} is worse than a greedy schedule at ${totalCost(model, greedy)}`,
    );
  }
});

test('turning every turbine off is always available, so the farm alone is never infeasible', async () => {
  // Worth stating as a property, because it decides what "infeasible" can even
  // mean for curtailment: Off costs full generation but emits nothing, so any
  // positive capacity is reachable. An impossible cell therefore only ever
  // comes from what the turbines CANNOT switch off — the fixed sources.
  const model = randomModel(3, 3, 3, 2, 0.45);
  model.capacities = model.capacities.map(() => 1e-9);
  assert.deepEqual(unsatisfiableResources(model), []);
  const got = await solveWithHighs(model);
  assert.equal(got.status, 'optimal');
  assert.deepEqual(got.chosen, [2, 2, 2], 'every turbine off — expensive, but legal');
});

test('a limit the fixed sources alone breach is infeasible, and named', async () => {
  // A negative capacity is how that arrives: the cap is the limit MINUS the
  // energy from sources the optimiser cannot touch, so it goes negative exactly
  // when a BESS (or anything else fixed) is already over on its own. The honest
  // answer is that no schedule complies — not the least-bad one called optimal.
  const model = randomModel(3, 3, 3, 2, 0.45);
  model.capacities = [-1, 5];
  assert.deepEqual(unsatisfiableResources(model), [0], 'only the breached resource is named');
  const got = await solveWithHighs(model);
  assert.equal(got.status, 'infeasible');
  assert.equal(solveByEnumeration(model).status, 'infeasible');
});

test('a capacity of exactly zero admits only silence — and is not dropped', async () => {
  // Scaling a row by its capacity is impossible at zero. Skipping the row would
  // let a cheaper, breaching schedule through while the solver reported it as
  // proven optimal, so a zero row goes out unscaled instead.
  const model: MilpModel = {
    groups: [{
      key: 't0',
      options: [
        { key: 'full', cost: 0, use: [3] },
        { key: 'off', cost: 90, use: [0] },
      ],
    }],
    capacities: [0],
  };
  assert.match(toLpFormat(model), /r0: .*<= 0/, 'the zero row must survive into the LP');
  const got = await solveWithHighs(model);
  assert.equal(got.status, 'optimal');
  assert.equal(got.cost, 90, 'the only legal schedule is off');
  assert.deepEqual(got.chosen, [1]);
});

test('a farm that needs no curtailment costs nothing', async () => {
  const model = randomModel(11, 5, 4, 3, 1.0);   // capacity == all-loud use
  const got = await solveWithHighs(model);
  assert.equal(got.status, 'optimal');
  assert.equal(got.cost, 0, 'every turbine should stay at full power');
  assert.deepEqual(got.chosen, [0, 0, 0, 0, 0]);
});

test('rows are scaled so a quiet turbine is not rounded out of a constraint', async () => {
  // HiGHS drops matrix entries below 1e-9 by default. Unscaled, a receiver
  // whose cap is ~1e-4 energy units alongside contributions of ~1e-10 would
  // lose those terms entirely and report a schedule that does not comply.
  const model: MilpModel = {
    groups: [
      {
        key: 't0',
        options: [
          { key: 'full', cost: 0, use: [2e-10] },
          { key: 'off', cost: 50, use: [0] },
        ],
      },
      {
        key: 't1',
        options: [
          { key: 'full', cost: 0, use: [2e-10] },
          { key: 'off', cost: 10, use: [0] },
        ],
      },
    ],
    // Only one of the two may run.
    capacities: [3e-10],
  };
  const lp = toLpFormat(model);
  assert.match(lp, /r0: .*<= 1$/m, 'the resource row is scaled to a unit capacity');
  assert.doesNotMatch(lp, /2e-10/, 'raw sub-tolerance coefficients must not reach the solver');

  const got = await solveWithHighs(model);
  assert.equal(got.status, 'optimal');
  assert.equal(got.cost, 10, 'the cheaper turbine is the one switched off');
  assert.ok(isFeasible(model, got.chosen));
});

test('an empty farm is optimal at no cost, and needs no solver', async () => {
  const got = await solveWithHighs({ groups: [], capacities: [10] });
  assert.deepEqual([got.status, got.cost, got.chosen], ['optimal', 0, []]);
});

test('the helpers agree with the model they describe', () => {
  const model = randomModel(5, 3, 3, 2, 0.5);
  const chosen = [0, 1, 2];
  const use = resourceUse(model, chosen);
  for (let j = 0; j < 2; j++) {
    const manual = model.groups.reduce((a, g, i) => a + g.options[chosen[i]].use[j], 0);
    assert.ok(Math.abs(use[j] - manual) < 1e-12);
  }
  // The quietest-everything floor never exceeds any real assignment.
  const lo = minimumUse(model);
  assert.ok(lo.every((v, j) => v <= use[j] + 1e-12));
});
