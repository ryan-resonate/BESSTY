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
  const colNorm = grid.cols > 1 ? 1 / (grid.cols - 1) : 0;
  const rowNorm = grid.rows > 1 ? 1 / (grid.rows - 1) : 0;

  const sets: ContourLineSet[] = [];
  for (const f of features) {
    const lines: Array<Array<[number, number]>> = [];
    for (const polygon of f.coordinates) {
      for (const ring of polygon) {
        const line: Array<[number, number]> = (ring as Array<[number, number]>).map(
          ([col, row]) => [
            sw[0] + row * rowNorm * latRange,
            sw[1] + col * colNorm * lngRange,
          ],
        );
        if (line.length > 1) lines.push(line);
      }
    }
    sets.push({ threshold: f.value, lines });
  }
  return sets;
}
