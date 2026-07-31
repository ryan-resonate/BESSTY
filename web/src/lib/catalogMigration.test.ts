import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeMigration, planLocalCatalogMigration, sameEntryContent, seedEntriesToUpsert,
} from './catalogMigration';
import type { CatalogEntry, CatalogModeData, Project, Source } from './types';

const mode = (broadband: number[]): CatalogModeData => ({
  name: 'nominal', bandSystem: 'octave', frequencies: [63, 125],
  spectra: { broadband },
} as CatalogModeData);

const entry = (id: string, over: Partial<CatalogEntry> = {}): CatalogEntry => ({
  id, displayName: id, kind: 'bess', defaultMode: 'nominal', origin: 'user',
  modes: [mode([90, 92])],
  ...over,
} as CatalogEntry);

const src = (id: string, modelId: string, scope: 'local' | 'global' = 'local'): Source => ({
  id, name: id, kind: 'bess', latLng: [-27, 152], modelId, catalogScope: scope,
} as Source);

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'P', sources: [], receivers: [], barriers: [],
  scenario: { period: 'night', bandSystem: 'octave', windSpeed: 10 },
  ...over,
} as unknown as Project);

// ------------------------------------------------------------------ content eq

test('entries differing only in bookkeeping fields are the same product', () => {
  assert.equal(
    sameEntryContent(entry('a', { origin: 'seed' }), entry('a', { origin: 'user' })),
    true,
  );
  // Key order must not matter.
  const x = { ...entry('a'), kind: 'bess', id: 'a' } as CatalogEntry;
  assert.equal(sameEntryContent(entry('a'), x), true);
});

test('entries differing in sound power are NOT the same product', () => {
  const loud = entry('a', { modes: [mode([99, 99])] });
  assert.equal(sameEntryContent(entry('a'), loud), false);
});

// -------------------------------------------------------------------- planning

test('a local model with no global clash moves across and sources repoint', () => {
  const p = project({ localCatalog: [entry('mp')], sources: [src('s1', 'mp')] });
  const m = planLocalCatalogMigration(p, [], 'p1');
  assert.deepEqual(m.upserts.map((e) => e.id), ['mp']);
  assert.deepEqual(m.renamed, []);
  assert.equal(m.sourcesRepointed, 1);
  assert.equal(m.project.sources[0].catalogScope, 'global');
  assert.equal(m.project.sources[0].modelId, 'mp');
  assert.equal(m.project.localCatalog, undefined, 'localCatalog is dropped');
});

test('an identical global entry is reused, not rewritten', () => {
  const p = project({ localCatalog: [entry('mp')], sources: [src('s1', 'mp')] });
  const m = planLocalCatalogMigration(p, [entry('mp', { origin: 'seed' })], 'p1');
  assert.deepEqual(m.upserts, [], 'nothing to write');
  assert.deepEqual(m.reused, ['mp']);
  assert.equal(m.project.sources[0].modelId, 'mp');
});

test('a clashing id with DIFFERENT content keeps the project version under a derived id', () => {
  // Silently adopting the global definition would change this project's levels.
  const globalLoud = entry('mp', { modes: [mode([99, 99])] });
  const p = project({ localCatalog: [entry('mp')], sources: [src('s1', 'mp')] });
  const m = planLocalCatalogMigration(p, [globalLoud], 'p1');
  assert.deepEqual(m.upserts.map((e) => e.id), ['mp-from-p1']);
  assert.deepEqual(m.renamed, [{ from: 'mp', to: 'mp-from-p1' }]);
  assert.equal(m.project.sources[0].modelId, 'mp-from-p1',
    'the source follows the project version, not the global one');
});

test('non-local sources are left completely alone', () => {
  const p = project({
    localCatalog: [entry('mp')],
    sources: [src('s1', 'mp'), src('s2', 'other', 'global')],
  });
  const m = planLocalCatalogMigration(p, [], 'p1');
  assert.equal(m.sourcesRepointed, 1);
  assert.equal(m.project.sources[1].catalogScope, 'global');
  assert.equal(m.project.sources[1].modelId, 'other');
});

test('a source pointing at a missing local model is left as-is, not invented', () => {
  const p = project({ localCatalog: [], sources: [src('s1', 'ghost')] });
  const m = planLocalCatalogMigration(p, [], 'p1');
  assert.equal(m.sourcesRepointed, 0);
  assert.equal(m.project.sources[0].catalogScope, 'local', 'already broken; left visible');
});

test('BESS group segments repoint too, including nested ones', () => {
  const p = project({
    localCatalog: [entry('mp')],
    sources: [],
    bessGroups: [{
      id: 'g', name: 'G', centerLatLng: [-27, 152], rotationDeg: 0,
      sequence: [
        { kind: 'row', id: 'r1', gapAfterM: 0,
          row: { id: 'rr', segments: [{ id: 'sg1', catalogScope: 'local', modelId: 'mp', count: 4 }] } },
        { kind: 'group', id: 'g2', repeatDown: 1, repeatRight: 1, gapDownM: 0, gapRightM: 0, gapAfterM: 0,
          items: [{ kind: 'row', id: 'r2', gapAfterM: 0,
            row: { id: 'rr2', segments: [{ id: 'sg2', catalogScope: 'local', modelId: 'mp', count: 2 }] } }] },
      ],
    }],
  } as unknown as Partial<Project>);
  const m = planLocalCatalogMigration(p, [], 'p1');
  const seq = m.project.bessGroups![0].sequence as unknown as Array<Record<string, never>>;
  const top = (seq[0] as unknown as { row: { segments: Array<{ catalogScope: string; modelId: string }> } });
  const nested = (seq[1] as unknown as { items: Array<{ row: { segments: Array<{ catalogScope: string }> } }> });
  assert.equal(top.row.segments[0].catalogScope, 'global');
  assert.equal(nested.items[0].row.segments[0].catalogScope, 'global',
    'a nested segment left on local would fail to resolve after migration');
});

test('migrating twice is a no-op the second time', () => {
  const p = project({ localCatalog: [entry('mp')], sources: [src('s1', 'mp')] });
  const first = planLocalCatalogMigration(p, [], 'p1');
  const second = planLocalCatalogMigration(first.project, first.upserts, 'p1');
  assert.deepEqual(second.upserts, []);
  assert.equal(second.sourcesRepointed, 0);
});

// ------------------------------------------------------------------ seed upsert

test('seed upsert writes only what is missing, and is idempotent', () => {
  const seed = [entry('a'), entry('b'), entry('c')];
  assert.deepEqual(seedEntriesToUpsert(seed, []).map((e) => e.id), ['a', 'b', 'c']);
  assert.deepEqual(seedEntriesToUpsert(seed, [entry('b')]).map((e) => e.id), ['a', 'c']);
  assert.deepEqual(seedEntriesToUpsert(seed, seed), []);
});

test('a seed entry edited globally is not reverted to the bundled version', () => {
  const edited = entry('a', { modes: [mode([70, 70])] });
  assert.deepEqual(seedEntriesToUpsert([entry('a')], [edited]), [],
    'matched by id — content differences are the user\'s deliberate edit');
});

test('describeMigration reports nothing to do without inventing work', () => {
  const m = planLocalCatalogMigration(project({ localCatalog: [] }), [], 'p1');
  assert.match(describeMigration(m), /No local models to migrate/);
});
