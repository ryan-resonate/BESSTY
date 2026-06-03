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
  BessGroupItem,
  BessRow,
  BessSegment,
  BessSeqItem,
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
  /// Axis-aligned bounding-box extents (m) of the unit AFTER its in-row
  /// rotation — `widthM` along the row, `lengthM` across it. Used for packing
  /// (x-advance), row depth, and the group bounding box. (The map renders the
  /// native catalog footprint rotated by `yawDeg`, so these are extents, not
  /// the drawn rectangle.)
  widthM: number;
  lengthM: number;
  /// The unit's in-row rotation (deg), folded into yawDeg by the materialiser.
  rotationDeg: number;
  /// Horizontal alignment carried from the owning row, applied as a global
  /// post-process (`applyRowAlignment`) once the full base block is known.
  /// Absent / 'left' + 0 offset → no shift (the historic behaviour).
  align?: 'left' | 'center' | 'right';
  alignOffsetM?: number;
  /// Stable id of the physical ROW INSTANCE this unit belongs to. All units of
  /// one row (and its vertical rowRepeat copies, which share x-extent) carry the
  /// same key so they shift together during alignment. Set in `layoutItem`;
  /// preserved verbatim by `offsetUnits`/`tile2D` (they spread `...u`).
  alignKey?: string;
}

/// Convert a BessGroup into Sources. Pure function -- the caller
/// merges these into project.sources (replacing the group's existing
/// children, keyed by `source.groupId === group.id`).
export function materialiseBessGroup(
  group: BessGroup,
  lookup: CatalogLookup,
  opts: { existingOverrides?: BessGroup['unitOverrides'] } = {},
): MaterialisedGroup {
  // Two layout engines share one placement tail. Groups that opt into the
  // recursive `sequence` model use the new nested/2-D engine; everything else
  // keeps the original flat path byte-for-byte (so legacy layouts + per-unit
  // overrides are untouched).
  const placed = Array.isArray(group.sequence)
    ? layoutSequenceUnits(group, lookup)
    : layoutFlatUnits(group, lookup);
  return finishPlacement(placed, group, lookup, opts);
}

/// Legacy flat layout — stamp rows × rowRepeat × sequenceRepeat top-to-bottom.
/// Unchanged from the original materialiser.
function layoutFlatUnits(group: BessGroup, lookup: CatalogLookup): PlacedUnit[] {
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
  return placed;
}

/// Shared placement tail — recentre on the bbox, rotate by the group rotation,
/// project to lat/lng, apply per-slot overrides, and stamp Sources. Used by
/// both the flat and the recursive layouts.
function finishPlacement(
  placed: PlacedUnit[],
  group: BessGroup,
  lookup: CatalogLookup,
  opts: { existingOverrides?: BessGroup['unitOverrides'] },
): MaterialisedGroup {
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
      // Stamp the effective on-screen rotation: group rotation + the unit's
      // in-row rotation. The placement step packs by the rotated bounding box,
      // so the renderer draws the native catalog footprint (widthM × lengthM)
      // rotated by yawDeg and it lines up with the reserved cell.
      yawDeg: group.rotationDeg + p.rotationDeg,
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

/// Per-segment in-row rotation (deg). New field `rotationDeg`; falls back to
/// the legacy `orientation` toggle (across → 90, along → 0).
function segRotationDeg(seg: BessSegment): number {
  if (typeof seg.rotationDeg === 'number' && Number.isFinite(seg.rotationDeg)) {
    return seg.rotationDeg;
  }
  return seg.orientation === 'across' ? 90 : 0;
}

/// Per-segment alignment across the row depth band. Defaults to 'middle'.
function segAlignment(seg: BessSegment): 'top' | 'middle' | 'bottom' {
  return seg.alignment ?? 'middle';
}

/// Per-row horizontal alignment within the group bounding box. Defaults to
/// 'left' (the pre-feature behaviour — every row flush at x=0).
function rowAlign(row: BessRow): 'left' | 'center' | 'right' {
  return row.align ?? 'left';
}

/// Per-row signed horizontal nudge (m, +right) applied after the anchor.
function rowAlignOffset(row: BessRow): number {
  return typeof row.alignOffsetM === 'number' && Number.isFinite(row.alignOffsetM)
    ? row.alignOffsetM
    : 0;
}

/// Axis-aligned bounding box of a (widthM × lengthM) rectangle rotated by
/// `deg`. `widthM` is the unit's long axis (along the row at 0°). Returns the
/// extent along the row (x) and across it (y). At 0° → (w, l); at 90° → (l, w).
function rotatedExtent(widthM: number, lengthM: number, deg: number): { along: number; across: number } {
  const r = (deg * Math.PI) / 180;
  const c = Math.abs(Math.cos(r));
  const s = Math.abs(Math.sin(r));
  return {
    along: widthM * c + lengthM * s,
    across: widthM * s + lengthM * c,
  };
}

interface LayoutBlock {
  units: PlacedUnit[];
  width: number;   // extent along the row (x)
  height: number;  // extent across the row / depth (y)
}

/// Lay out one row's segments into a 0-origin block (unit centres relative to
/// the row's top-left). Base slot keys are the per-row part
/// `k{segSeqIdx}-s{segId}-u{u}`; callers prefix them with their tiling path.
/// Single source of truth for in-row geometry (segment packing + per-segment
/// rotation + top/mid/bottom alignment), shared by the flat and recursive paths.
function layoutRowBlock(row: BessRow, lookup: CatalogLookup): LayoutBlock {
  const units: PlacedUnit[] = [];
  // Per-unit alignment, recorded during the first pass so centreY can be set
  // once the row's full depth is known.
  const aligns: Array<'top' | 'middle' | 'bottom'> = [];
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
      const rotDeg = segRotationDeg(seg);
      const align = segAlignment(seg);
      // Bounding box of the unit AFTER its in-row rotation: `along` packs it
      // along the row (x); `across` sets the row depth (y). Generalises the
      // old 0/90 width↔length swap to any angle, with no overlap.
      const ext = rotatedExtent(fp.widthM, fp.lengthM, rotDeg);
      if (ext.across > maxLengthInRow) maxLengthInRow = ext.across;
      for (let u = 0; u < count; u++) {
        units.push({
          // Slot key gains the segment-sequence index (k) so per-unit
          // overrides survive a change in segmentSequenceRepeat. Older
          // keys (without k) continue to work via existingOverrides
          // lookup; they just won't match any post-rewrite slots, which
          // is the correct behaviour for a structural change.
          slotKey: `k${segSeqIdx}-s${seg.id}-u${u}`,
          segRef: {
            catalogScope: seg.catalogScope,
            modelId: seg.modelId,
            modeOverride: seg.modeOverride,
          },
          centreX: x + ext.along / 2,
          centreY: ext.across / 2,   // provisional (top); fixed in pass 2
          widthM: ext.along,
          lengthM: ext.across,
          rotationDeg: rotDeg,
        });
        aligns.push(align);
        x += ext.along;
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
  // Pass 2: now the row's full depth (maxLengthInRow) is known, place each
  // unit across the row band per its segment alignment. 'top' keeps the
  // provisional top-aligned centre; 'middle' centres it in the band; 'bottom'
  // pushes the unit's bottom edge to the band's bottom. (For a uniform-depth
  // row all three coincide, so existing single-model rows are unchanged.)
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    switch (aligns[i]) {
      case 'middle': u.centreY = maxLengthInRow / 2; break;
      case 'bottom': u.centreY = maxLengthInRow - u.lengthM / 2; break;
      default: break; // 'top' already set to u.lengthM/2
    }
  }
  return { units, width: x, height: maxLengthInRow };
}

/// Legacy flat-path row placement: lay out at 0-origin, then prefix the base
/// slot keys with `q{seq}-r{row}-c{copy}` and offset by `y`. Produces the SAME
/// slot keys + positions as before, so flat-group overrides are unaffected.
function placeRow(
  row: BessRow,
  rowIdx: number,
  rowCopyIdx: number,
  seqIdx: number,
  y: number,
  lookup: CatalogLookup,
): { units: PlacedUnit[]; rowLengthM: number } {
  const block = layoutRowBlock(row, lookup);
  const prefix = `q${seqIdx}-r${rowIdx}-c${rowCopyIdx}-`;
  const units = block.units.map((u) => ({
    ...u,
    slotKey: prefix + u.slotKey,
    centreY: u.centreY + y,
  }));
  return { units, rowLengthM: block.height };
}

// ===== Recursive (nested + 2-D) layout engine =====

function offsetUnits(units: PlacedUnit[], dx: number, dy: number): PlacedUnit[] {
  return units.map((u) => ({ ...u, centreX: u.centreX + dx, centreY: u.centreY + dy }));
}

/// Stack item blocks top-to-bottom, left-aligned at x=0, with `gaps[i]` between
/// item i and i+1. Returns the combined block.
function stackDown(blocks: LayoutBlock[], gaps: number[]): LayoutBlock {
  const units: PlacedUnit[] = [];
  let y = 0;
  let width = 0;
  for (let i = 0; i < blocks.length; i++) {
    units.push(...offsetUnits(blocks[i].units, 0, y));
    width = Math.max(width, blocks[i].width);
    y += blocks[i].height;
    if (i < blocks.length - 1) y += gaps[i] ?? 0;
  }
  return { units, width, height: y };
}

/// Tile a block in 2-D: `nDown` copies stacked vertically (gapDown between),
/// `nRight` copies along x (gapRight between). Each copy's slot keys are
/// prefixed with its (down,right) indices so they stay unique + stable.
function tile2D(
  b: LayoutBlock,
  nDown: number, gapDown: number,
  nRight: number, gapRight: number,
  keyPrefix: string,
): LayoutBlock {
  const down = Math.max(1, Math.floor(nDown));
  const right = Math.max(1, Math.floor(nRight));
  const units: PlacedUnit[] = [];
  for (let d = 0; d < down; d++) {
    for (let r = 0; r < right; r++) {
      const dx = r * (b.width + gapRight);
      const dy = d * (b.height + gapDown);
      for (const u of b.units) {
        units.push({
          ...u,
          centreX: u.centreX + dx,
          centreY: u.centreY + dy,
          slotKey: `${keyPrefix}D${d}R${r}.${u.slotKey}`,
        });
      }
    }
  }
  return {
    units,
    width: right * b.width + (right - 1) * gapRight,
    height: down * b.height + (down - 1) * gapDown,
  };
}

/// Lay out a sequence item (row or nested group) into a 0-origin block.
function layoutItem(item: BessSeqItem, lookup: CatalogLookup): LayoutBlock {
  if (item.kind === 'row') {
    const r = migrateLegacyRow(item.row);
    const base = layoutRowBlock(r, lookup);
    // Tag every unit with the row's alignment + a stable per-row-instance key
    // (`a{item.id}`) so the global `applyRowAlignment` pass can shift the whole
    // row together later. The key survives tiling (tile2D/offsetUnits spread
    // `...u`), so vertical rowRepeat copies — which share x-extent — shift
    // identically.
    const align = rowAlign(r);
    const alignOffsetM = rowAlignOffset(r);
    const alignKey = `a${item.id}`;
    const tagged: LayoutBlock = {
      ...base,
      units: base.units.map((u) => ({ ...u, align, alignOffsetM, alignKey })),
    };
    // A row item still honours its own `rowRepeat` (a row-local vertical
    // repeat) — a convenience equivalent to wrapping it in a down-group, so the
    // existing per-row "Repeat row ×N" control keeps working. The item id tags
    // the keys so sibling rows of the same model don't collide.
    const rr = Math.max(1, Math.floor(r.rowRepeat ?? 1));
    if (rr > 1) {
      return tile2D(tagged, rr, r.gapBetweenCopiesM ?? 2, 1, 0, `i${item.id}.`);
    }
    return { ...tagged, units: tagged.units.map((u) => ({ ...u, slotKey: `i${item.id}.${u.slotKey}` })) };
  }
  return layoutGroupItem(item, lookup);
}

/// Lay out a nested group: stack its items top-to-bottom, then tile 2-D.
function layoutGroupItem(g: BessGroupItem, lookup: CatalogLookup): LayoutBlock {
  const inner = stackDown(
    g.items.map((it) => layoutItem(it, lookup)),
    g.items.map((it) => it.gapAfterM ?? 0),
  );
  return tile2D(inner, g.repeatDown ?? 1, g.gapDownM ?? 0, g.repeatRight ?? 1, g.gapRightM ?? 0, `g${g.id}.`);
}

/// Apply per-row horizontal alignment to the base sequence block, in place.
///
/// The reference is the WHOLE base block: its width `block.width` is the widest
/// row anywhere in the group (nested groups included, since they're already
/// stacked into the block). Every row instance sits left-aligned at x∈[0,w]
/// after `stackDown`; here we shift each instance so its chosen edge lands on
/// the box edge, plus a signed offset.
///
/// Grouping is by `alignKey` (one key per physical row instance). Vertical
/// rowRepeat copies share a key and the same x-extent, so they shift together
/// and identically — correct. We run this on the BASE block, BEFORE the top-
/// level whole-sequence repeat, so each replicated tile is aligned the same way
/// rather than every copy snapping to the far edge of the replicated strip.
///
/// Reference width is frozen at the pre-shift `block.width`, so offsets that
/// push a row past the edge don't feed back into other rows' anchors.
function applyRowAlignment(block: LayoutBlock): void {
  const W = block.width;
  // Bucket units by row instance, skipping plain left/0 rows (the no-op
  // majority) and any untagged units (e.g. the legacy flat path).
  const groups = new Map<string, PlacedUnit[]>();
  for (const u of block.units) {
    if (!u.alignKey) continue;
    const align = u.align ?? 'left';
    const offset = u.alignOffsetM ?? 0;
    if (align === 'left' && offset === 0) continue;
    let g = groups.get(u.alignKey);
    if (!g) { g = []; groups.set(u.alignKey, g); }
    g.push(u);
  }
  for (const units of groups.values()) {
    let minLeft = Infinity;
    let maxRight = -Infinity;
    for (const u of units) {
      const l = u.centreX - u.widthM / 2;
      const r = u.centreX + u.widthM / 2;
      if (l < minLeft) minLeft = l;
      if (r > maxRight) maxRight = r;
    }
    const w = maxRight - minLeft;
    const align = units[0].align ?? 'left';
    const offset = units[0].alignOffsetM ?? 0;
    let targetLeft: number;
    switch (align) {
      case 'right': targetLeft = W - w; break;
      case 'center': targetLeft = (W - w) / 2; break;
      default: targetLeft = 0; break; // 'left'
    }
    const shift = (targetLeft + offset) - minLeft;
    if (shift === 0) continue;
    for (const u of units) u.centreX += shift;
  }
}

/// Recursive layout for sequence-based groups: lay out the top-level sequence,
/// then apply the group's top-level 2-D repeat. Units stay in a 0-origin frame;
/// `finishPlacement` recentres + rotates + projects.
function layoutSequenceUnits(group: BessGroup, lookup: CatalogLookup): PlacedUnit[] {
  const items = group.sequence ?? [];
  const inner = stackDown(
    items.map((it) => layoutItem(it, lookup)),
    items.map((it) => it.gapAfterM ?? 0),
  );
  // Per-row horizontal alignment is resolved against the full base-block width
  // (the group bounding box) before the whole-sequence repeat tiles it.
  applyRowAlignment(inner);
  return tile2D(
    inner,
    group.repeatDown ?? 1, group.gapDownM ?? 5,
    group.repeatRight ?? 1, group.gapRightM ?? 5,
    'top.',
  ).units;
}

/// Convert a legacy flat BessGroup into the recursive sequence model, preserving
/// layout exactly. `rowRepeat` → a wrapping group (down ×rowRepeat);
/// `sequenceRepeat` → the top-level `repeatDown`. Used by the wizard to upgrade
/// an old group the first time it's edited in the nested UI. Idempotent — a
/// group that already has a `sequence` is returned as-is.
export function groupToSequence(
  group: BessGroup,
): Pick<BessGroup, 'sequence' | 'repeatDown' | 'gapDownM' | 'repeatRight' | 'gapRightM'> {
  if (Array.isArray(group.sequence)) {
    return {
      sequence: group.sequence,
      repeatDown: group.repeatDown ?? 1,
      gapDownM: group.gapDownM ?? 5,
      repeatRight: group.repeatRight ?? 1,
      gapRightM: group.gapRightM ?? 5,
    };
  }
  const rows = group.rows.map(migrateLegacyRow);
  const interGaps = group.interRowGapsM ?? [];
  // Each row becomes a row item, keeping its own `rowRepeat` (the recursive
  // engine honours it as a row-local down-repeat — see `layoutItem`). No need
  // to wrap repeated rows in a group, so the migration stays 1:1 with the
  // original row list.
  const items: BessSeqItem[] = rows.map((row, i): BessSeqItem => ({
    kind: 'row',
    id: row.id,
    row,
    gapAfterM: i < rows.length - 1 ? (interGaps[i] ?? 2) : 0,
  }));
  return {
    sequence: items,
    repeatDown: group.sequenceRepeat ?? 1,
    gapDownM: group.gapBetweenSequencesM ?? 5,
    repeatRight: 1,
    gapRightM: 0,
  };
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
      rotationDeg: 0,
      alignment: 'middle',
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
              rotationDeg: 0,
              alignment: 'middle',
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
