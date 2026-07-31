import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPatchWithGroupOverrides, clearOverriddenFields, patchToOverride,
} from './groupOverrides';
import type { BessGroup, Project, Source } from './types';

const src = (id: string, over: Partial<Source> = {}): Source => ({
  id, name: id, kind: 'bess', latLng: [-27, 152],
  modelId: 'mp', catalogScope: 'global', ...over,
} as Source);

const project = (sources: Source[], groups: Partial<BessGroup>[] = []): Project => ({
  id: 'p', name: 'P', sources, receivers: [], barriers: [],
  scenario: { period: 'night', bandSystem: 'octave', windSpeed: 10 },
  bessGroups: groups,
} as unknown as Project);

const member = (id: string, slotKey: string) =>
  src(id, { groupId: 'g1', slotKey });

// ------------------------------------------------------------------ translation

test('only fields the materialiser can re-apply become overrides', () => {
  assert.deepEqual(patchToOverride({ elevationOffset: 3 }), { elevationOffset: 3 });
  assert.deepEqual(patchToOverride({ modeOverride: 'night' }), { modeOverride: 'night' });
  assert.deepEqual(
    patchToOverride({ modelId: 'x', catalogScope: 'global' }),
    { modelOverride: { catalogScope: 'global', modelId: 'x' } },
  );
  // Nothing re-appliable → no override at all.
  assert.equal(patchToOverride({ name: 'renamed' }), null);
  assert.equal(patchToOverride({ yawDeg: 90 }), null);
  // A half-specified model swap isn't a model override.
  assert.equal(patchToOverride({ modelId: 'x' }), null);
});

// --------------------------------------------------------------------- applying

test('a bulk edit on group members writes BOTH the source and the override', () => {
  const p = project([member('u1', 'r0-c0-p0-u0'), member('u2', 'r0-c0-p0-u1')], [{ id: 'g1' }]);
  const next = applyPatchWithGroupOverrides(p, ['u1', 'u2'], { elevationOffset: 3.3 });

  assert.equal(next.sources[0].elevationOffset, 3.3, 'live source updates now');
  assert.deepEqual(next.bessGroups![0].unitOverrides, {
    'r0-c0-p0-u0': { elevationOffset: 3.3 },
    'r0-c0-p0-u1': { elevationOffset: 3.3 },
  }, 'and survives the next re-materialisation');
});

test('standalone sources are patched without inventing overrides', () => {
  const p = project([src('s1')], [{ id: 'g1' }]);
  const next = applyPatchWithGroupOverrides(p, ['s1'], { elevationOffset: 2 });
  assert.equal(next.sources[0].elevationOffset, 2);
  assert.equal(next.bessGroups![0].unitOverrides, undefined, 'no group touched');
});

test('an existing override is merged, not replaced', () => {
  // A unit already nudged on the map must not lose its position because the
  // user then bulk-edited its height.
  const p = project([member('u1', 'k1')], [{
    id: 'g1', unitOverrides: { k1: { latLngDelta: [0.0001, 0.0002] } },
  }]);
  const next = applyPatchWithGroupOverrides(p, ['u1'], { elevationOffset: 5 });
  assert.deepEqual(next.bessGroups![0].unitOverrides!.k1, {
    latLngDelta: [0.0001, 0.0002],
    elevationOffset: 5,
  });
});

test('a patch with nothing re-appliable leaves the group untouched', () => {
  const p = project([member('u1', 'k1')], [{ id: 'g1' }]);
  const next = applyPatchWithGroupOverrides(p, ['u1'], { name: 'renamed' });
  assert.equal(next.sources[0].name, 'renamed');
  assert.equal(next.bessGroups![0].unitOverrides, undefined);
});

test('only the targeted group is rewritten', () => {
  const p = project(
    [member('u1', 'k1'), src('u2', { groupId: 'g2', slotKey: 'k9' })],
    [{ id: 'g1' }, { id: 'g2' }],
  );
  const next = applyPatchWithGroupOverrides(p, ['u1'], { elevationOffset: 1 });
  assert.deepEqual(Object.keys(next.bessGroups![0].unitOverrides ?? {}), ['k1']);
  assert.equal(next.bessGroups![1].unitOverrides, undefined);
});

// ---------------------------------------------------------- overwrite direction

test('"change all" clears the overrides it overwrites, keeping unrelated ones', () => {
  const g = {
    id: 'g1',
    unitOverrides: {
      k1: { modeOverride: 'night', latLngDelta: [1, 2] },
      k2: { modeOverride: 'night' },
      k3: { elevationOffset: 4 },
    },
  } as unknown as BessGroup;
  const cleared = clearOverriddenFields(g, ['modeOverride']);
  // k1 keeps its position nudge; k2 becomes empty and is dropped entirely
  // rather than left as `{}`; k3 is untouched.
  assert.deepEqual(cleared.unitOverrides, {
    k1: { latLngDelta: [1, 2] },
    k3: { elevationOffset: 4 },
  });
});

test('clearing on a group with no overrides is a no-op', () => {
  const g = { id: 'g1' } as unknown as BessGroup;
  assert.equal(clearOverriddenFields(g, ['modeOverride']), g);
});

test('round trip: bulk edit survives, then change-all overwrites it', () => {
  // The full locked behaviour in one test.
  const p = project([member('u1', 'k1')], [{ id: 'g1' }]);
  const edited = applyPatchWithGroupOverrides(p, ['u1'], { modeOverride: 'night' });
  assert.equal(edited.bessGroups![0].unitOverrides!.k1.modeOverride, 'night');

  const afterChangeAll = clearOverriddenFields(edited.bessGroups![0], ['modeOverride']);
  assert.deepEqual(afterChangeAll.unitOverrides, {},
    'the wizard wins — the stale override would otherwise re-apply over it');
});
