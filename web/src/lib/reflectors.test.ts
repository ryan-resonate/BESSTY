import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cullFacades, enumeratedPaths, facadesFromFootprint, maxReflectorsFor,
  MAX_ENUMERATED_PATHS, type Facade,
} from './reflectors';

const facade = (x: number, alpha = 0.2): Facade => ({
  segment: [[x, 0], [x, 10]], base_z: 0, top_z: 5, alpha,
});

// ------------------------------------------------------------------- budget

test('the enumeration count matches the engine guard formula', () => {
  // Sum over k of m*(m-1)^(k-1).
  assert.equal(enumeratedPaths(10, 2), 90);
  assert.equal(enumeratedPaths(10, 3), 90 + 810);
  assert.equal(enumeratedPaths(1, 3), 0, 'one reflector enumerates no sequences');
  assert.equal(enumeratedPaths(50, 1), 0, 'first order is not enumerated');
});

test('order 3 caps at 46 surfaces — the number that shapes this feature', () => {
  assert.equal(maxReflectorsFor(3), 46);
  assert.ok(enumeratedPaths(46, 3) <= MAX_ENUMERATED_PATHS);
  assert.ok(enumeratedPaths(47, 3) > MAX_ENUMERATED_PATHS, '47 would be rejected');
  // A container is 4 facades, so this is ~11 units.
  assert.ok(maxReflectorsFor(2) > maxReflectorsFor(3), 'lower order allows more');
  assert.equal(maxReflectorsFor(1), Number.MAX_SAFE_INTEGER, 'first order is unbounded');
});

// ------------------------------------------------------------------- culling

test('facades far from every source-receiver line are dropped', () => {
  const near = facade(0);
  const far = facade(10000);
  const r = cullFacades([near, far], [[-100, 5]], [[100, 5]], { order: 1, corridorM: 250 });
  assert.equal(r.facades.length, 1);
  assert.equal(r.facades[0], near);
});

test('degenerate and fully-absorptive facades are dropped', () => {
  const zeroHeight: Facade = { segment: [[0, 0], [0, 10]], base_z: 5, top_z: 5, alpha: 0 };
  const zeroLength: Facade = { segment: [[0, 0], [0, 0]], base_z: 0, top_z: 5, alpha: 0 };
  // alpha = 1 gives 10*lg(1-alpha) = -infinity, i.e. no contribution at all.
  const perfectAbsorber = facade(0, 1);
  const r = cullFacades(
    [zeroHeight, zeroLength, perfectAbsorber, facade(0)],
    [[-100, 5]], [[100, 5]], { order: 1 },
  );
  assert.equal(r.facades.length, 1);
});

test('the order degrades rather than emitting a scene the engine would reject', () => {
  // 60 facades all on-path: too many for order 3 (46), fine for order 2.
  const many = Array.from({ length: 60 }, (_, i) => facade(i));
  const r = cullFacades(many, [[-100, 5]], [[100, 5]], { order: 3, corridorM: 100000 });
  assert.equal(r.degraded, true);
  assert.ok(r.order < 3, `expected degradation, got order ${r.order}`);
  assert.ok(enumeratedPaths(r.facades.length, r.order) <= MAX_ENUMERATED_PATHS,
    'whatever survives must fit the guard');
});

test('a set that fits is not degraded and keeps every facade', () => {
  const few = Array.from({ length: 10 }, (_, i) => facade(i));
  const r = cullFacades(few, [[-100, 5]], [[100, 5]], { order: 3, corridorM: 100000 });
  assert.equal(r.degraded, false);
  assert.equal(r.order, 3);
  assert.equal(r.facades.length, 10);
  assert.equal(r.droppedForBudget, 0);
});

test('truncation keeps the NEAREST facades and reports how many went', () => {
  // Order 1 is unbounded, so force truncation via a tiny corridor instead.
  const spread = [facade(0), facade(50), facade(5000)];
  const r = cullFacades(spread, [[0, 5]], [[100, 5]], { order: 1, corridorM: 100 });
  assert.equal(r.facades.length, 2, 'the 5 km one is outside the corridor');
});

test('first order is never degraded — there is nothing below it', () => {
  const many = Array.from({ length: 500 }, (_, i) => facade(i));
  const r = cullFacades(many, [[-100, 5]], [[100, 5]], { order: 1, corridorM: 100000 });
  assert.equal(r.order, 1);
  assert.equal(r.degraded, false);
  assert.equal(r.facades.length, 500, 'first order enumerates no sequences, so no cap');
});

// ---------------------------------------------------------------- footprints

test('a container footprint yields four closed facades', () => {
  const corners: Array<[number, number]> = [[0, 0], [5, 0], [5, 2], [0, 2]];
  const f = facadesFromFootprint(corners, 10, 2.6, 0.1);
  assert.equal(f.length, 4);
  // Closed: the last facade returns to the first corner.
  assert.deepEqual(f[3].segment[1], corners[0]);
  assert.equal(f[0].base_z, 10);
  assert.equal(f[0].top_z, 12.6);
  assert.ok(f.every((x) => x.alpha === 0.1));
});
