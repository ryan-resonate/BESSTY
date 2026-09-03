import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import {
  buildTerrainField, clearTerrainFieldCache, correctedDemRaster, fillHoles, lastTerrainBuild,
  TERRAIN_MARGIN_M, TERRAIN_MAX_CELLS_PER_AXIS, type TerrainFieldOptions,
} from './terrainField';
import { buildScene, type SceneInput } from './sceneBuilder';
import type { DemRaster } from './dem';
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

  // Endpoint ground must agree with the raster: a receiver on the corrected
  // cell stands at 0 m, not on a 60 m spike the engine no longer sees.
  const corrected = correctedDemRaster(dem, hf, ORIGIN);
  const spikeLatLng = localMetresToLatLng(SPIKE_EN, ORIGIN);
  assert.equal(dem.elevation(...spikeLatLng), 60, 'the raw DEM still has the spike');
  assert.ok(Math.abs(corrected.elevation(...spikeLatLng)) < 1e-6, 'corrected surface is flat there');

  // Outside the field extent there is nothing to correct, so the raw DEM answers.
  const far = localMetresToLatLng([hf.origin[0] - 5000, hf.origin[1] - 5000], ORIGIN);
  assert.equal(corrected.elevation(...far), dem.elevation(...far));
  assert.equal(corrected.source, dem.source, 'provenance survives the wrapper');
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

test('the last build belongs to one DEM, and is not reported for another', () => {
  // The memo holds ONE entry, and the UI reads it long after the solve: without
  // the DEM argument, swapping the raster leaves the previous surface's pitch
  // and flagged cells on screen, attributed to the new one.
  clearTerrainFieldCache();
  const dem = spikeDem();
  buildTerrainField(dem, ORIGIN, pts, {});
  assert.equal(lastTerrainBuild(dem)?.count, 1, 'the DEM it was built from');
  assert.equal(lastTerrainBuild()?.count, 1, 'no argument still means "whatever was last"');
  assert.equal(lastTerrainBuild(spikeDem()), null, 'a different raster gets nothing');
  assert.equal(lastTerrainBuild(null), null);
});
