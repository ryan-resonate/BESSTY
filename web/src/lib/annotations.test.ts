// Annotation geometry and labelling.
//
// The map and the PDF draw annotations with completely different machinery, so
// what keeps the figure on screen and the figure in the report agreeing is that
// both ask these functions the same questions. That makes the answers worth
// pinning — particularly the tilt, where getting the longitude scaling wrong
// gives a label that lies along a different line than the one drawn.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  annotationPoints, annotationsOf, dimensionLabel, dimensionMidpoint, dimensionTiltDeg,
  leaderAttachOffset, newAnnotationId, validAnnotation,
} from './annotations';
import type { Annotation, DimensionAnnotation } from './types';

const SITE: [number, number] = [-33.6, 138.7];

function dim(to: [number, number], label?: string): DimensionAnnotation {
  return { id: 'd1', kind: 'dimension', from: SITE, to, label };
}

// ---------- labels ----------

test('a dimension reads its measured length to one decimal', () => {
  // 0.001° of latitude ≈ 111.2 m at any longitude.
  const d = dim([SITE[0] + 0.001, SITE[1]]);
  const label = dimensionLabel(d);
  assert.match(label, /^11[01]\.\d m$/, label);
});

test('past a kilometre it switches units rather than printing 1104.6 m', () => {
  assert.match(dimensionLabel(dim([SITE[0] + 0.01, SITE[1]])), /^1\.1\d km$/);
});

test('an explicit label wins, so a nominal figure can override the measurement', () => {
  assert.equal(dimensionLabel(dim([SITE[0] + 0.001, SITE[1]], '6 m min.')), '6 m min.');
  // An empty string is "not set", not "label with nothing" — otherwise clearing
  // the field would blank the dimension instead of restoring the measurement.
  assert.match(dimensionLabel(dim([SITE[0] + 0.001, SITE[1]], '')), /m$/);
});

// ---------- geometry ----------

test('the label sits at the midpoint', () => {
  const d = dim([SITE[0] + 0.002, SITE[1] + 0.004]);
  assert.deepEqual(dimensionMidpoint(d), [SITE[0] + 0.001, SITE[1] + 0.002]);
});

test('a due-east dimension is horizontal and a due-north one vertical', () => {
  assert.ok(Math.abs(dimensionTiltDeg(dim([SITE[0], SITE[1] + 0.01]))) < 1e-9);
  assert.ok(Math.abs(dimensionTiltDeg(dim([SITE[0] + 0.01, SITE[1]])) - 90) < 1e-9);
});

test('a label lies ALONG its line, not mirrored across it', () => {
  // The sign bug this pins: negating the tilt still gives a plausible-looking
  // angle, so it only shows up as a label crossing its own line. Checked
  // against the geometry rather than against the formula — the direction the
  // rotated text runs must be parallel to the line it labels.
  const cases: Array<[number, number]> = [
    [0.01, 0.01],    // north-east: text runs up-right
    [-0.01, 0.01],   // south-east: text runs down-right
    [0.006, 0.013],  // shallow north-east
    [-0.013, 0.004], // steep south-east
  ];
  for (const [dLat, dLng] of cases) {
    const d = dim([SITE[0] + dLat, SITE[1] + dLng]);
    const rad = (dimensionTiltDeg(d) * Math.PI) / 180;
    // Screen direction of rotated text, in page coords where y grows downward.
    const textDir = [Math.cos(rad), -Math.sin(rad)];
    // Screen direction of the line itself: east is +x, north is -y.
    const latScale = Math.cos((SITE[0] * Math.PI) / 180);
    const len = Math.hypot(dLng * latScale, dLat);
    const lineDir = [(dLng * latScale) / len, -dLat / len];
    // Parallel means |cross| ≈ 0. A mirrored label gives a large cross product
    // for anything that is not exactly horizontal or vertical.
    const cross = textDir[0] * lineDir[1] - textDir[1] * lineDir[0];
    assert.ok(Math.abs(cross) < 1e-9, `Δ(${dLat}, ${dLng}): label off by cross=${cross.toFixed(4)}`);
  }
});

test('tilt accounts for meridian convergence — degrees of longitude are shorter', () => {
  // At latitude -33.6, cos(lat) ≈ 0.833, so equal degree steps in latitude and
  // longitude are NOT a 45° line on screen: the longitude step is the shorter
  // one, making the line steeper. Ignoring the scaling would give exactly 45.
  const tilt = dimensionTiltDeg(dim([SITE[0] + 0.01, SITE[1] + 0.01]));
  assert.ok(tilt > 45.5 && tilt < 60, `expected steeper than 45°, got ${tilt.toFixed(2)}`);
});

test('tilt never turns text upside down', () => {
  for (let bearing = 0; bearing < 360; bearing += 7) {
    const rad = (bearing * Math.PI) / 180;
    const t = dimensionTiltDeg(dim([SITE[0] + 0.01 * Math.cos(rad), SITE[1] + 0.01 * Math.sin(rad)]));
    assert.ok(t > -90 && t <= 90, `bearing ${bearing}° gave ${t}`);
  }
});

// ---------- leader attachment ----------

test('a leader attaches to the side of the note facing its target', () => {
  const halfW = 30;
  const halfH = 10;
  // Straight right: exits the right edge, halfway up.
  assert.deepEqual(leaderAttachOffset(100, 0, halfW, halfH), { dx: 30, dy: 0 });
  // Straight down (screen y grows downward): exits the bottom edge.
  assert.deepEqual(leaderAttachOffset(0, 100, halfW, halfH), { dx: 0, dy: 10 });
  assert.deepEqual(leaderAttachOffset(-100, 0, halfW, halfH), { dx: -30, dy: 0 });
  assert.deepEqual(leaderAttachOffset(0, -100, halfW, halfH), { dx: 0, dy: -10 });
});

test('the attachment lands ON the box edge, never inside or beyond it', () => {
  const halfW = 30;
  const halfH = 10;
  for (let deg = 0; deg < 360; deg += 3) {
    const rad = (deg * Math.PI) / 180;
    const { dx, dy } = leaderAttachOffset(Math.cos(rad) * 250, Math.sin(rad) * 250, halfW, halfH);
    // On the boundary: one coordinate is at its limit, neither is past it.
    assert.ok(Math.abs(dx) <= halfW + 1e-9, `${deg}°: dx ${dx}`);
    assert.ok(Math.abs(dy) <= halfH + 1e-9, `${deg}°: dy ${dy}`);
    const onEdge = Math.abs(Math.abs(dx) - halfW) < 1e-9 || Math.abs(Math.abs(dy) - halfH) < 1e-9;
    assert.ok(onEdge, `${deg}°: (${dx}, ${dy}) is not on the edge`);
    // …and it is in the direction of the target, so the leader points the
    // right way rather than out of the opposite side.
    assert.ok(dx * Math.cos(rad) >= -1e-9 && dy * Math.sin(rad) >= -1e-9, `${deg}° points backwards`);
  }
});

test('a wide, short note exits its long side for a shallow approach', () => {
  // The box is 6× wider than tall, so a 45° approach leaves through the
  // BOTTOM, not the corner — which is what stops the rule crossing the words.
  const { dx, dy } = leaderAttachOffset(100, 100, 60, 10);
  assert.equal(dy, 10);
  assert.ok(dx < 60);
});

test('a target sitting on the note yields no offset rather than NaN', () => {
  assert.deepEqual(leaderAttachOffset(0, 0, 30, 10), { dx: 0, dy: 0 });
  assert.deepEqual(leaderAttachOffset(NaN, 5, 30, 10), { dx: 0, dy: 0 });
});

test('annotationPoints covers what the annotation occupies', () => {
  assert.equal(annotationPoints({ id: 't', kind: 'text', latLng: SITE, text: 'x' }).length, 1);
  assert.equal(annotationPoints({
    id: 't', kind: 'text', latLng: SITE, text: 'x', leaderTo: [SITE[0] + 0.001, SITE[1]],
  }).length, 2);
  assert.equal(annotationPoints(dim([SITE[0] + 0.001, SITE[1]])).length, 2);
});

// ---------- reading from a document ----------

test('a malformed annotation is dropped rather than crashing the map', () => {
  const bad = [
    null,
    { id: 'a', kind: 'text' },                                  // no position
    { id: 'b', kind: 'text', latLng: [NaN, 1], text: '' },       // non-finite
    { id: 'c', kind: 'dimension', from: SITE },                  // half a dimension
    { id: 'd', kind: 'circle', latLng: SITE },                   // unknown kind
    { kind: 'text', latLng: SITE, text: 'no id' },
  ] as unknown as Annotation[];
  for (const a of bad) assert.equal(validAnnotation(a), false, JSON.stringify(a));

  const good: Annotation = { id: 'ok', kind: 'text', latLng: SITE, text: 'fine' };
  assert.equal(validAnnotation(good), true);
  assert.deepEqual(annotationsOf({ annotations: [...bad, good] }), [good]);
});

test('a project with no annotations reads as an empty list, not undefined', () => {
  assert.deepEqual(annotationsOf({}), []);
});

test('generated ids are unique across a rapid burst', () => {
  // All within one millisecond, so the timestamp is identical for every id and
  // only the sequence separates them. Randomness alone flaked here at ~7 %.
  const ids = new Set(Array.from({ length: 5000 }, () => newAnnotationId()));
  assert.equal(ids.size, 5000);
});
