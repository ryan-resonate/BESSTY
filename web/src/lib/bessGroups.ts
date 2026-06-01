// BESS group materialiser — turns a parametric `BessGroup` recipe into
// the flat list of `Source` objects the solver / map already understand.
//
// Design summary (see also docs/mockups/bess-group.html):
//   - A group has an ordered list of `BessRow` templates.
//   - Each template can stamp `rowRepeat` identical copies, stacked
//     top-to-bottom with `gapToNextRowM` between every adjacent pair
//     (and between the template's final copy and the next template).
//   - Each row contains an explicit unit pattern that repeats
//     `patternRepeat` times within the row, with `spacingWithinM`
//     edge-to-edge between every adjacent unit (including between
//     pattern copies).
//   - Per-unit "slots" are addressed by a stable string key:
//       `r<rowIdx>-c<rowCopyIdx>-p<patternCopyIdx>-u<unitIdxInPattern>`
//     The materialised `Source.slotKey` stores this; the group's
//     `unitOverrides` map is keyed by it. Slots survive a parameter
//     change provided their (rowIdx, rowCopyIdx, patternCopyIdx,
//     unitIdxInPattern) indices still resolve.
//   - Footprints come from `footprintFor(catalogEntry)` in catalog.ts,
//     which falls back to per-kind defaults when the entry doesn't
//     pin its own footprintM.
//
// Coordinate model:
//   1. Walk the rows in the group's LOCAL frame, with `x` increasing
//      eastward and `y` increasing southward (standard screen-style
//      top-down). Units are metres.
//   2. After all units are placed, compute the bounding box and shift
//      everything so the bounding-box centre is at (0, 0). This means
//      `centerLatLng` always corresponds to the geometric centre of
//      the materialised array, no matter what rows are added or
//      removed.
//   3. Rotate by `rotationDeg` (clockwise from north → screen-
//      clockwise about origin).
//   4. Project to lat/lng around `centerLatLng` using an equirectangular
//      approximation. At the scale of a BESS site (<< 1 km) the
//      distortion is negligible.

import { footprintFor } from './catalog';
import type {
  BessGroup,
  BessRow,
  BessSegment,
  CatalogEntry,
  CatalogScope,
  Source,
  SourceKind,
} from './types';

/// Catalog accessor — supplied by the caller so this module doesn't
/// have to know how the global / personal / local caches are wired.
/// Returns `null` for missing references; the materialiser falls back
/// to per-kind footprint defaults but still emits the unit (the source
/// will render with the warning the rest of the app already uses for
/// missing entries).
export type CatalogLookup = (scope: CatalogScope, modelId: string) => CatalogEntry | null;

/// Result of materialising one group: the flat source list (already
/// tagged with `groupId` + `slotKey`), plus diagnostics for the UI.
export interface MaterialisedGroup {
  sources: Source[];
  /// Bounding-box dimensions of the materialised array (m, unrotated).
  /// Surfaced in the wizard's summary tile.
  bboxWidthM: number;
  bboxLengthM: number;
  /// Per-kind unit counts. Convenience for the summary.
  counts: Record<SourceKind, number>;
  /// Override keys that were in `group.unitOverrides` but no longer
  /// correspond to any slot after the parameter change. The UI uses
  /// this to flag "N hand-edits will be discarded" before Apply.
  droppedOverrideKeys: string[];
}

interface PlacedUnit {
  slotKey: string;
  /// The segment ref this unit was generated from (post-migration,
  /// every unit traces back to a segment). Carries the catalog
  /// scope + modelId + optional mode override.
  segRef: { catalogScope: CatalogScope; modelId: string; modeOverride?: string | null };
  /// Local-frame centre of the unit (m), before rotation + centring.
  centreX: number;
  centreY: number;
  /// Footprint -- used for bounding-box calc + downstream rendering.
  /// These are already orientation-adjusted (swapped for 'across').
  widthM: number;
  lengthM: number;
}

/// Convert a BessGroup into Sources. Pure function -- the caller
/// merges these into project.sources (replacing the group's existing
/// children, keyed by `source.groupId === group.id`).
export function materialiseBessGroup(
  group: BessGroup,
  lookup: CatalogLookup,
  opts: { existingOverrides?: BessGroup['unitOverrides'] } = {},
): MaterialisedGroup {
  // Normalise rows: migrate any legacy pattern-based rows to the
  // segment model up front so the walker below only deals with one
  // shape. This is pure (no mutation of the input group).
  const rows = group.rows.map((r) => migrateLegacyRow(r));

  // ----- Step 1: walk the rows in local coords, recording placements -----
  // Outer loop: stamp the entire row sequence `sequenceRepeat` times
  // top-to-bottom, with `gapBetweenSequencesM` between copies. Each
  // outer iteration is one "block" of all rows. seqIdx becomes part of
  // the slot key so per-unit overrides survive sequence-count changes.
  const placed: PlacedUnit[] = [];
  let y = 0;
  const lastRowIdx = rows.length - 1;
  // Inter-row gaps: indexed by source-row-index. We auto-pad with the
  // default of 2 m so a freshly added row doesn't crash the walker.
  const interGaps = group.interRowGapsM ?? [];
  const seqReps = Math.max(1, group.sequenceRepeat ?? 1);
  const seqGapM = group.gapBetweenSequencesM ?? 5;
  for (let seqIdx = 0; seqIdx < seqReps; seqIdx++) {
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
      const row = rows[rowIdx];
      if (row.rowRepeat < 1) continue;
      for (let rowCopyIdx = 0; rowCopyIdx < row.rowRepeat; rowCopyIdx++) {
        const placedThisCopy = placeRow(row, rowIdx, rowCopyIdx, seqIdx, y, lookup);
        placed.push(...placedThisCopy.units);
        // Advance y past this row's footprint length, then the
        // appropriate gap. Between copies of the same template:
        // gapBetweenCopiesM. After the last copy of a row, before the
        // next row in the same sequence: interRowGapsM[rowIdx].
        // Final row's final copy of the final sequence: no gap. After
        // the final row's final copy of a non-final sequence:
        // gapBetweenSequencesM.
        y += placedThisCopy.rowLengthM;
        const isLastCopyOfThisRow = rowCopyIdx === row.rowRepeat - 1;
        const isLastRow = rowIdx === lastRowIdx;
        const isLastSeq = seqIdx === seqReps - 1;
        if (!isLastCopyOfThisRow) {
          y += row.gapBetweenCopiesM ?? 2;
        } else if (!isLastRow) {
          y += interGaps[rowIdx] ?? 2;
        } else if (!isLastSeq) {
          y += seqGapM;
        }
      }
    }
  }

  // ----- Step 2: bounding box + recentre so (0,0) is the group's centre -----
  const bbox = boundingBox(placed);
  const cx = (bbox.minX + bbox.maxX) / 2;
  const cy = (bbox.minY + bbox.maxY) / 2;
  for (const p of placed) {
    p.centreX -= cx;
    p.centreY -= cy;
  }

  // ----- Step 3 + 4: rotate, project to lat/lng, apply overrides -----
  const radians = (group.rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(radians);
  const sinR = Math.sin(radians);
  const overrides = opts.existingOverrides ?? group.unitOverrides ?? {};
  const usedOverrideKeys = new Set<string>();
  const sources: Source[] = [];
  const counts: Record<SourceKind, number> = { wtg: 0, bess: 0, auxiliary: 0 };

  for (const p of placed) {
    const override = overrides[p.slotKey];
    if (override) usedOverrideKeys.add(p.slotKey);
    // Apply rotation (screen-clockwise == standard 2D rotation matrix
    // when y points south).
    const rotX = p.centreX * cosR - p.centreY * sinR;
    const rotY = p.centreX * sinR + p.centreY * cosR;
    let latLng = metresToLatLng(group.centerLatLng, rotX, rotY);
    if (override?.latLngDelta) {
      latLng = [
        latLng[0] + override.latLngDelta[0],
        latLng[1] + override.latLngDelta[1],
      ];
    }
    const ref = override?.modelOverride ?? p.segRef;
    const entry = lookup(ref.catalogScope, ref.modelId);
    const kind: SourceKind = entry?.kind ?? 'bess';
    counts[kind]++;
    // User-facing name: number units sequentially per-kind within the
    // group (e.g. "GP BESS — BESS 1" ... "GP BESS — BESS 168",
    // "GP BESS — INV 1" ... "GP BESS — INV 24"). Stable identifier
    // for diffing / overrides lives on `id` (which still uses the
    // slotKey); the name field is purely display.
    const kindLabel: Record<SourceKind, string> = {
      wtg: 'WTG', bess: 'BESS', auxiliary: 'AUX',
    };
    const displayName = `${group.name} — ${kindLabel[kind]} ${counts[kind]}`;
    const src: Source = {
      // ID stays slot-key based for stable per-unit override + diff
      // identification across re-materialisation. Never user-visible.
      id: `${group.id}-${p.slotKey}`,
      kind,
      name: displayName,
      latLng,
      modelId: ref.modelId,
      catalogScope: ref.catalogScope,
      groupId: group.id,
      slotKey: p.slotKey,
      // Stamp the group rotation onto the unit so the on-map renderer
      // (sourceMarker, fix #7) can rotate the footprint rect. The
      // 'across' orientation is already baked into the unit's
      // width/length swap in placeRow, so we don't add another 90°
      // here -- the rect at rotationDeg with already-swapped
      // dimensions renders correctly.
      yawDeg: group.rotationDeg,
    };
    // Mode override priority: per-slot override > segment-level
    // modeOverride > catalog default. We surface the SEGMENT value
    // on the materialised Source so the solver picks it up.
    if (override?.modeOverride !== undefined) {
      src.modeOverride = override.modeOverride;
    } else if (p.segRef.modeOverride !== undefined) {
      src.modeOverride = p.segRef.modeOverride;
    }
    if (override?.elevationOffset !== undefined) src.elevationOffset = override.elevationOffset;
    sources.push(src);
  }

  const droppedOverrideKeys = Object.keys(overrides).filter(
    (k) => !usedOverrideKeys.has(k),
  );

  return {
    sources,
    bboxWidthM: bbox.maxX - bbox.minX,
    bboxLengthM: bbox.maxY - bbox.minY,
    counts,
    droppedOverrideKeys,
  };
}

// ===== Internal helpers =====

function placeRow(
  row: BessRow,
  rowIdx: number,
  rowCopyIdx: number,
  seqIdx: number,
  y: number,
  lookup: CatalogLookup,
): { units: PlacedUnit[]; rowLengthM: number } {
  const units: PlacedUnit[] = [];
  let x = 0;
  let maxLengthInRow = 0;
  const segments = row.segments ?? [];
  // Per-row "segment-sequence repeat": stamps the entire segment list
  // N times WITHIN one physical row. E.g. [BESS×8, INV×1] with reps=3
  // -> [BESS×8 INV BESS×8 INV BESS×8 INV] inline. Distinct from
  // group.sequenceRepeat (which stamps row sequences top-to-bottom).
  // Defaults to 1 (no inline repeat); inter-repeat spacing comes from
  // row.gapBetweenSegmentSequencesM, with sensible fallbacks.
  const segSeqReps = Math.max(1, row.segmentSequenceRepeat ?? 1);
  const lastSegGap = segments.length > 0 ? (segments[segments.length - 1].gapAfterM || 0) : 0;
  const segSeqGap = row.gapBetweenSegmentSequencesM ?? (lastSegGap > 0 ? lastSegGap : 3);
  for (let segSeqIdx = 0; segSeqIdx < segSeqReps; segSeqIdx++) {
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const seg = segments[segIdx];
      const count = Math.max(0, Math.floor(seg.count));
      if (count === 0) continue;
      const entry = lookup(seg.catalogScope, seg.modelId);
      // Catalog footprint = (widthM, lengthM) in the unit's NATIVE frame.
      // For BESS / aux the convention is widthM = LONG axis, lengthM =
      // SHORT axis (matches the marker rect drawn as 18×12 with the
      // long side horizontal). "Along" orientation lays units with the
      // long axis along the row direction (so we lay them widthM
      // along x); "across" rotates 90° (lay lengthM along x).
      const fp = entry ? footprintFor(entry) : { widthM: 5.1, lengthM: 1.7 };
      const orientedWidthM = seg.orientation === 'across' ? fp.lengthM : fp.widthM;
      const orientedLengthM = seg.orientation === 'across' ? fp.widthM : fp.lengthM;
      if (orientedLengthM > maxLengthInRow) maxLengthInRow = orientedLengthM;
      for (let u = 0; u < count; u++) {
        units.push({
          // Slot key gains the segment-sequence index (k) so per-unit
          // overrides survive a change in segmentSequenceRepeat. Older
          // keys (without k) continue to work via existingOverrides
          // lookup; they just won't match any post-rewrite slots, which
          // is the correct behaviour for a structural change.
          slotKey: `q${seqIdx}-r${rowIdx}-c${rowCopyIdx}-k${segSeqIdx}-s${seg.id}-u${u}`,
          segRef: {
            catalogScope: seg.catalogScope,
            modelId: seg.modelId,
            modeOverride: seg.modeOverride,
          },
          centreX: x + orientedWidthM / 2,
          centreY: y + orientedLengthM / 2,
          widthM: orientedWidthM,
          lengthM: orientedLengthM,
        });
        x += orientedWidthM;
        // Intra-segment spacing applies between consecutive units in the
        // same segment only. The LAST unit in the segment gets the
        // segment's gapAfterM appended (handled below).
        if (u < count - 1) x += seg.spacingWithinM;
      }
      // Gap to next segment (skipped for the final segment in the
      // current sequence copy -- handled by segSeqGap below).
      if (segIdx < segments.length - 1) x += seg.gapAfterM;
    }
    // Gap between sequence copies (skipped after the final copy).
    if (segSeqIdx < segSeqReps - 1) x += segSeqGap;
  }
  return { units, rowLengthM: maxLengthInRow };
}

/// Translate a legacy pattern-based row into the segment model. Pure;
/// runs every time we materialise a group, so old projects keep
/// working without a one-shot migration step. New rows already have
/// `segments` and pass through unchanged.
///
/// Heuristic: the legacy `pattern` was a flat list of unit refs with
/// uniform `spacingWithinM`. We collapse consecutive runs of the same
/// (catalogScope, modelId) into one segment with the appropriate
/// count, and set every segment's spacingWithinM + gapAfterM to the
/// row's old uniform spacing -- preserves visual layout exactly.
export function migrateLegacyRow(row: BessRow): BessRow {
  if (row.segments && row.segments.length > 0) return row;
  if (!row.pattern || row.pattern.length === 0) {
    return {
      ...row,
      segments: [],
      rowRepeat: row.rowRepeat ?? 1,
      gapBetweenCopiesM: row.gapBetweenCopiesM ?? 2,
    };
  }
  const spacing = row.spacingWithinM ?? 1.5;
  const repeat = Math.max(1, row.patternRepeat ?? 1);
  // Expand pattern × patternRepeat into a flat list, then collapse
  // adjacent same-model runs.
  const expanded: Array<{ catalogScope: CatalogScope; modelId: string }> = [];
  for (let p = 0; p < repeat; p++) {
    for (const u of row.pattern) {
      expanded.push({ catalogScope: u.catalogScope, modelId: u.modelId });
    }
  }
  const segments: BessSegment[] = [];
  let i = 0;
  let segCounter = 0;
  while (i < expanded.length) {
    const ref = expanded[i];
    let count = 1;
    while (i + count < expanded.length
        && expanded[i + count].catalogScope === ref.catalogScope
        && expanded[i + count].modelId === ref.modelId) {
      count++;
    }
    segments.push({
      id: `mig-${row.id}-${segCounter++}`,
      catalogScope: ref.catalogScope,
      modelId: ref.modelId,
      count,
      spacingWithinM: spacing,
      // Legacy spacing was uniform across the entire row, so the
      // gap-after between segments also matches.
      gapAfterM: spacing,
      orientation: 'along',
    });
    i += count;
  }
  return {
    id: row.id,
    segments,
    rowRepeat: row.rowRepeat ?? 1,
    gapBetweenCopiesM: row.gapBetweenCopiesM ?? (row.gapToNextRowM ?? 2),
  };
}

function boundingBox(placed: PlacedUnit[]): {
  minX: number; maxX: number; minY: number; maxY: number;
} {
  if (placed.length === 0) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of placed) {
    const x0 = p.centreX - p.widthM / 2;
    const x1 = p.centreX + p.widthM / 2;
    const y0 = p.centreY - p.lengthM / 2;
    const y1 = p.centreY + p.lengthM / 2;
    if (x0 < minX) minX = x0;
    if (x1 > maxX) maxX = x1;
    if (y0 < minY) minY = y0;
    if (y1 > maxY) maxY = y1;
  }
  return { minX, maxX, minY, maxY };
}

/// Equirectangular projection: convert a (dx, dy) offset in metres
/// (x = east, y = south) back to a [lat, lng] pair relative to the
/// supplied origin. At BESS-site scale (<< 1 km) the distortion is
/// well under 1 cm — fine for unit placement.
function metresToLatLng(
  origin: [number, number],
  dxM: number,
  dyM: number,
): [number, number] {
  const R = 6371008.8;
  const lat0Rad = (origin[0] * Math.PI) / 180;
  const dLatDeg = (-dyM / R) * (180 / Math.PI);   // y south → smaller lat
  const dLngDeg = (dxM / (R * Math.cos(lat0Rad))) * (180 / Math.PI);
  return [origin[0] + dLatDeg, origin[1] + dLngDeg];
}

/// Build a fresh BessGroup with one sensible-default row template, for
/// the "+ BESS group" entry point. The wizard immediately re-renders
/// the preview, so the default looks reasonable in the first frame.
export function newBessGroupTemplate(
  id: string,
  name: string,
  centerLatLng: [number, number],
  defaultBessRef: { catalogScope: CatalogScope; modelId: string } | null,
): BessGroup {
  return {
    id,
    name,
    centerLatLng,
    rotationDeg: 0,
    rows: [
      {
        id: `${id}-row1`,
        segments: defaultBessRef
          ? [{
              id: `${id}-row1-seg1`,
              catalogScope: defaultBessRef.catalogScope,
              modelId: defaultBessRef.modelId,
              count: 8,
              spacingWithinM: 1.5,
              gapAfterM: 0,
              orientation: 'along',
            }]
          : [],
        rowRepeat: 1,
        gapBetweenCopiesM: 2,
      },
    ],
    interRowGapsM: [],
  };
}

/// Drop sources that belong to a group from a flat source list. Used
/// when re-materialising a group OR deleting it -- the new sources
/// (if any) get spliced back in afterwards.
export function withoutGroupSources(
  sources: Source[],
  groupId: string,
): Source[] {
  return sources.filter((s) => s.groupId !== groupId);
}

/// Replace a group's materialised sources in-place within a flat list,
/// preserving the order of standalone sources around it. Returns a
/// fresh array (input is not mutated).
export function withGroupSources(
  sources: Source[],
  groupId: string,
  fresh: Source[],
): Source[] {
  return [...withoutGroupSources(sources, groupId), ...fresh];
}
