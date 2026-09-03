import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import {
  buildTerrainField, clearTerrainFieldCache, correctedDemRaster, fillHoles, lastTerrainBuild,
  MAX_REPORTED_SUSPECT_CELLS, TERRAIN_MARGIN_M, TERRAIN_MAX_CELLS_PER_AXIS,
  type TerrainFieldOptions,
} from './terrainField';
import { flagSuspectCells } from './terrainQa';
import { buildScene, type SceneInput } from './sceneBuilder';
import { captureDemRegion, type DemRaster } from './dem';
import type { Project } from './types';
import { latLngToLocalMetres, localMetresToLatLng } from './geo';

type Topography = NonNullable<NonNullable<Project['settings']>['topography']>;

const ORIGIN: [number, number] = [-27.0, 152.0];

/** DEM whose elevation is an arbitrary function of LOCAL METRES east/north. */
function demFromLocal(f: (e: number, n: number) => number, resolutionM = 20): DemRaster {
  return {
    resolutionM,
    elevation: (lat: number, lng: number) => {
      const [e, n] = latLngToLocalMetres([lat, lng], ORIGIN);
      return f(e, n);
    },
    bounds: { sw: [-90, -180], ne: [90, 180] },
    tilesLoaded: 1,
  } as DemRaster;
}

const flatDem = demFromLocal(() => 0);
/** A 40 m ridge running north-south, centred at e = 500 m, ~60 m wide. */
const ridgeDem = demFromLocal((e) => (Math.abs(e - 500) < 30 ? 40 : 0));

const pts: Array<[number, number]> = [ORIGIN, [ORIGIN[0], ORIGIN[1] + 0.01]];

// --------------------------------------------------------------- grid layout

test('field covers every point plus the margin, at DEM resolution', () => {
  const hf = buildTerrainField(flatDem, ORIGIN, pts, {})!;
  assert.equal(hf.type, 'heightfield');
  assert.equal(hf.spacing, 20, 'uses the DEM native resolution');
  assert.equal(hf.heights.length, hf.nx * hf.ny, 'heights length matches nx*ny (engine requires this)');

  // Every input point must sit inside the raster, with the margin honoured.
  for (const p of pts) {
    const [e, n] = latLngToLocalMetres(p, ORIGIN);
    assert.ok(e >= hf.origin[0] + TERRAIN_MARGIN_M - hf.spacing, 'east margin');
    assert.ok(n >= hf.origin[1] + TERRAIN_MARGIN_M - hf.spacing, 'north margin');
    assert.ok(e <= hf.origin[0] + (hf.nx - 1) * hf.spacing - TERRAIN_MARGIN_M + hf.spacing);
    assert.ok(n <= hf.origin[1] + (hf.ny - 1) * hf.spacing - TERRAIN_MARGIN_M + hf.spacing);
  }
});

test('no DEM, or no points, means no terrain (engine falls back to flat)', () => {
  assert.equal(buildTerrainField(null, ORIGIN, pts), null);
  assert.equal(buildTerrainField(flatDem, ORIGIN, []), null);
});

test('grid is capped so a huge extent cannot blow memory', () => {
  // 200 km across at 1 m native resolution would be 200k cells per axis.
  const huge: Array<[number, number]> = [ORIGIN, [ORIGIN[0] + 1.8, ORIGIN[1] + 2.0]];
  const hf = buildTerrainField(demFromLocal(() => 0, 1), ORIGIN, huge, {})!;
  assert.ok(hf.nx <= TERRAIN_MAX_CELLS_PER_AXIS && hf.ny <= TERRAIN_MAX_CELLS_PER_AXIS,
    `capped at ${TERRAIN_MAX_CELLS_PER_AXIS}, got ${hf.nx}x${hf.ny}`);
  assert.ok(hf.spacing > 1, 'pitch coarsened rather than exceeding the cap');
  assert.equal(hf.heights.length, hf.nx * hf.ny);
});

test('sampled values land where the engine will look for them', () => {
  // Engine convention: node (ix, iy) sits at origin + (ix, iy)*spacing, row-major.
  const hf = buildTerrainField(ridgeDem, ORIGIN, pts, {})!;
  for (const [ix, iy] of [[3, 4], [10, 2], [hf.nx - 1, hf.ny - 1]] as Array<[number, number]>) {
    const e = hf.origin[0] + ix * hf.spacing;
    const n = hf.origin[1] + iy * hf.spacing;
    const [lat, lng] = localMetresToLatLng([e, n], ORIGIN);
    assert.ok(Math.abs(hf.heights[iy * hf.nx + ix] - ridgeDem.elevation(lat, lng)) < 1e-6,
      `cell (${ix},${iy}) matches the DEM at its own position`);
  }
});

// ---------------------------------------------------------------- holes + QA

test('non-finite cells are filled from the nearest finite neighbour', () => {
  const h = [0, 0, 0, 0, NaN, 0, 0, 0, 5];
  assert.equal(fillHoles(h, 3, 3), true);
  assert.ok(h.every(Number.isFinite), 'no NaN survives (the engine rejects them)');
  assert.equal(h[4], 0, 'hole took a neighbouring value');
});

test('an all-hole DEM yields no terrain rather than a fake flat plane', () => {
  const h = [NaN, NaN, NaN, NaN];
  assert.equal(fillHoles(h, 2, 2), false);
  assert.equal(buildTerrainField(demFromLocal(() => NaN), ORIGIN, pts), null);
});

/// Where the injected spike sits, in local metres east/north of ORIGIN. Well
/// inside the modelled extent and away from any raster border.
const SPIKE_EN: [number, number] = [400, 200];

/// Flat ground with a single 60 m spike over the DEM cell containing `SPIKE_EN`.
/// The spike is a full cell wide so exactly one raster node lands on it — the
/// shape a bilinear-resampled blunder actually has.
function spikeDem(resolutionM = 20): DemRaster {
  return demFromLocal(
    (e, n) => (Math.abs(e - SPIKE_EN[0]) < resolutionM / 2
      && Math.abs(n - SPIKE_EN[1]) < resolutionM / 2 ? 60 : 0),
    resolutionM,
  );
}

test('the QA pass records the flagged cell, at its own position on the map', () => {
  clearTerrainFieldCache();
  const hf = buildTerrainField(spikeDem(), ORIGIN, pts, {})!;
  const qa = lastTerrainBuild()!;
  assert.equal(qa.count, 1, 'one blunder, one flag');
  assert.equal(qa.pitchM, hf.spacing);
  assert.ok(Math.abs(qa.maxDevM - 60) < 1e-6, 'deviation measured against the ring median');
  assert.equal(qa.correction, null, 'flagging never corrects on its own');
  assert.equal(qa.cells.length, 1);

  const [e, n] = latLngToLocalMetres(qa.cells[0].latLng, ORIGIN);
  assert.ok(Math.abs(e - SPIKE_EN[0]) <= hf.spacing, `flagged cell east ${e.toFixed(1)} m`);
  assert.ok(Math.abs(n - SPIKE_EN[1]) <= hf.spacing, `flagged cell north ${n.toFixed(1)} m`);
  assert.equal(qa.cells[0].z, 60);
  assert.equal(qa.cells[0].median, 0, 'correction would put it back on the flat ground');

  // The raster itself is untouched: the spike is still in the terrain the
  // engine screens against, which is the point of reporting it.
  assert.ok(hf.heights.includes(60), 'nothing was silently smoothed away');
});

test('a clean DEM flags nothing', () => {
  clearTerrainFieldCache();
  buildTerrainField(ridgeDem, ORIGIN, pts, {});
  const qa = lastTerrainBuild()!;
  assert.equal(qa.count, 0, 'a real 60 m-wide ridge is terrain');
  assert.deepEqual(qa.cells, []);
});

test('qaCorrect replaces the flagged cell, and the corrected raster follows it', () => {
  clearTerrainFieldCache();
  const dem = spikeDem();
  const hf = buildTerrainField(dem, ORIGIN, pts, { qaCorrect: true })!;
  const qa = lastTerrainBuild()!;
  assert.equal(qa.count, 1);
  assert.deepEqual(qa.correction, { changed: 1, maxChangeM: 60 });
  assert.ok(!hf.heights.includes(60), 'the blunder is out of the screening raster');
  assert.equal(qa.cells[0].z, 60, 'the record still quotes the value that was flagged');
  assert.equal(qa.deltas.size, 1, 'one cell moved, so one delta');

  // Endpoint ground must agree with the raster: a receiver on the corrected
  // cell stands at 0 m, not on a 60 m spike the engine no longer sees.
  const corrected = correctedDemRaster(dem, hf, ORIGIN, qa.deltas);
  const spikeLatLng = localMetresToLatLng(SPIKE_EN, ORIGIN);
  assert.equal(dem.elevation(...spikeLatLng), 60, 'the raw DEM still has the spike');
  assert.ok(Math.abs(corrected.elevation(...spikeLatLng)) < 1e-6, 'corrected surface is flat there');

  // Outside the field extent there is nothing to correct, so the raw DEM answers.
  const far = localMetresToLatLng([hf.origin[0] - 5000, hf.origin[1] - 5000], ORIGIN);
  assert.equal(corrected.elevation(...far), dem.elevation(...far));
  assert.equal(corrected.source, dem.source, 'provenance survives the wrapper');
});

test('the correction is a sparse delta: away from a flag the raw DEM answers exactly', () => {
  // The wrapper used to return the FIELD's own bilinear everywhere inside the
  // extent, so one flagged cell moved every source, receiver, grid cell and
  // wall foot by the resampling error — metres where a fine DEM had been
  // coarsened to the cell cap — and put a step at the field edge.
  clearTerrainFieldCache();
  const curved = demFromLocal(
    (e, n) => (Math.abs(e - SPIKE_EN[0]) < 10 && Math.abs(n - SPIKE_EN[1]) < 10
      ? 60
      : Math.sin(e / 137) * 12 + Math.cos(n / 91) * 7),
    20,
  );
  const hf = buildTerrainField(curved, ORIGIN, pts, { qaCorrect: true })!;
  const qa = lastTerrainBuild()!;
  assert.equal(qa.count, 1, 'the spike, and only the spike');
  const corrected = correctedDemRaster(curved, hf, ORIGIN, qa.deltas);

  // Mid-cell, well inside the raster and far from the flag: bit-for-bit equal.
  for (const [e, n] of [[10, 30], [-110, 90], [810, -50]] as Array<[number, number]>) {
    const p = localMetresToLatLng([e, n], ORIGIN);
    assert.equal(corrected.elevation(...p), curved.elevation(...p), `at (${e}, ${n})`);
  }
  // No seam at the field edge either — the raw DEM on both sides of it.
  const edge = localMetresToLatLng([hf.origin[0], hf.origin[1] + 40], ORIGIN);
  assert.equal(corrected.elevation(...edge), curved.elevation(...edge));

  // …and the flagged cell itself still reads the corrected surface.
  const spike = localMetresToLatLng(SPIKE_EN, ORIGIN);
  assert.ok(corrected.elevation(...spike) < curved.elevation(...spike) - 40, 'the spike is gone');
});

test('the corrected raster hides the raw grid, so snapshots follow the correction', () => {
  // `captureDemRegion` copies straight out of `DemRaster.grid()` when the raster
  // offers one. Spreading `...dem` inherited that method, and the grid workers
  // then screened against the UNCORRECTED terrain.
  clearTerrainFieldCache();
  const spike = spikeDem();
  const half = 100;
  const sw = localMetresToLatLng([SPIKE_EN[0] - half, SPIKE_EN[1] - half], ORIGIN);
  const ne = localMetresToLatLng([SPIKE_EN[0] + half, SPIKE_EN[1] + half], ORIGIN);
  const region = captureDemRegion(spike, sw, ne, 5, 5);
  const gridded: DemRaster = { ...spike, grid: () => region };
  const centre = 2 * 5 + 2;               // the middle sample sits on the spike
  assert.equal(captureDemRegion(gridded, sw, ne, 5, 5).data[centre], 60, 'raw grid, raw spike');

  const hf = buildTerrainField(gridded, ORIGIN, pts, { qaCorrect: true })!;
  const qa = lastTerrainBuild()!;
  const corrected = correctedDemRaster(gridded, hf, ORIGIN, qa.deltas);
  assert.equal(corrected.grid, undefined, 'the delta surface has no regular grid to offer');
  const snap = captureDemRegion(corrected, sw, ne, 5, 5);
  assert.ok(Math.abs(snap.data[centre]) < 0.1, `snapshot follows the correction: ${snap.data[centre]}`);
});

/// Where the uneven 2×2 smear sits, as GRID indices into the built field.
const SMEAR_IX = 20;
const SMEAR_IY = 20;
/// The reviewer's case: one bad source cell bilinear-smeared over 2×2. Only the
/// 49 is flagged — the two 21s are level with each other, so they cluster and
/// fail the "strictly above its ring" test — and replacing it alone leaves them
/// standing over the hole it left.
const SMEAR = [[49, 21], [21, 9]];

/// Flat ground carrying `SMEAR`, placed by grid index. The first sample the
/// field asks for is node (0, 0), so the patch lands where the test wants it
/// without having to predict the extent's own origin.
function smearDem(pitchM = 10): DemRaster {
  let base: [number, number] | null = null;
  return demFromLocal((e, n) => {
    if (!base) base = [e, n];
    const ix = Math.round((e - base[0]) / pitchM) - SMEAR_IX;
    const iy = Math.round((n - base[1]) / pitchM) - SMEAR_IY;
    return SMEAR[iy]?.[ix] ?? 0;
  }, pitchM);
}

test('correction iterates to a fixed point, so no residual is left behind', () => {
  clearTerrainFieldCache();
  const flagsOnly = buildTerrainField(smearDem(), ORIGIN, pts, {})!;
  assert.equal(lastTerrainBuild()!.count, 1, 'flagging still reports the DEM as delivered');
  assert.ok(flagsOnly.heights.includes(49), 'and changes nothing');

  clearTerrainFieldCache();
  const hf = buildTerrainField(smearDem(), ORIGIN, pts, { qaCorrect: true })!;
  const qa = lastTerrainBuild()!;
  assert.equal(qa.count, 1, 'one pass of flagging still sees only the 49');
  // A single pass replaced the 49 and stopped; the 21s then stood clear of the
  // hole it left and were flagged on the next solve, for ever.
  assert.equal(qa.correction?.changed, 3, 'the 49 and both 21s');
  assert.equal(qa.correction?.maxChangeM, 49, 'the largest change, over all passes');
  assert.equal(qa.deltas.size, 3);
  assert.equal(
    flagSuspectCells(hf.heights, hf.nx, hf.ny, hf.spacing).count, 0,
    'the corrected raster has nothing left to flag',
  );
});

test('the reported cells are the worst ones, not the first ones scanned', () => {
  // Past the 500-cell cap the record used to be a band along the south edge of
  // the raster, because the flag list is in row-major order.
  clearTerrainFieldCache();
  // A spike on every third cell of a 20 m grid, growing eastwards, so the
  // biggest deviations are the far ones — the last a row-major scan reaches.
  let base: [number, number] | null = null;
  const many = demFromLocal((e, n) => {
    if (!base) base = [e, n];
    const ix = Math.round((e - base[0]) / 20);
    const iy = Math.round((n - base[1]) / 20);
    return ix % 3 === 1 && iy % 3 === 1 ? 30 + ix : 0;
  }, 20);
  buildTerrainField(many, ORIGIN, pts, {});
  const qa = lastTerrainBuild()!;
  assert.ok(qa.count > MAX_REPORTED_SUSPECT_CELLS, `${qa.count} flagged`);
  assert.equal(qa.cells.length, MAX_REPORTED_SUSPECT_CELLS, 'the list is capped');
  const dev = qa.cells.map((c) => Math.abs(c.z - c.median));
  for (let i = 1; i < dev.length; i++) {
    assert.ok(dev[i] <= dev[i - 1] + 1e-9, `cell ${i} out of order: ${dev[i - 1]} then ${dev[i]}`);
  }
  assert.ok(Math.abs(dev[0] - qa.maxDevM) < 1e-9, 'the worst cell leads the list');
});


// ----------------------------------------------- the gate: does it screen?

const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));

/** Source at the origin, receiver ~1 km east, terrain from `dem`. */
function solveAcross(dem: DemRaster, opts: TerrainFieldOptions = {}): number {
  const rx: [number, number] = [ORIGIN[0], ORIGIN[1] + 0.0101];
  const input: SceneInput = {
    origin: ORIGIN,
    sources: [{ id: 's1', latLng: ORIGIN, heightAglM: 2, lw: lw10() }],
    receivers: [{ id: 'r1', latLng: rx, heightAboveGroundM: 1.5 }],
    barriers: [],
    dem,
    terrain: buildTerrainField(dem, ORIGIN, [ORIGIN, rx], opts),
    settings: {
      standard: 'iso9613-2:2024',
      defaultG: 0.5,
      atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
      dzCapDb: null,
      c0Db: 0,
    },
  };
  return JSON.parse(solve_scene(JSON.stringify(buildScene(input)))).per_receiver[0].total_dba;
}

test('GATE: a ridge in the DEM screens the path; flat ground does not', () => {
  const flat = solveAcross(flatDem);
  const ridged = solveAcross(ridgeDem);
  assert.ok(Number.isFinite(flat) && Number.isFinite(ridged));
  assert.ok(ridged < flat - 5,
    `40 m ridge must screen: flat ${flat.toFixed(2)} → ridged ${ridged.toFixed(2)} dBA`);
});

test("an old project still carrying 'despikeStrength' solves, unchanged", () => {
  // The field is gone from the type, so this is how one arrives: straight out
  // of the stored JSON. It must be ignored — not crash, not resurrect itself,
  // and not move a level.
  const legacy: Topography = JSON.parse('{"virtualBarrierMinHeightM":2,"despikeStrength":"medium"}');
  clearTerrainFieldCache();
  const withLegacy = solveAcross(ridgeDem, { qaCorrect: legacy.qaCorrect });
  clearTerrainFieldCache();
  assert.ok(Number.isFinite(withLegacy));
  assert.equal(withLegacy, solveAcross(ridgeDem));
});

test('a heightfield the engine accepts is emitted for a real-shaped project', () => {
  const hf = buildTerrainField(ridgeDem, ORIGIN, pts)!;
  // The engine validates nx*ny vs heights.len() and rejects non-finite cells;
  // a solve that returns without throwing proves the raster is well-formed.
  const scene = buildScene({
    origin: ORIGIN,
    sources: [{ id: 's', latLng: ORIGIN, heightAglM: 2, lw: lw10() }],
    receivers: [{ id: 'r', latLng: pts[1], heightAboveGroundM: 1.5 }],
    barriers: [], dem: ridgeDem, terrain: hf,
    settings: {
      standard: 'iso9613-2:2024', defaultG: 0.5,
      atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
      dzCapDb: null, c0Db: 0,
    },
  });
  assert.doesNotThrow(() => solve_scene(JSON.stringify(scene)));
});

test('the last build record is the LAST build, whichever raster made it', () => {
  // The memo holds ONE entry, so the record is only meaningful read straight
  // after a build. The UI no longer reads it at all — `evaluateProject` hands
  // its own build's record back with the results — and the DEM-keyed guard that
  // papered over the late read is gone with it.
  clearTerrainFieldCache();
  buildTerrainField(spikeDem(), ORIGIN, pts, {});
  assert.equal(lastTerrainBuild()?.count, 1);
  buildTerrainField(ridgeDem, ORIGIN, pts, {});
  assert.equal(lastTerrainBuild()?.count, 0, 'the newer build replaced it');
});
