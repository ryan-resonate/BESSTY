// The cascade decides, silently and per project, which elevation dataset a
// solve stands on. Nothing in the UI lets a user override it, so the ordering
// and the fall-through are the whole contract — and a source that quietly
// returns the WRONG raster instead of falling through would be invisible.

import test from 'node:test';
import assert from 'node:assert/strict';

import { terrainReportLine, terrainSourceNote, type DemRaster } from '../dem';
import {
  AUTO_DEM_SOURCES, loadAutoDem, upgradeStillWanted,
  type DemBounds, type DemSource,
} from './index';
import { demSPixelWindow, demSWindowRaster, GA_DEM_S } from './gaDemS';

const BOUNDS: DemBounds = { sw: [-26.80, 151.88], ne: [-26.76, 151.92] };

const raster = (tag: string): DemRaster => ({
  elevation: () => 1,
  bounds: BOUNDS,
  tilesLoaded: 1,
  source: {
    id: 'terrarium', label: tag, attribution: `credit ${tag}`, licence: 'x', nativePitchM: 30,
  },
});

interface FakeOpts {
  covers?: boolean;
  throwOn?: 'covers' | 'load';
  deferred?: boolean;
  /// Hold `load` open until the returned promise is resolved by the test.
  gate?: Promise<void>;
  /// Bumped on every `covers` / `load` call, so a test can prove a source was
  /// never reached at all.
  calls?: string[];
}

function fake(id: string, opts: FakeOpts = {}): DemSource {
  return {
    id,
    label: id,
    deferred: opts.deferred,
    async covers() {
      opts.calls?.push(`${id}.covers`);
      if (opts.throwOn === 'covers') throw new Error(`${id} covers exploded`);
      return opts.covers ?? true;
    },
    async load() {
      opts.calls?.push(`${id}.load`);
      if (opts.throwOn === 'load') throw new Error(`${id} load exploded`);
      if (opts.gate) await opts.gate;
      return raster(id);
    },
  };
}

const labelOf = async (sources: DemSource[]) =>
  (await loadAutoDem(BOUNDS, { sources })).source?.label;

/// A promise plus its resolver, for holding a slow source open.
function gate(): { promise: Promise<void>; open: () => void } {
  let open = () => {};
  const promise = new Promise<void>((resolve) => { open = () => resolve(); });
  return { promise, open };
}

/// Resolves with the raster the deferred pass hands back, or `null` if that
/// pass ends without one.
function upgradeOutcome(sources: DemSource[]): {
  fast: Promise<DemRaster>;
  settled: Promise<DemRaster | null>;
} {
  let seen: DemRaster | null = null;
  let done!: (r: DemRaster | null) => void;
  const settled = new Promise<DemRaster | null>((resolve) => { done = resolve; });
  const fast = loadAutoDem(BOUNDS, {
    sources,
    onUpgrade: (r) => { seen = r; },
    onUpgradeSettled: () => done(seen),
  });
  return { fast, settled };
}

test('cascade: the first covering source wins', async () => {
  assert.equal(await labelOf([fake('a'), fake('b')]), 'a');
});

test('cascade: a source with no coverage is skipped', async () => {
  assert.equal(await labelOf([fake('a', { covers: false }), fake('b')]), 'b');
});

test('cascade: a source that throws falls through to the next', async () => {
  assert.equal(await labelOf([fake('a', { throwOn: 'load' }), fake('b')]), 'b');
  assert.equal(await labelOf([fake('a', { throwOn: 'covers' }), fake('b')]), 'b');
});

test('cascade: every source failing is an error, not a flat plane', async () => {
  await assert.rejects(
    () => loadAutoDem(BOUNDS, { sources: [fake('a', { throwOn: 'load' }), fake('b', { covers: false })] }),
    /No DEM source/,
  );
});

// ----------------------------------------------------------- deferred upgrade

test('cascade does not wait for a deferred source, then upgrades to it', async () => {
  // The whole point: a Queensland project must be standing on DEM-S while the
  // LiDAR export is still in flight. The deferred source's `load` is held open,
  // so if the returned promise waited for it this test would hang.
  const slow = gate();
  const calls: string[] = [];
  const deferred = fake('slow', { deferred: true, gate: slow.promise, calls });
  const { fast, settled } = upgradeOutcome([deferred, fake('fast', { calls })]);
  assert.equal((await fast).source?.label, 'fast');
  // …and none of the slow chain has even started at that point: the caller
  // gets its raster before the first `identify` goes out, not merely before
  // the export finishes.
  assert.deepEqual(calls, ['fast.covers', 'fast.load']);
  slow.open();
  assert.equal((await settled)?.source?.label, 'slow');
});

test('a deferred source that does not cover, or throws, leaves the DEM alone', async () => {
  for (const dud of [
    fake('slow', { deferred: true, covers: false }),
    fake('slow', { deferred: true, throwOn: 'covers' }),
    fake('slow', { deferred: true, throwOn: 'load' }),
  ]) {
    const { fast, settled } = upgradeOutcome([dud, fake('fast')]);
    assert.equal((await fast).source?.label, 'fast');
    assert.equal(await settled, null, `${dud.id} must not upgrade`);
  }
});

test('without onUpgrade a deferred source is never touched', async () => {
  // Validation scripts and probe tools call the cascade with no callback: they
  // cannot swap a raster mid-run, so they must not pay for nine probes and a
  // 16 MB export either.
  const calls: string[] = [];
  const sources = [fake('slow', { deferred: true, calls }), fake('fast', { calls })];
  assert.equal((await loadAutoDem(BOUNDS, { sources })).source?.label, 'fast');
  // Long enough for the deferred pass's macrotask to have run, had there been one.
  await new Promise((r) => { setTimeout(r, 5); });
  assert.deepEqual(calls, ['fast.covers', 'fast.load']);
});

test('a superseded load drops the deferred pass instead of running it', async () => {
  // `stillWanted` is the caller saying the raster would be thrown away anyway
  // (an upload, moved bounds, another project). Nine probes and a 16 MB export
  // must not go out for it — and the settle must still fire, or the chip would
  // sit on "checking QLD LiDAR…" for ever.
  const calls: string[] = [];
  let upgraded = false;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => { resolveSettled = resolve; });
  const sources = [fake('slow', { deferred: true, calls }), fake('fast', { calls })];
  const r = await loadAutoDem(BOUNDS, {
    sources,
    stillWanted: () => false,
    onUpgrade: () => { upgraded = true; },
    onUpgradeSettled: () => resolveSettled(),
  });
  assert.equal(r.source?.label, 'fast');
  await settled;
  assert.equal(upgraded, false);
  assert.deepEqual(calls, ['fast.covers', 'fast.load']);
});

test('an upgrade is applied only while it is still the newest DEM load', () => {
  // The counter is bumped by an upload, by a re-fetch for moved bounds and by a
  // project switch, so a stale upgrade landing after any of those would put the
  // project back on terrain the user has already moved off.
  assert.equal(upgradeStillWanted(7, 7), true);
  assert.equal(upgradeStillWanted(7, 8), false);
});

test('cascade order is best-first and holds no upload source', () => {
  // Uploads bypass the cascade entirely (ProjectScreen never calls it while one
  // is loaded), so an `upload` entry here would be a bug. Order is finest data
  // first: QLD LiDAR (metres), DEM-S (30 m bare earth), tiles (30 m raw SRTM).
  assert.deepEqual(AUTO_DEM_SOURCES.map((s) => s.id), ['qld-lidar', 'ga-dem-s', 'terrarium']);
  // QLD is the quality winner but costs tens of seconds, so it is the deferred
  // one: nothing else may be, or a project would sit with no terrain at all.
  assert.deepEqual(AUTO_DEM_SOURCES.filter((s) => s.deferred).map((s) => s.id), ['qld-lidar']);
});

// ------------------------------------------------------------------ reporting

test('terrain diagnostics note names the source, pitch and raster size', () => {
  const note = terrainSourceNote(raster('GA SRTM 1s DEM-S v1.0'), { spacing: 27.5, nx: 120, ny: 98 });
  assert.equal(note, 'Terrain: GA SRTM 1s DEM-S v1.0, 27.5 m cells, 120×98 raster');
});

test('report line carries the credit, and both pitches only when they differ', () => {
  const dem = raster('GA SRTM 1s DEM-S v1.0');
  assert.equal(
    terrainReportLine(dem, 30.0),
    'Terrain: GA SRTM 1s DEM-S v1.0 · 30.0 m cells · credit GA SRTM 1s DEM-S v1.0',
  );
  assert.equal(
    terrainReportLine(dem, 55.0),
    'Terrain: GA SRTM 1s DEM-S v1.0 · 30.0 m native, 55.0 m sampled · credit GA SRTM 1s DEM-S v1.0',
  );
  assert.equal(terrainReportLine(null, 30), null);
});

// -------------------------------------------------------------------- DEM-S

test('DEM-S covers Australia and nothing outside the COG', async () => {
  assert.equal(await GA_DEM_S.covers(BOUNDS), true);                                  // Tarong
  assert.equal(await GA_DEM_S.covers({ sw: [-37.9, 144.8], ne: [-37.7, 145.1] }), true); // Melbourne
  assert.equal(await GA_DEM_S.covers({ sw: [-41.5, 172.5], ne: [-41.2, 173.0] }), false); // NZ
  assert.equal(await GA_DEM_S.covers({ sw: [-45.5, 146.0], ne: [-45.2, 146.4] }), false); // south of 44°S
});

test('DEM-S window covers the bounds plus the 500 m terrain margin', () => {
  const win = demSPixelWindow(BOUNDS);
  const r = demSWindowRaster(win, new Float32Array(win.nx * win.ny).fill(100));
  const mPerDeg = (Math.PI / 180) * 6371008.8;
  const cosLat = Math.cos((-26.78 * Math.PI) / 180);
  // `buildTerrainField` pads its heightfield by TERRAIN_MARGIN_M, so a raster
  // short of that samples 0 m off the edge and invents a cliff. Slack is one
  // pixel of bilinear stencil plus rounding, so ~600 m is the ceiling.
  const margins = [
    (r.bounds.ne[0] - BOUNDS.ne[0]) * mPerDeg,
    (BOUNDS.sw[0] - r.bounds.sw[0]) * mPerDeg,
    (r.bounds.ne[1] - BOUNDS.ne[1]) * mPerDeg * cosLat,
    (BOUNDS.sw[1] - r.bounds.sw[1]) * mPerDeg * cosLat,
  ];
  for (const m of margins) assert.ok(m >= 500 && m <= 600, `margin ${m.toFixed(0)} m`);
});

test('DEM-S raster interpolates bilinearly and reports the finer axis pitch', () => {
  const win = demSPixelWindow(BOUNDS);
  // A pure west→east ramp of 1 m per pixel: the value at a point must be its
  // fractional column, so a half-pixel step reads 0.5.
  const values = new Float32Array(win.nx * win.ny);
  for (let j = 0; j < win.ny; j++) for (let i = 0; i < win.nx; i++) values[j * win.nx + i] = i;
  const r = demSWindowRaster(win, values);
  const [lat, lng] = [r.bounds.ne[0], r.bounds.sw[1]];
  const pixelDeg = 0.000277777778;
  assert.ok(Math.abs(r.elevation(lat, lng) - 0) < 1e-6);
  assert.ok(Math.abs(r.elevation(lat, lng + pixelDeg * 0.5) - 0.5) < 1e-6);
  assert.ok(Math.abs(r.elevation(lat, lng + pixelDeg * 3) - 3) < 1e-6);
  // Outside the sampled window the contract is 0, as for every other raster.
  assert.equal(r.elevation(lat + 1, lng), 0);
  // E-W is the finer axis at 27°S: 30.9 · cos φ ≈ 27.5 m.
  assert.ok(Math.abs((r.resolutionM ?? 0) - 27.5) < 0.5, `${r.resolutionM}`);
  assert.equal(r.source?.id, 'ga-dem-s');
});

test('DEM-S maps the float32 nodata sentinel to NaN and keeps ocean at 0', () => {
  const win = { x0: 0, y0: 0, nx: 2, ny: 2 };
  const r = demSWindowRaster(win, [-3.4028234663852886e38, 0, 0, 0]);
  assert.ok(Number.isNaN(r.elevation(r.bounds.ne[0], r.bounds.sw[1])));
  assert.equal(r.elevation(r.bounds.sw[0], r.bounds.ne[1]), 0);
});

test('DEM-S window indices are pinned to the published COG origin', () => {
  // Everything below rests on three published numbers — origin lon
  // 112.99986111, lat −10.00013889, pixel 0.000277777778° — and the tests above
  // ask the raster where it thinks it is, so they would pass just as happily
  // with a wrong origin or a window index off by one. Both mistakes shift every
  // elevation by a pixel, ~28 m, silently.
  //
  // The origin is a HALF pixel outside the first cell, so 113 °E + k/3600 is
  // the centre of column k and 10 °S + k/3600 the centre of row k−1:
  //   153.0 °E → column (153 − 113) · 3600         = 144000
  //   27.5 °S  → row    (27.5 − 10) · 3600 − 0.5   = 62999
  const pt: [number, number] = [-27.5, 153.0];
  const win = demSPixelWindow({ sw: pt, ne: pt }, 0);
  assert.equal(win.x0, 143999);   // the containing column, less a pixel of stencil
  assert.equal(win.y0, 62998);
  // …and the window really is indexed from there: plant a marker in the pixel
  // that contains the point and read it back AT the point.
  const values = new Float32Array(win.nx * win.ny);
  values[(62999 - win.y0) * win.nx + (144000 - win.x0)] = 42;
  const h = demSWindowRaster(win, values).elevation(pt[0], pt[1]);
  assert.ok(h > 41.9, `expected ~42 m at the pinned pixel, got ${h}`);
});

test('DEM-S rows run north to south, row 0 at the top', () => {
  // geotiff.js hands back the window row-major from its NORTH-WEST corner. Read
  // the other way up the terrain is mirrored about the site's centre latitude —
  // hills where the valleys are, and no test that only checks interpolation
  // would notice.
  const win = demSPixelWindow(BOUNDS);
  const values = new Float32Array(win.nx * win.ny);
  for (let j = 0; j < win.ny; j++) for (let i = 0; i < win.nx; i++) values[j * win.nx + i] = j;
  const r = demSWindowRaster(win, values);
  const pixelDeg = 0.000277777778;
  const lng = r.bounds.sw[1];
  assert.ok(r.bounds.ne[0] > r.bounds.sw[0], 'ne is the northern corner');
  assert.ok(Math.abs(r.elevation(r.bounds.ne[0], lng) - 0) < 1e-6, 'row 0 is the north edge');
  assert.ok(Math.abs(r.elevation(r.bounds.ne[0] - 3 * pixelDeg, lng) - 3) < 1e-6);
  assert.ok(Math.abs(r.elevation(r.bounds.sw[0], lng) - (win.ny - 1)) < 1e-6, 'last row is the south edge');
});
