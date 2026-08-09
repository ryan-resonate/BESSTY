// The materialiser's mode chain — specifically its behaviour across a
// per-unit MODEL swap.
//
// A segment's mode override is a name from the SEGMENT model's datasheet. When
// a unit override points that slot at a different model, the segment's mode
// must stop applying: `spectrumFor` doesn't reject an unknown mode name, it
// silently substitutes the catalog's first mode, so a leaked name solves at a
// level nobody chose. Gaps a sparse per-unit override leaves must fall to the
// NEW model's default — never to the old model's mode.

import test from 'node:test';
import assert from 'node:assert/strict';

import { materialiseBessGroup, type CatalogLookup } from './bessGroups';
import type { BessGroup, CatalogEntry, ModeOverride } from './types';

const entry = (id: string, defaultMode: string): CatalogEntry => ({
  id, displayName: id, kind: 'bess', origin: 'user',
  defaultMode,
  modes: [
    { name: defaultMode, bandSystem: 'octave', weighting: 'A', frequencies: [], spectra: {} },
  ],
} as unknown as CatalogEntry);

const lookup: CatalogLookup = (_scope, modelId) =>
  modelId === 'A' ? entry('A', 'Adef')
    : modelId === 'B' ? entry('B', 'Bdef')
      : null;

/// One row, one segment, one unit — the smallest group that materialises.
function groupWith(
  segMode: ModeOverride | undefined,
  unitOverride?: BessGroup['unitOverrides'],
): BessGroup {
  return {
    id: 'g', name: 'G', centerLatLng: [-33.6, 138.7], rotationDeg: 0,
    rows: [],
    sequence: [{
      kind: 'row', id: 'r1', gapAfterM: 0,
      row: {
        id: 'row1', rowRepeat: 1, gapBetweenCopiesM: 0,
        segments: [{
          id: 's1', catalogScope: 'global', modelId: 'A',
          modeOverride: segMode, count: 1, spacingWithinM: 0, gapAfterM: 0,
        }],
      },
    }],
    unitOverrides: unitOverride,
  } as BessGroup;
}

/// The single unit's slot key, discovered from a plain materialisation so the
/// tests don't hardcode the key format.
const SLOT = (() => {
  const r = materialiseBessGroup(groupWith('x'), lookup);
  assert.equal(r.sources.length, 1);
  return r.sources[0].slotKey!;
})();

function materialisedMode(
  segMode: ModeOverride | undefined,
  override?: NonNullable<BessGroup['unitOverrides']>[string],
): ModeOverride | undefined {
  const g = groupWith(segMode, override ? { [SLOT]: override } : undefined);
  const r = materialiseBessGroup(g, lookup);
  assert.equal(r.sources.length, 1);
  return r.sources[0].modeOverride;
}

test('a model-swapped unit does not inherit the segment mode', () => {
  // The reviewer scenario: segment holds a mode of model A; the unit is
  // swapped to B with a SPARSE per-period override (day/evening only, night
  // "(no change)"). The gap must NOT be filled with A's mode.
  const got = materialisedMode('OldY', {
    modelOverride: { catalogScope: 'global', modelId: 'B' },
    modeOverride: { day: 'Bdef', evening: 'Bdef' },
  });
  assert.deepEqual(got, { day: 'Bdef', evening: 'Bdef' },
    'night must stay absent — it resolves to B\'s default, not to A\'s "OldY"');
});

test('a model swap with no mode override drops the segment mode entirely', () => {
  // The whole-string variant of the same leak (pre-existing before per-period
  // modes): override only swaps the model, and the segment's A-mode used to
  // ride along onto B.
  const got = materialisedMode('OldY', {
    modelOverride: { catalogScope: 'global', modelId: 'B' },
  });
  assert.equal(got, undefined);
});

test('a unit still on the segment model merges per period, nearest first', () => {
  // Same-model unit overrides keep the documented chain: unit night, segment
  // day/evening.
  const got = materialisedMode('OldY', { modeOverride: { night: 'unitN' } });
  assert.deepEqual(got, { day: 'OldY', evening: 'OldY', night: 'unitN' });

  // Including when the override names the SAME model explicitly.
  const got2 = materialisedMode('OldY', {
    modelOverride: { catalogScope: 'global', modelId: 'A' },
    modeOverride: { night: 'unitN' },
  });
  assert.deepEqual(got2, { day: 'OldY', evening: 'OldY', night: 'unitN' });
});

test('with no overrides the segment mode surfaces unchanged', () => {
  assert.equal(materialisedMode('OldY'), 'OldY');
  assert.equal(materialisedMode(undefined), undefined);
  // Explicit null (pin to catalog default) surfaces as null, exactly as the
  // pre-period chain did.
  assert.equal(materialisedMode(null), null);
});
