// DEM → solver `Heightfield`.
//
// The engine now does its own terrain screening: given a raster of ground
// elevations it samples the profile along each source→receiver line and treats
// any ridge that breaks the line of sight as a diffracting edge (ISO/TR
// 17534-3 §5.8 — an unbounded ridge, so it contributes no around-the-side path).
//
// This replaces the app's former approach of pre-reducing each path to synthetic
// "virtual barrier" walls in JavaScript. That pipeline had to hull, prominence-
// filter and re-sample per source→receiver pair at a fixed 8 m floor / 256-sample
// cap, and it silently skipped clustered sources. Handing over the raster instead
// gives one terrain path, sampling at the DEM's own resolution, for every source.
//
// Worker-safe and pure: geo helpers and a DemRaster only, no wasm, no firebase.

import type { DemRaster } from './dem';
import { latLngToLocalMetres, localMetresToLatLng } from './geo';
import type { SceneHeightfield } from './sceneBuilder';

/** Padding around the modelled extent (m) — a ridge just outside the source /
 *  receiver hull still screens paths near the edge. */
export const TERRAIN_MARGIN_M = 500;

/** Cap on grid size per axis. 2048² f64 ≈ 32 MB, the worst case we'll transfer
 *  to a worker; real projects land far below this. */
export const TERRAIN_MAX_CELLS_PER_AXIS = 2048;

/** Fallback cell size when the DEM doesn't report its own resolution. */
const DEFAULT_DEM_RESOLUTION_M = 20;

export type DespikeStrength = 'off' | 'low' | 'medium';

export interface TerrainFieldOptions {
  /** Peak-preserving Hampel despike of the sampled grid. Default `'low'`. */
  despikeStrength?: DespikeStrength;
  /** Override the sampling pitch (m). Defaults to the DEM's native resolution. */
  spacingM?: number;
}

/** Median (lower-middle for even length). */
function medianOf(vals: number[]): number {
  if (vals.length === 0) return 0;
  const s = vals.slice().sort((a, b) => a - b);
  return s[(s.length - 1) >> 1];
}

/**
 * Hampel despike over a 2-D grid: replace a cell with its neighbourhood median
 * ONLY when it is a statistical outlier (> t·MAD) AND off by a real margin
 * (≥ 1 m). Peak-preserving — a genuine crest sits on its own slope so it is not
 * an outlier, whereas an isolated DEM blunder (common in global tilesets) is.
 *
 * The former per-path 1-D despike moved here so the correction is applied once
 * to the raster instead of repeatedly along every profile.
 */
export function despikeGrid(
  heights: number[],
  nx: number,
  ny: number,
  strength: DespikeStrength,
): number[] {
  if (strength === 'off' || nx < 3 || ny < 3) return heights;
  const k = strength === 'medium' ? 2 : 1;      // half-window (cells)
  const t = strength === 'medium' ? 2.5 : 3.5;  // MAD multiples
  const MIN_ABS_M = 1.0;                        // ignore sub-metre wobble
  const out = heights.slice();
  const win: number[] = [];
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      win.length = 0;
      for (let jy = Math.max(0, iy - k); jy <= Math.min(ny - 1, iy + k); jy++) {
        for (let jx = Math.max(0, ix - k); jx <= Math.min(nx - 1, ix + k); jx++) {
          win.push(heights[jy * nx + jx]);
        }
      }
      const med = medianOf(win);
      const mad = medianOf(win.map((v) => Math.abs(v - med)));
      const sigma = Math.max(1.4826 * mad, 0.3); // floor so flat ground isn't all outliers
      const v = heights[iy * nx + ix];
      const dev = Math.abs(v - med);
      if (dev > MIN_ABS_M && dev > t * sigma) out[iy * nx + ix] = med;
    }
  }
  return out;
}

/**
 * Fill non-finite cells from their nearest finite neighbour (multi-source BFS
 * over the 4-neighbourhood, so each hole takes the value of whichever finite
 * cell reaches it first in grid steps). Mutates `heights`.
 *
 * The engine rejects a heightfield containing NaN, and a DEM hole must not sink
 * a whole project. Returns `false` when nothing was finite to spread — the
 * caller should then omit terrain rather than invent a flat plane.
 */
export function fillHoles(heights: number[], nx: number, ny: number): boolean {
  const n = nx * ny;
  let head = 0;
  const queue: number[] = [];
  for (let i = 0; i < n; i++) if (Number.isFinite(heights[i])) queue.push(i);
  if (queue.length === 0) return false;
  while (head < queue.length) {
    const i = queue[head++];
    const ix = i % nx;
    const iy = (i / nx) | 0;
    const v = heights[i];
    if (ix > 0 && !Number.isFinite(heights[i - 1])) { heights[i - 1] = v; queue.push(i - 1); }
    if (ix < nx - 1 && !Number.isFinite(heights[i + 1])) { heights[i + 1] = v; queue.push(i + 1); }
    if (iy > 0 && !Number.isFinite(heights[i - nx])) { heights[i - nx] = v; queue.push(i - nx); }
    if (iy < ny - 1 && !Number.isFinite(heights[i + nx])) { heights[i + nx] = v; queue.push(i + nx); }
  }
  return true;
}

/**
 * Sample a `DemRaster` into a `Heightfield` covering every supplied point plus
 * [`TERRAIN_MARGIN_M`], in the same local-metres frame as the rest of the scene.
 *
 * Pitch is the DEM's own resolution, coarsened only if that would exceed
 * [`TERRAIN_MAX_CELLS_PER_AXIS`]. Returns `null` when there is no DEM or nothing
 * to cover — the caller then omits terrain and the engine treats the ground as
 * flat, exactly as before.
 */
export function buildTerrainField(
  dem: DemRaster | null,
  origin: [number, number],
  points: Array<[number, number]>,
  opts: TerrainFieldOptions = {},
): SceneHeightfield | null {
  if (!dem || points.length === 0) return null;

  let minE = Infinity; let minN = Infinity; let maxE = -Infinity; let maxN = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const [e, n] = latLngToLocalMetres(p, origin);
    if (e < minE) minE = e;
    if (n < minN) minN = n;
    if (e > maxE) maxE = e;
    if (n > maxN) maxN = n;
  }
  if (!Number.isFinite(minE) || !Number.isFinite(minN)) return null;

  minE -= TERRAIN_MARGIN_M; minN -= TERRAIN_MARGIN_M;
  maxE += TERRAIN_MARGIN_M; maxN += TERRAIN_MARGIN_M;

  const spanE = Math.max(maxE - minE, 1);
  const spanN = Math.max(maxN - minN, 1);
  const native = opts.spacingM ?? dem.resolutionM ?? DEFAULT_DEM_RESOLUTION_M;
  // Never finer than the data, never so fine that the grid blows the cell cap.
  const spacing = Math.max(
    native > 0 ? native : DEFAULT_DEM_RESOLUTION_M,
    Math.max(spanE, spanN) / TERRAIN_MAX_CELLS_PER_AXIS,
  );

  const nx = Math.min(TERRAIN_MAX_CELLS_PER_AXIS, Math.max(2, Math.ceil(spanE / spacing) + 1));
  const ny = Math.min(TERRAIN_MAX_CELLS_PER_AXIS, Math.max(2, Math.ceil(spanN / spacing) + 1));

  // Row-major, `heights[iy * nx + ix]`, node (ix, iy) at
  // (origin_e + ix·spacing, origin_n + iy·spacing) — the engine's convention.
  const heights = new Array<number>(nx * ny);
  for (let iy = 0; iy < ny; iy++) {
    const n = minN + iy * spacing;
    for (let ix = 0; ix < nx; ix++) {
      const e = minE + ix * spacing;
      const [lat, lng] = localMetresToLatLng([e, n], origin);
      heights[iy * nx + ix] = dem.elevation(lat, lng);
    }
  }

  if (!fillHoles(heights, nx, ny)) return null;   // nothing finite anywhere
  const cleaned = despikeGrid(heights, nx, ny, opts.despikeStrength ?? 'low');

  return { type: 'heightfield', origin: [minE, minN], spacing, nx, ny, heights: cleaned };
}
