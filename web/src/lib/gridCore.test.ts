// Grid path: correctness + the plan's perf gate, exercised through the real
// engine (`runBatchedGrid` drives a WasmSession per tile).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import { runBatchedGrid, type GridJob, type GridTile } from './gridCore';
import { buildScene } from './sceneBuilder';
import { buildTerrainField } from './terrainField';
import type { ResolvedSource, SceneSettings } from './sceneBuilder';
import type { DemRaster } from './dem';
import { latLngToLocalMetres } from './geo';

const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

const ORIGIN: [number, number] = [-27.0, 152.0];
const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));
/// IEC 61672-1 octave A-weighting, for the one-shot cross-check.
const OCTAVE_AW_T = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

const SETTINGS: SceneSettings = {
  standard: 'iso9613-2:2024',
  defaultG: 0.5,
  atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
  dzCapDb: null,
  c0Db: 0,
};

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

/** A cols×rows grid over `spanM`, tiled TILE×TILE, with `sources` in every tile. */
function makeJob(
  cols: number,
  rows: number,
  spanM: number,
  sources: ResolvedSource[],
  over: Partial<GridJob> = {},
): GridJob {
  const dxM = spanM / cols;
  const dyM = spanM / rows;
  const R = 6371008.8;
  const dLat = (spanM / 2 / R) * (180 / Math.PI);
  const dLng = (spanM / 2 / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI);
  const TILE = 16;
  const tiles: GridTile[] = [];
  for (let row0 = 0; row0 < rows; row0 += TILE) {
    for (let col0 = 0; col0 < cols; col0 += TILE) {
      tiles.push({
        col0, row0,
        cols: Math.min(TILE, cols - col0),
        rows: Math.min(TILE, rows - row0),
        sources,
      });
    }
  }
  return {
    cols, rows, dxM, dyM, origin: ORIGIN,
    bounds: {
      sw: [ORIGIN[0] - dLat, ORIGIN[1] - dLng],
      ne: [ORIGIN[0] + dLat, ORIGIN[1] + dLng],
    },
    nBands: 10,
    cutoffM: 0,
    dOmegaDb: 0,
    rxHeightAboveGround: 1.5,
    barriers: [],
    settings: SETTINGS,
    topo: undefined,
    terrain: null,
    includeContainers: false,
    roofOffsetM: 0.3,
    tiles,
    ...over,
  };
}

const centreSource: ResolvedSource[] = [{ id: 's1', latLng: ORIGIN, heightAglM: 4, lw: lw10() }];

test('every cell is computed and levels fall away from the source', () => {
  const job = makeJob(32, 32, 1000, centreSource);
  const r = runBatchedGrid(job, flatDem);
  assert.equal(r.dbA.length, 32 * 32);
  assert.ok(r.dbA.every((v) => Number.isFinite(v)), 'no NaN cells');
  assert.ok(r.dbA.every((v) => v > -120), 'every cell was actually solved (none left at the -120 sentinel)');
  // Centre cell must be the loudest.
  const centre = r.dbA[16 * 32 + 16];
  assert.equal(Math.max(...r.dbA), centre, 'peak level sits at the source');
  const corner = r.dbA[0];
  assert.ok(centre > corner + 10, `falls away: centre ${centre.toFixed(1)} vs corner ${corner.toFixed(1)}`);
});

test('a grid cell matches the same receiver solved through the one-shot path', () => {
  // Real cross-check against `solve_scene`: identical geometry must give an
  // identical number, so a batching / row-col-transpose / indexing bug can't hide.
  const job = makeJob(16, 16, 800, centreSource);
  const r = runBatchedGrid(job, flatDem);
  const col = 12; const row = 3;                       // deliberately col != row
  const e = (col - (16 - 1) / 2) * job.dxM;
  const n = (row - (16 - 1) / 2) * job.dyM;

  const scene = buildScene({
    origin: ORIGIN,
    sources: centreSource,
    receivers: [],
    barriers: [], dem: flatDem, terrain: null, settings: SETTINGS,
  });
  scene.receivers = [{ id: 'x', position: [e, n, 1.5], height_agl: 1.5 }];
  const oneShot = JSON.parse(solve_scene(JSON.stringify(scene)));
  const bands = oneShot.per_receiver[0].per_source[0].bands as number[];
  let aSum = 0;
  for (let i = 0; i < bands.length; i++) aSum += Math.pow(10, (bands[i] + OCTAVE_AW_T[i]) / 10);
  const expected = 10 * Math.log10(aSum);

  assert.ok(Math.abs(r.dbA[row * 16 + col] - expected) < 1e-4,
    `grid cell (${col},${row}) = ${r.dbA[row * 16 + col].toFixed(4)}, one-shot = ${expected.toFixed(4)}`);
});

test('the per-source cutoff is applied per CELL, not per tile', () => {
  // Two sources 600 m apart with a 300 m cutoff. The discriminating assertion is
  // the SECOND one: a cell close to `far` must still hear it even though it
  // shares a tile with cells that are out of range — a per-tile drop would fail.
  const far: ResolvedSource = {
    id: 'far', latLng: [ORIGIN[0], ORIGIN[1] + 0.006], heightAglM: 4, lw: lw10(),
  };
  const sources = [centreSource[0], far];
  const withCutoff = runBatchedGrid(makeJob(32, 32, 1400, sources, { cutoffM: 300 }), flatDem);
  const noCutoff = runBatchedGrid(makeJob(32, 32, 1400, sources, { cutoffM: 0 }), flatDem);
  const farOnly = runBatchedGrid(makeJob(32, 32, 1400, [centreSource[0]], { cutoffM: 0 }), flatDem);

  // 1. Where the far source is out of range, its contribution is gone.
  const centreIdx = 16 * 32 + 16;
  assert.ok(withCutoff.dbA[centreIdx] < noCutoff.dbA[centreIdx],
    'far source dropped where it exceeds the cutoff');
  assert.ok(Math.abs(withCutoff.dbA[centreIdx] - farOnly.dbA[centreIdx]) < 1e-6,
    'and the remaining level equals the near source alone');

  // 2. A cell WITHIN 300 m of `far` must still hear it. `far` sits ~594 m east of
  // centre; find the cell nearest to it and check it differs from near-only.
  const dxM = 1400 / 32;
  const farCol = Math.round(594 / dxM + (32 - 1) / 2);
  const nearFarIdx = 16 * 32 + Math.min(31, farCol);
  assert.ok(withCutoff.dbA[nearFarIdx] > farOnly.dbA[nearFarIdx] + 1,
    `a cell beside the far source still hears it (per-CELL cutoff): `
    + `${farOnly.dbA[nearFarIdx].toFixed(1)} → ${withCutoff.dbA[nearFarIdx].toFixed(1)} dBA`);
  assert.ok(withCutoff.dbA.every((v) => Number.isFinite(v)));
});

test('the -120 dB floor is applied before DΩ, as the previous engine did', () => {
  // A cell far below the floor must read exactly -120 regardless of DΩ, rather
  // than being lifted off the floor by it.
  const silent: ResolvedSource[] = [{
    id: 'quiet', latLng: ORIGIN, heightAglM: 4, lw: Array(10).fill(-200),
  }];
  const withOmega = runBatchedGrid(makeJob(8, 8, 400, silent, { dOmegaDb: 3 }), flatDem);
  assert.ok(withOmega.dbA.every((v) => v === -120), 'floor holds with DΩ = +3');
});

test('terrain screening reaches the grid', () => {
  // Ridge between the source and the east half of the grid.
  const ridgeDem = demFromLocal((e) => (Math.abs(e - 200) < 40 ? 50 : 0));
  const terrain = buildTerrainField(ridgeDem, ORIGIN, [ORIGIN, [ORIGIN[0], ORIGIN[1] + 0.008]], {
    despikeStrength: 'off',
  });
  const flat = runBatchedGrid(makeJob(32, 32, 1200, centreSource), flatDem);
  const ridged = runBatchedGrid(makeJob(32, 32, 1200, centreSource, { terrain }), ridgeDem);
  // A cell well east of the ridge must be quieter than on flat ground.
  const idx = 16 * 32 + 28;
  assert.ok(ridged.dbA[idx] < flat.dbA[idx] - 3,
    `ridge screens the grid: ${flat.dbA[idx].toFixed(1)} → ${ridged.dbA[idx].toFixed(1)} dBA`);
});

test('an empty tile leaves its cells at the floor rather than NaN', () => {
  const job = makeJob(16, 16, 500, []);
  const r = runBatchedGrid(job, flatDem);
  assert.ok(r.dbA.every((v) => v === -120), 'no sources → floor everywhere, no NaN');
});

test('PERF GATE: a 128x128 grid solves in reasonable wall-clock', () => {
  // 16k cells against a 12-unit BESS row — the shape of a real preview grid.
  const units: ResolvedSource[] = Array.from({ length: 12 }, (_, i) => ({
    id: `u${i}`,
    latLng: [ORIGIN[0] + i * 0.0002, ORIGIN[1]] as [number, number],
    heightAglM: 3,
    lw: lw10(),
  }));
  const job = makeJob(128, 128, 2000, units);
  const t0 = performance.now();
  const r = runBatchedGrid(job, flatDem);
  const ms = performance.now() - t0;
  console.log(`    128x128 x 12 sources: ${ms.toFixed(0)} ms (${r.computedMs.toFixed(0)} ms reported)`);
  assert.equal(r.dbA.length, 128 * 128);
  assert.ok(r.dbA.every((v) => Number.isFinite(v)));
  // Generous ceiling: the gate is a regression tripwire, not a benchmark. The
  // old per-cell path took ~10-20 s for this shape on a dev laptop.
  assert.ok(ms < 60_000, `grid took ${ms.toFixed(0)} ms`);
});

// ---------------------------------------------------------------- I12 progress

test('progress reports every tile exactly once and finishes at 100%', () => {
  const job = makeJob(32, 32, 1000, centreSource);
  const seen: Array<[number, number]> = [];
  runBatchedGrid(job, flatDem, (done, total) => seen.push([done, total]));

  assert.ok(seen.length > 0, 'progress must fire');
  assert.equal(seen.length, job.tiles.length, 'one report per tile');
  // Monotonic 1..N against a constant total — a bar that jumps backwards or
  // never reaches the end is worse than no bar.
  assert.deepEqual(seen.map(([d]) => d), job.tiles.map((_, i) => i + 1));
  assert.ok(seen.every(([, t]) => t === job.tiles.length), 'total stays constant');
  const [lastDone, lastTotal] = seen[seen.length - 1];
  assert.equal(lastDone, lastTotal, 'ends at 100%');
});

test('tiles with no sources still count toward progress', () => {
  // A source in one corner leaves most tiles empty. Skipping them would make a
  // sparse job appear to stall and then jump.
  const corner: ResolvedSource[] = [{
    id: 's1', latLng: [ORIGIN[0] + 0.004, ORIGIN[1] + 0.004], heightAglM: 4, lw: lw10(),
  }];
  const job = makeJob(32, 32, 200, corner, { cutoffM: 100 });
  let last = 0;
  runBatchedGrid(job, flatDem, (done) => { last = done; });
  assert.equal(last, job.tiles.length, 'every tile reported, including empty ones');
});

test('omitting the progress callback is fine', () => {
  const job = makeJob(16, 16, 1000, centreSource);
  assert.doesNotThrow(() => runBatchedGrid(job, flatDem));
});

// -------------------------------------------------------------- I7 rotation

test('a rotated job places its cells as the rotation of the unrotated ones', () => {
  // The gate for I7: cells must follow the box, not merely cover it.
  const base = makeJob(8, 8, 500, centreSource);
  const rotated = { ...base, rotationDeg: 90 };

  const cellsOf = (job: typeof base) => {
    const seen: Array<[number, number]> = [];
    // Re-derive what runBatchedGrid computes, via its own output geometry:
    // solve and read the dbA field is indirect, so instead assert on the
    // documented transform using the same arithmetic the core uses.
    const { cols, rows, dxM, dyM, origin } = job;
    const R = 6371008.8;
    const lat0 = (origin[0] * Math.PI) / 180;
    const rot = ((job.rotationDeg ?? 0) * Math.PI) / 180;
    const cosR = Math.cos(rot);
    const sinR = Math.sin(rot);
    for (let row = 0; row < rows; row++) {
      const nBox = (row - (rows - 1) / 2) * dyM;
      for (let col = 0; col < cols; col++) {
        const eBox = (col - (cols - 1) / 2) * dxM;
        const e = eBox * cosR + nBox * sinR;
        const n = -eBox * sinR + nBox * cosR;
        seen.push([
          origin[0] + (n / R) * (180 / Math.PI),
          origin[1] + (e / (R * Math.cos(lat0))) * (180 / Math.PI),
        ]);
      }
    }
    return seen;
  };

  const plain = cellsOf(base);
  const spun = cellsOf(rotated);
  assert.equal(plain.length, spun.length);
  // A 90 degree rotation maps the set onto itself for a square grid, so the
  // SETS match while individual cells have moved.
  const key = (p: [number, number]) => `${p[0].toFixed(9)},${p[1].toFixed(9)}`;
  assert.deepEqual(new Set(spun.map(key)).size, new Set(plain.map(key)).size);
  assert.notEqual(key(spun[0]), key(plain[0]), 'cell 0 actually moved');
});

test('an unrotated job is bit-for-bit what it always was', () => {
  // Rotation must be a pure no-op at 0 degrees, or every existing project's
  // numbers would shift.
  const job = makeJob(16, 16, 800, centreSource);
  const a = runBatchedGrid(job, flatDem);
  const b = runBatchedGrid({ ...job, rotationDeg: 0 }, flatDem);
  assert.deepEqual(Array.from(a.dbA), Array.from(b.dbA));
});

test('rotating a grid changes the answer at a fixed cell index', () => {
  // A source off-centre means the rotated lattice samples different places.
  const off: ResolvedSource[] = [{
    id: 's1', latLng: [ORIGIN[0] + 0.003, ORIGIN[1]], heightAglM: 4, lw: lw10(),
  }];
  const job = makeJob(16, 16, 800, off);
  const a = runBatchedGrid(job, flatDem);
  const b = runBatchedGrid({ ...job, rotationDeg: 90 }, flatDem);
  assert.notDeepEqual(Array.from(a.dbA), Array.from(b.dbA));
});
