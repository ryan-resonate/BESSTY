import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chooseZoom, fitFrame, formatScale, niceScaleLength, PAGES, project, tileRange,
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
