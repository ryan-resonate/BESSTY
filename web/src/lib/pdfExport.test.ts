import test from 'node:test';
import assert from 'node:assert/strict';

import { jsPDF } from 'jspdf';

import {
  beginFrameClip, chooseZoom, clipPolylineToRect, clipSegmentToRect, endFrameClip,
  fitFrame, formatScale, niceScaleLength, PAGES, project, tileRange,
} from './pdfExport';

const extent = { sw: [-27.01, 152.0] as [number, number], ne: [-27.0, 152.01] as [number, number] };

test('the projection is Web Mercator normalised to the unit square', () => {
  const eq = project(0, 0);
  assert.ok(Math.abs(eq.x - 0.5) < 1e-12);
  assert.ok(Math.abs(eq.y - 0.5) < 1e-12);
  // y increases southward.
  assert.ok(project(-45, 0).y > project(45, 0).y);
  // x increases eastward.
  assert.ok(project(0, 90).x > project(0, -90).x);
});

test('the map frame preserves aspect — a stretched figure is a wrong scale bar', () => {
  const f = fitFrame(extent, PAGES['a4-landscape'], 0);
  const p = project(extent.sw[0], extent.sw[1]);
  const q = project(extent.ne[0], extent.ne[1]);
  const worldAspect = Math.abs(q.x - p.x) / Math.abs(q.y - p.y);
  assert.ok(Math.abs((f.w / f.h) - worldAspect) < 1e-9);
});

test('the frame fits inside the page margins', () => {
  const page = PAGES['a4-landscape'];
  const f = fitFrame(extent, page, 20);
  assert.ok(f.x >= page.marginMm - 1e-9);
  assert.ok(f.y >= page.marginMm + 20 - 1e-9);
  assert.ok(f.x + f.w <= page.widthMm - page.marginMm + 1e-9);
  assert.ok(f.y + f.h <= page.heightMm - page.marginMm + 1e-9);
});

test('corners map to the frame corners, and north is up', () => {
  const f = fitFrame(extent, PAGES['a4-landscape'], 0);
  const [swX, swY] = f.toPage(extent.sw[0], extent.sw[1]);
  const [neX, neY] = f.toPage(extent.ne[0], extent.ne[1]);
  assert.ok(Math.abs(swX - f.x) < 1e-6, 'west edge');
  assert.ok(Math.abs(neX - (f.x + f.w)) < 1e-6, 'east edge');
  // Page y grows downward, so the NORTH corner has the SMALLER y.
  assert.ok(neY < swY, 'north is up the page');
});

test('scale bar lengths are numbers people recognise', () => {
  assert.equal(niceScaleLength(1), 1);
  assert.equal(niceScaleLength(3), 2);
  assert.equal(niceScaleLength(7), 5);
  assert.equal(niceScaleLength(23), 20);
  assert.equal(niceScaleLength(1400), 1000);
  assert.equal(niceScaleLength(0), 100, 'degenerate input still gives something drawable');
  assert.equal(formatScale(500), '500 m');
  assert.equal(formatScale(2000), '2 km');
  assert.equal(formatScale(1500), '1.5 km');
});

test('metresPerMm is plausible for a known extent', () => {
  // ~1.1 km tall at this latitude, on an A4 landscape page.
  const f = fitFrame(extent, PAGES['a4-landscape'], 0);
  const acrossM = f.metresPerMm * f.w;
  assert.ok(acrossM > 500 && acrossM < 2000, `expected ~1 km across, got ${acrossM.toFixed(0)} m`);
});

test('tile range covers the extent', () => {
  const r = tileRange(extent, 14);
  assert.ok(r.x1 >= r.x0);
  assert.ok(r.y1 >= r.y0);
  assert.equal(r.n, Math.pow(2, 14));
});

test('zoom selection is bounded so a huge extent cannot fire a thousand requests', () => {
  const world = { sw: [-60, -170] as [number, number], ne: [60, 170] as [number, number] };
  const z = chooseZoom(world, 2400, 19);
  const r = tileRange(world, z);
  const tiles = (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
  assert.ok(tiles <= 400, `expected a bounded tile count, got ${tiles}`);
});

test('a small extent still picks a detailed zoom', () => {
  const z = chooseZoom(extent, 2400, 19);
  assert.ok(z >= 13, `expected a detailed zoom for a 1 km extent, got ${z}`);
});

// ---- clipping to the map frame ----

const box = { x: 10, y: 10, w: 100, h: 80 };   // right edge 110, bottom edge 90

test('a segment fully inside the rect is returned unchanged', () => {
  assert.deepEqual(clipSegmentToRect([20, 20], [50, 60], box), [[20, 20], [50, 60]]);
});

test('a segment fully outside the rect is rejected', () => {
  assert.equal(clipSegmentToRect([0, 0], [5, 200], box), null);       // left of it
  assert.equal(clipSegmentToRect([120, 0], [200, 200], box), null);   // right of it
  assert.equal(clipSegmentToRect([0, 95], [200, 95], box), null);     // passes below
});

test('a crossing segment is cut exactly at the boundaries', () => {
  const seg = clipSegmentToRect([0, 50], [200, 50], box);
  assert.ok(seg);
  assert.ok(Math.abs(seg[0][0] - 10) < 1e-9 && Math.abs(seg[0][1] - 50) < 1e-9, `in at ${seg[0]}`);
  assert.ok(Math.abs(seg[1][0] - 110) < 1e-9 && Math.abs(seg[1][1] - 50) < 1e-9, `out at ${seg[1]}`);
});

test('a diagonal exit lands on the rect edge, not past it', () => {
  const seg = clipSegmentToRect([60, 50], [160, 150], box);
  assert.ok(seg);
  assert.ok(Math.abs(seg[1][1] - (box.y + box.h)) < 1e-9, `expected bottom-edge exit, got ${seg[1]}`);
});

test('a polyline that leaves and re-enters becomes two runs, all inside', () => {
  const runs = clipPolylineToRect([[20, 20], [150, 20], [150, 40], [20, 40]], box);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    for (const [x, y] of run) {
      assert.ok(x >= box.x - 1e-9 && x <= box.x + box.w + 1e-9, `x ${x} escaped`);
      assert.ok(y >= box.y - 1e-9 && y <= box.y + box.h + 1e-9, `y ${y} escaped`);
    }
  }
});

test('an all-inside polyline is one run, identical to the input', () => {
  const pts: Array<[number, number]> = [[20, 20], [40, 30], [60, 20], [80, 70]];
  const runs = clipPolylineToRect(pts, box);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], pts);
});

test('a fully-outside polyline clips to nothing', () => {
  assert.deepEqual(clipPolylineToRect([[0, 0], [5, 5], [0, 200]], box), []);
});

test('every vertex of a wild multi-crossing polyline stays inside the rect', () => {
  // A growing spiral centred in the box, crossing all four edges repeatedly —
  // the shape of a contour line around a source near the frame edge.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 50; i++) {
    pts.push([60 + Math.cos(i * 0.7) * (5 + i * 3), 50 + Math.sin(i * 0.7) * (5 + i * 3)]);
  }
  const runs = clipPolylineToRect(pts, box);
  assert.ok(runs.length > 1, 'a spiral this size must cross the frame more than once');
  for (const run of runs) {
    assert.ok(run.length >= 2);
    for (const [x, y] of run) {
      assert.ok(x >= box.x - 1e-9 && x <= box.x + box.w + 1e-9, `x ${x} escaped`);
      assert.ok(y >= box.y - 1e-9 && y <= box.y + box.h + 1e-9, `y ${y} escaped`);
    }
  }
});

test('beginFrameClip emits re→W→n — the null-style regression, pinned at the app helper', () => {
  // jsPDF's rect() PAINTS and consumes the path unless the style argument is
  // literally null (putStyle early-returns only for null). The report's clip
  // once emitted `re S W n` — a stroked rectangle, then a clip with no current
  // path, which viewers ignore — and every contour overflowed the frame.
  // Guard the operator sequence of the helper buildPdf actually calls, so the
  // one-argument regression cannot return silently.
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: [297, 210] });
  beginFrameClip(doc, { x: 10, y: 10, w: 100, h: 80 });
  doc.lines([[10, 10]], 20, 20);
  endFrameClip(doc);
  const out = doc.output();
  assert.match(out, / re\s+W\s+n\s/, 'rect path must flow unpainted into W n');
  assert.doesNotMatch(out, / re\s+S\s/, 'the rect must not be painted before the clip');
});
