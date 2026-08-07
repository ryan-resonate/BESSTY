// DXF → project objects: units, placement, and the layer plan.
//
// The unit check is the one that matters most. A millimetre drawing read as
// metres is not a crash and not a wrong-looking shape — it is a site 1000× too
// big, correctly drawn, which is exactly the kind of mistake that survives all
// the way into a report.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseDxf, type DxfEntity } from './dxfParse';
import {
  applyDxfPlan, layerHasZ, layerLabels, layerPolylines, nextBarrierIndexFor, placePoint,
  suggestedUnit, unitCandidates, type DxfLayerPlan, type DxfPlacement,
} from './dxfImport';

/// MGA Zone 54 (EPSG:28354), a South Australian wind-farm CRS. Coordinates are
/// metres, so a placement scale of 1 means "the drawing is already in metres".
const MGA54: DxfPlacement = { unitScale: 1, epsg: 28354 };

function dxf(pairs: Array<[number | string, string | number]>): string {
  return pairs.map(([c, v]) => `${c}\r\n${v}`).join('\r\n') + '\r\n';
}
function entities(body: Array<[number | string, string | number]>, header: Array<[number | string, string | number]> = []) {
  return dxf([
    [0, 'SECTION'], [2, 'HEADER'], ...header, [0, 'ENDSEC'],
    [0, 'SECTION'], [2, 'ENTITIES'], ...body, [0, 'ENDSEC'], [0, 'EOF'],
  ]);
}

/// A 200 × 100 rectangle, in whatever units the caller means it to be.
function rect(scale = 1, layer = 'WALLS'): DxfEntity[] {
  return parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, layer], [70, 1],
    [10, 0], [20, 0],
    [10, 200 * scale], [20, 0],
    [10, 200 * scale], [20, 100 * scale],
    [10, 0], [20, 100 * scale],
  ])).entities;
}

// ---------- units ----------

test('each unit interpretation reports the site size it implies', () => {
  const cands = unitCandidates(rect(1000), null);       // drawn in millimetres
  const mm = cands.find((c) => c.label === 'millimetres')!;
  const m = cands.find((c) => c.label === 'metres')!;
  assert.equal(mm.widthM, 200);
  assert.equal(m.widthM, 200_000);
  assert.equal(mm.plausible, true);
  assert.equal(m.plausible, false, '200 km is not a site');
});

test('the header wins when it is plausible', () => {
  const doc = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'A'], [10, 0], [20, 0], [10, 300], [20, 400],
  ], [[9, '$INSUNITS'], [70, 6]]));
  const pick = suggestedUnit(unitCandidates(doc.entities, doc.insUnits));
  assert.equal(pick.label, 'metres');
  assert.equal(pick.fromHeader, true);
});

test('an implausible header claim is overruled by the geometry', () => {
  // Claims kilometres, but the extent is 200 000 units — 200 000 km is a
  // quarter of the way to the moon, so the drawing is really millimetres.
  const doc = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'A'], [10, 0], [20, 0], [10, 200000], [20, 100000],
  ], [[9, '$INSUNITS'], [70, 7]]));
  const pick = suggestedUnit(unitCandidates(doc.entities, doc.insUnits));
  assert.equal(pick.label, 'millimetres');
  assert.equal(pick.widthM, 200);
});

test('with no header at all the most site-like reading is suggested', () => {
  const pick = suggestedUnit(unitCandidates(rect(1000), null));
  assert.equal(pick.label, 'millimetres');
});

// ---------- placement ----------

test('a point projects through the chosen CRS and scale', () => {
  const a = placePoint({ x: 500000, y: 6250000 }, { unitScale: 1, epsg: 28354 })!;
  const b = placePoint({ x: 500200, y: 6250000 }, { unitScale: 1, epsg: 28354 })!;
  assert.ok(a[0] < 0 && a[1] > 100, `expected southern-hemisphere lat/lng, got ${a}`);
  // 200 m east: ~0.0023° of longitude at this latitude.
  const dLng = b[1] - a[1];
  assert.ok(dLng > 0.002 && dLng < 0.003, `${dLng}`);
});

test('the unit scale changes the ground distance, as a mm-vs-m mix-up would', () => {
  const near = placePoint({ x: 500200, y: 6250000 }, { unitScale: 0.001, epsg: 28354 });
  const far = placePoint({ x: 500200, y: 6250000 }, { unitScale: 1, epsg: 28354 });
  assert.notDeepEqual(near, far);
});

test('a placement that lands outside the world returns null, not Infinity', () => {
  // proj4 answers far out-of-range input with Infinity rather than throwing,
  // and a non-finite coordinate serialises to `null` in Firestore — so a
  // barrier with no position would be discovered long after the import.
  // Reading an MGA drawing as kilometres does exactly this.
  assert.equal(placePoint({ x: 500200, y: 6250000 }, { unitScale: 1000, epsg: 28354 }), null);
  assert.equal(placePoint({ x: NaN, y: 6250000 }, MGA54), null);
  assert.equal(placePoint({ x: 500200, y: Infinity }, MGA54), null);
});

test('an unplaceable shape is dropped whole and reported, not partly imported', () => {
  // A real MGA-coordinate drawing read as KILOMETRES: the eastings become
  // 500 000 km, which proj4 answers with Infinity rather than an error.
  const ents = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'WALLS'], [70, 1],
    [10, 500000], [20, 6250000],
    [10, 500200], [20, 6250000],
    [10, 500200], [20, 6250100],
  ])).entities;
  const bad: DxfPlacement = { unitScale: 1000, epsg: 28354 };
  assert.deepEqual(layerPolylines(ents, 'WALLS', bad), []);
  const r = applyDxfPlan(ents, [plan()], bad);
  assert.equal(r.barriers.length, 0);
  assert.ok(
    r.summary.some((s) => s.includes('could not be placed')),
    r.summary.join(' | '),
  );
  // The same drawing at the right scale imports cleanly.
  assert.equal(applyDxfPlan(ents, [plan()], MGA54).barriers.length, 1);
});

// ---------- layers ----------

test('a closed polyline is returned as a ring', () => {
  const polys = layerPolylines(rect(1), 'WALLS', MGA54);
  assert.equal(polys.length, 1);
  assert.equal(polys[0].closed, true);
  // Closed rings repeat their first point so downstream code need not special-case.
  assert.deepEqual(polys[0].points[0], polys[0].points[polys[0].points.length - 1]);
});

test('a circle becomes a ring whose radius survives the round trip', () => {
  const ents = parseDxf(entities([
    [0, 'CIRCLE'], [8, 'TANKS'], [10, 500000], [20, 6250000], [40, 25],
  ])).entities;
  const [ring] = layerPolylines(ents, 'TANKS', MGA54, 0.5);
  assert.ok(ring.points.length > 8, 'should be tessellated');
  // Every vertex is 25 m from the centre, within the chord tolerance.
  const centre = placePoint({ x: 500000, y: 6250000 }, MGA54)!;
  const mPerDegLat = 110_574;
  const mPerDegLng = 111_320 * Math.cos((centre[0] * Math.PI) / 180);
  for (const [lat, lng] of ring.points) {
    const r = Math.hypot((lat - centre[0]) * mPerDegLat, (lng - centre[1]) * mPerDegLng);
    assert.ok(Math.abs(r - 25) < 1, `radius ${r.toFixed(2)} m`);
  }
});

test('the chord tolerance is in metres, not drawing units', () => {
  // The same physical circle, drawn once in metres and once in millimetres,
  // must tessellate to the same number of vertices. Treating the tolerance as
  // drawing units would make the millimetre version 1000× finer.
  const inM = parseDxf(entities([[0, 'CIRCLE'], [8, 'T'], [10, 0], [20, 0], [40, 25]])).entities;
  const inMm = parseDxf(entities([[0, 'CIRCLE'], [8, 'T'], [10, 0], [20, 0], [40, 25000]])).entities;
  const a = layerPolylines(inM, 'T', { unitScale: 1, epsg: 28354 }, 0.5);
  const b = layerPolylines(inMm, 'T', { unitScale: 0.001, epsg: 28354 }, 0.5);
  assert.equal(a[0].points.length, b[0].points.length);
});

test('Z is only offered where the drawing actually carries it', () => {
  assert.equal(layerHasZ(rect(1), 'WALLS'), false);
  const withZ = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'W'], [10, 0], [20, 0], [30, 42], [10, 5], [20, 0], [30, 43],
  ])).entities;
  assert.equal(layerHasZ(withZ, 'W'), true);
});

test('text on a layer becomes labelled reference points', () => {
  const ents = parseDxf(entities([
    [0, 'TEXT'], [8, 'NOTES'], [10, 500000], [20, 6250000], [1, 'Pump house'],
  ])).entities;
  const labels = layerLabels(ents, 'NOTES', MGA54);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].label, 'Pump house');
  assert.equal(labels[0].type, 'point');
});

// ---------- applying a plan ----------

const plan = (over: Partial<DxfLayerPlan> = {}): DxfLayerPlan => ({
  layer: 'WALLS', target: 'barriers', heightM: 4, useZ: false, ...over,
});

test('a barrier layer produces walls at the entered height', () => {
  const r = applyDxfPlan(rect(1), [plan()], MGA54);
  assert.equal(r.barriers.length, 1);
  assert.deepEqual(new Set(r.barriers[0].topHeightsM), new Set([4]));
  assert.equal(r.barriers[0].polylineLatLng.length, 5);   // closed ring
  assert.ok(r.summary.some((s) => s.includes('1 wall')));
});

test('a skipped layer produces nothing', () => {
  const r = applyDxfPlan(rect(1), [plan({ target: 'skip' })], MGA54);
  assert.equal(r.barriers.length, 0);
  assert.equal(r.referenceFeaturesByLayer.length, 0);
});

test('a reference layer keeps closed shapes as polygons and open ones as lines', () => {
  const ents = [
    ...rect(1, 'SITE'),
    ...parseDxf(entities([[0, 'LINE'], [8, 'SITE'], [10, 0], [20, 0], [11, 9], [21, 9]])).entities,
  ];
  const r = applyDxfPlan(ents, [plan({ layer: 'SITE', target: 'reference' })], MGA54);
  const types = r.referenceFeaturesByLayer[0].features.map((f) => f.type).sort();
  assert.deepEqual(types, ['line', 'polygon']);
});

test('absolute Z becomes height above the ground under each vertex', () => {
  const ents = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'W'],
    [10, 500000], [20, 6250000], [30, 112],
    [10, 500050], [20, 6250000], [30, 115],
  ])).entities;
  // Terrain at 100 m: a 112 m crest is a 12 m wall, a 115 m crest is 15 m.
  const r = applyDxfPlan(ents, [plan({ layer: 'W', useZ: true })], MGA54, {
    nextBarrierIndex: 1, groundAt: () => 100,
  });
  assert.deepEqual(r.barriers[0].topHeightsM, [12, 15]);
});

test('Z mode without terrain falls back to the entered height AND says so', () => {
  const ents = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'W'],
    [10, 500000], [20, 6250000], [30, 112],
    [10, 500050], [20, 6250000], [30, 115],
  ])).entities;
  const r = applyDxfPlan(ents, [plan({ layer: 'W', useZ: true, heightM: 3 })], MGA54, {
    nextBarrierIndex: 1, groundAt: null,
  });
  assert.deepEqual(r.barriers[0].topHeightsM, [3, 3]);
  assert.ok(r.summary.some((s) => s.includes('fell back')), r.summary.join(' | '));
});

test('a Z below the ground still gives a usable wall, not a negative one', () => {
  const ents = parseDxf(entities([
    [0, 'LWPOLYLINE'], [8, 'W'],
    [10, 500000], [20, 6250000], [30, 90],
    [10, 500050], [20, 6250000], [30, 95],
  ])).entities;
  const r = applyDxfPlan(ents, [plan({ layer: 'W', useZ: true })], MGA54, {
    nextBarrierIndex: 1, groundAt: () => 100,
  });
  for (const h of r.barriers[0].topHeightsM) assert.ok(h > 0, `${h} should be clamped positive`);
});

test('barrier numbering continues from the project\'s existing walls', () => {
  const r = applyDxfPlan(rect(1), [plan()], MGA54, { nextBarrierIndex: 7, groundAt: null });
  assert.ok(r.barriers[0].id.endsWith('-7'), r.barriers[0].id);
  assert.ok(r.barriers[0].name.includes('7'));
});

test('the next barrier number comes from the highest id, not the count', () => {
  // Import three, delete two, import again: a COUNT restarts inside the range
  // already used and mints a duplicate id — and the editor then drags and
  // deletes both barriers as one object, because every lookup matches on id.
  const after = [{ id: 'B-dxf-3' }];
  assert.equal(nextBarrierIndexFor(after), 4);
  assert.equal(after.length + 1, 2, 'the count would have collided with B-dxf-3');

  assert.equal(nextBarrierIndexFor([]), 1);
  // Hand-drawn walls use a different prefix but the same trailing number.
  assert.equal(nextBarrierIndexFor([{ id: 'B-2' }, { id: 'B-dxf-9' }, { id: 'B-4' }]), 10);
  // An id with no trailing number must not poison the maximum.
  assert.equal(nextBarrierIndexFor([{ id: 'barrier' }, { id: 'B-dxf-2' }]), 3);
});
