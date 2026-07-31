import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allSegments, describeBulk, setModeWhereSupported, swapModel,
} from './bessBulkSwap';
import type { BessSegment, BessSeqItem } from './types';

const seg = (over: Partial<BessSegment>): BessSegment => ({
  id: 's', catalogScope: 'global', modelId: 'mp', count: 4,
  spacingWithinM: 1.5, gapAfterM: 0, ...over,
} as BessSegment);

const row = (id: string, segments: BessSegment[]): BessSeqItem => ({
  kind: 'row', id, row: { id: `${id}-r`, segments }, gapAfterM: 5,
} as unknown as BessSeqItem);

/** A row at the top level plus a row nested inside a group — bulk edits must
 *  reach both, since a group's content is where most units actually live. */
const tree = (): BessSeqItem[] => [
  row('top', [seg({ id: 'a', modelId: 'mp', count: 8 })]),
  {
    kind: 'group', id: 'g1', repeatDown: 2, gapDownM: 5,
    repeatRight: 1, gapRightM: 0, gapAfterM: 0,
    items: [row('inner', [
      seg({ id: 'b', modelId: 'mp', count: 4 }),
      seg({ id: 'c', modelId: 'inv', count: 1 }),
    ])],
  } as unknown as BessSeqItem,
];

test('the walker reaches nested segments, not just top-level rows', () => {
  assert.deepEqual(allSegments(tree()).map((s) => s.id), ['a', 'b', 'c']);
});

test('swapModel rewrites every matching segment at any depth', () => {
  const r = swapModel(
    tree(),
    { scope: 'global', modelId: 'mp' },
    { scope: 'global', modelId: 'mp2', mode: 'nominal' },
  );
  const segs = allSegments(r.sequence);
  assert.deepEqual(segs.map((s) => s.modelId), ['mp2', 'mp2', 'inv'], 'nested one swapped too');
  assert.deepEqual(segs.map((s) => s.modeOverride), ['nominal', 'nominal', undefined]);
  assert.equal(r.changed, 2);
  assert.equal(r.units, 12, '8 + 4 units carried the swapped model');
});

test('swapping without a target mode clears the override to the model default', () => {
  const r = swapModel(
    [row('x', [seg({ modeOverride: 'night' })])],
    { scope: 'global', modelId: 'mp' },
    { scope: 'global', modelId: 'mp2' },
  );
  assert.equal(allSegments(r.sequence)[0].modeOverride, undefined,
    'the old mode name may not exist on the new model');
});

test('swapModel leaves non-matching models untouched', () => {
  const before = tree();
  const r = swapModel(before, { scope: 'global', modelId: 'nope' }, { scope: 'global', modelId: 'x' });
  assert.equal(r.changed, 0);
  assert.equal(r.units, 0);
  assert.deepEqual(allSegments(r.sequence).map((s) => s.modelId), ['mp', 'mp', 'inv']);
});

// ------------------------------------------------------- mode-only, with skips

const modesFor = (_scope: string, modelId: string) =>
  modelId === 'mp' ? ['nominal', 'night'] : ['nominal'];

test('mode-only change applies where supported and reports the skips', () => {
  const r = setModeWhereSupported(tree(), 'night', modesFor as never);
  const segs = allSegments(r.sequence);
  assert.deepEqual(segs.map((s) => s.modeOverride), ['night', 'night', undefined]);
  assert.equal(r.changed, 2);
  assert.equal(r.units, 12);
  // The inverter has no 'night' mode — left completely alone, not forced.
  assert.equal(r.skipped, 1);
  assert.equal(r.skippedUnits, 1);
});

test('a mode every model supports skips nothing', () => {
  const r = setModeWhereSupported(tree(), 'nominal', modesFor as never);
  assert.equal(r.skipped, 0);
  assert.equal(r.units, 13, 'all 8 + 4 + 1 units');
});

test('segments already on the target mode are not counted as changed', () => {
  const once = setModeWhereSupported(tree(), 'night', modesFor as never);
  const twice = setModeWhereSupported(once.sequence, 'night', modesFor as never);
  assert.equal(twice.changed, 0, 'idempotent — re-applying changes nothing');
  assert.equal(twice.units, 0);
});

test('describeBulk names the units and the skips', () => {
  const r = setModeWhereSupported(tree(), 'night', modesFor as never);
  const msg = describeBulk(r, 'set to "night"');
  assert.match(msg, /12 units set to "night"\./);
  assert.match(msg, /1 unit skipped \(mode not available\)\./);

  const clean = setModeWhereSupported(tree(), 'nominal', modesFor as never);
  assert.doesNotMatch(describeBulk(clean, 'set'), /skipped/);
});
