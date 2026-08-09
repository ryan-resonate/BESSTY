// Per-period operating modes: the resolver, the fallback chain, and Off.
//
// The rule these tests exist to protect: `spectrumFor` silently falls back to a
// catalog's FIRST mode when it doesn't recognise a name. So an override that
// isn't resolved — or the reserved Off id reaching it — doesn't fail, it runs
// the source at some other mode and reports the number as if it were right.
// Every assertion about `null` below is really an assertion that the caller was
// forced to notice.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MODE_OFF,
  applyModeEdit,
  describeModes,
  involvesOff,
  mergeModeChain,
  modeForPeriod,
  normaliseModeOverride,
  perPeriodModesEnabled,
  resolveModeName,
  sourceIsOff,
  variesByPeriod,
  withPeriodMode,
} from './modes';
import type { ModeOverride, Project } from './types';

test('a plain string still means every period', () => {
  // The whole compatibility story: documents written before per-period modes
  // existed carry a string, and must resolve identically in all three periods.
  for (const p of ['day', 'evening', 'night'] as const) {
    assert.equal(modeForPeriod('NRO0', p), 'NRO0');
    assert.equal(resolveModeName('NRO0', p, 'default'), 'NRO0');
  }
});

test('an absent override inherits the catalog default', () => {
  assert.equal(resolveModeName(undefined, 'night', 'nominal'), 'nominal');
  assert.equal(resolveModeName(null, 'night', 'nominal'), 'nominal');
  // …and so does a period the object simply doesn't mention.
  assert.equal(resolveModeName({ night: 'NRO2' }, 'day', 'nominal'), 'nominal');
  assert.equal(resolveModeName({ night: 'NRO2' }, 'night', 'nominal'), 'NRO2');
});

test('Off resolves to null rather than to a mode name', () => {
  // Returning the string would hand `__off` to `spectrumFor`, which does not
  // know it and would fall back to the catalog's first mode — the source would
  // run, at a level nobody chose.
  assert.equal(resolveModeName(MODE_OFF, 'night', 'nominal'), null);
  assert.equal(resolveModeName({ night: MODE_OFF }, 'night', 'nominal'), null);
  assert.equal(resolveModeName({ night: MODE_OFF }, 'day', 'nominal'), 'nominal');
  assert.equal(sourceIsOff({ modeOverride: { night: MODE_OFF } }, 'night'), true);
  assert.equal(sourceIsOff({ modeOverride: { night: MODE_OFF } }, 'day'), false);
  assert.equal(sourceIsOff({ modeOverride: 'nominal' }, 'night'), false);
});

test('the override chain resolves PER PERIOD, nearest first', () => {
  // A unit that names only a night mode still takes the segment's day mode.
  // Choosing one whole link — the pre-period behaviour — would have made
  // setting one period silently blank the other two.
  const merged = mergeModeChain({ night: 'NRO2' }, 'NRO0');
  assert.deepEqual(merged, { day: 'NRO0', evening: 'NRO0', night: 'NRO2' });

  // With no per-period link anywhere, it is exactly the old first-defined-wins.
  assert.equal(mergeModeChain(undefined, 'seg'), 'seg');
  assert.equal(mergeModeChain('unit', 'seg'), 'unit');
  assert.equal(mergeModeChain(undefined, undefined), undefined);
  // `null` is a value, not an absence: it stops the chain and inherits the
  // catalog default, which is what it has always meant.
  assert.equal(mergeModeChain(null, 'seg'), null);
});

test('three equal periods collapse back to a plain string', () => {
  // So a project set per-period and then levelled out stores — and
  // fingerprints — identically to one that never touched the feature.
  assert.equal(normaliseModeOverride({ day: 'a', evening: 'a', night: 'a' }), 'a');
  assert.equal(normaliseModeOverride({}), undefined);
  assert.deepEqual(normaliseModeOverride({ day: 'a', night: 'b' }), { day: 'a', night: 'b' });
  assert.equal(variesByPeriod('a'), false);
  assert.equal(variesByPeriod({ day: 'a', evening: 'a', night: 'a' }), false);
  assert.equal(variesByPeriod({ day: 'a', night: 'b' }), true);
});

test('setting one period keeps what the others were resolving to', () => {
  // Starting from "NRO0 all day", switching the night mode must not hand day
  // and evening back to the catalog default.
  const next = withPeriodMode('NRO0', 'night', MODE_OFF);
  assert.deepEqual(next, { day: 'NRO0', evening: 'NRO0', night: MODE_OFF });

  // Setting it back to the shared value collapses the object again.
  assert.equal(withPeriodMode(next, 'night', 'NRO0'), 'NRO0');

  // From nothing, only the named period is written — the rest keep inheriting.
  const fromNothing = withPeriodMode(undefined, 'night', 'NRO2');
  assert.deepEqual(fromNothing, { night: 'NRO2' });
  // Explicit `undefined` VALUES are never emitted: Firestore rejects them, and
  // a shape that only survives because a writer prunes it is a trap.
  assert.deepEqual(Object.keys(fromNothing as object), ['night']);
});

test('a bulk edit names only the periods it changes', () => {
  // Setting the night mode across a selection must leave each source's own day
  // and evening alone — and those differ from one source to the next.
  const edit: ModeOverride = { night: 'NRO2' };
  assert.deepEqual(applyModeEdit('NRO0', edit), { day: 'NRO0', evening: 'NRO0', night: 'NRO2' });
  assert.deepEqual(applyModeEdit('quiet', edit), { day: 'quiet', evening: 'quiet', night: 'NRO2' });
  assert.deepEqual(applyModeEdit(undefined, edit), { night: 'NRO2' });
  // A plain string is still the blunt instrument: every period.
  assert.equal(applyModeEdit({ day: 'a', night: 'b' }, 'c'), 'c');
  // No edit changes nothing, and returns the value it was given untouched.
  const untouched: ModeOverride = { day: 'a', night: 'b' };
  assert.equal(applyModeEdit(untouched, undefined), untouched);
});

test('the summary names every period, Off included', () => {
  assert.equal(describeModes({ day: 'NRO0', evening: 'NRO0', night: MODE_OFF }, 'x'),
    'NRO0 / NRO0 / Off');
  assert.equal(describeModes({ night: MODE_OFF }, 'nominal'), 'nominal / nominal / Off');
  assert.equal(describeModes('NRO0', 'nominal'), 'NRO0');
  assert.equal(describeModes(undefined, 'nominal'), 'nominal');
});

test('involvesOff sees a uniform Off, which variesByPeriod cannot', () => {
  // The UI shows the mode control whenever an override varies OR involves Off.
  // A source set Off in every period doesn't vary, so this predicate is the
  // only thing standing between that source and an invisible, uneditable Off.
  assert.equal(involvesOff(MODE_OFF), true);
  assert.equal(variesByPeriod(MODE_OFF), false);          // …which is why it exists
  assert.equal(involvesOff({ night: MODE_OFF }), true);
  assert.equal(involvesOff({ day: 'a', evening: 'a', night: MODE_OFF }), true);
  assert.equal(involvesOff('NRO0'), false);
  assert.equal(involvesOff({ day: 'a', night: 'b' }), false);
  assert.equal(involvesOff(undefined), false);
  assert.equal(involvesOff(null), false);
});

test('the capability is off unless a project switches it on', () => {
  const base = { settings: {} } as unknown as Project;
  assert.equal(perPeriodModesEnabled(base), false);
  assert.equal(perPeriodModesEnabled({} as Project), false);
  assert.equal(
    perPeriodModesEnabled({ settings: { periods: { perPeriodModes: true } } } as Project),
    true,
  );
});
