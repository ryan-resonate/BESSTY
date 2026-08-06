// P3 — contour extraction off the main thread.
//
// Tracing iso-lines over a grid is pure geometry, but it is not cheap: a large
// raster at a fine dB step produces tens of thousands of vertices, and it ran
// on the main thread every time a grid finished OR any display control moved
// (contour step, palette domain). That is the hitch felt when a background
// regrid completes mid-gesture.
//
// The worker CACHES the grid it was last given, keyed by an id the main thread
// assigns. Re-tracing at a different dB step — the common case, since display
// controls change far more often than the grid — then costs one small message
// instead of shipping the whole raster again.

import { buildContourLines, type ContourLineSet } from './contourLines';
import type { GridResult } from './gridCore';

interface ContourRequest {
  id: number;
  /// Identity of the grid this request refers to.
  gridId: number;
  /// The grid itself, or null to reuse the cached one under `gridId`.
  grid: GridResult | null;
  thresholds: number[];
}

let cachedGrid: GridResult | null = null;
let cachedGridId = -1;

self.onmessage = (ev: MessageEvent<ContourRequest>) => {
  const { id, gridId, grid, thresholds } = ev.data;
  try {
    if (grid) {
      cachedGrid = grid;
      cachedGridId = gridId;
    } else if (gridId !== cachedGridId) {
      // The main thread believed we held this grid and we don't. Say so rather
      // than tracing a stale raster — wrong contours look exactly like right
      // ones.
      throw new Error('contour worker: grid cache miss');
    }
    if (!cachedGrid) throw new Error('contour worker: no grid');
    const sets: ContourLineSet[] = buildContourLines(cachedGrid, thresholds);
    (self as unknown as Worker).postMessage({ id, ok: true, sets });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(e) });
  }
};
