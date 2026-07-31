// Bulk model / mode edits across a BESS group's segment sequence.
//
// Pure functions over `BessSeqItem[]` so the wizard's "change all" controls can
// be unit-tested without React. A group's sequence nests (rows contain repeated
// sub-sequences), so every helper here walks the whole tree rather than the top
// level only — a bulk edit that silently skips nested segments is worse than no
// bulk edit.

import type { BessSegment, BessSeqItem, CatalogScope } from './types';

/// Apply `fn` to every segment of every row anywhere in the tree.
export function mapAllSegments(
  items: BessSeqItem[],
  fn: (seg: BessSegment) => BessSegment,
): BessSeqItem[] {
  return items.map((it): BessSeqItem => (
    it.kind === 'row'
      ? { ...it, row: { ...it.row, segments: it.row.segments.map(fn) } }
      : { ...it, items: mapAllSegments(it.items, fn) }
  ));
}

/// Every segment in the tree, flattened depth-first (the wizard's visual order).
export function allSegments(items: BessSeqItem[]): BessSegment[] {
  const out: BessSegment[] = [];
  for (const it of items) {
    if (it.kind === 'row') out.push(...it.row.segments);
    else out.push(...allSegments(it.items));
  }
  return out;
}

export interface BulkResult {
  sequence: BessSeqItem[];
  /// Segments changed.
  changed: number;
  /// Units covered by those segments — what the user actually cares about.
  units: number;
  /// Segments that matched the selector but could not take the requested mode.
  skipped: number;
  /// Units in those skipped segments.
  skippedUnits: number;
}

/// Swap every segment of `from` to `toModel`, optionally pinning a mode.
///
/// `toMode` must be a mode the TARGET model has — the caller sources the list
/// from the target's catalog entry. Passing `undefined` resets to the target's
/// default (the historical behaviour), since the old mode name may not exist on
/// the new model.
export function swapModel(
  items: BessSeqItem[],
  from: { scope: CatalogScope; modelId: string },
  to: { scope: CatalogScope; modelId: string; mode?: string | null },
): BulkResult {
  let changed = 0;
  let units = 0;
  const sequence = mapAllSegments(items, (sg) => {
    if (sg.catalogScope !== from.scope || sg.modelId !== from.modelId) return sg;
    changed++;
    units += sg.count;
    return {
      ...sg,
      catalogScope: to.scope,
      modelId: to.modelId,
      modeOverride: to.mode ?? undefined,
    };
  });
  return { sequence, changed, units, skipped: 0, skippedUnits: 0 };
}

/// Set the mode on every segment whose model offers it.
///
/// `modesFor` returns the mode names available on a given model; a segment
/// whose model doesn't list `mode` is left completely alone and counted as
/// skipped. This is the "change all" case that spans models — picking
/// "night mode" across a group where only some products have one.
export function setModeWhereSupported(
  items: BessSeqItem[],
  mode: string,
  modesFor: (scope: CatalogScope, modelId: string) => string[],
): BulkResult {
  let changed = 0;
  let units = 0;
  let skipped = 0;
  let skippedUnits = 0;
  const sequence = mapAllSegments(items, (sg) => {
    if (!modesFor(sg.catalogScope, sg.modelId).includes(mode)) {
      skipped++;
      skippedUnits += sg.count;
      return sg;
    }
    if (sg.modeOverride === mode) return sg;   // already there — not a change
    changed++;
    units += sg.count;
    return { ...sg, modeOverride: mode };
  });
  return { sequence, changed, units, skipped, skippedUnits };
}

/// One-line report for the toast, e.g.
/// "12 units set to night. 4 skipped (mode not available)."
export function describeBulk(r: BulkResult, what: string): string {
  const parts = [`${r.units} unit${r.units === 1 ? '' : 's'} ${what}.`];
  if (r.skipped > 0) {
    parts.push(
      `${r.skippedUnits} unit${r.skippedUnits === 1 ? '' : 's'} skipped (mode not available).`,
    );
  }
  return parts.join(' ');
}
