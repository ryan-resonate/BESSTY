import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import {
  buildTerrainField, despikeGrid, fillHoles, TERRAIN_MARGIN_M, TERRAIN_MAX_CELLS_PER_AXIS,
} from './terrainField';
import { buildScene, type SceneInput } from './sceneBuilder';
import type { DemRaster } from './dem';
import { latLngToLocalMetres, localMetresToLatLng } from './geo';

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
  const hf = buildTerrainField(flatDem, ORIGIN, pts, { despikeStrength: 'off' })!;
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
  const hf = buildTerrainField(demFromLocal(() => 0, 1), ORIGIN, huge, { despikeStrength: 'off' })!;
  assert.ok(hf.nx <= TERRAIN_MAX_CELLS_PER_AXIS && hf.ny <= TERRAIN_MAX_CELLS_PER_AXIS,
    `capped at ${TERRAIN_MAX_CELLS_PER_AXIS}, got ${hf.nx}x${hf.ny}`);
  assert.ok(hf.spacing > 1, 'pitch coarsened rather than exceeding the cap');
  assert.equal(hf.heights.length, hf.nx * hf.ny);
});

test('sampled values land where the engine will look for them', () => {
  // Engine convention: node (ix, iy) sits at origin + (ix, iy)*spacing, row-major.
  const hf = buildTerrainField(ridgeDem, ORIGIN, pts, { despikeStrength: 'off' })!;
  for (const [ix, iy] of [[3, 4], [10, 2], [hf.nx - 1, hf.ny - 1]] as Array<[number, number]>) {
    const e = hf.origin[0] + ix * hf.spacing;
    const n = hf.origin[1] + iy * hf.spacing;
    const [lat, lng] = localMetresToLatLng([e, n], ORIGIN);
    assert.ok(Math.abs(hf.heights[iy * hf.nx + ix] - ridgeDem.elevation(lat, lng)) < 1e-6,
      `cell (${ix},${iy}) matches the DEM at its own position`);
  }
});

// ------------------------------------------------------------ holes + despike

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

test('despike removes an isolated blunder but preserves a real crest', () => {
  const nx = 7; const ny = 7;
  const flat = new Array(nx * ny).fill(0);
  // Single-cell spike — a classic global-DEM blunder.
  const spiked = flat.slice(); spiked[3 * nx + 3] = 60;
  assert.ok(despikeGrid(spiked, nx, ny, 'low')[3 * nx + 3] < 10, 'blunder flattened');

  // A genuine ridge (a whole column raised) must survive: it is not an outlier
  // in its own neighbourhood.
  const ridge = flat.slice();
  for (let iy = 0; iy < ny; iy++) for (const ix of [2, 3, 4]) ridge[iy * nx + ix] = 40;
  const kept = despikeGrid(ridge, nx, ny, 'low');
  assert.equal(kept[3 * nx + 3], 40, 'real crest preserved');

  assert.deepEqual(despikeGrid(spiked, nx, ny, 'off'), spiked, "'off' is a no-op");
});

// ----------------------------------------------- the gate: does it screen?

const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));

/** Source at the origin, receiver ~1 km east, terrain from `dem`. */
function solveAcross(dem: DemRaster): number {
  const rx: [number, number] = [ORIGIN[0], ORIGIN[1] + 0.0101];
  const input: SceneInput = {
    origin: ORIGIN,
    sources: [{ id: 's1', latLng: ORIGIN, heightAglM: 2, lw: lw10() }],
    receivers: [{ id: 'r1', latLng: rx, heightAboveGroundM: 1.5 }],
    barriers: [],
    dem,
    terrain: buildTerrainField(dem, ORIGIN, [ORIGIN, rx], { despikeStrength: 'off' }),
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
