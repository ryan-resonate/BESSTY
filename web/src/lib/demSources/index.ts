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
//
// One source is worth having but far too slow to wait for. It is marked
// `deferred`: the cascade resolves on the best FAST source, and the deferred
// one loads afterwards in the background and replaces it (`loadAutoDem`'s
// `onUpgrade`). A project is therefore usable in a second or two everywhere,
// and steps up to LiDAR where there is LiDAR.

import { loadDemForBounds, type DemRaster } from '../dem';
import { GA_DEM_S } from './gaDemS';
import { QLD_LIDAR } from './qldLidar';

export interface DemBounds {
  sw: [number, number];
  ne: [number, number];
}

export interface DemSource {
  id: string;
  label: string;
  /// Never make the first raster wait for this one. A deferred source is loaded
  /// only after the project is already standing on a DEM, and only for a caller
  /// that can swap the raster under a live project (`onUpgrade`).
  deferred?: boolean;
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

/// QLD LiDAR is the best terrain BESSTY can reach and by far the slowest to
/// get: nine `identify` probes, then a 2048² export the service fails often
/// enough to need up to three attempts — one measured Brisbane load took 52 s
/// (`validation/dem-source-memo.md` §1), during which a Queensland project had
/// no terrain at all and nothing on screen said why. So it is deferred rather
/// than dropped: DEM-S puts real ground under the project immediately, and the
/// LiDAR replaces it when it arrives.
const QLD_LIDAR_UPGRADE: DemSource = { ...QLD_LIDAR, deferred: true };

/// Best first: metre-scale LiDAR where the Queensland service has it, the
/// national 30 m bare-earth DEM everywhere else in Australia, tiles elsewhere.
/// The order is still the quality order — the QLD entry is simply reached
/// through the upgrade pass rather than by making the user wait for it.
export const AUTO_DEM_SOURCES: DemSource[] = [QLD_LIDAR_UPGRADE, GA_DEM_S, TERRARIUM];

export interface AutoDemOptions {
  /// Cascade to try. Defaults to [`AUTO_DEM_SOURCES`].
  sources?: readonly DemSource[];
  /// Receives a deferred source's raster after this call's promise has already
  /// resolved with the fast one. Supplying it is what enables the deferred pass
  /// at all: a caller that cannot swap the DEM under itself (a validation
  /// script, a probe tool) never pays for those sources.
  onUpgrade?: (raster: DemRaster) => void;
  /// Called once when the deferred pass is over, whether or not it upgraded
  /// anything, so a UI that says it is checking can stop saying so.
  onUpgradeSettled?: () => void;
  /// Is the deferred pass still worth running? Checked before it starts and
  /// before every step of it, so a load the caller has already superseded — an
  /// upload, a re-fetch for moved bounds, a project switch — stops rather than
  /// spending nine probes and a 16 MB export on a raster it would then throw
  /// away. Absent ⇒ always wanted.
  stillWanted?: () => boolean;
}

/// First NON-DEFERRED source that covers `bounds` and loads. A source that
/// reports no coverage, or throws, is skipped with a warning — a dataset being
/// down must degrade the terrain, never the solve.
///
/// With `onUpgrade`, the deferred sources are then tried in order, in the
/// background: the returned promise never waits for them, and a failure there
/// costs nothing but a warning, because the caller already has a DEM.
export async function loadAutoDem(
  bounds: DemBounds,
  opts: AutoDemOptions = {},
): Promise<DemRaster> {
  const sources = opts.sources ?? AUTO_DEM_SOURCES;
  for (const source of sources) {
    if (source.deferred) continue;
    try {
      if (!(await source.covers(bounds))) continue;
      const raster = await source.load(bounds);
      startUpgrade(bounds, sources, opts);
      return raster;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[BESSTY] DEM source "${source.id}" unavailable, trying the next:`, err);
    }
  }
  throw new Error('No DEM source could supply elevations for this area.');
}

/// Kick off the deferred pass, on a macrotask so the caller has committed the
/// fast raster — and the browser has had a beat to draw it — before nine
/// `identify` probes and a 16 MB export go out.
function startUpgrade(
  bounds: DemBounds,
  sources: readonly DemSource[],
  opts: AutoDemOptions,
): void {
  const { onUpgrade, onUpgradeSettled } = opts;
  if (!onUpgrade) return;
  const deferred = sources.filter((s) => s.deferred);
  setTimeout(() => {
    // Superseded during the macrotask gap: nothing to do, but the caller is
    // still told the pass is over so its "checking…" chip can stop.
    const pass = opts.stillWanted?.() === false
      ? Promise.resolve()
      : runUpgrade(bounds, deferred, opts, onUpgrade);
    void pass.finally(() => onUpgradeSettled?.());
  }, 0);
}

/// First deferred source that covers and loads wins; anything else is a warning
/// and nothing more. The project keeps the DEM it already has.
///
/// `stillWanted` is re-checked between every await: each step is seconds long,
/// so the answer really can change under it, and past that point the work is
/// pure cost.
async function runUpgrade(
  bounds: DemBounds,
  deferred: readonly DemSource[],
  opts: AutoDemOptions,
  onUpgrade: (raster: DemRaster) => void,
): Promise<void> {
  const wanted = () => opts.stillWanted?.() ?? true;
  for (const source of deferred) {
    if (!wanted()) return;
    try {
      if (!(await source.covers(bounds))) continue;
      if (!wanted()) return;
      const raster = await source.load(bounds);
      if (!wanted()) return;
      onUpgrade(raster);
      return;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[BESSTY] DEM upgrade source "${source.id}" unavailable, keeping the loaded DEM:`,
        err,
      );
    }
  }
}

/// Is an upgrade that has just landed still wanted?
///
/// Only if the load that asked for it is still the newest one. Every other DEM
/// path bumps the same generation counter, so an upload, a re-fetch for moved
/// bounds and a project switch all mean the raster on screen is no longer the
/// one this upgrade was meant to replace — and applying it would silently put
/// the project back on terrain the user has moved off.
export function upgradeStillWanted(genAtRequest: number, currentGen: number): boolean {
  return genAtRequest === currentGen;
}
