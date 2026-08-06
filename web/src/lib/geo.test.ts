import test from 'node:test';
import assert from 'node:assert/strict';

import { calcAreaCorners, latLngToLocalMetres } from './geo';

const CENTRE: [number, number] = [-27.0, 152.0];

/// Axis-aligned lat/lng bounds of a corner set.
function boundsOf(corners: Array<[number, number]>) {
  const lats = corners.map((c) => c[0]);
  const lngs = corners.map((c) => c[1]);
  return {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
  };
}

test('an unrotated calc area has corners at ±half its width and height', () => {
  const corners = calcAreaCorners({ centerLatLng: CENTRE, widthM: 1000, heightM: 600 });
  assert.equal(corners.length, 4);
  for (const c of corners) {
    const [e, n] = latLngToLocalMetres(c, CENTRE);
    assert.ok(Math.abs(Math.abs(e) - 500) < 0.5, `east offset ${e.toFixed(2)} should be ±500`);
    assert.ok(Math.abs(Math.abs(n) - 300) < 0.5, `north offset ${n.toFixed(2)} should be ±300`);
  }
});

test('rotation preserves the rectangle: side lengths and diagonal are unchanged', () => {
  const spec = { centerLatLng: CENTRE, widthM: 1000, heightM: 600, rotationDeg: 37 };
  const corners = calcAreaCorners(spec).map((c) => latLngToLocalMetres(c, CENTRE));
  const side = (a: number, b: number) =>
    Math.hypot(corners[b][0] - corners[a][0], corners[b][1] - corners[a][1]);
  // Corners run round the rectangle, so consecutive pairs alternate W, H, W, H.
  assert.ok(Math.abs(side(0, 1) - 1000) < 0.5, `width ${side(0, 1).toFixed(2)}`);
  assert.ok(Math.abs(side(1, 2) - 600) < 0.5, `height ${side(1, 2).toFixed(2)}`);
  assert.ok(Math.abs(side(2, 3) - 1000) < 0.5);
  assert.ok(Math.abs(side(3, 0) - 600) < 0.5);
});

test('a rotated area needs a BIGGER axis-aligned box than width × height', () => {
  // The bug this guards: the DEM fetch bounds were derived from width/height
  // alone, which describes the UNROTATED box. A rotated area then had corners
  // outside the downloaded tiles, and a DEM miss reads as 0 m (sea level)
  // rather than an error — so those corners silently solved against the wrong
  // ground.
  const flat = boundsOf(calcAreaCorners({ centerLatLng: CENTRE, widthM: 1000, heightM: 600 }));
  const spun = boundsOf(calcAreaCorners({
    centerLatLng: CENTRE, widthM: 1000, heightM: 600, rotationDeg: 45,
  }));
  assert.ok(spun.maxLat > flat.maxLat, 'a 45° rotation must extend the box north');
  assert.ok(spun.minLat < flat.minLat, 'and south');
  // At 45° the extent along each axis becomes (w + h)/√2 ≈ 1131 m, so the
  // north–south span grows from 600 m to about that.
  const spanN = (spun.maxLat - spun.minLat) * (Math.PI / 180) * 6371008.8;
  assert.ok(
    Math.abs(spanN - 1600 / Math.SQRT2) < 2,
    `expected a ~${(1600 / Math.SQRT2).toFixed(0)} m north–south span at 45°, got ${spanN.toFixed(0)} m`,
  );
});

test('a 90° rotation swaps the width and height of the bounding box', () => {
  const spun = boundsOf(calcAreaCorners({
    centerLatLng: CENTRE, widthM: 1000, heightM: 600, rotationDeg: 90,
  }));
  const spanN = (spun.maxLat - spun.minLat) * (Math.PI / 180) * 6371008.8;
  assert.ok(Math.abs(spanN - 1000) < 1, `expected 1000 m north–south, got ${spanN.toFixed(1)}`);
});
