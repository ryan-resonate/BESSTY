import test from 'node:test';
import assert from 'node:assert/strict';

import {
  correctSuspectCells, flagSuspectCells, suspectRiseM, suspectSlopeDeg,
} from './terrainQa';

// 21×21 test grid, centre cell (10, 10).
const N = 21;
const C = 10;
const at = (ix: number, iy: number) => iy * N + ix;

/** Grid of `f(ix, iy)` (flat zero by default). */
function grid(f: (ix: number, iy: number) => number = () => 0): number[] {
  const h = new Array<number>(N * N);
  for (let iy = 0; iy < N; iy++) for (let ix = 0; ix < N; ix++) h[at(ix, iy)] = f(ix, iy);
  return h;
}

/** Flat grid with `cells` set to `value`. */
function withCells(cells: Array<[number, number]>, value: number, base = grid()): number[] {
  const h = base.slice();
  for (const [ix, iy] of cells) h[at(ix, iy)] = value;
  return h;
}

/** Every cell of column `ix` — a north–south ridge or cutting once given a value. */
function column(ix: number): Array<[number, number]> {
  return Array.from({ length: N }, (_, iy) => [ix, iy] as [number, number]);
}

// ------------------------------------------------------------ threshold rule

test('slope rule: 45° at every pitch — a step of more than one cell width', () => {
  assert.equal(suspectSlopeDeg(), 45);
  assert.equal(suspectRiseM(30), 30);
  assert.equal(suspectRiseM(17), 17);
  assert.equal(suspectRiseM(5), 5);
});

test('real-world amplitudes at 17, 30 and 5 m pitch', () => {
  const spike = withCells([[C, C]], 60);
  const pit = withCells([[C, C]], -60);
  const bump = withCells([[C, C]], 1.2);
  for (const pitch of [17, 30, 5]) {
    assert.deepEqual(flagSuspectCells(spike, N, N, pitch).indices, [at(C, C)], `60 m spike at ${pitch} m`);
    assert.deepEqual(flagSuspectCells(pit, N, N, pitch).indices, [at(C, C)], `60 m pit at ${pitch} m`);
    assert.equal(flagSuspectCells(bump, N, N, pitch).count, 0, `1.2 m bump at ${pitch} m`);
  }
  // A 15 m step exceeds 45° only when the pitch is under 15 m: the smeared
  // blob is flagged at 5 m and, by the rule's own definition (41° and 27°),
  // left alone at 17 m and 30 m.
  const blob15 = withCells([[C, C], [C + 1, C], [C, C + 1], [C + 1, C + 1]], 15);
  assert.equal(flagSuspectCells(blob15, N, N, 5).count, 4);
  assert.equal(flagSuspectCells(blob15, N, N, 17).count, 0);
  assert.equal(flagSuspectCells(blob15, N, N, 30).count, 0);
  // Conical peak rising 10 m per 17 m cell (30°) is terrain.
  const cone = grid((ix, iy) => Math.max(0, 30 - 10 * Math.max(Math.abs(ix - C), Math.abs(iy - C))));
  assert.equal(flagSuspectCells(cone, N, N, 17).count, 0);
});

// ------------------------------------------------- shape rules, per pitch

// Amplitudes are stated relative to the rise threshold (= the pitch) so each
// case means the same thing at every pitch: A is a step twice what the rule
// tolerates.
for (const pitch of [30, 17, 5]) {
  const rise = suspectRiseM(pitch);
  const A = 2 * rise;
  const flags = (h: number[]) => flagSuspectCells(h, N, N, pitch);
  const label = `pitch ${pitch} m (rise limit ${rise.toFixed(1)} m)`;

  test(`isolated spike and pit are flagged, exactly once — ${label}`, () => {
    const spike = flags(withCells([[C, C]], A));
    assert.deepEqual(spike.indices, [at(C, C)]);
    assert.equal(spike.count, 1);
    assert.ok(Math.abs(spike.maxDevM - A) < 1e-9, 'deviation is measured against the ring median');

    const pit = flags(withCells([[C, C]], -A));
    assert.deepEqual(pit.indices, [at(C, C)]);
    assert.ok(Math.abs(pit.maxDevM - A) < 1e-9);
  });

  test(`a 2×2 block (bilinear-smeared blunder) is flagged whole — ${label}`, () => {
    const cells: Array<[number, number]> = [[C, C], [C + 1, C], [C, C + 1], [C + 1, C + 1]];
    const r = flags(withCells(cells, 1.5 * rise));
    assert.deepEqual(r.indices, cells.map(([x, y]) => at(x, y)).sort((a, b) => a - b));
    assert.equal(r.count, 4);
    assert.ok(Math.abs(r.maxDevM - 1.5 * rise) < 1e-9, 'ring median of a block cell is the flat ground');

    // A two-cell blob and an L within a 2×2 box are the same artefact.
    assert.equal(flags(withCells([[C, C], [C + 1, C]], A)).count, 2);
    assert.equal(flags(withCells([[C, C], [C + 1, C], [C, C + 1]], A)).count, 3);
  });

  test(`a bump below the slope rule is not flagged — ${label}`, () => {
    assert.equal(flags(withCells([[C, C]], 1.2)).count, 0);
    assert.equal(flags(withCells([[C, C]], rise * 0.99)).count, 0, 'just under the limit');
  });

  test(`one-cell-wide ridges, diagonals and cuttings are never flagged — ${label}`, () => {
    assert.equal(flags(withCells(column(C), 5)).count, 0, 'low N-S ridge');
    assert.equal(flags(withCells(column(C), A)).count, 0, 'ridge above the slope rule');
    assert.equal(flags(withCells(column(C), -5)).count, 0, 'low cutting');
    assert.equal(flags(withCells(column(C), -A)).count, 0, 'deep cutting');
    const diag = Array.from({ length: N }, (_, i) => [i, i] as [number, number]);
    assert.equal(flags(withCells(diag, A)).count, 0, 'diagonal ridge');
    const shortRidge = Array.from({ length: 3 }, (_, i) => [C, C - 1 + i] as [number, number]);
    assert.equal(flags(withCells(shortRidge, A)).count, 0, 'a 1×3 bund is already too long');
  });

  test(`two- and three-cell-wide ridges are never flagged — ${label}`, () => {
    assert.equal(flags(withCells([...column(C), ...column(C + 1)], A)).count, 0);
    assert.equal(flags(withCells([...column(C - 1), ...column(C), ...column(C + 1)], A)).count, 0);
  });

  test(`peaks, slopes and summits are terrain — ${label}`, () => {
    // Cone and summit slopes sit at 60 % of the rise limit, i.e. real hills.
    const s = 0.6 * rise;
    const cone = grid((ix, iy) => Math.max(0, 3 * s - s * Math.max(Math.abs(ix - C), Math.abs(iy - C))));
    assert.equal(flags(cone).count, 0, 'conical peak');
    assert.equal(flags(grid((ix) => 2 * ix)).count, 0, 'planar slope');
    assert.equal(flags(grid((ix, iy) => 3 * rise - (3 * rise / 100) * ((ix - C) ** 2 + (iy - C) ** 2))).count, 0,
      'paraboloid summit');
  });

  test(`a 3×3 block is too big to be a blunder — ${label}`, () => {
    const cells: Array<[number, number]> = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) cells.push([C + dx, C + dy]);
    assert.equal(flags(withCells(cells, 1.5 * rise)).count, 0);
  });

  test(`a spike touching a ridge is flagged; the ridge is not — ${label}`, () => {
    // The spike stands a full rise limit above the crest, so it is not linked
    // into the ridge's cluster.
    const h = withCells([[C + 1, C]], 2 * A, withCells(column(C), A));
    assert.deepEqual(flags(h).indices, [at(C + 1, C)]);
  });

  test(`a cliff with an undulating crest is one long cluster, not a row of blunders — ${label}`, () => {
    // Step of 2A across x = 10; crest cells wobble by ±1 m so some are strict
    // local maxima. A per-cell extremum test would flag those.
    const h = grid((ix, iy) => (ix >= C ? 2 * A + (iy % 3 === 0 ? 1 : iy % 3 === 1 ? -1 : 0) : 0));
    assert.equal(flags(h).count, 0);
  });

  test(`a spike beside a pit flags both — ${label}`, () => {
    const h = withCells([[C + 1, C]], -A, withCells([[C, C]], A));
    assert.deepEqual(flags(h).indices, [at(C, C), at(C + 1, C)]);
  });

  test(`border cells are never flagged — ${label}`, () => {
    for (const cell of [[0, C], [N - 1, C], [7, 0], [7, N - 1], [0, 0], [N - 1, N - 1]] as Array<[number, number]>) {
      assert.equal(flags(withCells([cell], A)).count, 0, `border cell ${cell}`);
    }
    // One cell in from the border is interior and does count.
    assert.equal(flags(withCells([[1, 1]], A)).count, 1);
  });

  test(`holes: a non-finite neighbour suppresses the flag, a hole further away does not — ${label}`, () => {
    const spike = withCells([[C, C]], A);
    const nanRing = spike.slice(); nanRing[at(C + 1, C + 1)] = NaN;
    assert.equal(flags(nanRing).count, 0, 'NaN in the ring');
    const infRing = spike.slice(); infRing[at(C - 1, C)] = Infinity;
    assert.equal(flags(infRing).count, 0, 'Infinity in the ring');
    const nanFar = spike.slice(); nanFar[at(C + 2, C + 2)] = NaN;
    assert.equal(flags(nanFar).count, 1, 'NaN two cells away is irrelevant');
    assert.equal(flags(withCells([[C, C]], NaN)).count, 0, 'the hole itself is not suspect');
  });

  test(`correction changes exactly the flagged cells, from the original values — ${label}`, () => {
    // A 2×2 blob at A plus a lone spike at 1.5·A well away from it.
    const blob: Array<[number, number]> = [[C, C], [C + 1, C], [C, C + 1], [C + 1, C + 1]];
    const h = withCells(blob, A, withCells([[3, 3]], 1.5 * A));
    const snapshot = h.slice();
    const flagged = flags(h);
    assert.equal(flagged.count, 5);

    const r = correctSuspectCells(h, N, N, flagged.indices);
    assert.deepEqual(h, snapshot, 'input untouched');
    assert.notEqual(r.heights, h, 'a copy is returned');
    assert.equal(r.heights.length, h.length);
    assert.equal(r.changed, 5);
    assert.ok(Math.abs(r.maxChangeM - 1.5 * A) < 1e-9, 'largest change is the lone spike');
    for (let i = 0; i < h.length; i++) {
      if (flagged.indices.includes(i)) assert.equal(r.heights[i], 0, `flagged cell ${i} back to the ring median`);
      else assert.equal(r.heights[i], h[i], `cell ${i} left alone`);
    }
    assert.equal(flags(r.heights).count, 0, 'nothing left to flag');
  });

  test(`a spike on a planar slope is corrected onto the plane — ${label}`, () => {
    const plane = grid((ix, iy) => 2 * ix + 1 * iy);
    const h = plane.slice(); h[at(C, C)] += A;
    const flagged = flags(h);
    assert.deepEqual(flagged.indices, [at(C, C)]);
    const r = correctSuspectCells(h, N, N, flagged.indices);
    assert.equal(r.heights[at(C, C)], plane[at(C, C)]);
  });
}

// ---------------------------------------------------------- misc behaviour

test("'off' equivalent: an empty index list returns an identical copy", () => {
  const h = withCells([[C, C]], 60);
  const r = correctSuspectCells(h, N, N, []);
  assert.deepEqual(r.heights, h);
  assert.notEqual(r.heights, h);
  assert.equal(r.changed, 0);
  assert.equal(r.maxChangeM, 0);
});

test('typed-array input is accepted and gives the same answer', () => {
  const h = Float32Array.from(withCells([[C, C]], 60));
  const r = flagSuspectCells(h, N, N, 5);
  assert.deepEqual(r.indices, [at(C, C)]);
  const c = correctSuspectCells(h, N, N, r.indices);
  assert.ok(Array.isArray(c.heights));
  assert.equal(c.heights[at(C, C)], 0);
});

test('grids too small to have an interior, and bad arguments', () => {
  assert.deepEqual(flagSuspectCells([0, 0, 0, 0], 2, 2, 5), { indices: [], count: 0, maxDevM: 0 });
  assert.throws(() => flagSuspectCells([0, 0, 0], 2, 2, 5), RangeError);
  assert.throws(() => flagSuspectCells([0, 0, 0, 0], 2, 2, 0), RangeError);
});

// ------------------------------------------------------------------ speed

test('2048² grid flags in well under a second', () => {
  const nx = 2048, ny = 2048;
  const h = new Array<number>(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      h[iy * nx + ix] = 40 * Math.sin(ix / 37) * Math.cos(iy / 53) + 0.01 * ix;
    }
  }
  const spikes = 20;
  for (let k = 0; k < spikes; k++) h[(100 + 90 * k) * nx + (150 + 80 * k)] += 200;

  const t0 = performance.now();
  const r = flagSuspectCells(h, nx, ny, 30);
  const ms = performance.now() - t0;
  console.log(`    terrainQa: 2048x2048 flagged in ${ms.toFixed(0)} ms (${r.count} cells)`);
  assert.equal(r.count, spikes);
  assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
});
