import test from 'node:test';
import assert from 'node:assert/strict';

import { Diagnostics, summariseDiagnostics } from './diagnostics';

test('a cap that fires on every tile is ONE note, not four hundred', () => {
  const d = new Diagnostics();
  for (let i = 0; i < 400; i++) {
    d.note('sources.cutoff', 'info', 'Contributions beyond 20.0 km dropped.');
  }
  assert.equal(d.size, 1);
  assert.equal(d.list()[0].count, 400, 'but the count still tells you how often');
});

test('the FIRST message is kept — it carries the numbers', () => {
  const d = new Diagnostics();
  d.note('terrain.resampled', 'material', 'Resampled to 24 m (DEM provides 20 m).');
  d.note('terrain.resampled', 'material', 'Resampled to 99 m (DEM provides 20 m).');
  assert.match(d.list()[0].message, /24 m/);
});

test('a cap that is material anywhere is material overall', () => {
  const d = new Diagnostics();
  d.note('x', 'info', 'first');
  d.note('x', 'material', 'second');
  assert.equal(d.list()[0].severity, 'material');
});

test('material notes sort first, then by how often they fired', () => {
  const d = new Diagnostics();
  d.note('info.rare', 'info', 'a');
  d.note('info.common', 'info', 'b', 50);
  d.note('material.one', 'material', 'c');
  assert.deepEqual(d.list().map((x) => x.code),
    ['material.one', 'info.common', 'info.rare']);
});

test('merging worker notes does not double-count codes', () => {
  // Grid tiles solve in a worker and report separately.
  const main = new Diagnostics();
  main.note('sources.cutoff', 'info', 'dropped', 10);
  const worker = new Diagnostics();
  worker.note('sources.cutoff', 'info', 'dropped', 5);
  worker.note('terrain.resampled', 'material', 'coarser');

  main.merge(worker);
  assert.equal(main.size, 2);
  const cutoff = main.list().find((d) => d.code === 'sources.cutoff')!;
  assert.equal(cutoff.count, 15);
});

test('a clean solve reports nothing rather than a reassuring zero', () => {
  assert.equal(summariseDiagnostics([]), null);
  assert.equal(new Diagnostics().size, 0);
});

test('the summary flags when something can actually move levels', () => {
  const d = new Diagnostics();
  d.note('a', 'info', 'bounded a resource');
  assert.equal(summariseDiagnostics(d.list()), '1 approximation');

  d.note('b', 'material', 'changed the model');
  assert.equal(summariseDiagnostics(d.list()), '2 approximations · 1 can move levels');
});
