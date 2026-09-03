// The pitch an uploaded DEM is sampled at.
//
// `resolutionM` used to be left unset here, so every uploaded GeoTIFF —
// including 1 m LiDAR — was screened at `terrainField`'s 20 m fallback and most
// of the data the user supplied was thrown away. These cases pin the arithmetic
// that now derives it, since there is no fixture GeoTIFF to parse end to end.

import test from 'node:test';
import assert from 'node:assert/strict';

import { demPixelPitchM } from './demUpload';

// A site near Tarong, the project the DEM work was validated against.
const BOUNDS = { sw: [-26.80, 151.88] as [number, number], ne: [-26.76, 151.92] as [number, number] };

test('projected CRS: the pitch is the finer axis, in the file’s own metres', () => {
  // MGA zone 56, 2 km × 2 km at 1000 × 500 pixels → 2 m E-W, 4 m N-S.
  assert.ok(Math.abs(demPixelPitchM(28356, 1998, 1996, 1000, 500, BOUNDS) - 2) < 1e-9);
  // Square 5 m cells.
  assert.equal(demPixelPitchM(28356, 5000, 5000, 1001, 1001, BOUNDS), 5);
});

test('projected CRS in feet is converted, not taken at face value', () => {
  // 10 international feet per cell is 3.048 m, not 10 m.
  const ft = demPixelPitchM(2230, 1000, 1000, 101, 101, BOUNDS, 0.3048);
  assert.ok(Math.abs(ft - 10 * 0.3048) < 1e-9, `${ft} m`);
  // US survey foot differs in the sixth digit; it must not be silently ignored.
  const us = demPixelPitchM(2230, 1000, 1000, 101, 101, BOUNDS, 1200 / 3937);
  assert.ok(us > ft, 'the US survey foot is the longer of the two');
});

test('geographic CRS: degrees become metres, E-W shortened by the latitude', () => {
  // A 1-second grid: 1/3600° per cell. At 26.78 °S the E-W cell is ~27.6 m and
  // the N-S one ~30.9 m, so the finer axis is E-W.
  const deg = 1 / 3600;
  const pitch = demPixelPitchM(4326, deg * 100, deg * 100, 101, 101, BOUNDS);
  const nsM = deg * (Math.PI / 180) * 6371008.8;
  assert.ok(Math.abs(pitch - nsM * Math.cos((26.78 * Math.PI) / 180)) < 0.05, `${pitch} m`);
  assert.ok(pitch < nsM, 'E-W is the finer axis away from the equator');

  // NAD83 (4269) is treated as geographic too, not as metres.
  assert.equal(demPixelPitchM(4269, deg * 100, deg * 100, 101, 101, BOUNDS), pitch);
});

test('a single-pixel or degenerate raster does not divide by zero', () => {
  assert.ok(Number.isFinite(demPixelPitchM(28356, 10, 10, 1, 1, BOUNDS)));
  assert.ok(demPixelPitchM(28356, 10, 10, 1, 1, BOUNDS) > 0);
});
