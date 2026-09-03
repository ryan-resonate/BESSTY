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

import type { DemRaster, TerrainQaSummary } from './dem';
import type { Diagnostics } from './diagnostics';
import { latLngToLocalMetres, localMetresToLatLng } from './geo';
import type { SceneHeightfield } from './sceneBuilder';
import { correctSuspectCells, flagSuspectCells } from './terrainQa';

/** Padding around the modelled extent (m) — a ridge just outside the source /
 *  receiver hull still screens paths near the edge. */
export const TERRAIN_MARGIN_M = 500;

/** Cap on grid size per axis. 2048² f64 ≈ 32 MB, the worst case we'll transfer
 *  to a worker; real projects land far below this. */
export const TERRAIN_MAX_CELLS_PER_AXIS = 2048;

/** Fallback cell size when the DEM doesn't report its own resolution. */
const DEFAULT_DEM_RESOLUTION_M = 20;

/** Most flagged cells the build record keeps for the map overlay. A DEM that
 *  produced more than this is broken in a way no overlay would clarify. */
const MAX_REPORTED_SUSPECT_CELLS = 500;

export interface TerrainFieldOptions {
  /** Override the sampling pitch (m). Defaults to the DEM's native resolution. */
  spacingM?: number;
  /** Replace cells the QA pass flags with their ring median
   *  (`settings.topography.qaCorrect`). Off by default: flagging is reporting,
   *  correcting is a modelling decision. */
  qaCorrect?: boolean;
  /** I20: where to report that the cell cap forced a coarser pitch. */
  diagnostics?: Diagnostics;
}

/** One flagged cell, in the frame the map and the report speak. */
export interface SuspectCell {
  latLng: [number, number];
  /** Sampled elevation (m) — the value that looks wrong. */
  z: number;
  /** Median of its 8-neighbour ring (m) — what correction would put there. */
  median: number;
}

/** What the most recent `buildTerrainField` produced, for callers that need to
 *  report on it (diagnostics, the PDF line, the map overlay) without having the
 *  raster plumbed through to them. */
export interface TerrainBuildInfo extends TerrainQaSummary {
  /** Pitch (m) terrain was ACTUALLY screened at — the cell cap can make this
   *  coarser than the DEM's own resolution, and only the built field knows. */
  pitchM: number;
  /** Flagged cells, capped at [`MAX_REPORTED_SUSPECT_CELLS`]. */
  cells: SuspectCell[];
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
/// Memo for `buildTerrainField`. Sampling a DEM over a project extent is up to
/// 2048x2048 = 4.2M elevation lookups on the main thread — cheap enough once,
/// ruinous when repeated. `evaluateProject` rebuilt it on EVERY call, so a
/// factorial study of N combinations paid it N times and locked the UI for
/// seconds on a 2x2 case. The raster depends only on the DEM and the covered
/// extent, neither of which a model swap changes.
let memo: { key: string; value: SceneHeightfield | null; info: TerrainBuildInfo | null } | null = null;

function memoKey(
  dem: DemRaster,
  origin: [number, number],
  points: Array<[number, number]>,
  opts: TerrainFieldOptions,
): string {
  // Bounds to ~1 m, so a sub-metre source nudge doesn't invalidate the raster.
  let minLat = Infinity; let minLng = Infinity; let maxLat = -Infinity; let maxLng = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    if (p[0] < minLat) minLat = p[0];
    if (p[1] < minLng) minLng = p[1];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] > maxLng) maxLng = p[1];
  }
  const r = (v: number) => (Number.isFinite(v) ? v.toFixed(5) : 'x');
  return [
    demIdentity(dem), origin[0].toFixed(5), origin[1].toFixed(5),
    r(minLat), r(minLng), r(maxLat), r(maxLng),
    opts.qaCorrect ? 'qa' : 'raw', opts.spacingM ?? 'auto',
  ].join('|');
}

/// A stable identity for a DemRaster. Rasters are plain objects rebuilt on
/// load, so a WeakMap tag is attached lazily rather than relying on reference
/// equality.
const demTags = new WeakMap<object, string>();
let demSeq = 0;
function demIdentity(dem: DemRaster): string {
  const o = dem as unknown as object;
  let t = demTags.get(o);
  if (!t) { t = `dem${++demSeq}`; demTags.set(o, t); }
  return t;
}

/// Drop the cached raster. Call when the DEM itself is replaced.
export function clearTerrainFieldCache(): void {
  memo = null;
}

/// What the most recent build produced, or `null` if none has been (or it
/// produced no terrain). Read straight after `buildTerrainField` — the memo
/// holds one entry, so a later build for a different extent replaces it.
export function lastTerrainBuild(): TerrainBuildInfo | null {
  return memo?.info ?? null;
}

/// A `DemRaster` that reads the QA-CORRECTED surface inside the built field and
/// the raw DEM outside it.
///
/// Endpoint ground (sources, receivers, grid cells, wall feet) is looked up
/// from the DemRaster, while the engine screens paths against the heightfield.
/// With correction on those two disagree exactly where it matters — a receiver
/// standing on a corrected cell would otherwise float 60 m over the terrain the
/// engine sees. `origin` is the scene's geodetic origin, the same one the field
/// was built in.
export function correctedDemRaster(
  dem: DemRaster,
  field: SceneHeightfield,
  origin: [number, number],
): DemRaster {
  const { spacing, nx, ny, heights } = field;
  const [e0, n0] = field.origin;
  return {
    ...dem,
    elevation(lat: number, lng: number): number {
      const [e, n] = latLngToLocalMetres([lat, lng], origin);
      const fx = (e - e0) / spacing;
      const fy = (n - n0) / spacing;
      if (!(fx >= 0 && fx <= nx - 1 && fy >= 0 && fy <= ny - 1)) return dem.elevation(lat, lng);
      // The field is at least 2×2, so clamping the cell corner to the last full
      // cell keeps the far edge interpolating (t = 1) rather than indexing off.
      const ix = Math.min(Math.floor(fx), nx - 2);
      const iy = Math.min(Math.floor(fy), ny - 2);
      const tx = fx - ix;
      const ty = fy - iy;
      const h00 = heights[iy * nx + ix];
      const h10 = heights[iy * nx + ix + 1];
      const h01 = heights[(iy + 1) * nx + ix];
      const h11 = heights[(iy + 1) * nx + ix + 1];
      return h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) + h01 * (1 - tx) * ty + h11 * tx * ty;
    },
  };
}

export function buildTerrainField(
  dem: DemRaster | null,
  origin: [number, number],
  points: Array<[number, number]>,
  opts: TerrainFieldOptions = {},
): SceneHeightfield | null {
  if (!dem || points.length === 0) return null;

  const key = memoKey(dem, origin, points, opts);
  if (memo && memo.key === key) return memo.value;

  let minE = Infinity; let minN = Infinity; let maxE = -Infinity; let maxN = -Infinity;
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const [e, n] = latLngToLocalMetres(p, origin);
    if (e < minE) minE = e;
    if (n < minN) minN = n;
    if (e > maxE) maxE = e;
    if (n > maxN) maxN = n;
  }
  if (!Number.isFinite(minE) || !Number.isFinite(minN)) {
    memo = { key, value: null, info: null };
    return null;
  }

  minE -= TERRAIN_MARGIN_M; minN -= TERRAIN_MARGIN_M;
  maxE += TERRAIN_MARGIN_M; maxN += TERRAIN_MARGIN_M;

  const spanE = Math.max(maxE - minE, 1);
  const spanN = Math.max(maxN - minN, 1);
  const native = opts.spacingM ?? dem.resolutionM ?? DEFAULT_DEM_RESOLUTION_M;
  // Never finer than the data, never so fine that the grid blows the cell cap.
  const nativeClean = native > 0 ? native : DEFAULT_DEM_RESOLUTION_M;
  const capFloor = Math.max(spanE, spanN) / TERRAIN_MAX_CELLS_PER_AXIS;
  const spacing = Math.max(nativeClean, capFloor);
  // I20: the cap winning means terrain is screened at a coarser pitch than the
  // DEM actually provides — small ridges shorter than a cell stop diffracting.
  if (opts.diagnostics && capFloor > nativeClean) {
    opts.diagnostics.note(
      'terrain.resampled', 'material',
      `Terrain resampled to ${spacing.toFixed(0)} m (DEM provides ${nativeClean.toFixed(0)} m) — `
      + `the modelled area needs more than ${TERRAIN_MAX_CELLS_PER_AXIS} cells per axis. `
      + 'Ridges narrower than a cell no longer screen.',
    );
  }

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

  if (!fillHoles(heights, nx, ny)) { memo = { key, value: null, info: null }; return null; }

  // Terrain QA. Blunders are FLAGGED always and corrected only on request: the
  // Hampel despike this replaced silently erased every one-cell bund and
  // cutting it met, so nothing here touches the raster unless asked, and what
  // it would touch is reported either way. `correctSuspectCells` runs
  // regardless because it is what knows each flagged cell's ring median — the
  // value the report quotes — and it only visits the (few) flagged cells.
  const qa = flagSuspectCells(heights, nx, ny, spacing);
  let final = heights;
  const info: TerrainBuildInfo = {
    pitchM: spacing, count: qa.count, maxDevM: qa.maxDevM, correction: null, cells: [],
  };
  if (qa.count > 0) {
    const fixed = correctSuspectCells(heights, nx, ny, qa.indices);
    for (const i of qa.indices.slice(0, MAX_REPORTED_SUSPECT_CELLS)) {
      const ix = i % nx;
      const iy = (i - ix) / nx;
      info.cells.push({
        latLng: localMetresToLatLng([minE + ix * spacing, minN + iy * spacing], origin),
        z: heights[i],
        median: fixed.heights[i],
      });
    }
    if (opts.qaCorrect) {
      final = fixed.heights;
      info.correction = { changed: fixed.changed, maxChangeM: fixed.maxChangeM };
    }
  }

  const field: SceneHeightfield = {
    type: 'heightfield', origin: [minE, minN], spacing, nx, ny, heights: final,
  };
  memo = { key, value: field, info };
  return field;
}
