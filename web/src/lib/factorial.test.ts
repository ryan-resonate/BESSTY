import test from 'node:test';
import assert from 'node:assert/strict';

import {
  axisOverlap, axisScopeOptions, candidateLabel, enumerateCombos, projectFingerprint,
  projectForCombo, scopeKey, worstOf,
  type AxisSpec, type Candidate, type ComboResult,
} from './factorial';
import type { Project, Source } from './types';

const cand = (id: string, mode: string | null = null): Candidate => ({
  catalogScope: 'global', modelId: id, mode, label: candidateLabel(id, mode),
});

const src = (id: string, modelId = 'old'): Source => ({
  id, name: id, kind: 'bess', latLng: [-27, 152],
  modelId, catalogScope: 'global', modeOverride: 'orig',
} as Source);

const project = (): Project => ({
  id: 'p', name: 'P', receivers: [], barriers: [],
  sources: [src('b1'), src('b2'), src('i1'), src('other')],
  scenario: { period: 'night', bandSystem: 'octave', windSpeed: 10 },
} as unknown as Project);

const battery: AxisSpec = { sourceIds: ['b1', 'b2'], candidates: [cand('MP2'), cand('MP3', 'night')] };
const inverter: AxisSpec = { sourceIds: ['i1'], candidates: [cand('INV-A'), cand('INV-B'), cand('INV-C')] };

test('every combination is enumerated once', () => {
  const combos = enumerateCombos(battery, inverter);
  assert.equal(combos.length, 2 * 3);
  const seen = new Set(combos.map((c) => `${c.batteryIdx}:${c.inverterIdx}`));
  assert.equal(seen.size, 6, 'no duplicates, none missed');
});

test('batteries vary fastest, so the matrix reads batteries across the top', () => {
  const combos = enumerateCombos(battery, inverter);
  assert.deepEqual(
    combos.slice(0, 3).map((c) => `${c.batteryIdx}-${c.inverterIdx}`),
    ['0-0', '1-0', '0-1'],
  );
});

test('a combo swaps only its axis members', () => {
  const p = project();
  const combos = enumerateCombos(battery, inverter);
  const next = projectForCombo(p, battery, inverter, combos[0]);

  const byId = new Map(next.sources.map((s) => [s.id, s]));
  assert.equal(byId.get('b1')!.modelId, 'MP2');
  assert.equal(byId.get('b2')!.modelId, 'MP2');
  assert.equal(byId.get('i1')!.modelId, 'INV-A');
  // Anything outside both axes is held constant — that's the whole point of a
  // controlled study.
  assert.equal(byId.get('other')!.modelId, 'old');
  assert.equal(byId.get('other')!.modeOverride, 'orig');
});

test('the mode travels with the model', () => {
  const p = project();
  const withMode = enumerateCombos(battery, inverter).find((c) => c.battery.mode === 'night')!;
  const next = projectForCombo(p, battery, inverter, withMode);
  const b1 = next.sources.find((s) => s.id === 'b1')!;
  assert.equal(b1.modelId, 'MP3');
  assert.equal(b1.modeOverride, 'night');
});

test('GATE: running every combination leaves the project byte-identical', () => {
  const p = project();
  const before = projectFingerprint(p);
  for (const c of enumerateCombos(battery, inverter)) {
    const clone = projectForCombo(p, battery, inverter, c);
    // Mutating the clone must not reach the original either.
    clone.sources[0].modelId = 'VANDALISED';
    clone.name = 'VANDALISED';
  }
  assert.equal(projectFingerprint(p), before);
});

test('worst-case picks the highest level across the selected receivers only', () => {
  const r: ComboResult = {
    combo: enumerateCombos(battery, inverter)[0],
    byReceiver: new Map([['r1', 41.2], ['r2', 38.0], ['r3', 55.0]]),
  };
  assert.equal(worstOf(r, ['r1', 'r2']), 41.2, 'r3 was not selected');
  assert.equal(worstOf(r, ['r1', 'r2', 'r3']), 55.0);
  assert.equal(worstOf(r, []), null);
  assert.equal(worstOf(r, ['nope']), null, 'a receiver with no result is not zero');
});

test('non-finite results are ignored rather than treated as a level', () => {
  const r: ComboResult = {
    combo: enumerateCombos(battery, inverter)[0],
    byReceiver: new Map([['r1', -Infinity], ['r2', 30]]),
  };
  assert.equal(worstOf(r, ['r1', 'r2']), 30);
});

test('candidate labels distinguish the same model in different modes', () => {
  assert.equal(candidateLabel('MP2', null), 'MP2');
  assert.equal(candidateLabel('MP2', 'night'), 'MP2 — night');
  assert.notEqual(candidateLabel('MP2', 'day'), candidateLabel('MP2', 'night'));
});

// ------------------------------------------------------------- axis scoping

test('scopes cover all-of-a-kind and each group, skipping empty ones', () => {
  const p = {
    ...project(),
    sources: [
      { ...src('b1'), kind: 'bess', groupId: 'g1' },
      { ...src('i1'), kind: 'auxiliary', groupId: 'g1' },
      { ...src('b2'), kind: 'bess' },
    ],
    bessGroups: [
      { id: 'g1', name: 'Row A' },
      { id: 'g2', name: 'Empty row' },
    ],
  } as unknown as Project;

  const labels = axisScopeOptions(p).map((o) => o.label);
  assert.ok(labels.some((l) => l.startsWith('All BESS')));
  assert.ok(labels.some((l) => l.startsWith('All auxiliary')));
  // A group holding BOTH kinds appears once per kind — that's the whole point.
  assert.ok(labels.includes('Row A — BESS (1)'));
  assert.ok(labels.includes('Row A — auxiliary (1)'));
  // An empty group is not offered: an axis you cannot populate is noise.
  assert.ok(!labels.some((l) => l.startsWith('Empty row')));
});

test('a group scope selects only that group members', () => {
  const p = {
    ...project(),
    sources: [
      { ...src('b1'), kind: 'bess', groupId: 'g1' },
      { ...src('b2'), kind: 'bess', groupId: 'g2' },
    ],
    bessGroups: [{ id: 'g1', name: 'A' }, { id: 'g2', name: 'B' }],
  } as unknown as Project;
  const a = axisScopeOptions(p).find((o) => o.label.startsWith('A —'))!;
  assert.deepEqual(a.sourceIds, ['b1']);
});

test('overlapping axes are detected — axis 1 would otherwise silently win', () => {
  const all: AxisSpec = { sourceIds: ['b1', 'b2'], candidates: [] };
  const one: AxisSpec = { sourceIds: ['b1'], candidates: [] };
  assert.deepEqual(axisOverlap(all, one), ['b1']);
  assert.deepEqual(axisOverlap(one, { sourceIds: ['i1'], candidates: [] }), []);
});

test('scope keys are stable and distinguish kind within a group', () => {
  assert.notEqual(
    scopeKey({ kind: 'group', groupId: 'g1', sourceKind: 'bess' }),
    scopeKey({ kind: 'group', groupId: 'g1', sourceKind: 'auxiliary' }),
  );
  assert.equal(scopeKey({ kind: 'all', sourceKind: 'bess' }), 'all:bess');
});
