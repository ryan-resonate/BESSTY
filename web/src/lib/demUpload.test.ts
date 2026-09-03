// Where an uploaded DEM's cells actually are, and how big it says they are.
//
// `resolutionM` used to be left unset here, so every uploaded GeoTIFF —
// including 1 m LiDAR — was screened at `terrainField`'s 20 m fallback and most
// of the data the user supplied was thrown away. The pitch cases pin the
// arithmetic that now derives it; the georeferencing ones parse a hand-built
// fixture end to end, because a half-pixel offset moves every level in the
// project and nothing else would notice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { demPixelPitchM, parseDemGeoTiffBuffer } from './demUpload';
import { floatGeoTiff } from './__fixtures__/geotiff';

// A site near Tarong, the project the DEM work was validated against.
const BOUNDS = { sw: [-26.80, 151.88] as [number, number], ne: [-26.76, 151.92] as [number, number] };

test('projected CRS: the pitch is the finer axis, in the file’s own metres', () => {
  // MGA zone 56, 2 km × 2 km at 1000 × 500 pixels → 2 m E-W, 4 m N-S.
  assert.ok(Math.abs(demPixelPitchM(28356, 2000, 2000, 1000, 500, BOUNDS) - 2) < 1e-9);
  // Square 5 m cells.
  assert.equal(demPixelPitchM(28356, 5000, 5000, 1000, 1000, BOUNDS), 5);
});

test('projected CRS in feet is converted, not taken at face value', () => {
  // 10 international feet per cell is 3.048 m, not 10 m.
  const ft = demPixelPitchM(2230, 1000, 1000, 100, 100, BOUNDS, 0.3048);
  assert.ok(Math.abs(ft - 10 * 0.3048) < 1e-9, `${ft} m`);
  // US survey foot differs in the sixth digit; it must not be silently ignored.
  const us = demPixelPitchM(2230, 1000, 1000, 100, 100, BOUNDS, 1200 / 3937);
  assert.ok(us > ft, 'the US survey foot is the longer of the two');
});

test('geographic CRS: degrees become metres, E-W shortened by the latitude', () => {
  // A 1-second grid: 1/3600° per cell. At 26.78 °S the E-W cell is ~27.6 m and
  // the N-S one ~30.9 m, so the finer axis is E-W.
  const deg = 1 / 3600;
  const pitch = demPixelPitchM(4326, deg * 100, deg * 100, 100, 100, BOUNDS);
  const nsM = deg * (Math.PI / 180) * 6371008.8;
  assert.ok(Math.abs(pitch - nsM * Math.cos((26.78 * Math.PI) / 180)) < 0.05, `${pitch} m`);
  assert.ok(pitch < nsM, 'E-W is the finer axis away from the equator');

  // Every GEOGRAPHIC CRS the registry knows, not a hard-coded 4326/4269 pair:
  // a 5 m ELVIS DEM tagged GDA94 read as metres reports 5e-5 m per cell, which
  // pins the heightfield to its cap and prints "0.0 m native" on the report.
  for (const code of [4269, 4283, 7844, 4322]) {
    assert.equal(demPixelPitchM(code, deg * 100, deg * 100, 100, 100, BOUNDS), pitch, `EPSG:${code}`);
  }
  // …and a projected one still reads as metres.
  assert.ok(demPixelPitchM(28356, deg * 100, deg * 100, 100, 100, BOUNDS) < 1e-3);
});

test('a single-pixel or degenerate raster does not divide by zero', () => {
  assert.ok(Number.isFinite(demPixelPitchM(28356, 10, 10, 1, 1, BOUNDS)));
  assert.ok(demPixelPitchM(28356, 10, 10, 1, 1, BOUNDS) > 0);
});

// --------------------------------------------------------- georeferencing

const W = 152.0;
const N = -27.0;
const PIX = 0.001;

/// 3 × 3, each cell holding its own column index — so a sample reads back as
/// the (fractional) column it landed in.
function columnsTiff(rasterType: 1 | 2 = 1): ArrayBuffer {
  const values = new Float32Array(9);
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) values[j * 3 + i] = i;
  return floatGeoTiff(values, 3, 3, W, N, PIX, rasterType);
}

test('PixelIsArea: the bbox names pixel EDGES, so centres sit half a pixel in', async () => {
  // This is the GeoTIFF default and what ELVIS, GDAL and the QLD ImageServer
  // all write. Treating the corners as centres offset every sample by half a
  // cell and stretched the raster by 1/(width − 1) on top of that.
  const dem = await parseDemGeoTiffBuffer(columnsTiff());
  const lat = N - PIX * 1.5;                         // middle row's centre
  const centre0 = W + PIX / 2;
  // Exact to the degree arithmetic itself: a cell centre reads its own value
  // back, with no contribution bled in from either neighbour.
  const near = (v: number, want: number, what: string) =>
    assert.ok(Math.abs(v - want) < 1e-9, `${what}: ${v}`);
  near(dem.elevation(lat, centre0), 0, 'the first cell at its own centre');
  near(dem.elevation(lat, centre0 + PIX), 1, 'the centre cell, at its centre');
  // The shared edge between two cells is half way between their centres.
  near(dem.elevation(lat, W + PIX), 0.5, 'the shared edge interpolates');
  near(dem.elevation(lat, W + 2 * PIX), 1.5, 'and the next one');
  // Past the last cell CENTRE there is no stencil, so — as with every other
  // raster in the app — coverage ends there rather than at the bbox corner.
  assert.equal(dem.elevation(lat, W + 3 * PIX), 0, 'the outer half-pixel');
  // Pitch is the bbox over the CELL COUNT, not the gaps between centres.
  const nsM = PIX * (Math.PI / 180) * 6371008.8;
  assert.ok(Math.abs((dem.resolutionM ?? 0) - nsM * Math.cos((N * Math.PI) / 180)) < 0.05);
});

test('PixelIsPoint is honoured: there the tie point IS the first centre', async () => {
  const dem = await parseDemGeoTiffBuffer(columnsTiff(2));
  const lat = N - PIX;                               // middle row, on its centre
  assert.equal(dem.elevation(lat, W), 0, 'no half-pixel shift for a point raster');
  assert.ok(Math.abs(dem.elevation(lat, W + PIX) - 1) < 1e-9);
  assert.ok(Math.abs(dem.elevation(lat, W + PIX * 1.5) - 1.5) < 1e-9);
});
