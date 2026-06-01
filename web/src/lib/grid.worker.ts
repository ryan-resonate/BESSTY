// Grid compute worker (S1). Keeps the contour grid off the main thread so the
// UI stays responsive. Imports ONLY the worker-safe `gridCore` + `dem` (no
// catalog/firebase). The main thread resolves the catalog into a serializable
// `GridJob`; this worker reconstructs the DEM from a region snapshot and runs
// the shared `runBatchedGrid` core.

import init from '../wasm/beesty_solver.js';
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
    const result: GridResult = runBatchedGrid(job, dem);
    // Transfer the dB(A) buffer back to avoid a copy.
    (self as unknown as Worker).postMessage(
      { id, ok: true, result },
      [result.dbA.buffer],
    );
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, ok: false, error: String(e) });
  }
};
