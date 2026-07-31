import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildEnvelope, materialisePaste, parseEnvelope, type CopySelection,
} from './clipboardObjects';
import type { Project, Source } from './types';

let seq = 0;
const newId = (p: string) => `${p}-${++seq}`;

const src = (id: string, lat: number, lng: number, over: Partial<Source> = {}): Source => ({
  id, name: id, kind: 'bess', latLng: [lat, lng],
  modelId: 'mp', catalogScope: 'global', ...over,
} as Source);

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p', name: 'P', sources: [], receivers: [], barriers: [],
  scenario: { period: 'night', bandSystem: 'octave', windSpeed: 10 },
  ...over,
} as unknown as Project);

const sel = (over: Partial<CopySelection> = {}): CopySelection => ({
  sourceIds: new Set<string>(), receiverIds: new Set<string>(),
  barrierIds: new Set<string>(), ...over,
});

test('an empty selection produces no envelope', () => {
  assert.equal(buildEnvelope(project(), sel()), null);
});

test('the envelope round-trips through JSON', () => {
  const p = project({ sources: [src('a', -27, 152)] });
  const env = buildEnvelope(p, sel({ sourceIds: new Set(['a']) }))!;
  const back = parseEnvelope(JSON.stringify(env));
  assert.deepEqual(back, env);
});

test('foreign clipboard content is ignored, not an error', () => {
  for (const junk of ['', 'hello', '{}', '[]', 'null', '{"beesty":99}', '<html>']) {
    assert.equal(parseEnvelope(junk), null, `junk: ${junk}`);
  }
  // Right magic, missing objects.
  assert.equal(parseEnvelope('{"beesty":1,"origin":[0,0]}'), null);
});

test('paste preserves relative layout and moves the centroid to the anchor', () => {
  seq = 0;
  // Two sources 0.002 deg apart; centroid is halfway.
  const p = project({ sources: [src('a', -27.0, 152.0), src('b', -27.0, 152.002)] });
  const env = buildEnvelope(p, sel({ sourceIds: new Set(['a', 'b']) }))!;
  assert.deepEqual(env.origin, [-27.0, 152.001]);

  const out = materialisePaste(env, [-30.0, 140.0], newId);
  // Separation preserved exactly...
  const [s1, s2] = out.sources;
  assert.ok(Math.abs((s2.latLng[1] - s1.latLng[1]) - 0.002) < 1e-12, 'spacing kept');
  // ...and the centroid landed on the anchor.
  const midLng = (s1.latLng[1] + s2.latLng[1]) / 2;
  assert.ok(Math.abs(midLng - 140.0) < 1e-12);
  assert.ok(Math.abs(s1.latLng[0] - (-30.0)) < 1e-12);
});

test('every pasted object gets a fresh id', () => {
  seq = 0;
  const p = project({ sources: [src('a', -27, 152)] });
  const env = buildEnvelope(p, sel({ sourceIds: new Set(['a']) }))!;
  const out = materialisePaste(env, [-27, 152], newId);
  assert.notEqual(out.sources[0].id, 'a');
  assert.equal(out.newIds.length, 1);
  assert.equal(out.newIds[0], out.sources[0].id);
});

// ----------------------------------------------------------------- BESS groups

const grouped = () => project({
  sources: [
    src('u1', -27, 152, { groupId: 'g1', slotKey: 'k1' }),
    src('u2', -27, 152.001, { groupId: 'g1', slotKey: 'k2' }),
  ],
  bessGroups: [{
    id: 'g1', name: 'Row A', centerLatLng: [-27, 152.0005], rotationDeg: 0,
    unitOverrides: { k1: { elevationOffset: 3 } },
  }],
} as unknown as Partial<Project>);

test('a fully-selected group is copied as a group with a new id', () => {
  seq = 0;
  const env = buildEnvelope(grouped(), sel({ sourceIds: new Set(['u1', 'u2']) }))!;
  assert.equal(env.objects.bessGroups.length, 1);

  const out = materialisePaste(env, [-30, 140], newId);
  assert.equal(out.bessGroups.length, 1);
  assert.notEqual(out.bessGroups[0].id, 'g1');
  assert.match(out.bessGroups[0].name, /\(copy\)$/);
  // Members point at the NEW group.
  assert.equal(out.sources[0].groupId, out.bessGroups[0].id);
  assert.equal(out.sources[1].groupId, out.bessGroups[0].id);
});

test('a pasted group does not share override state with the original', () => {
  seq = 0;
  const p = grouped();
  const env = buildEnvelope(p, sel({ sourceIds: new Set(['u1', 'u2']) }))!;
  const out = materialisePaste(env, [-30, 140], newId);

  out.bessGroups[0].unitOverrides!.k1.elevationOffset = 99;
  assert.equal(p.bessGroups![0].unitOverrides!.k1.elevationOffset, 3,
    'editing the copy must not edit the original');
});

test('a PARTIALLY selected group copies its units as standalone sources', () => {
  seq = 0;
  // Copying half a group would otherwise produce a group whose sequence does
  // not match its units.
  const env = buildEnvelope(grouped(), sel({ sourceIds: new Set(['u1']) }))!;
  assert.equal(env.objects.bessGroups.length, 0);
  assert.equal(env.objects.sources[0].groupId, undefined);
  assert.equal(env.objects.sources[0].slotKey, undefined);

  const out = materialisePaste(env, [-30, 140], newId);
  assert.equal(out.sources[0].groupId, undefined);
  assert.equal(out.bessGroups.length, 0);
});

test('barrier vertices all translate together', () => {
  seq = 0;
  const p = project({
    barriers: [{
      id: 'b1', name: 'w', type: 'wall',
      polylineLatLng: [[-27, 152], [-27, 152.001]],
      topHeightsM: [5, 5], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0.2,
    }],
  } as unknown as Partial<Project>);
  const env = buildEnvelope(p, sel({ barrierIds: new Set(['b1']) }))!;
  const out = materialisePaste(env, [-30, 140], newId);
  const poly = out.barriers[0].polylineLatLng;
  assert.ok(Math.abs((poly[1][1] - poly[0][1]) - 0.001) < 1e-12, 'shape preserved');
  assert.notEqual(out.barriers[0].id, 'b1');
});
