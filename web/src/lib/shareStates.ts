// What a share can be built from: the states this session has actually
// computed, priced so the publisher can choose.
//
// The viewer does no calculation, so a share can only ever show a state that
// was solved BEFORE it was published. That makes this list the whole of what a
// reader will be able to switch between — and it is why the publish dialog
// prices each one rather than quietly assembling everything: a full raster is
// a few hundred kB, a Firestore document stops at 1 MB, and the difference
// between "fits" and "does not" is which boxes are ticked.
//
// Two sources, and no third:
//
//   - THE CURRENT SCREEN — the active period at the scenario wind speed, from
//     the results already on the map.
//   - A WIND SWEEP — every (period, wind speed) a sweep in this session
//     solved.
//
// Deliberately NOT offered: the other two periods at the current wind speed.
// Producing those means solving them, and a publish dialog that silently runs
// three more solves is both slow and a different feature. Someone who wants
// all three periods runs a sweep with all three ticked, which is what the
// sweep is for and yields a better share anyway.

import type { GridResult, ReceiverResult } from './solver';
import type { Period, Project } from './types';
import type { SweepResult } from './windSweep';
import { assessedLevel, exceedsLimit, limitComparisonFor, limitFor } from './limits';
import { PERIOD_LABEL } from './modes';
import {
  jsonBytes, shareGridOf,
  type ShareReceiverLevel, type ShareState,
} from './share';

/// One publishable state, with everything the dialog needs to draw a row.
export interface AvailableState {
  /// Stable across re-renders and unique per (period, wind speed, origin), so
  /// a tick survives the list being rebuilt.
  key: string;
  period: Period;
  windSpeed: number;
  origin: 'current' | 'sweep';
  label: string;
  /// The receivers half — always present, always cheap.
  receivers: ShareReceiverLevel[];
  /// The raster, when this state has one. Held separately from the state so
  /// the dialog can price and exclude it: it is almost always the difference
  /// between a share that fits and one that does not.
  grid: GridResult | null;
  /// Bytes the receivers half costs, and bytes the grid would add.
  receiverBytes: number;
  gridBytes: number;
}

/// Everything the dialog can offer, cheapest first within each origin.
export function collectShareStates(input: {
  project: Project;
  /// Receiver results for the ACTIVE period, as the map is showing them.
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  sweep: SweepResult | null;
}): AvailableState[] {
  const { project, results, grid, sweep } = input;
  const out: AvailableState[] = [];

  const current = buildState(
    project,
    project.scenario.period,
    project.scenario.windSpeed,
    results,
    grid,
    'current',
  );
  if (current) out.push(current);

  for (const s of sweep?.states ?? []) {
    // A sweep state that duplicates the current screen is not offered twice.
    // They are the same (period, wind speed); which of the two rasters ends up
    // in the share does not matter, but two identical rows in the dialog does.
    if (current && s.period === current.period && s.windSpeed === current.windSpeed) continue;
    const built = buildState(project, s.period, s.windSpeed, s.receivers, s.grid, 'sweep');
    if (built) out.push(built);
  }
  return out;
}

function buildState(
  project: Project,
  period: Period,
  windSpeed: number,
  results: ReceiverResult[] | null,
  grid: GridResult | null,
  origin: 'current' | 'sweep',
): AvailableState | null {
  // Nothing solved means nothing to publish. A state with no levels and no
  // raster would render as an empty map with a period label — worse than not
  // offering it, because the reader cannot tell it apart from a compliant one.
  if ((!results || results.length === 0) && !grid) return null;

  const comparison = limitComparisonFor(project);
  const receivers: ShareReceiverLevel[] = project.receivers.map((rx) => {
    const r = results?.find((x) => x.receiverId === rx.id);
    const levelDb = r && Number.isFinite(r.totalDbA) ? r.totalDbA : null;
    const assessedDb = assessedLevel(r);
    // Resolved at THIS state's wind speed. With limit tables in use the limit
    // differs between states, so it travels with the state rather than with
    // the receiver — the same rule the wind sweep follows.
    const limitDb = limitFor(project, rx, period, windSpeed);
    return {
      id: rx.id,
      levelDb,
      assessedDb,
      limitDb,
      exceeds: exceedsLimit(assessedDb, limitDb, comparison),
    };
  });

  return {
    key: `${origin}:${period}:${windSpeed}`,
    period,
    windSpeed,
    origin,
    label: `${PERIOD_LABEL[period]} · ${windSpeed} m/s${origin === 'current' ? ' (on screen)' : ''}`,
    receivers,
    grid,
    receiverBytes: jsonBytes(receivers),
    gridBytes: grid ? jsonBytes(shareGridOf(grid)) : 0,
  };
}

/// Total bytes for a selection, before contours are traced.
///
/// An UNDER-estimate by design, and the dialog says so: contour polylines are
/// only known once traced, which costs real work per state. Erring low here
/// would be dangerous if the publish then silently truncated — it does not.
/// The function checks the true size and refuses, so the estimate's job is to
/// steer the choice, not to be the guarantee.
export function estimateBytes(
  states: readonly AvailableState[],
  selected: ReadonlySet<string>,
  includeGrid: boolean,
): number {
  let total = 0;
  for (const s of states) {
    if (!selected.has(s.key)) continue;
    total += s.receiverBytes;
    if (includeGrid) total += s.gridBytes;
  }
  return total;
}

/// Assemble the states to send, given a selection.
///
/// Contours are supplied by the caller (tracing needs the worker and the
/// display levels), so this stays pure and testable.
export function shareStatesFor(
  states: readonly AvailableState[],
  selected: ReadonlySet<string>,
  includeGrid: boolean,
  contoursByKey: ReadonlyMap<string, ShareState['contours']>,
): ShareState[] {
  const out: ShareState[] = [];
  for (const s of states) {
    if (!selected.has(s.key)) continue;
    const contours = contoursByKey.get(s.key);
    out.push({
      period: s.period,
      windSpeed: s.windSpeed,
      receivers: s.receivers,
      ...(contours && contours.length > 0 ? { contours } : {}),
      ...(includeGrid && s.grid ? { grid: shareGridOf(s.grid) } : {}),
    });
  }
  return out;
}
