import test from 'node:test';
import assert from 'node:assert/strict';

import { containerHeightFor, footprintFor, resolveContainer } from './catalogDims';
import type { CatalogEntry, Source, SourceKind } from './types';

// Minimal catalog entry — only the fields container resolution reads.
const entryOf = (kind: SourceKind, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id: 'm1',
  displayName: 'Test unit',
  kind,
  defaultMode: 'nominal',
  modes: [],
  origin: 'seed',
  ...over,
} as CatalogEntry);

const sourceOf = (kind: SourceKind, over: Partial<Source> = {}): Source => ({
  id: 's1',
  name: 'S1',
  latLng: [-27.0, 152.0],
  modelId: 'm1',
  catalogScope: 'global',
  kind,
  ...over,
} as Source);

// --------------------------------------------------------------- the regression
//
// A container used to require `entry.containerHeightM`, which NOTHING ever set:
// no seed entry carried one, the catalog editor had no field for it, and no UI
// wrote the per-source override. So `resolveContainer` returned undefined for
// every source and the whole "Source containers" setting was a silent no-op.
// This is the test that would have caught it — it deliberately uses a bare
// catalog entry, exactly as shipped.

test('a stock catalog entry with no containerHeightM still resolves a container', () => {
  for (const kind of ['bess', 'auxiliary'] as const) {
    const box = resolveContainer(sourceOf(kind), entryOf(kind));
    assert.ok(box, `${kind}: expected a container from a bare catalog entry`);
    assert.ok(box.heightM > 0, `${kind}: height must be positive`);
    assert.ok(box.lengthM > 0 && box.widthM > 0, `${kind}: plan dims must be positive`);
  }
});

test('per-kind height defaults, and an entry value overrides them', () => {
  assert.equal(containerHeightFor(entryOf('bess')), 2.6);
  assert.equal(containerHeightFor(entryOf('auxiliary')), 2.2);
  assert.equal(containerHeightFor(entryOf('bess', { containerHeightM: 3.4 })), 3.4);
  // Junk in the catalog falls back rather than producing a zero-height box.
  assert.equal(containerHeightFor(entryOf('bess', { containerHeightM: 0 })), 2.6);
  assert.equal(containerHeightFor(entryOf('bess', { containerHeightM: NaN })), 2.6);
});

// ------------------------------------------------------------------ opting out

test('enabled:false opts one unit out; WTGs never get a box', () => {
  assert.equal(
    resolveContainer(sourceOf('bess', { container: { enabled: false } }), entryOf('bess')),
    undefined,
  );
  assert.equal(resolveContainer(sourceOf('wtg'), entryOf('wtg')), undefined);
  // enabled:true / absent both mean "on".
  assert.ok(resolveContainer(sourceOf('bess', { container: {} }), entryOf('bess')));
  assert.ok(resolveContainer(sourceOf('bess', { container: { enabled: true } }), entryOf('bess')));
});

// ------------------------------------------------------------------- overrides

test('per-source dimension overrides win over the catalog', () => {
  const box = resolveContainer(
    sourceOf('bess', { container: { lengthM: 12, widthM: 3, heightM: 4 } }),
    entryOf('bess', { footprintM: { widthM: 6, lengthM: 2 }, containerHeightM: 2.9 }),
  );
  assert.deepEqual(box, { lengthM: 12, widthM: 3, heightM: 4, bearingDeg: 90 });
});

test('a blank / zero / NaN override falls back instead of deleting the box', () => {
  const entry = entryOf('bess', { footprintM: { widthM: 6, lengthM: 2 }, containerHeightM: 2.9 });
  for (const bad of [undefined, 0, NaN, -1]) {
    const box = resolveContainer(
      sourceOf('bess', { container: { lengthM: bad, widthM: bad, heightM: bad } }),
      entry,
    );
    assert.ok(box, `override ${String(bad)} must not delete the container`);
    assert.deepEqual(box, { lengthM: 6, widthM: 2, heightM: 2.9, bearingDeg: 90 });
  }
});

// ----------------------------------------------------------------- orientation

test('the box long axis is the footprint widthM, and bearing is yaw + 90', () => {
  const entry = entryOf('bess', { footprintM: { widthM: 6, lengthM: 2 } });
  // BEESTY's footprint convention: `widthM` is the LONG axis, running EAST at
  // yaw 0. `containerFootprint` takes the long axis along a compass bearing
  // (0 = north), so an unrotated unit must come out bearing 90 (east).
  const fp = footprintFor(entry);
  const box = resolveContainer(sourceOf('bess'), entry);
  assert.equal(box?.lengthM, fp.widthM, 'long axis == footprint widthM');
  assert.equal(box?.widthM, fp.lengthM, 'short axis == footprint lengthM');
  assert.equal(box?.bearingDeg, 90, 'yaw 0 lies east-west, as the map draws it');

  assert.equal(resolveContainer(sourceOf('bess', { yawDeg: 30 }), entry)?.bearingDeg, 120);
});

test('bearingDeg is the standalone fallback; yawDeg wins when both are present', () => {
  const entry = entryOf('bess');
  // Standalone unit (no yaw): the override supplies the heading.
  assert.equal(
    resolveContainer(sourceOf('bess', { container: { bearingDeg: 45 } }), entry)?.bearingDeg,
    135,
  );
  // Grouped unit: the row heading governs, per the `Source.container` contract.
  assert.equal(
    resolveContainer(
      sourceOf('bess', { yawDeg: 10, container: { bearingDeg: 45 } }),
      entry,
    )?.bearingDeg,
    100,
  );
});
