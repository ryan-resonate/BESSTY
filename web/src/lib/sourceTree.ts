// Barnes-Hut treecode for source aggregation.
//
// Replaces the flat-grid clustering in propagation.ts with an adaptive
// quadtree. Per-receiver, the tree is walked depth-first; at each node
// the "multipole acceptance criterion" decides whether to use the node's
// energy-summed centroid representation (cheap, accurate when far) or
// recurse into the children. The geometric error from treating a cluster
// as a point goes as (s/d)^2, so a θ of 0.5 keeps absolute error well
// under 1 dB even for tightly-spaced clusters.
//
// One-directional FMM: we have many sources but a small set of receivers
// (named + grid cells), so the symmetric multipole-to-local half of full
// FMM would be over-engineered. The S2M-only treecode is the natural fit.
//
// Building cost: O(N log N) once per snapshot.
// Eval cost per receiver: O(log N + k) where k is the leaf count near
// the receiver. Compared to the previous flat-cell pre-pass (O(N) per
// receiver), this is a strict improvement above ~30 sources.

import type { CatalogEntry, Project, Source } from './types';
import { lookupEntry, spectrumFor } from './catalog';
import { approxDistanceM } from './propagation';
import type { EffectiveSource } from './propagation';

interface NodeBounds {
  /// Diagonal length of the bounding box in metres. Used as the "size"
  /// in the multipole acceptance test.
  diagM: number;
  /// Bounding box corners (lat/lng).
  minLat: number; maxLat: number;
  minLng: number; maxLng: number;
}

interface TreeNode {
  bounds: NodeBounds;
  /// Energy-weighted centroid (lat, lng) — the point used as the source
  /// location when the node is accepted as a multipole.
  centroidLat: number;
  centroidLng: number;
  /// Combined Lw spectrum (energy sum across every leaf below).
  /// `null` for empty nodes (which are pruned).
  combinedLw: Float64Array;
  /// Combined source absolute Z above local ground (energy-weighted mean
  /// of leaf member z-above-ground values). Used only when the node is
  /// accepted as a multipole.
  zAboveGround: number;
  /// Number of source leaves below this node (1 for a single leaf).
  memberCount: number;
  /// Either children (internal node) or leaves (terminal node).
  children: TreeNode[] | null;
  leaves: Source[] | null;
}

/// Maximum number of sources per leaf cell. Smaller = deeper tree, more
/// granular near-field; larger = shallower tree, faster build/walk.
const LEAF_CAP = 4;

/// Build the Barnes-Hut tree once per snapshot. Returns null when there
/// are no real sources to aggregate (caller should skip propagation).
export function buildSourceTree(
  project: Project,
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
): TreeNode | null {
  const valid = project.sources.filter((s) =>
    Number.isFinite(s.latLng[0]) && Number.isFinite(s.latLng[1])
  );
  if (valid.length === 0) return null;

  // Bounding box of all sources.
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const s of valid) {
    if (s.latLng[0] < minLat) minLat = s.latLng[0];
    if (s.latLng[0] > maxLat) maxLat = s.latLng[0];
    if (s.latLng[1] < minLng) minLng = s.latLng[1];
    if (s.latLng[1] > maxLng) maxLng = s.latLng[1];
  }
  // Cache spectrum lookup per (entry+mode) so rebuilds aren't catalog-bound.
  const spectrumCache = new Map<string, Float64Array | null>();
  function lwFor(s: Source): { lw: Float64Array; zAg: number } | null {
    const entry: CatalogEntry | null = lookupEntry(project, s);
    if (!entry) return null;
    const modeName = s.modeOverride ?? entry.defaultMode;
    const cacheKey = `${s.catalogScope}|${s.modelId}|${modeName}|${windSpeed}`;
    let lw = spectrumCache.get(cacheKey);
    if (lw === undefined) {
      lw = spectrumFor(entry, modeName, windSpeed, bandSystem);
      spectrumCache.set(cacheKey, lw);
    }
    if (!lw) return null;
    const zAg = s.kind === 'wtg'
      ? (s.hubHeight ?? entry.hubHeights?.[0] ?? 100)
      : (s.elevationOffset ?? 0) + 1.5;
    return { lw, zAg };
  }

  return buildNode(valid, { minLat, maxLat, minLng, maxLng }, lwFor);
}

function buildNode(
  members: Source[],
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  lwFor: (s: Source) => { lw: Float64Array; zAg: number } | null,
): TreeNode | null {
  if (members.length === 0) return null;

  // Aggregate Lw + centroid + z. Walk every member exactly once.
  let firstLw: Float64Array | null = null;
  for (const s of members) {
    const got = lwFor(s);
    if (got) { firstLw = got.lw; break; }
  }
  if (!firstLw) return null;        // every member had a missing catalog entry
  const NB = firstLw.length;
  const sumE = new Float64Array(NB);
  let totalEnergy = 0;
  let centLat = 0, centLng = 0, zSum = 0;
  for (const s of members) {
    const got = lwFor(s);
    if (!got) continue;
    let memberE = 0;
    for (let i = 0; i < NB; i++) {
      const e = Math.pow(10, got.lw[i] / 10);
      sumE[i] += e;
      memberE += e;
    }
    totalEnergy += memberE;
    centLat += s.latLng[0] * memberE;
    centLng += s.latLng[1] * memberE;
    zSum += got.zAg * memberE;
  }
  if (totalEnergy <= 0) return null;
  const combinedLw = new Float64Array(NB);
  for (let i = 0; i < NB; i++) {
    combinedLw[i] = sumE[i] > 0 ? 10 * Math.log10(sumE[i]) : -Infinity;
  }
  const centroidLat = centLat / totalEnergy;
  const centroidLng = centLng / totalEnergy;
  const zAboveGround = zSum / totalEnergy;
  const diagM = bboxDiagM(bbox);

  // Leaf condition: small enough to stop subdividing.
  if (members.length <= LEAF_CAP) {
    return {
      bounds: { ...bbox, diagM },
      centroidLat, centroidLng, combinedLw, zAboveGround,
      memberCount: members.length,
      children: null,
      leaves: members,
    };
  }

  // Quadrant split. Use the bbox midpoint (not the centroid) so the
  // split stays geometrically regular — keeps the s/d acceptance test
  // well-behaved.
  const midLat = (bbox.minLat + bbox.maxLat) / 2;
  const midLng = (bbox.minLng + bbox.maxLng) / 2;
  const buckets: Source[][] = [[], [], [], []];
  for (const s of members) {
    const ix = (s.latLng[0] >= midLat ? 2 : 0) + (s.latLng[1] >= midLng ? 1 : 0);
    buckets[ix].push(s);
  }
  // If every member fell in the same bucket (degenerate, e.g. two coincident
  // sources), return as a leaf to avoid infinite recursion.
  const nonEmptyBuckets = buckets.filter((b) => b.length > 0);
  if (nonEmptyBuckets.length === 1) {
    return {
      bounds: { ...bbox, diagM },
      centroidLat, centroidLng, combinedLw, zAboveGround,
      memberCount: members.length,
      children: null,
      leaves: members,
    };
  }
  const children: TreeNode[] = [];
  for (let q = 0; q < 4; q++) {
    if (buckets[q].length === 0) continue;
    const sub = quadrantBbox(bbox, q);
    const child = buildNode(buckets[q], sub, lwFor);
    if (child) children.push(child);
  }
  return {
    bounds: { ...bbox, diagM },
    centroidLat, centroidLng, combinedLw, zAboveGround,
    memberCount: members.length,
    children,
    leaves: null,
  };
}

function bboxDiagM(b: { minLat: number; maxLat: number; minLng: number; maxLng: number }): number {
  const R = 6371008.8;
  const dLatM = (b.maxLat - b.minLat) * (Math.PI / 180) * R;
  const lat0 = ((b.minLat + b.maxLat) / 2) * (Math.PI / 180);
  const dLngM = (b.maxLng - b.minLng) * (Math.PI / 180) * R * Math.cos(lat0);
  return Math.sqrt(dLatM * dLatM + dLngM * dLngM);
}

function quadrantBbox(
  b: { minLat: number; maxLat: number; minLng: number; maxLng: number },
  q: number,
): { minLat: number; maxLat: number; minLng: number; maxLng: number } {
  const midLat = (b.minLat + b.maxLat) / 2;
  const midLng = (b.minLng + b.maxLng) / 2;
  // q bits: bit 1 = upper-half lat (north); bit 0 = upper-half lng (east).
  return {
    minLat: q & 2 ? midLat : b.minLat,
    maxLat: q & 2 ? b.maxLat : midLat,
    minLng: q & 1 ? midLng : b.minLng,
    maxLng: q & 1 ? b.maxLng : midLng,
  };
}

/// Walk the tree for one receiver. Returns the EffectiveSource list to
/// hand to the existing per-pair snapshot pipeline.
///
///   - `theta`  : Barnes-Hut acceptance parameter. Lower = more accurate
///                but visits more nodes. Default 0.5 keeps geometric
///                error under ~25% relative (≈ 1 dB total).
///   - `cutoffM`: hard cut — nodes whose centroid is further than this
///                from the receiver contribute nothing. 0 disables.
export function walkSourceTree(
  root: TreeNode,
  receiverLatLng: [number, number],
  theta: number,
  cutoffM: number,
): EffectiveSource[] {
  const out: EffectiveSource[] = [];
  let clusterId = 0;
  function visit(node: TreeNode) {
    const d = approxDistanceM(receiverLatLng, [node.centroidLat, node.centroidLng]);
    if (cutoffM > 0 && d - node.bounds.diagM / 2 > cutoffM) {
      // Even the nearest face of this node's bbox is past the cutoff.
      return;
    }
    // Acceptance: node looks small from here.
    const accept = (theta > 0)
      ? (node.bounds.diagM / Math.max(d, 1) < theta)
      : (node.leaves != null);     // theta==0 → always recurse to leaves
    if (accept) {
      if (node.leaves && node.leaves.length === 1) {
        // Single-leaf node: pass the real source through with full gradient
        // tracking (no clustering, no AD loss).
        const s = node.leaves[0];
        out.push({
          id: s.id, kind: 'real', source: s, latLng: s.latLng, memberCount: 1,
        });
      } else {
        out.push({
          id: `cluster-${clusterId++}`,
          kind: 'cluster',
          latLng: [node.centroidLat, node.centroidLng],
          lwOverride: node.combinedLw,
          zAboveGround: node.zAboveGround,
          memberCount: node.memberCount,
        });
      }
      return;
    }
    // Recurse — internal node walks its children, leaf node enumerates.
    if (node.children) {
      for (const c of node.children) visit(c);
    } else if (node.leaves) {
      for (const s of node.leaves) {
        if (cutoffM > 0 && approxDistanceM(receiverLatLng, s.latLng) > cutoffM) continue;
        out.push({
          id: s.id, kind: 'real', source: s, latLng: s.latLng, memberCount: 1,
        });
      }
    }
  }
  visit(root);
  return out;
}
