import test from 'node:test';
import assert from 'node:assert/strict';

import { exceedsLimit, limitComparisonFor } from './limits';
import type { Project } from './types';

const projectWith = (limitComparison?: 'integer' | 'exact') =>
  ({ settings: limitComparison ? { limitComparison } : {} } as unknown as Project);

test('integer mode: only a genuine exceedance fails', () => {
  // The locked example: 40.4 rounds to 40, which does not exceed 40.
  assert.equal(exceedsLimit(40.4, 40, 'integer'), false, '40.4 → 40, passes');
  assert.equal(exceedsLimit(40.6, 40, 'integer'), true, '40.6 → 41, fails');
  // Half-up at the boundary.
  assert.equal(exceedsLimit(40.5, 40, 'integer'), true, '40.5 → 41 (half-up), fails');
  assert.equal(exceedsLimit(40.49, 40, 'integer'), false);
  // Comfortably over / under.
  assert.equal(exceedsLimit(44, 40, 'integer'), true);
  assert.equal(exceedsLimit(35.2, 40, 'integer'), false);
});

test('exact mode compares unrounded', () => {
  assert.equal(exceedsLimit(40.4, 40, 'exact'), true, 'any excess fails in exact mode');
  assert.equal(exceedsLimit(40.0001, 40, 'exact'), true);
  assert.equal(exceedsLimit(39.9999, 40, 'exact'), false);
});

test('landing exactly on the limit passes in both modes', () => {
  assert.equal(exceedsLimit(40, 40, 'integer'), false);
  assert.equal(exceedsLimit(40, 40, 'exact'), false);
  // And a level that ROUNDS onto the limit also passes.
  assert.equal(exceedsLimit(40.2, 40, 'integer'), false);
});

test('only the level rounds — the limit is taken as entered', () => {
  // A 40.6 dB limit is unusual but legal; it must not be rounded to 41.
  assert.equal(exceedsLimit(41, 40.6, 'integer'), true, '41 > 40.6');
  assert.equal(exceedsLimit(40.4, 40.6, 'integer'), false, '40 ≤ 40.6');
});

test('no result is not a failure', () => {
  for (const bad of [null, undefined, NaN, Infinity]) {
    assert.equal(exceedsLimit(bad as number | null, 40, 'integer'), false, `level ${String(bad)}`);
    assert.equal(exceedsLimit(bad as number | null, 40, 'exact'), false, `level ${String(bad)}`);
  }
  // A non-finite LIMIT can't judge anything either.
  assert.equal(exceedsLimit(80, NaN, 'integer'), false);
});

test('negative levels round half-up toward +infinity, as documented', () => {
  // No real receiver sits here, but the behaviour is defined rather than
  // accidental: Math.round(-40.5) === -40.
  assert.equal(exceedsLimit(-40.5, -41, 'integer'), true, '-40.5 → -40 > -41');
  assert.equal(exceedsLimit(-40.6, -41, 'integer'), false, '-40.6 → -41, equal, passes');
});

test('integer is the default when the project says nothing', () => {
  assert.equal(limitComparisonFor(projectWith()), 'integer');
  assert.equal(limitComparisonFor(projectWith('exact')), 'exact');
  assert.equal(limitComparisonFor(projectWith('integer')), 'integer');
  // A project with no settings object at all still resolves.
  assert.equal(limitComparisonFor({} as unknown as Project), 'integer');
});

test('the default flips a marginal receiver green relative to exact mode', () => {
  // This is the visible behaviour change on existing projects, pinned so it is
  // a decision rather than a surprise.
  const level = 40.4, limit = 40;
  assert.equal(exceedsLimit(level, limit, limitComparisonFor(projectWith())), false);
  assert.equal(exceedsLimit(level, limit, 'exact'), true);
});
