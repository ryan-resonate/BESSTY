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
  BessRowUnit,
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
  unit: BessRowUnit;
  /// Local-frame centre of the unit (m), before rotation + centring.
  centreX: number;
  centreY: number;
  /// Footprint -- used for bounding-box calc + downstream rendering.
  widthM: number;
  lengthM: number;
}

/// Convert a BessGroup into Sources. Pure function -- the caller
/// merges these into project.sources (replacing the group's existing
/// children, keyed by `source.groupId === group.id`).
export function materialiseBessGroup(
  group: BessGroup,
  lookup: CatalogLookup,
  opts: { existingOverrides?: Record<string, BessGroup['unitOverrides'] extends infer T ? T extends Record<string, infer U> ? U : never : never> } = {},
): MaterialisedGroup {
  // ----- Step 1: walk the rows in local coords, recording placements -----
  const placed: PlacedUnit[] = [];
  let y = 0;
  const lastRowIdx = group.rows.length - 1;
  for (let rowIdx = 0; rowIdx < group.rows.length; rowIdx++) {
    const row = group.rows[rowIdx];
    if (row.rowRepeat < 1) continue;
    for (let rowCopyIdx = 0; rowCopyIdx < row.rowRepeat; rowCopyIdx++) {
      const placedThisCopy = placeRow(row, rowIdx, rowCopyIdx, y, lookup);
      placed.push(...placedThisCopy.units);
      // Advance y past this row's footprint length (the maximum unit
      // length in the row) + the inter-row gap, unless this is the
      // very last row + copy combination.
      y += placedThisCopy.rowLengthM;
      const isLastCopyOfLastRow =
        rowIdx === lastRowIdx && rowCopyIdx === row.rowRepeat - 1;
      if (!isLastCopyOfLastRow) {
        y += row.gapToNextRowM;
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
    const ref = override?.modelOverride ?? p.unit;
    const entry = lookup(ref.catalogScope, ref.modelId);
    const kind: SourceKind = entry?.kind ?? 'bess';
    counts[kind]++;
    const src: Source = {
      id: `${group.id}-${p.slotKey}`,
      kind,
      // Name the unit by its slot for stable identification. Users
      // can rename per-unit via the side panel; that becomes another
      // override field we'll add when #18 / per-unit-edit UI lands.
      name: `${group.name} ${p.slotKey}`,
      latLng,
      modelId: ref.modelId,
      catalogScope: ref.catalogScope,
      groupId: group.id,
      slotKey: p.slotKey,
    };
    if (override?.modeOverride !== undefined) src.modeOverride = override.modeOverride;
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
  y: number,
  lookup: CatalogLookup,
): { units: PlacedUnit[]; rowLengthM: number } {
  const units: PlacedUnit[] = [];
  let x = 0;
  let maxLengthInRow = 0;
  const reps = Math.max(1, row.patternRepeat);
  for (let patternCopyIdx = 0; patternCopyIdx < reps; patternCopyIdx++) {
    for (let unitIdx = 0; unitIdx < row.pattern.length; unitIdx++) {
      const unit = row.pattern[unitIdx];
      const entry = lookup(unit.catalogScope, unit.modelId);
      const { widthM, lengthM } = entry
        ? footprintFor(entry)
        // Missing entry: fall back to BESS default. The materialiser
        // still emits the source; the UI surfaces the broken ref via
        // its usual lookup chain.
        : { widthM: 5.1, lengthM: 1.7 };
      if (lengthM > maxLengthInRow) maxLengthInRow = lengthM;
      units.push({
        slotKey: `r${rowIdx}-c${rowCopyIdx}-p${patternCopyIdx}-u${unitIdx}`,
        unit,
        centreX: x + widthM / 2,
        centreY: y + lengthM / 2,
        widthM,
        lengthM,
      });
      x += widthM;
      // spacing between consecutive units (within the pattern AND
      // between pattern copies)
      const isLastUnitOfLastCopy =
        unitIdx === row.pattern.length - 1 && patternCopyIdx === reps - 1;
      if (!isLastUnitOfLastCopy) x += row.spacingWithinM;
    }
  }
  return { units, rowLengthM: maxLengthInRow };
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
        pattern: defaultBessRef ? [defaultBessRef] : [],
        patternRepeat: 8,
        spacingWithinM: 1.5,
        gapToNextRowM: 2,
        rowRepeat: 1,
      },
    ],
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
