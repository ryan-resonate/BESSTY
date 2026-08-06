// Iso-line generation for the contour grid using d3-contour. Each threshold
// produces a MultiPolygon (filled region) whose ring boundaries we treat as
// the iso-lines. Coordinates come back in grid (col, row) space — we project
// them to lat/lng via the grid's bounding box.

import { contours as d3contours } from 'd3-contour';
import type { GridResult } from './gridCore';

export interface ContourLineSet {
  /// dB(A) value of the threshold.
  threshold: number;
  /// One feature per line (MultiPolygon ring) at this threshold, in lat/lng.
  /// Each line is an array of `[lat, lng]` points suitable for L.polyline.
  lines: Array<Array<[number, number]>>;
}

export function buildContourLines(
  grid: GridResult,
  thresholds: number[],
): ContourLineSet[] {
  const generator = d3contours()
    .size([grid.cols, grid.rows])
    .thresholds(thresholds)
    .smooth(true);

  const arr = Array.from(grid.dbA);
  // `ContourMultiPolygon extends GeoJSON.MultiPolygon` so the geometry
  // fields live directly on each feature.
  const features = generator(arr);

  const { sw, ne } = grid.bounds;
  const latRange = ne[0] - sw[0];
  const lngRange = ne[1] - sw[1];
  // Cell-centred mapping. The grid's `bounds` enclose the calc-area
  // rectangle exactly; cell `i` is sampled at the centre of the i-th
  // sub-rectangle, i.e. at (i + 0.5) / cols of the way from sw to ne.
  //
  // d3-contour itself uses the convention that "value at array index i
  // is at output coord (i + 0.5)" — that's what its smoothing formula
  // `x + (T - v0) / (v1 - v0) − 0.5` falls out of: when T = v0 the
  // smoothed x reduces to (x − 0.5), the position of the LEFT-neighbour
  // value at index (x − 1); when T = v1 the smoothed x reduces to
  // (x + 0.5), the position of the value at index x. So a contour
  // vertex at output coord X is already at "physical position X"
  // measured in cell-widths from the SW corner of the bounds rectangle
  // — *the +0.5 is baked into d3's coords*. Mapping is therefore
  // `lng = sw + X / cols × lngRange` with NO extra +0.5; adding one
  // here pushes every contour half a cell NE relative to the
  // raster overlay (which Leaflet centres correctly on cells via
  // `imageOverlay`).
  const lngScale = grid.cols > 0 ? 1 / grid.cols : 0;
  const latScale = grid.rows > 0 ? 1 / grid.rows : 0;

  const sets: ContourLineSet[] = [];
  for (const f of features) {
    const lines: Array<Array<[number, number]>> = [];
    for (const polygon of f.coordinates) {
      for (const ring of polygon) {
        const line: Array<[number, number]> = (ring as Array<[number, number]>).map(
          ([col, row]) => [
            sw[0] + row * latScale * latRange,
            sw[1] + col * lngScale * lngRange,
          ],
        );
        if (line.length > 1) lines.push(line);
      }
    }
    sets.push({ threshold: f.value, lines });
  }
  return sets;
}

/// Per-threshold MultiPolygons in **GeoJSON [lng, lat] order**, suitable
/// for direct use as a MapLibre / Mapbox `geojson` source. Each entry
/// represents the level set `dbA >= threshold`. Bands are produced by
/// stacking features from low → high threshold and painting each in the
/// band's colour — the higher (smaller-area) polygons render on top of
/// the lower ones, producing the expected banded fill.
///
/// Used by the 3D view's grid overlay where the previous canvas / image
/// source approach kept getting clipped by MapLibre's terrain-mesh tile
/// sampler. Polygons drape natively to terrain so the overlay renders
/// cleanly across zoom levels.
export interface ContourBandPolygon {
  threshold: number;
  /// MultiPolygon coordinates: outer-ring → holes, in [lng, lat] order.
  polygon: Array<Array<Array<[number, number]>>>;
}

export function buildContourPolygons(
  grid: GridResult,
  thresholds: number[],
): ContourBandPolygon[] {
  const generator = d3contours()
    .size([grid.cols, grid.rows])
    .thresholds(thresholds)
    .smooth(true);

  const arr = Array.from(grid.dbA);
  const features = generator(arr);

  const { sw, ne } = grid.bounds;
  const latRange = ne[0] - sw[0];
  const lngRange = ne[1] - sw[1];
  const lngScale = grid.cols > 0 ? 1 / grid.cols : 0;
  const latScale = grid.rows > 0 ? 1 / grid.rows : 0;

  const out: ContourBandPolygon[] = [];
  for (const f of features) {
    // Each MultiPolygon: array of polygons, each polygon: array of rings,
    // each ring: array of [col, row] points (cell-centred coords from
    // d3-contour — see the buildContourLines comment for the +0.5
    // discussion). We project to [lng, lat] for GeoJSON consumers.
    const projected: Array<Array<Array<[number, number]>>> = f.coordinates.map(
      (poly) => poly.map(
        (ring) => (ring as Array<[number, number]>).map<[number, number]>(
          ([col, row]) => [
            sw[1] + col * lngScale * lngRange,
            sw[0] + row * latScale * latRange,
          ],
        ),
      ),
    );
    out.push({ threshold: f.value, polygon: projected });
  }
  // Lowest threshold first → renders below higher (more-attenuated)
  // bands, which sit on top.
  out.sort((a, b) => a.threshold - b.threshold);
  return out;
}

// ============== P3: tracing on a worker ==============
//
// `buildContourLines` stays exported and synchronous — the PDF and the KML /
// shapefile exporters are one-off, user-initiated, and simpler read that way.
// What moves off the main thread is the MAP's tracing, which re-runs on every
// grid update and every display-control change.

/// Identity for a grid, so the worker can cache the raster across re-traces at
/// different dB steps. A WeakMap tag rather than a field on GridResult: the
/// grid crosses a structured-clone boundary and must stay plain data.
const gridIds = new WeakMap<object, number>();
let nextGridId = 1;
function gridIdOf(grid: GridResult): number {
  let id = gridIds.get(grid as unknown as object);
  if (id === undefined) {
    id = nextGridId++;
    gridIds.set(grid as unknown as object, id);
  }
  return id;
}

let contourWorker: Worker | null = null;
let contourSeq = 0;
/// Which grid the live worker holds. Reset whenever the worker is rebuilt.
let workerGridId = -1;

function getContourWorker(): Worker {
  if (!contourWorker) {
    contourWorker = new Worker(new URL('./contour.worker.ts', import.meta.url), { type: 'module' });
    workerGridId = -1;
  }
  return contourWorker;
}

/// Trace iso-lines for `grid` at `thresholds`, on a worker when one is
/// available and inline otherwise (node tests, and any environment without
/// Workers). Rejects only on a real failure; the caller decides what a failure
/// means for the map.
export async function buildContourLinesAsync(
  grid: GridResult,
  thresholds: number[],
): Promise<ContourLineSet[]> {
  if (typeof Worker === 'undefined') return buildContourLines(grid, thresholds);
  const worker = getContourWorker();
  const gridId = gridIdOf(grid);
  // Ship the raster only when the worker doesn't already hold this grid. A
  // structured clone of a 512×512 grid is a megabyte; re-tracing at a new dB
  // step should not pay it.
  const sendGrid = workerGridId !== gridId;
  const id = ++contourSeq;
  return new Promise<ContourLineSet[]>((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    const onMessage = (ev: MessageEvent) => {
      const d = ev.data as { id: number; ok?: boolean; sets?: ContourLineSet[]; error?: string };
      if (d.id !== id) return;
      cleanup();
      if (d.ok && d.sets) resolve(d.sets);
      else reject(new Error(d.error ?? 'contour worker failed'));
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      // Drop the worker so the next call rebuilds it, and forget what it held.
      if (contourWorker === worker) { contourWorker.terminate(); contourWorker = null; }
      workerGridId = -1;
      reject(new Error(`contour worker error: ${e.message || 'load failed'}`));
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
    // Record the cache state BEFORE posting: the worker stores the grid on
    // receipt, so a later request must not think it still needs to send it.
    if (sendGrid) workerGridId = gridId;
    worker.postMessage({ id, gridId, grid: sendGrid ? grid : null, thresholds });
  });
}
