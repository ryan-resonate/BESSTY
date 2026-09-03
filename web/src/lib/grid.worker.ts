// Grid compute worker (S1). Keeps the contour grid off the main thread so the
// UI stays responsive. Imports ONLY the worker-safe `gridCore` + `dem` (no
// catalog/firebase). The main thread resolves the catalog into a serializable
// `GridJob`; this worker reconstructs the DEM from a region snapshot and runs
// the shared `runBatchedGrid` core.
//
// P2: several of these run in parallel, each given a SHARD of the job's tiles
// (tiles are independent by construction). Each shard returns a full-size dbA
// buffer with only its own cells written; the main thread copies each shard's
// tile rectangles into the final grid.
//
// The DEM region and the terrain heightfield are the big parts of a message, so
// each is sent once per worker and cached here under its key — a re-run over the
// same area (a settings change, a source nudge) ships only the job.

import init from '../wasm/iso9613_wasm.js';
import {
  runBatchedGrid, unpackHeightfield,
  type GridJob, type GridResult, type PackedHeightfield,
} from './gridCore';
import { regionRaster, type DemRegion, type DemRaster } from './dem';
import type { SceneHeightfield } from './sceneBuilder';

let ready: Promise<void> | null = null;
function ensureReady(): Promise<void> {
  if (!ready) ready = Promise.resolve(init()).then(() => undefined);
  return ready;
}

/// Last DEM this worker was given, kept so repeat runs over the same extent
/// don't re-send it. Keyed by the main thread's region-cache key.
let cachedDem: DemRaster | null = null;
let cachedRegionKey: string | null = null;

/// Last heightfield this worker was given, unboxed once on receipt. Up to 2048²
/// cells: identical for every shard of a job and unchanged by a re-run over the
/// same extent, so the job posted here never carries it and the main thread
/// sends it separately, keyed, exactly as it does the DEM region.
let cachedTerrain: SceneHeightfield | null = null;
let cachedTerrainKey: string | null = null;

interface GridRequest {
  id: number;
  job: GridJob;
  /// The region itself, or null to reuse whatever `regionKey` names.
  region: DemRegion | null;
  /// Identity of the region this job expects. Null means "no DEM".
  regionKey: string | null;
  /// The heightfield itself, or null to reuse whatever `terrainKey` names.
  terrain: PackedHeightfield | null;
  /// Identity of the heightfield this job expects. Null means "flat ground".
  terrainKey: string | null;
}

self.onmessage = async (ev: MessageEvent<GridRequest>) => {
  const { id, job, region, regionKey, terrain, terrainKey } = ev.data;
  try {
    await ensureReady();
    if (region) {
      cachedDem = regionRaster(region);
      cachedRegionKey = regionKey;
    } else if (regionKey === null) {
      cachedDem = null;
      cachedRegionKey = null;
    } else if (regionKey !== cachedRegionKey) {
      // The main thread believed we had this region and we don't — refuse
      // rather than silently solving against the wrong (or no) terrain.
      throw new Error('grid worker: DEM region cache miss');
    }
    if (terrain) {
      cachedTerrain = unpackHeightfield(terrain);
      cachedTerrainKey = terrainKey;
    } else if (terrainKey === null) {
      cachedTerrain = null;
      cachedTerrainKey = null;
    } else if (terrainKey !== cachedTerrainKey) {
      throw new Error('grid worker: terrain cache miss');
    }
    const dem = cachedDem;
    // I12: report per-tile progress so the UI can show something moving. Posted
    // at most every PROGRESS_MS — a 512×512 grid is ~1000 tiles, and a
    // postMessage per tile would flood the main thread we're trying to keep
    // free.
    let lastPost = 0;
    const PROGRESS_MS = 100;
    const withTerrain: GridJob = { ...job, terrain: cachedTerrain };
    const result: GridResult = runBatchedGrid(withTerrain, dem, (tilesDone, tilesTotal) => {
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
