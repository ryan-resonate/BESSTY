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
export const MAX_REPORTED_SUSPECT_CELLS = 500;

/** Hard bound on the flag → correct loop `qaCorrect` runs. Correcting the worst
 *  cell of an uneven smear can leave its neighbours steep enough to flag on the
 *  next look, so the pass iterates; the bound is what guarantees it stops. */
const QA_CORRECTION_PASSES = 3;

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
  /** Flagged cells, worst deviation first, capped at
   *  [`MAX_REPORTED_SUSPECT_CELLS`]. `count` is the true total. */
  cells: SuspectCell[];
  /** Sparse `cell index → (corrected − raw)`, one entry per cell correction
   *  actually moved and nothing else. Empty unless `qaCorrect` was on and
   *  something was flagged. This — not the corrected raster — is what
   *  [`correctedDemRaster`] adds to the DEM. */
  deltas: Map<number, number>;
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
///
/// TWO entries, most recent first. A solve builds two different fields — the
/// receiver pass covers sources + receivers, the grid job covers the calc-area
/// corners + sources — so a one-entry memo was evicted by each in turn and the
/// ordinary edit → solve → regrid loop re-sampled both every time. Worse, a
/// rebuilt field is a NEW object, and the grid's pack cache keys on identity,
/// so the whole heightfield was re-packed and re-shipped to every worker.
type MemoEntry = { key: string; value: SceneHeightfield | null; info: TerrainBuildInfo | null };
const MEMO_SIZE = 2;
let memo: MemoEntry[] = [];

/// Put `entry` at the front, evicting the oldest past [`MEMO_SIZE`]. Used for a
/// hit as well as a new build, so `lastTerrainBuild` speaks for the most recent
/// CALL — from the caller's point of view a hit is as much a build as a miss.
function remember(entry: MemoEntry): void {
  const at = memo.indexOf(entry);
  if (at >= 0) memo.splice(at, 1);
  memo.unshift(entry);
  if (memo.length > MEMO_SIZE) memo.length = MEMO_SIZE;
}

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

/// Drop the cached rasters. Call when the DEM itself is replaced.
export function clearTerrainFieldCache(): void {
  memo = [];
}

/// What the most recent build produced, or `null` if none has been (or it
/// produced no terrain).
///
/// Only ever safe to read STRAIGHT AFTER a `buildTerrainField` call, with no
/// await in between: it describes whichever field that call returned, and the
/// next build — typically the contour grid's, over a different extent —
/// describes that one instead. Anything that needs the record later is handed
/// it (`evaluateProject` returns it).
export function lastTerrainBuild(): TerrainBuildInfo | null {
  return memo[0]?.info ?? null;
}

/// The DEM plus whatever the QA correction moved — the raw raster everywhere
/// else, exactly.
///
/// Endpoint ground (sources, receivers, grid cells, wall feet) is looked up
/// from the DemRaster, while the engine screens paths against the heightfield.
/// With correction on those two disagree exactly where it matters — a receiver
/// standing on a corrected cell would otherwise float 60 m over the terrain the
/// engine sees.
///
/// What is added is the sparse DELTA (`corrected − raw` at the corrected cells,
/// zero everywhere else), not the resampled field: returning the field's own
/// bilinear moved every endpoint in the extent by the resampling error — metres
/// where a fine DEM had been coarsened to the cell cap — and put a step at the
/// field edge. Border cells are never flagged, so the delta reaches the edge as
/// zero and there is no seam. `origin` is the scene's geodetic origin, the same
/// one the field was built in.
export function correctedDemRaster(
  dem: DemRaster,
  field: SceneHeightfield,
  origin: [number, number],
  deltas: ReadonlyMap<number, number>,
): DemRaster {
  if (deltas.size === 0) return dem;
  const { spacing, nx, ny } = field;
  const [e0, n0] = field.origin;
  const delta = (ix: number, iy: number) => deltas.get(iy * nx + ix) ?? 0;
  return {
    ...dem,
    // The wrapper is NOT a regular lat/lng grid — the raster underneath may be,
    // and `captureDemRegion`'s fast path would then snapshot it uncorrected.
    grid: undefined,
    elevation(lat: number, lng: number): number {
      const raw = dem.elevation(lat, lng);
      const [e, n] = latLngToLocalMetres([lat, lng], origin);
      const fx = (e - e0) / spacing;
      const fy = (n - n0) / spacing;
      if (!(fx >= 0 && fx <= nx - 1 && fy >= 0 && fy <= ny - 1)) return raw;
      // The field is at least 2×2, so clamping the cell corner to the last full
      // cell keeps the far edge interpolating (t = 1) rather than indexing off.
      const ix = Math.min(Math.floor(fx), nx - 2);
      const iy = Math.min(Math.floor(fy), ny - 2);
      const tx = fx - ix;
      const ty = fy - iy;
      const d = delta(ix, iy) * (1 - tx) * (1 - ty)
        + delta(ix + 1, iy) * tx * (1 - ty)
        + delta(ix, iy + 1) * (1 - tx) * ty
        + delta(ix + 1, iy + 1) * tx * ty;
      return d === 0 ? raw : raw + d;
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
  const hit = memo.find((e) => e.key === key);
  if (hit) { remember(hit); return hit.value; }

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
    remember({ key, value: null, info: null });
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

  if (!fillHoles(heights, nx, ny)) { remember({ key, value: null, info: null }); return null; }

  // Terrain QA. Blunders are FLAGGED always and corrected only on request: the
  // Hampel despike this replaced silently erased every one-cell bund and
  // cutting it met, so nothing here touches the raster unless asked, and what
  // it would touch is reported either way. `correctSuspectCells` runs
  // regardless because it is what knows each flagged cell's ring median — the
  // value the report quotes — and it only visits the (few) flagged cells.
  const qa = flagSuspectCells(heights, nx, ny, spacing);
  let final = heights;
  const info: TerrainBuildInfo = {
    pitchM: spacing, count: qa.count, maxDevM: qa.maxDevM,
    correction: null, cells: [], deltas: new Map(),
  };
  if (qa.count > 0) {
    const fixed = correctSuspectCells(heights, nx, ny, qa.indices);
    // Report the WORST cells, not the first ones the row-major scan reached:
    // past the cap that was a band along the south edge of the raster, which
    // says nothing about where the DEM is actually broken.
    const worst = qa.indices
      .map((i) => ({ i, dev: Math.abs(heights[i] - fixed.heights[i]) }))
      .sort((a, b) => b.dev - a.dev)
      .slice(0, MAX_REPORTED_SUSPECT_CELLS);
    for (const { i } of worst) {
      const ix = i % nx;
      const iy = (i - ix) / nx;
      info.cells.push({
        latLng: localMetresToLatLng([minE + ix * spacing, minN + iy * spacing], origin),
        z: heights[i],
        median: fixed.heights[i],
      });
    }
    if (opts.qaCorrect) {
      // Correcting can expose what it was hiding: an uneven 2×2 smear flags only
      // its worst cell, and replacing that leaves the rest steep enough to flag
      // on the next look, so a single pass leaves residuals behind. Iterate to a
      // fixed point, hard-bounded. Only the CORRECTION iterates — `count`,
      // `maxDevM` and `cells` still describe the DEM as it was delivered.
      const touched = new Set<number>(qa.indices);
      let maxChangeM = fixed.maxChangeM;
      final = fixed.heights;
      for (let pass = 1; pass < QA_CORRECTION_PASSES; pass++) {
        const again = flagSuspectCells(final, nx, ny, spacing);
        if (again.count === 0) break;
        const next = correctSuspectCells(final, nx, ny, again.indices);
        if (next.changed === 0) break;
        for (const i of again.indices) touched.add(i);
        if (next.maxChangeM > maxChangeM) maxChangeM = next.maxChangeM;
        final = next.heights;
      }
      for (const i of touched) {
        const d = final[i] - heights[i];
        if (d !== 0) info.deltas.set(i, d);
      }
      info.correction = { changed: info.deltas.size, maxChangeM };
    }
  }

  const field: SceneHeightfield = {
    type: 'heightfield', origin: [minE, minN], spacing, nx, ny, heights: final,
  };
  remember({ key, value: field, info });
  return field;
}
