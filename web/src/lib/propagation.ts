// Per-receiver source preprocessing applied before each WASM call:
//
//   1. **Distance cutoff** — sources further than
//      `settings.propagation.maxContributionDistanceM` from the receiver
//      contribute negligibly (Adiv >> Lw), so we skip them entirely.
//
//   2. **Clustering** — sources further than
//      `settings.propagation.clusterBeyondM` get gridded into spatial
//      cells of that size and folded into a single "virtual" point source
//      per cell. The virtual source sits at the cell centroid with an
//      energy-summed Lw spectrum. Near-field sources stay individual so
//      their directivity / barrier interactions are preserved.
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

import type { Project, Source, Receiver, CatalogEntry } from './types';
import type { DemRaster } from './dem';
import { latLngToLocalMetres } from './solver';
import { lookupEntry, spectrumFor } from './catalog';

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
  clusterBeyondM: number;
  maxClustersPerReceiver: number;
}

const DEFAULT_PROP: PropagationSettings = {
  maxContributionDistanceM: 20000,
  clusterBeyondM: 1500,
  maxClustersPerReceiver: 32,
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

/// Build the per-receiver effective source list:
///   - drop sources further than `maxContributionDistanceM`
///   - keep nearby sources individual
///   - cluster distant sources into spatial cells of `clusterBeyondM`
export function effectiveSourcesFor(
  project: Project,
  receiver: Receiver,
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
): EffectiveSource[] {
  const cfg = propagationSettings(project);
  const cutoff = cfg.maxContributionDistanceM;
  const clusterBeyond = cfg.clusterBeyondM;

  const near: EffectiveSource[] = [];
  // Bucket key → list of sources falling in that cell.
  const farBuckets = new Map<string, Source[]>();

  for (const s of project.sources) {
    if (!Number.isFinite(s.latLng[0]) || !Number.isFinite(s.latLng[1])) continue;
    const d = approxDistanceM(receiver.latLng, s.latLng);
    if (cutoff > 0 && d > cutoff) continue;     // out of range entirely
    if (clusterBeyond <= 0 || d <= clusterBeyond) {
      near.push({ id: s.id, kind: 'real', source: s, latLng: s.latLng, memberCount: 1 });
      continue;
    }
    // Far source — bucket by spatial cell. Cell size = clusterBeyondM in
    // metres, converted into a quantised lat/lng key. Using a coarse-grid
    // hash means two sources in the same cell always cluster together,
    // regardless of which receiver we're looking at — that lets us reuse
    // the bucket result if we wanted to (we don't currently, but it keeps
    // the math local-frame-independent).
    const cellLatDeg = (clusterBeyond / 6371008.8) * (180 / Math.PI);
    const cellLngDeg = cellLatDeg / Math.max(0.05, Math.cos((s.latLng[0] * Math.PI) / 180));
    const key = `${Math.floor(s.latLng[0] / cellLatDeg)}:${Math.floor(s.latLng[1] / cellLngDeg)}`;
    const list = farBuckets.get(key) ?? [];
    list.push(s);
    farBuckets.set(key, list);
  }

  // Materialise clusters. Centroid is the energy-weighted mean lat/lng so
  // the cluster sits "where the noise is", not the geometric centre.
  const clusters: EffectiveSource[] = [];
  for (const [, members] of farBuckets) {
    const c = buildCluster(project, members, bandSystem, windSpeed, clusters.length);
    if (c) clusters.push(c);
  }
  // If there are more clusters than the cap, keep the loudest N. Skipped
  // clusters add a single combined "rest" cluster to avoid losing energy.
  let kept = clusters;
  if (cfg.maxClustersPerReceiver > 0 && clusters.length > cfg.maxClustersPerReceiver) {
    clusters.sort((a, b) => totalLw(b.lwOverride!) - totalLw(a.lwOverride!));
    const top = clusters.slice(0, cfg.maxClustersPerReceiver - 1);
    const rest = clusters.slice(cfg.maxClustersPerReceiver - 1);
    const restMerged = mergeClusters(rest, kept.length);
    kept = restMerged ? [...top, restMerged] : top;
  }
  return [...near, ...kept];
}

function totalLw(lw: Float64Array): number {
  let s = 0;
  for (let i = 0; i < lw.length; i++) s += Math.pow(10, lw[i] / 10);
  return s > 0 ? 10 * Math.log10(s) : -Infinity;
}

function buildCluster(
  project: Project,
  members: Source[],
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
  index: number,
): EffectiveSource | null {
  if (members.length === 0) return null;
  const NB = bandSystem === 'octave' ? 10 : 31;
  const sumLw = new Float64Array(NB);
  let totalEnergy = 0;
  let centLat = 0, centLng = 0;
  let zSum = 0, zCount = 0;
  for (const s of members) {
    const entry: CatalogEntry | null = lookupEntry(project, s);
    if (!entry) continue;
    const modeName = s.modeOverride ?? entry.defaultMode;
    const lw = spectrumFor(entry, modeName, windSpeed, bandSystem);
    let memberEnergy = 0;
    for (let i = 0; i < NB; i++) {
      const e = Math.pow(10, lw[i] / 10);
      sumLw[i] += e;
      memberEnergy += e;
    }
    totalEnergy += memberEnergy;
    centLat += s.latLng[0] * memberEnergy;
    centLng += s.latLng[1] * memberEnergy;
    if (s.kind === 'wtg') {
      zSum += s.hubHeight ?? entry.hubHeights?.[0] ?? 100;
    } else {
      zSum += (s.elevationOffset ?? 0) + 1.5;
    }
    zCount += 1;
  }
  if (totalEnergy <= 0 || zCount === 0) return null;
  // Convert summed energy back to Lp dB.
  for (let i = 0; i < NB; i++) {
    sumLw[i] = sumLw[i] > 0 ? 10 * Math.log10(sumLw[i]) : -Infinity;
  }
  return {
    id: `cluster-${index}`,
    kind: 'cluster',
    latLng: [centLat / totalEnergy, centLng / totalEnergy],
    lwOverride: sumLw,
    zAboveGround: zSum / zCount,
    memberCount: members.length,
  };
}

function mergeClusters(rest: EffectiveSource[], indexBase: number): EffectiveSource | null {
  if (rest.length === 0) return null;
  const NB = rest[0].lwOverride!.length;
  const sum = new Float64Array(NB);
  let totalEnergy = 0;
  let centLat = 0, centLng = 0;
  let zSum = 0;
  let memberCount = 0;
  for (const c of rest) {
    let energy = 0;
    for (let i = 0; i < NB; i++) {
      const e = Math.pow(10, c.lwOverride![i] / 10);
      sum[i] += e;
      energy += e;
    }
    totalEnergy += energy;
    centLat += c.latLng[0] * energy;
    centLng += c.latLng[1] * energy;
    zSum += (c.zAboveGround ?? 1.5) * energy;
    memberCount += c.memberCount;
  }
  if (totalEnergy <= 0) return null;
  for (let i = 0; i < NB; i++) {
    sum[i] = sum[i] > 0 ? 10 * Math.log10(sum[i]) : -Infinity;
  }
  return {
    id: `cluster-${indexBase}-rest`,
    kind: 'cluster',
    latLng: [centLat / totalEnergy, centLng / totalEnergy],
    lwOverride: sum,
    zAboveGround: zSum / totalEnergy,
    memberCount,
  };
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
