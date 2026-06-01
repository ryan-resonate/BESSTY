// Per-receiver source preprocessing applied before each WASM call:
//
//   1. **Distance cutoff** — sources further than
//      `settings.propagation.maxContributionDistanceM` from the receiver
//      contribute negligibly (Adiv >> Lw), so we skip them entirely.
//
//   2. **Barnes-Hut tree clustering** — adaptive spatial aggregation via
//      `lib/sourceTree.ts`. A quadtree of all real sources is built once
//      per snapshot; each receiver walks it depth-first and collapses any
//      subtree where the bounding-box diagonal `s` and centroid-distance
//      `d` satisfy `s/d < θ`. Far clusters fold into a single virtual
//      source at their energy-weighted centroid; near sources remain
//      individual (full ISO 9613 evaluation + AD gradients for drag).
//      One Barnes-Hut tree replaces the previous coupled
//      `clusterBeyondM` + cell-grid heuristic with a single physically-
//      meaningful tolerance knob (`treeAcceptanceTheta`).
//
//   3. **Topography virtual barriers** — for each source→receiver pair,
//      sample the DEM at N evenly-spaced points and check whether any
//      sample pokes above the straight-line path by more than
//      `settings.topography.virtualBarrierMinHeightM`. Those samples are
//      converted into ad-hoc thin barriers that get appended to the
//      project's user-defined barriers in the WASM call. This is how
//      ridges / ranges / hills enter the ISO 9613-2 General method —
//      the engine itself stays terrain-agnostic.
//
// All three are project-wide settings, opt-out via the SettingsModal.

import type { Project, Source, Receiver } from './types';
import { buildSourceTree, walkSourceTree } from './sourceTree';

// Geo helpers + the topography sampler now live in the worker-safe `gridCore`
// (so the grid worker doesn't pull this module's catalog/firebase deps). Keep
// re-exporting `approxDistanceM` here for existing importers (e.g. sourceTree).
export { approxDistanceM, topographyBarriers, type TopoSettings } from './gridCore';

/// Lightweight "source-shaped" thing handed to the snapshot loop. Includes
/// real Sources (kept verbatim) and synthetic cluster aggregates.
export interface EffectiveSource {
  /// Stable id used to key snapshot pairs. For real sources this is the
  /// source.id; for clusters it's `cluster-<receiverId>-<n>`.
  id: string;
  /// 'real' = pass-through to existing snapshot path (catalog entry +
  /// gradient tracking). 'cluster' = synthetic; the precomputed lw spectrum
  /// is fed directly as a generic point source (no AD gradients — clusters
  /// are treated as immobile aggregates, refreshed on the next snapshot).
  kind: 'real' | 'cluster';
  /// Underlying source when kind === 'real'.
  source?: Source;
  /// Centroid lat/lng for clusters; for real, equals source.latLng.
  latLng: [number, number];
  /// Pre-summed Lw spectrum (cluster only). Real sources resolve via catalog.
  lwOverride?: Float64Array;
  /// Source-Z above ground (cluster only). Mean of contributing source Zs.
  zAboveGround?: number;
  /// Number of underlying real sources folded into this entry. Used for
  /// reporting / debugging. Always 1 for real, ≥1 for clusters.
  memberCount: number;
}

export interface PropagationSettings {
  maxContributionDistanceM: number;
  /// Barnes-Hut tree acceptance parameter (s/d ratio threshold). Lower =
  /// more accurate (recurses deeper), higher = faster but coarser. 0.5 is
  /// the common default — keeps geometric error well under 1 dB.
  treeAcceptanceTheta: number;
  /// Legacy fields, retained on disk for back-compat with v0.x projects.
  /// Not consulted by the current code path.
  clusterBeyondM?: number;
  maxClustersPerReceiver?: number;
}

const DEFAULT_PROP: PropagationSettings = {
  maxContributionDistanceM: 20000,
  treeAcceptanceTheta: 0.25,
};

export function propagationSettings(project: Project): PropagationSettings {
  return project.settings?.propagation ?? DEFAULT_PROP;
}

/// Per-receiver effective-source list, computed by walking a Barnes-Hut
/// tree once per receiver. For batched callers (snapshot loops) prefer
/// `buildEffectiveSourcesContext` + `effectiveSourcesForReceiver` so the
/// tree gets built once instead of per-receiver.
export function effectiveSourcesFor(
  project: Project,
  receiver: Receiver,
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
): EffectiveSource[] {
  const ctx = buildEffectiveSourcesContext(project, bandSystem, windSpeed);
  return effectiveSourcesForReceiver(ctx, receiver.latLng);
}

/// Cached per-snapshot tree. `tree` is null when the project has no usable
/// sources — callers should treat that as an empty effective list.
export interface PropagationContext {
  tree: ReturnType<typeof buildSourceTree>;
  cutoffM: number;
  theta: number;
}

export function buildEffectiveSourcesContext(
  project: Project,
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
): PropagationContext {
  const cfg = propagationSettings(project);
  return {
    tree: buildSourceTree(project, bandSystem, windSpeed),
    cutoffM: cfg.maxContributionDistanceM,
    theta: cfg.treeAcceptanceTheta,
  };
}

export function effectiveSourcesForReceiver(
  ctx: PropagationContext,
  receiverLatLng: [number, number],
): EffectiveSource[] {
  if (!ctx.tree) return [];
  return walkSourceTree(ctx.tree, receiverLatLng, ctx.theta, ctx.cutoffM);
}

// =================== Barrier pack helpers ===================
// `topographyBarriers` moved to `./gridCore` (worker-safe) and is re-exported
// from the top of this file for backward-compatible imports.

/// Concatenate two barrier-pack arrays into one. Both must already be in
/// `packBarriers` format (5 numbers per barrier).
export function concatBarriers(a: Float64Array, b: Float64Array): Float64Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Float64Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
