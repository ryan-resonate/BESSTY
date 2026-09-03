/**
 * Terrain QA: flag isolated DEM blunders in a resampled height grid without
 * ever touching real terrain.
 *
 * Replaces the Hampel despike, which erased every one-cell-wide bund, ridge
 * and cutting because a narrow feature is a statistical outlier in its own
 * window. This pass uses shape, not statistics (Hirt 2018's maximum-slope
 * idea): a blunder is a cell (or a bilinear-smeared 2×2 patch of cells) that
 * is implausibly steep to its neighbours AND stands strictly above or below
 * everything around it AND is not part of anything longer. Cliffs, ridges,
 * cuttings and peaks fail one of those and are reported, never corrected.
 *
 * Grid convention: row-major `heights[iy * nx + ix]`, uniform pitch in metres.
 * Pure and dependency-free so the UI, the solve pipeline and a node script can
 * all call it.
 */

export interface SuspectCells {
  /** Flagged cell indices (`iy * nx + ix`), ascending. */
  indices: number[];
  /** `indices.length`, for the diagnostic. */
  count: number;
  /** Largest |cell − median of its 8-neighbour ring| over flagged cells; 0 when none. */
  maxDevM: number;
}

export interface CorrectedCells {
  /** A copy of the input with each listed cell replaced by its ring median. */
  heights: number[];
  /** Cells whose value actually changed. */
  changed: number;
  /** Largest |new − old| over changed cells; 0 when none. */
  maxChangeM: number;
}

/**
 * Slope a single 4-neighbour step may not exceed before the cell is suspect:
 * 45° at every pitch, i.e. a rise of more than one cell width in one cell.
 * The angle does not have to protect real terrain — the cluster and ring rules
 * in `flagSuspectCells` already exclude ridges, cliffs and peaks — so it is set
 * low enough that a typical SRTM/DEM-S blunder (tens of metres at 30 m pitch)
 * is always steep enough to be seen. An earlier 60°/75° split asked for a
 * 63 m step at 17 m pitch and would have missed most real blunders.
 */
export function suspectSlopeDeg(): number {
  return 45;
}

/** The slope rule as a rise in metres: tan 45° = 1, so the limit is the pitch itself. */
export function suspectRiseM(pitchM: number): number {
  return pitchM;
}

// Mask states for the one byte-per-cell work array.
const STEEP = 1;     // shares a steep step with a 4-neighbour (border cells too)
const CANDIDATE = 2; // interior, finite, all 8 neighbours finite, steep
const VISITED = 3;   // candidate already assigned to a cluster

// Eight-neighbour offsets as (dx, dy) pairs.
const DX8 = [-1, 0, 1, -1, 1, -1, 0, 1];
const DY8 = [-1, -1, -1, 0, 0, 1, 1, 1];

/**
 * Flag cells that look like DEM blunders rather than terrain.
 *
 * A cell is suspect only if ALL hold:
 * 1. the rise to at least one 4-neighbour exceeds `suspectRiseM(pitchM)`;
 * 2. its cluster — the 8-connected group of steep cells it joins across steps
 *    that are themselves BELOW the rise threshold — has a bounding box of at
 *    most 2×2 cells;
 * 3. every cell of that cluster is strictly higher than every cell of the
 *    ring around the cluster, or strictly lower than all of them.
 *
 * Why the cluster, not the cell, is tested for the extremum: two adjacent
 * cells can never both be strict maxima, so a per-cell test would make rule 2
 * vacuous and could never catch a flat-topped 2×2 patch (what a single bad
 * source cell becomes after bilinear resampling). Why clusters only link across
 * sub-threshold steps: a spike that touches a cliff crest must not be absorbed
 * into the crest's long cluster and lost, while the undulating cells of a real
 * crest (a metre or two apart) stay one long cluster and are never flagged.
 *
 * Border cells are never flagged (the raster margin makes them irrelevant and
 * their ring is truncated). Non-finite cells are never flagged and any cell
 * with a non-finite neighbour is left alone — a hole is not evidence.
 *
 * O(n): one pass with two comparisons per cell, then a walk over the (sparse)
 * steep cells. No per-cell allocation.
 */
export function flagSuspectCells(
  heights: ArrayLike<number>,
  nx: number,
  ny: number,
  pitchM: number,
): SuspectCells {
  if (!(pitchM > 0) || !Number.isFinite(pitchM)) throw new RangeError(`terrainQa: pitch must be > 0, got ${pitchM}`);
  const n = nx * ny;
  if (heights.length !== n) throw new RangeError(`terrainQa: heights has ${heights.length} cells, expected ${nx}×${ny}`);
  if (nx < 3 || ny < 3) return { indices: [], count: 0, maxDevM: 0 };

  const rise = suspectRiseM(pitchM);
  const mask = new Uint8Array(n);
  const candidates: number[] = [];

  // Pass 1: mark both ends of every steep step. Comparing each cell with its
  // right and down neighbours only visits each step once; by the time the
  // loop reaches cell i, its left and up steps were tested by earlier cells,
  // so mask[i] is final after its own two comparisons and the candidate test
  // can run inline. NaN and ±Infinity fail (or fake) these comparisons, so
  // finiteness is checked explicitly for the few cells that become steep.
  for (let iy = 0; iy < ny; iy++) {
    const row = iy * nx;
    for (let ix = 0; ix < nx; ix++) {
      const i = row + ix;
      const v = heights[i];
      if (ix < nx - 1) {
        const d = v - heights[i + 1];
        if (d > rise || d < -rise) { mask[i] = STEEP; mask[i + 1] = STEEP; }
      }
      if (iy < ny - 1) {
        const d = v - heights[i + nx];
        if (d > rise || d < -rise) { mask[i] = STEEP; mask[i + nx] = STEEP; }
      }
      if (mask[i] === STEEP && ix > 0 && ix < nx - 1 && iy > 0 && iy < ny - 1 && ringIsFinite(heights, i, nx)) {
        mask[i] = CANDIDATE;
        candidates.push(i);
      }
    }
  }

  // Pass 2: cluster the candidates and test each small cluster against its ring.
  const flagged: number[] = [];
  const stack: number[] = [];
  const members: number[] = [];
  let maxDevM = 0;
  const ring = new Float64Array(8);
  for (const seed of candidates) {
    if (mask[seed] !== CANDIDATE) continue;
    mask[seed] = VISITED;
    stack.length = 0;
    members.length = 0;
    stack.push(seed);
    let minX = nx, maxX = -1, minY = ny, maxY = -1;
    let big = false;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      const cx = c % nx;
      const cy = (c - cx) / nx;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      // A 2×2 box holds at most four cells; past that only the visited marks matter.
      if (members.length < 4) members.push(c); else big = true;
      const hc = heights[c];
      for (let k = 0; k < 8; k++) {
        const nb = c + DY8[k] * nx + DX8[k]; // candidates are interior, so no wrap
        if (mask[nb] !== CANDIDATE) continue;
        const d = hc - heights[nb];
        if (d > rise || d < -rise) continue; // a steep step separates clusters
        mask[nb] = VISITED;
        stack.push(nb);
      }
    }
    if (big || maxX - minX > 1 || maxY - minY > 1) continue;

    // Rule 3: the whole cluster strictly above, or strictly below, its ring.
    let cMin = Infinity, cMax = -Infinity, rMin = Infinity, rMax = -Infinity;
    for (const m of members) {
      const hm = heights[m];
      if (hm < cMin) cMin = hm;
      if (hm > cMax) cMax = hm;
      for (let k = 0; k < 8; k++) {
        const nb = m + DY8[k] * nx + DX8[k];
        if (isMember(members, nb)) continue;
        const hn = heights[nb];
        if (hn < rMin) rMin = hn;
        if (hn > rMax) rMax = hn;
      }
    }
    if (!(cMin > rMax || cMax < rMin)) continue;

    for (const m of members) {
      flagged.push(m);
      const dev = Math.abs(heights[m] - ringMedian(heights, m, nx, ny, ring));
      if (dev > maxDevM) maxDevM = dev;
    }
  }

  flagged.sort((a, b) => a - b);
  return { indices: flagged, count: flagged.length, maxDevM };
}

/**
 * Replace each listed cell with the median of its 8-neighbour ring, computed
 * from the ORIGINAL values, and return the result as a copy. Nothing else is
 * altered, so a caller that passes `flagSuspectCells(...).indices` changes
 * exactly the flagged cells and an empty list is a no-op.
 */
export function correctSuspectCells(
  heights: ArrayLike<number>,
  nx: number,
  ny: number,
  indices: number[],
): CorrectedCells {
  const out = Array.from(heights);
  let changed = 0;
  let maxChangeM = 0;
  const ring = new Float64Array(8);
  for (const i of indices) {
    if (!(i >= 0 && i < out.length)) continue;
    const med = ringMedian(heights, i, nx, ny, ring);
    if (!Number.isFinite(med)) continue; // no finite neighbour to borrow from
    const old = heights[i];
    if (med === old) continue;
    out[i] = med;
    changed++;
    const delta = Number.isFinite(old) ? Math.abs(med - old) : Infinity;
    if (delta > maxChangeM) maxChangeM = delta;
  }
  return { heights: out, changed, maxChangeM };
}

/** True when the 3×3 block centred on interior cell `i` is all finite. */
function ringIsFinite(h: ArrayLike<number>, i: number, nx: number): boolean {
  for (let dy = -nx; dy <= nx; dy += nx) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!Number.isFinite(h[i + dy + dx])) return false;
    }
  }
  return true;
}

/** Linear membership test — clusters that reach here have at most four cells. */
function isMember(members: number[], i: number): boolean {
  for (let k = 0; k < members.length; k++) if (members[k] === i) return true;
  return false;
}

/**
 * Median of the finite, in-grid 8-neighbours of cell `i` (mean of the middle
 * pair for an even count, so a spike on a planar slope lands back on the
 * plane). NaN when no finite neighbour exists. `buf` is scratch so the hot
 * path allocates nothing.
 */
function ringMedian(h: ArrayLike<number>, i: number, nx: number, ny: number, buf: Float64Array): number {
  const ix = i % nx;
  const iy = (i - ix) / nx;
  let m = 0;
  for (let k = 0; k < 8; k++) {
    const jx = ix + DX8[k];
    const jy = iy + DY8[k];
    if (jx < 0 || jx >= nx || jy < 0 || jy >= ny) continue;
    const v = h[jy * nx + jx];
    if (!Number.isFinite(v)) continue;
    // Insertion sort as we go: eight values at most.
    let p = m++;
    while (p > 0 && buf[p - 1] > v) { buf[p] = buf[p - 1]; p--; }
    buf[p] = v;
  }
  if (m === 0) return NaN;
  return m % 2 === 1 ? buf[(m - 1) >> 1] : (buf[(m >> 1) - 1] + buf[m >> 1]) / 2;
}
