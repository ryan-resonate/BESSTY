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
import type { DemRaster } from './dem';
import { latLngToLocalMetres } from './solver';
import { buildSourceTree, walkSourceTree } from './sourceTree';

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
  treeAcceptanceTheta: 0.5,
};

export function propagationSettings(project: Project): PropagationSettings {
  return project.settings?.propagation ?? DEFAULT_PROP;
}

/// Compute the great-circle distance between two lat/lng points in metres.
/// Uses the equirectangular approximation — good to ~0.1% inside ~50 km
/// which is plenty for cutoff / cluster decisions.
export function approxDistanceM(a: [number, number], b: [number, number]): number {
  const R = 6371008.8;
  const lat0 = (a[0] * Math.PI) / 180;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const e = R * dLng * Math.cos(lat0);
  const n = R * dLat;
  return Math.sqrt(e * e + n * n);
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

// =================== Topography virtual barriers ===================

/// Sample the DEM along the (source → receiver) line at N intermediate
/// points; for each sample where the ground pokes above the straight-line
/// (sourceZ → rxZ) path by more than `minHeightM`, emit a thin virtual
/// barrier at the sample's local-frame XY with its top at the ground
/// elevation. The solver applies normal Abar to it via the General method.
///
/// Returns a Float64Array packed in the same layout as `packBarriers` —
/// (ax, ay, bx, by, topZ) per barrier — so callers can concatenate with
/// the user-defined barrier pack and pass through to WASM unchanged.
export function topographyBarriers(
  project: Project,
  source: Source,
  sourceXyz: [number, number, number],
  receiverLatLng: [number, number],
  receiverXyz: [number, number, number],
  origin: [number, number],
  dem: DemRaster | null,
): Float64Array {
  if (!dem) return new Float64Array(0);
  const cfg = project.settings?.topography;
  const samples = cfg?.pathSamples ?? 12;
  const minH = cfg?.virtualBarrierMinHeightM ?? 2;
  if (samples <= 0) return new Float64Array(0);

  const out: number[] = [];
  // Offset the barrier endpoints a little perpendicular to the path so the
  // solver sees a finite-length segment (matching the existing barrier
  // pack format which expects A and B endpoints).
  const dxPath = receiverXyz[0] - sourceXyz[0];
  const dyPath = receiverXyz[1] - sourceXyz[1];
  const pathLen = Math.sqrt(dxPath * dxPath + dyPath * dyPath);
  if (pathLen < 1) return new Float64Array(0);
  // Perpendicular unit vector × small extent (50 m wing each side).
  const perpX = -dyPath / pathLen;
  const perpY = dxPath / pathLen;
  const wing = 50;

  const srcLat = source.latLng[0];
  const srcLng = source.latLng[1];
  const rxLat = receiverLatLng[0];
  const rxLng = receiverLatLng[1];

  for (let k = 1; k < samples; k++) {
    const t = k / samples;
    const lat = srcLat + (rxLat - srcLat) * t;
    const lng = srcLng + (rxLng - srcLng) * t;
    const groundZ = dem.elevation(lat, lng);
    if (!Number.isFinite(groundZ)) continue;
    const lineZ = sourceXyz[2] + (receiverXyz[2] - sourceXyz[2]) * t;
    const protrusion = groundZ - lineZ;
    if (protrusion < minH) continue;

    const [e, n] = latLngToLocalMetres([lat, lng], origin);
    const ax = e + perpX * wing;
    const ay = n + perpY * wing;
    const bx = e - perpX * wing;
    const by = n - perpY * wing;
    out.push(ax, ay, bx, by, groundZ);
  }
  return new Float64Array(out);
}

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
