// Grid compute worker (S1). Keeps the contour grid off the main thread so the
// UI stays responsive. Imports ONLY the worker-safe `gridCore` + `dem` (no
// catalog/firebase). The main thread resolves the catalog into a serializable
// `GridJob`; this worker reconstructs the DEM from a region snapshot and runs
// the shared `runBatchedGrid` core.

import init from '../wasm/iso9613_wasm.js';
import { runBatchedGrid, type GridJob, type GridResult } from './gridCore';
import { regionRaster, type DemRegion } from './dem';

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = Promise.resolve(init()).then(() => undefined);
  return ready;
}

interface GridRequest {
  id: number;
  job: GridJob;
  region: DemRegion | null;
}

self.onmessage = async (ev: MessageEvent<GridRequest>) => {
  const { id, job, region } = ev.data;
  try {
    await ensureReady();
    const dem = region ? regionRaster(region) : null;
    // I12: report per-tile progress so the UI can show something moving. Posted
    // at most every PROGRESS_MS — a 512×512 grid is ~1000 tiles, and a
    // postMessage per tile would flood the main thread we're trying to keep
    // free.
    let lastPost = 0;
    const PROGRESS_MS = 100;
    const result: GridResult = runBatchedGrid(job, dem, (tilesDone, tilesTotal) => {
      const now = performance.now();
      if (tilesDone < tilesTotal && now - lastPost < PROGRESS_MS) return;
      lastPost = now;
      (self as unknown as Worker).postMessage({ id, progress: { tilesDone, tilesTotal } });
    });
    // Transfer the dB(A) buffer back to avoid a copy.
    (self as unknown as Worker).postMessage(
      { id, ok: true, result },
      [result.dbA.buffer],
    );
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(e) });
  }
};
