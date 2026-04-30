// Iso-line generation for the contour grid using d3-contour. Each threshold
// produces a MultiPolygon (filled region) whose ring boundaries we treat as
// the iso-lines. Coordinates come back in grid (col, row) space — we project
// them to lat/lng via the grid's bounding box.

import { contours as d3contours } from 'd3-contour';
import type { GridResult } from './solver';

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
