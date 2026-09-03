// Automatic elevation sources, tried in cascade order.
//
// One project, one DEM, no setting. The cascade prefers the best data that
// actually covers the site and falls back until something loads, because a
// terrain source is not a preference — it is the difference between a ridge
// that screens and one that does not, and the user has no way to judge which
// dataset is better for their site.
//
// A user-uploaded GeoTIFF is NOT in this list: it wins outright, and the
// caller (`ProjectScreen`) never reaches the cascade while one is loaded.

import { loadDemForBounds, type DemRaster } from '../dem';
import { GA_DEM_S } from './gaDemS';

export interface DemBounds {
  sw: [number, number];
  ne: [number, number];
}

export interface DemSource {
  id: string;
  label: string;
  /// Cheap, network-light test: does this dataset have data over `bounds`?
  covers(bounds: DemBounds): Promise<boolean>;
  load(bounds: DemBounds): Promise<DemRaster>;
}

/// AWS Terrain Tiles — global, always available, and the reason the cascade can
/// never come up empty. Kept last: it is raw SRTM inland in Australia, so any
/// source above it is better where it reaches.
const TERRARIUM: DemSource = {
  id: 'terrarium',
  label: 'AWS Terrain Tiles',
  covers: async () => true,
  load: ({ sw, ne }) => loadDemForBounds(sw, ne),
};

/// Best first. Phase 3 inserts `qldLidar` ahead of `GA_DEM_S`; nothing else
/// about the cascade changes when it does.
export const AUTO_DEM_SOURCES: DemSource[] = [GA_DEM_S, TERRARIUM];

/// First source that covers `bounds` and loads. A source that reports no
/// coverage, or throws, is skipped with a warning — a dataset being down must
/// degrade the terrain, never the solve.
export async function loadAutoDem(
  bounds: DemBounds,
  sources: readonly DemSource[] = AUTO_DEM_SOURCES,
): Promise<DemRaster> {
  for (const source of sources) {
    try {
      if (!(await source.covers(bounds))) continue;
      return await source.load(bounds);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[BESSTY] DEM source "${source.id}" unavailable, trying the next:`, err);
    }
  }
  throw new Error('No DEM source could supply elevations for this area.');
}
