// The elevation snapshot the grid workers solve against.
//
// The workers never see the DemRaster — they get this dense lat/lng grid, and
// whatever it does not resolve simply does not screen. Two things therefore
// matter: it must be sampled at the DEM's own pitch (a 1 m LiDAR source pinned
// at the old ~30 m target threw away everything that made it worth fetching),
// and the typed-array fast path must agree with the generic one, because only
// some rasters take it and nothing downstream would notice a disagreement.

import test from 'node:test';
import assert from 'node:assert/strict';

import { captureDemRegion, regionRaster, type DemRaster, type DemRegion } from './dem';
import { parseDemGeoTiffBuffer } from './demUpload';
import { RAMP_H, RAMP_NORTH, RAMP_PIXEL_DEG, RAMP_W, RAMP_WEST, rampTiff } from './__fixtures__/geotiff';
import { packHeightfield, type GridJob } from './gridCore';
import type { SceneHeightfield } from './sceneBuilder';
import { gridShardMessage, sourcePaddedBounds } from './solver';
import { TERRAIN_MAX_CELLS_PER_AXIS } from './terrainField';

// ------------------------------------------------------- snapshot fast path

const SRC_SW: [number, number] = [-27.50, 153.00];
const SRC_NE: [number, number] = [-27.46, 153.05];

/// A 7 × 5 source grid with a diagonal ramp and one hole, so the comparison
/// below exercises interpolation, NaN propagation and the edges.
function sourceGrid(): DemRegion {
  const nx = 7;
  const ny = 5;
  const data = new Float32Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) data[j * nx + i] = i * 3 - j * 2;
  data[2 * nx + 3] = NaN;
  return { data, sw: SRC_SW, ne: SRC_NE, nx, ny };
}

test('the snapshot fast path reproduces the generic sampling loop', () => {
  const src = sourceGrid();
  // The generic path goes through `elevation`; `regionRaster` is an
  // independently written bilinear lookup over the same grid, so this is a
  // comparison between two implementations, not a function against itself.
  const slow: DemRaster = regionRaster(src);
  const fast: DemRaster = { ...slow, grid: () => src };
  assert.equal(slow.grid, undefined, 'the generic raster must not offer a grid');

  // Deliberately offset and larger than the source, so ~a third of the output
  // falls outside coverage and must come back as the 0 both paths promise.
  const sw: [number, number] = [-27.515, 152.99];
  const ne: [number, number] = [-27.455, 153.045];
  const a = captureDemRegion(slow, sw, ne, 23, 19);
  const b = captureDemRegion(fast, sw, ne, 23, 19);

  assert.equal(b.nx, a.nx);
  assert.equal(b.ny, a.ny);
  let outside = 0;
  let holes = 0;
  for (let i = 0; i < a.data.length; i++) {
    if (Number.isNaN(a.data[i])) {
      assert.ok(Number.isNaN(b.data[i]), `hole at ${i} filled by the fast path`);
      holes++;
      continue;
    }
    if (a.data[i] === 0) outside++;
    // Same stencil, different order of the same arithmetic: agreement is to
    // floating-point noise, not bit-for-bit.
    assert.ok(Math.abs(a.data[i] - b.data[i]) < 1e-9, `sample ${i}: ${a.data[i]} vs ${b.data[i]}`);
  }
  assert.ok(holes > 0, 'the hole reached the output');
  assert.ok(outside > 20, 'part of the window really was outside the source');
});

test('an uploaded raster’s own grid frame matches its elevation lookup', async () => {
  // `DemRegion` corners are the extreme SAMPLE POINTS, but a GeoTIFF's bbox
  // names the outer pixel EDGES. Handing the bbox straight to `grid()` only
  // agreed with `elevation` while the sampler wrongly treated the corners as
  // centres, so the two paths would silently drift half a pixel apart.
  const dem = await parseDemGeoTiffBuffer(rampTiff(), { noDataValue: -9999 });
  assert.ok(dem.grid, 'a geographic upload offers its grid');

  // A window offset from, and larger than, the file, so edges and the outside-
  // coverage zero are exercised as well as the interior.
  const sw: [number, number] = [RAMP_NORTH - (RAMP_H + 1) * RAMP_PIXEL_DEG, RAMP_WEST - RAMP_PIXEL_DEG];
  const ne: [number, number] = [RAMP_NORTH + RAMP_PIXEL_DEG, RAMP_WEST + (RAMP_W + 1) * RAMP_PIXEL_DEG];
  // 17 × 12 deliberately: no sample lands exactly on the coverage boundary,
  // where the two differently-scaled index formulas could disagree by an ulp
  // and one path would drop to 0 while the other interpolated.
  const fast = captureDemRegion(dem, sw, ne, 17, 12);
  const slow = captureDemRegion({ ...dem, grid: undefined }, sw, ne, 17, 12);
  let holes = 0;
  for (let i = 0; i < slow.data.length; i++) {
    if (Number.isNaN(slow.data[i])) {
      assert.ok(Number.isNaN(fast.data[i]), `hole at ${i} filled by the fast path`);
      holes++;
      continue;
    }
    assert.ok(Math.abs(fast.data[i] - slow.data[i]) < 1e-9,
      `sample ${i}: ${fast.data[i]} vs ${slow.data[i]}`);
  }
  assert.ok(holes > 0, 'the no-data sentinel reached the output');
});

// -------------------------------------------------------- snapshot sizing

/// The calc area, plus one source well outside it.
const JOB = {
  bounds: { sw: [-27.50, 153.00], ne: [-27.40, 153.10] },
  tiles: [{ sources: [{ latLng: [-27.45, 153.20] }] }],
} as unknown as GridJob;

/// A 2 km BESS-sized site, where a metre-scale pitch fits inside the cap.
const SMALL_JOB = {
  bounds: { sw: [-27.50, 153.00], ne: [-27.48, 153.02] },
  tiles: [{ sources: [{ latLng: [-27.49, 153.01] }] }],
} as unknown as GridJob;

const spanM = (job: ReturnType<typeof sourcePaddedBounds>) => {
  const [sw, ne] = job;
  return {
    lat: (ne[0] - sw[0]) * 111_000,
    lng: (ne[1] - sw[1]) * 111_000 * Math.cos((sw[0] * Math.PI) / 180),
  };
};

test('the snapshot spans the sources, not just the calculation area', () => {
  const bounds = sourcePaddedBounds(JOB, 30);
  const [sw, ne] = bounds;
  // Ridge sampling walks the whole source→cell line, so a source outside the
  // box that is outside the snapshot reads sea level for its own ground.
  assert.ok(ne[1] > 153.20, 'the eastern source is inside the snapshot');
  assert.ok(sw[1] < 153.00 && sw[0] < -27.50 && ne[0] > -27.40);
});

test('the snapshot is sampled at the DEM’s own pitch', () => {
  const { lat, lng } = spanM(sourcePaddedBounds(JOB, 30));
  const [, , nx, ny] = sourcePaddedBounds(JOB, 30);
  assert.ok(Math.abs(lng / nx - 30) < 1, `${(lng / nx).toFixed(1)} m per sample E-W`);
  assert.ok(Math.abs(lat / ny - 30) < 1, `${(lat / ny).toFixed(1)} m per sample N-S`);

  // A finer DEM produces a finer snapshot — the whole point of the change.
  // Small site, so the cell cap does not bind before the pitch does.
  const small = spanM(sourcePaddedBounds(SMALL_JOB, 5));
  const [, , sx, sy] = sourcePaddedBounds(SMALL_JOB, 5);
  assert.ok(Math.abs(small.lng / sx - 5) < 0.5, `${(small.lng / sx).toFixed(1)} m per sample`);
  assert.ok(Math.abs(small.lat / sy - 5) < 0.5, `${(small.lat / sy).toFixed(1)} m per sample`);
  const [, , sx30] = sourcePaddedBounds(SMALL_JOB, 30);
  assert.ok(sx > sx30, 'a 5 m DEM is snapshotted more densely than a 30 m one');
});

test('the snapshot is capped at the engine’s own cell limit', () => {
  // 1 m LiDAR over this extent wants ~22 000 samples across. The snapshot is
  // cloned to every grid worker, and the engine caps its heightfield at the
  // same number, so anything finer is bytes for detail the solve discards.
  const [, , nx, ny] = sourcePaddedBounds(JOB, 1);
  assert.equal(nx, TERRAIN_MAX_CELLS_PER_AXIS);
  assert.ok(ny <= TERRAIN_MAX_CELLS_PER_AXIS);
});

// ------------------------------------------ what one shard is actually sent

const FIELD: SceneHeightfield = {
  type: 'heightfield', origin: [-250, -250], spacing: 10, nx: 3, ny: 2,
  heights: [10, 11, 12, 13, 14, 15],
};
const SHARD_JOB = { cols: 8, rows: 8, terrain: FIELD, tiles: [] } as unknown as GridJob;
const REGION: DemRegion = { data: new Float32Array(4), sw: SRC_SW, ne: SRC_NE, nx: 2, ny: 2 };
const HELD_NOTHING = { regionKey: null, terrainKey: null };
const REGION_ARG = { key: 'region-1', region: REGION };
const TERRAIN_ARG = { key: 'terrain-1', packed: packHeightfield(FIELD) };

test('the heightfield does not ride inside a shard’s job', () => {
  // It used to: up to 2048² boxed doubles, structure-cloned to EVERY shard on
  // EVERY solve, which is over a second of main-thread time each — and every
  // shard was getting the same one.
  const { message } = gridShardMessage(1, SHARD_JOB, [], REGION_ARG, TERRAIN_ARG, HELD_NOTHING);
  assert.equal(message.job.terrain, null, 'the job carries only the key');
  assert.equal(message.terrainKey, 'terrain-1');
  assert.ok(message.terrain?.heights instanceof Float64Array, 'and it crosses as one buffer');
  assert.deepEqual(Array.from(message.terrain!.heights), FIELD.heights);
});

test('the region and the heightfield are sent once per worker, then only named', () => {
  const first = gridShardMessage(1, SHARD_JOB, [], REGION_ARG, TERRAIN_ARG, HELD_NOTHING);
  assert.ok(first.message.region && first.message.terrain, 'a fresh worker is given both');
  assert.deepEqual(first.held, { regionKey: 'region-1', terrainKey: 'terrain-1' });

  const again = gridShardMessage(2, SHARD_JOB, [], REGION_ARG, TERRAIN_ARG, first.held);
  assert.equal(again.message.region, null, 'a re-solve over the same area names the region');
  assert.equal(again.message.terrain, null, '…and names the heightfield');
  assert.equal(again.message.regionKey, 'region-1');
  assert.equal(again.message.terrainKey, 'terrain-1');

  // A different terrain — the calc area moved, or the DEM changed — is shipped
  // again. The worker refuses a key it does not hold rather than solving flat.
  const moved = gridShardMessage(
    3, SHARD_JOB, [], REGION_ARG, { key: 'terrain-2', packed: TERRAIN_ARG.packed }, again.held,
  );
  assert.ok(moved.message.terrain, 'a new heightfield is shipped');
  assert.equal(moved.message.terrainKey, 'terrain-2');
});

test('a project with no terrain clears whatever the worker was holding', () => {
  const { message, held } = gridShardMessage(
    4, SHARD_JOB, [], null, null, { regionKey: 'region-1', terrainKey: 'terrain-1' },
  );
  assert.equal(message.terrainKey, null, 'null is "flat ground", not a cache hit');
  assert.equal(message.regionKey, null);
  assert.equal(message.terrain, null);
  assert.equal(message.region, null);
  assert.deepEqual(held, { regionKey: null, terrainKey: null });
});

test('a coarse DEM still gets a usable snapshot, and a broken pitch a sane one', () => {
  // The 128 floor: a 90 m DEM over a small site must not produce a 4×4 grid.
  const [, , nx, ny] = sourcePaddedBounds(JOB, 500);
  assert.equal(nx, 128);
  assert.equal(ny, 128);
  // `resolutionM` is optional on a DemRaster, and a synthetic one can carry
  // nonsense; neither may produce a zero-sized or infinite snapshot.
  for (const bad of [0, -5, NaN, Infinity]) {
    const [, , bx, by] = sourcePaddedBounds(JOB, bad);
    assert.ok(Number.isInteger(bx) && bx >= 128 && bx <= TERRAIN_MAX_CELLS_PER_AXIS, `${bad}`);
    assert.ok(Number.isInteger(by) && by >= 128 && by <= TERRAIN_MAX_CELLS_PER_AXIS, `${bad}`);
  }
});
