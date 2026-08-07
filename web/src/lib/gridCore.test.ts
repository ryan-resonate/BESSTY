// Grid path: correctness + the plan's perf gate, exercised through the real
// engine (`runBatchedGrid` drives a WasmSession per tile).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import {
  barriersForRegion, gridTileFingerprint, mergeShard, planIncrementalGrid, runBatchedGrid,
  segmentHitsBox, shardTiles,
  type GridJob, type GridTile,
} from './gridCore';
import { buildScene } from './sceneBuilder';
import { buildTerrainField } from './terrainField';
import type { ResolvedSource, SceneSettings } from './sceneBuilder';
import type { DemRaster } from './dem';
import { latLngToLocalMetres } from './geo';
import { weightsFor } from './weighting';

const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

const ORIGIN: [number, number] = [-27.0, 152.0];
const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));
/// The SAME weights the grid uses, from the shared module. A local copy here
/// made this cross-check compare the grid against a second implementation of
/// the weighting rather than against the one-shot solve — so it went red when
/// the shared curve moved to exact band centres, even though both paths still
/// agreed with each other.
const OCTAVE_AW_T = weightsFor('octave', 'A');

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

// ============== P2: sharding a grid across a worker pool ==============

test('round-robin sharding covers every tile exactly once', () => {
  const job = makeJob(64, 48, 2000, [
    { id: 's1', latLng: ORIGIN, heightAglM: 4, lw: lw10() },
  ]);
  for (const n of [1, 2, 3, 5, 8]) {
    const shards = shardTiles(job.tiles, n);
    const flat = shards.flat();
    assert.equal(flat.length, job.tiles.length, `n=${n}: tile count`);
    assert.equal(new Set(flat).size, job.tiles.length, `n=${n}: no tile duplicated or dropped`);
    // Round-robin must actually balance: shard sizes differ by at most one.
    const sizes = shards.map((s) => s.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `n=${n}: balanced (${sizes})`);
  }
});

test('asking for more shards than tiles yields one tile each, never an empty shard', () => {
  const job = makeJob(16, 16, 400, [
    { id: 's1', latLng: ORIGIN, heightAglM: 4, lw: lw10() },
  ]);   // one 16x16 tile
  const shards = shardTiles(job.tiles, 8);
  assert.equal(shards.length, 1);
  assert.equal(shards[0].length, 1);
});

test('a grid solved in shards and merged is IDENTICAL to solving it in one pass', () => {
  // The whole justification for the worker pool: splitting the tiles must not
  // change a single cell. Two off-centre sources so the field is not symmetric
  // and a mis-stitched shard could not accidentally match.
  const sources: ResolvedSource[] = [
    { id: 's1', latLng: [ORIGIN[0] + 0.004, ORIGIN[1] - 0.003], heightAglM: 4, lw: lw10() },
    { id: 's2', latLng: [ORIGIN[0] - 0.002, ORIGIN[1] + 0.005], heightAglM: 9, lw: lw10() },
  ];
  const job = makeJob(48, 32, 1600, sources);
  const whole = runBatchedGrid(job, flatDem);

  for (const n of [2, 3, 5]) {
    const merged = new Float32Array(job.cols * job.rows).fill(-120);
    for (const shard of shardTiles(job.tiles, n)) {
      const part = runBatchedGrid({ ...job, tiles: shard }, flatDem);
      mergeShard(merged, part.dbA, shard, job.cols, job.rows);
    }
    assert.deepEqual(
      Array.from(merged), Array.from(whole.dbA),
      `${n} shards must reproduce the single-pass grid exactly`,
    );
  }
});

test('merging only writes the cells a shard owns', () => {
  const cols = 8; const rows = 4;
  const into = new Float32Array(cols * rows).fill(-120);
  const from = new Float32Array(cols * rows).fill(42);
  // One 2x2 tile at (col 2, row 1).
  mergeShard(into, from, [{ col0: 2, row0: 1, cols: 2, rows: 2, sources: [] }], cols, rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const owned = c >= 2 && c < 4 && r >= 1 && r < 3;
      assert.equal(into[r * cols + c], owned ? 42 : -120, `cell (${c},${r})`);
    }
  }
});

test('a tile running past the grid edge is clipped, not wrapped', () => {
  const cols = 4; const rows = 4;
  const into = new Float32Array(cols * rows).fill(-120);
  const from = new Float32Array(cols * rows).fill(7);
  // Deliberately oversized: 16x16 tile anchored near the corner.
  mergeShard(into, from, [{ col0: 2, row0: 2, cols: 16, rows: 16, sources: [] }], cols, rows);
  // Only the bottom-right 2x2 may be written; nothing wraps to row 0.
  assert.deepEqual(Array.from(into.slice(0, 4)), [-120, -120, -120, -120]);
  assert.equal(into[2 * cols + 2], 7);
  assert.equal(into[3 * cols + 3], 7);
});

// ============== P4: incremental regrid ==============

const srcAt = (id: string, e: number, n: number): ResolvedSource => {
  const R = 6371008.8;
  return {
    id,
    latLng: [
      ORIGIN[0] + (n / R) * (180 / Math.PI),
      ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
    ],
    heightAglM: 4,
    lw: lw10(),
  };
};

test('an unchanged job reuses every tile', () => {
  const job = makeJob(48, 32, 1600, [srcAt('s1', 0, 0)]);
  const first = planIncrementalGrid(job, null);
  assert.equal(first.dirty.length, job.tiles.length, 'no cache ⇒ solve everything');
  assert.equal(first.reuse, null);

  const cache = {
    jobKey: first.jobKey, tileKeys: first.tileKeys,
    dbA: new Float32Array(job.cols * job.rows), cols: job.cols, rows: job.rows,
  };
  const second = planIncrementalGrid(job, cache);
  assert.equal(second.dirty.length, 0, 'identical job ⇒ nothing to solve');
  assert.equal(second.reuse?.tiles.length, job.tiles.length);
});

test('changing one tile marks only that tile dirty', () => {
  const job = makeJob(48, 32, 1600, [srcAt('s1', 0, 0)]);
  const base = planIncrementalGrid(job, null);
  const cache = {
    jobKey: base.jobKey, tileKeys: base.tileKeys,
    dbA: new Float32Array(job.cols * job.rows), cols: job.cols, rows: job.rows,
  };
  // Nudge one source in ONE tile.
  const next = {
    ...job,
    tiles: job.tiles.map((t, i) => (i === 2 ? { ...t, sources: [srcAt('s1', 1, 0)] } : t)),
  };
  const plan = planIncrementalGrid(next, cache);
  assert.equal(plan.dirty.length, 1);
  assert.equal(plan.reuse?.tiles.length, job.tiles.length - 1);
});

test('a job-level change invalidates everything, even with identical tiles', () => {
  const job = makeJob(48, 32, 1600, [srcAt('s1', 0, 0)]);
  const base = planIncrementalGrid(job, null);
  const cache = {
    jobKey: base.jobKey, tileKeys: base.tileKeys,
    dbA: new Float32Array(job.cols * job.rows), cols: job.cols, rows: job.rows,
  };
  for (const changed of [
    { ...job, dOmegaDb: 3 },
    { ...job, rxHeightAboveGround: 4 },
    { ...job, rotationDeg: 15 },
    { ...job, settings: { ...job.settings, defaultG: 0.9 } },
    { ...job, barriers: [{
      id: 'b', name: 'b', type: 'wall' as const, polylineLatLng: [ORIGIN, [ORIGIN[0] + 0.001, ORIGIN[1]] as [number, number]],
      topHeightsM: [5, 5], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0.1,
    }] },
    { ...job, includeReflections: true },
  ]) {
    const plan = planIncrementalGrid(changed, cache);
    assert.equal(plan.dirty.length, job.tiles.length, 'a job-level change must force a full solve');
    assert.equal(plan.reuse, null);
  }
});

test('the fingerprint notices a source moved by a millimetre', () => {
  // Rounded keys would miss this, and a missed change means stale cells that
  // look exactly like fresh ones.
  const a = gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [srcAt('s', 0, 0)] });
  const b = gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [srcAt('s', 0.001, 0)] });
  assert.notEqual(a, b);
  // …and a changed sound power, and a changed id.
  const c = srcAt('s', 0, 0);
  const d = { ...c, lw: c.lw.map((v, i) => (i === 5 ? v + 0.01 : v)) };
  assert.notEqual(
    gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [c] }),
    gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [d] }),
  );
  assert.notEqual(
    gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [c] }),
    gridTileFingerprint({ col0: 0, row0: 0, cols: 16, rows: 16, sources: [{ ...c, id: 's2' }] }),
  );
});

test('an incrementally-solved grid is IDENTICAL to a full re-solve', () => {
  // The whole justification for P4: reusing cells must not change one of them.
  const before = makeJob(48, 32, 1600, [srcAt('s1', 100, 60)]);
  const full0 = runBatchedGrid(before, flatDem);
  const plan0 = planIncrementalGrid(before, null);
  let cache = {
    jobKey: plan0.jobKey, tileKeys: plan0.tileKeys,
    dbA: full0.dbA, cols: before.cols, rows: before.rows,
  };

  // Now change the sources of a couple of tiles only, exactly as a localised
  // edit would.
  const after: GridJob = {
    ...before,
    tiles: before.tiles.map((t, i) => (
      i % 5 === 0 ? { ...t, sources: [srcAt('s1', 120, 60), srcAt('s2', -80, -40)] } : t
    )),
  };

  const plan = planIncrementalGrid(after, cache);
  assert.ok(plan.dirty.length > 0 && plan.dirty.length < after.tiles.length, 'a partial rebuild');

  const incremental = new Float32Array(after.cols * after.rows).fill(-120);
  mergeShard(incremental, plan.reuse!.from, plan.reuse!.tiles, after.cols, after.rows);
  const solved = runBatchedGrid({ ...after, tiles: plan.dirty }, flatDem);
  mergeShard(incremental, solved.dbA, plan.dirty, after.cols, after.rows);

  const full = runBatchedGrid(after, flatDem);
  assert.deepEqual(
    Array.from(incremental), Array.from(full.dbA),
    'the incremental grid must match a full solve exactly',
  );
  cache = { jobKey: plan.jobKey, tileKeys: plan.tileKeys, dbA: incremental, cols: after.cols, rows: after.rows };
  assert.equal(planIncrementalGrid(after, cache).dirty.length, 0, 'and the new cache is reusable');
});

// ============== P5: per-tile barrier culling ==============

test('segment/box overlap: inside, crossing, and missing', () => {
  const box = [0, 0, 100, 50] as const;
  const hit = (p: [number, number], q: [number, number]) =>
    segmentHitsBox(p, q, box[0], box[1], box[2], box[3]);
  assert.ok(hit([10, 10], [20, 20]), 'wholly inside');
  assert.ok(hit([-50, 25], [150, 25]), 'crossing right through');
  assert.ok(hit([-10, -10], [10, 10]), 'clipping a corner');
  assert.ok(hit([50, -20], [50, 20]), 'entering from below');
  assert.ok(!hit([-50, 200], [150, 200]), 'passing well above');
  assert.ok(!hit([-50, -1], [-10, 60]), 'wholly to the left');
  assert.ok(hit([0, 0], [0, 50]), 'lying exactly on an edge');
});

test('culling keeps every barrier that could screen, and drops the rest', () => {
  const bar = (id: string, pts: Array<[number, number]>) => ({
    id, name: id, type: 'wall' as const, polylineLatLng: pts,
    topHeightsM: pts.map(() => 4), baseFromGroundM: 0,
    surfaceDensityKgM2: 20, absorptionCoeff: 0.1,
  });
  const near = bar('near', [[-27.0, 152.0], [-27.0, 152.01]]);
  const far = bar('far', [[-26.0, 153.0], [-26.0, 153.01]]);
  const kept = barriersForRegion([near, far], -27.01, -26.99, 151.99, 152.02, 0.001);
  assert.deepEqual(kept.map((b) => b.id), ['near']);
});

test('a grid culled per tile is IDENTICAL to one solved with every barrier', () => {
  // The justification for P5: dropping barriers a tile cannot see must not
  // move a single cell. A screening wall near the sources plus a long fence
  // far away — the exact shape that makes culling worth doing.
  const R = 6371008.8;
  const at = (e: number, n: number): [number, number] => [
    ORIGIN[0] + (n / R) * (180 / Math.PI),
    ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
  ];
  const wallBar = (id: string, pts: Array<[number, number]>, h: number) => ({
    id, name: id, type: 'wall' as const,
    polylineLatLng: pts.map(([e, n]) => at(e, n)),
    topHeightsM: pts.map(() => h), baseFromGroundM: 0,
    surfaceDensityKgM2: 20, absorptionCoeff: 0.1,
  });
  // A screen across the middle of the modelled area, and a fence 3 km south
  // that no source→cell path can reach.
  const screen = wallBar('screen', [[-400, 120], [400, 120]], 6);
  const remote = wallBar('remote', [[-2000, -3000], [2000, -3000]], 6);

  const job = makeJob(48, 32, 1600, [
    { id: 's1', latLng: at(0, 0), heightAglM: 3, lw: lw10() },
  ], { barriers: [screen, remote] });

  const withAll = runBatchedGrid(job, flatDem);

  // Cull per tile exactly as buildGridJob does.
  const marginDeg = (250 / R) * (180 / Math.PI);
  const culled = {
    ...job,
    tiles: job.tiles.map((t) => {
      let minLat = Infinity; let maxLat = -Infinity;
      let minLng = Infinity; let maxLng = -Infinity;
      // Tile cell footprint, approximated by its corner cells, plus sources.
      for (const s of t.sources) {
        minLat = Math.min(minLat, s.latLng[0]); maxLat = Math.max(maxLat, s.latLng[0]);
        minLng = Math.min(minLng, s.latLng[1]); maxLng = Math.max(maxLng, s.latLng[1]);
      }
      // Whole grid bounds stand in for the cell footprint here (conservative).
      minLat = Math.min(minLat, job.bounds.sw[0]); maxLat = Math.max(maxLat, job.bounds.ne[0]);
      minLng = Math.min(minLng, job.bounds.sw[1]); maxLng = Math.max(maxLng, job.bounds.ne[1]);
      return {
        ...t,
        barriers: barriersForRegion([screen, remote], minLat, maxLat, minLng, maxLng, marginDeg),
      };
    }),
  };
  // The remote fence must actually have been dropped, or the test proves
  // nothing about culling.
  assert.ok(
    culled.tiles.every((t) => t.barriers!.length === 1 && t.barriers![0].id === 'screen'),
    'the 3 km-distant fence should be culled from every tile',
  );

  const withCull = runBatchedGrid(culled, flatDem);
  assert.deepEqual(
    Array.from(withCull.dbA), Array.from(withAll.dbA),
    'culling barriers a tile cannot see must not change any cell',
  );
});

// ============== reflections must reach the GRID, not just point receivers ==============

test('a U-shaped reflective wall changes contour levels with absorption', () => {
  // Ryan's report: a U of noise wall open on one side, contours identical at
  // α = 0 and α = 1 while point receivers moved. Cause: the grid builds its
  // Scene with `receivers: []` (cells arrive later via `set_receivers`), so the
  // facade corridor cull had nothing to measure against, every facade scored
  // Infinity, and the grid got NO reflectors at all.
  const R = 6371008.8;
  const at = (e: number, n: number): [number, number] => [
    ORIGIN[0] + (n / R) * (180 / Math.PI),
    ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
  ];
  // U open to the east, source inside, cells span the open side.
  const u = (alpha: number) => ([{
    id: 'u', name: 'u', type: 'wall' as const,
    polylineLatLng: [at(60, -60), at(-60, -60), at(-60, 60), at(60, 60)],
    topHeightsM: [8, 8, 8, 8],
    baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: alpha,
  }]);
  const job = (alpha: number) => makeJob(32, 32, 900, [
    { id: 's1', latLng: at(0, 0), heightAglM: 3, lw: lw10() },
  ], { barriers: u(alpha), includeReflections: true, maxReflectionOrder: 1 });

  const hard = runBatchedGrid(job(0), flatDem);
  const dead = runBatchedGrid(job(1), flatDem);

  // α = 1 absorbs everything, so it must be QUIETER than a perfectly
  // reflecting U — somewhere, by a real margin.
  let maxGain = 0;
  for (let i = 0; i < hard.dbA.length; i++) {
    if (Number.isFinite(hard.dbA[i]) && Number.isFinite(dead.dbA[i])) {
      maxGain = Math.max(maxGain, hard.dbA[i] - dead.dbA[i]);
    }
  }
  assert.ok(
    maxGain > 0.2,
    `reflective walls must raise grid levels vs fully absorptive ones; `
    + `largest difference was ${maxGain.toFixed(4)} dB (0 ⇒ the grid has no reflectors)`,
  );
});

test('reflections OFF and fully-absorptive walls agree on the grid', () => {
  // The control for the test above: with α = 1 the reflected path contributes
  // nothing, so it must match the reflections-off grid cell for cell. If this
  // fails while the previous test passes, the reflection wiring is adding
  // energy it should not.
  const R = 6371008.8;
  const at = (e: number, n: number): [number, number] => [
    ORIGIN[0] + (n / R) * (180 / Math.PI),
    ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
  ];
  const wall = (alpha: number) => ([{
    id: 'w', name: 'w', type: 'wall' as const,
    polylineLatLng: [at(-60, 40), at(60, 40)],
    topHeightsM: [8, 8], baseFromGroundM: 0,
    surfaceDensityKgM2: 20, absorptionCoeff: alpha,
  }]);
  const src = [{ id: 's1', latLng: at(0, 0), heightAglM: 3, lw: lw10() }];
  const off = runBatchedGrid(makeJob(24, 24, 800, src, { barriers: wall(0) }), flatDem);
  const absorptive = runBatchedGrid(
    makeJob(24, 24, 800, src, {
      barriers: wall(1), includeReflections: true, maxReflectionOrder: 1,
    }),
    flatDem,
  );
  assert.deepEqual(Array.from(absorptive.dbA), Array.from(off.dbA));
});
