// Compliance comparison — the single place a level is judged against a limit.
//
// Compliance is jurisdiction-flavoured. Most Australian conditions are written
// against whole-decibel limits, so a level is rounded to the nearest integer
// before the comparison and only a genuine exceedance fails: 40.4 dB rounds to
// 40, which does not exceed a 40 dB limit, so it passes. 40.6 rounds to 41 and
// fails. Some jurisdictions want the exact comparison instead, so it's a
// per-project setting.
//
// EVERY pass/fail decision in the app must come through `exceedsLimit` — marker
// colours, list rows, the results dock, exporters, PDF colours, the factorial
// matrix. An inline `level > limit` anywhere else is a bug: it silently opts
// that surface out of the project's chosen rule, and the surfaces then disagree
// with each other on the same receiver.

import type { Project } from './types';

export type LimitComparison = 'integer' | 'exact';

/// The project's comparison rule. Absent ⇒ `'integer'` — the locked default.
///
/// Note this means existing projects change verdict the first time they are
/// reopened after this shipped: a receiver at 40.4 against a 40 dB limit was
/// red and is now green. That is the intended default, not a regression.
export function limitComparisonFor(project: Project): LimitComparison {
  return project.settings?.limitComparison ?? 'integer';
}

/// The level a receiver is JUDGED on: its solved level plus any tonality
/// penalty. Falls back to the solved level, so a result from before tonality
/// existed — or one where the penalty is off, which is the default — behaves
/// exactly as it did.
///
/// Every pass/fail site reads this rather than `totalDbA`: the penalty is
/// decided once, in the solve, and a site that judged the raw level would show
/// a green badge beside a red export.
export function assessedLevel(
  result: { totalDbA: number; assessedDbA?: number } | null | undefined,
): number | null {
  if (!result) return null;
  const v = result.assessedDbA ?? result.totalDbA;
  return Number.isFinite(v) ? v : null;
}

/// Does `levelDbA` exceed `limitDbA` under the given rule?
///
/// - `'integer'` (default): `Math.round(level) > limit`. Standard half-up
///   rounding, so 40.5 → 41 (fails a 40 limit) but 40.4 → 40 (passes).
///   Only the LEVEL rounds — the limit is compared as entered, because it is a
///   set value rather than a measurement.
/// - `'exact'`: `level > limit`, unrounded.
///
/// Equality passes under both rules: the test is for *exceedance*, so a level
/// landing exactly on the limit complies.
///
/// A null / non-finite level is "no result", not a failure — callers that want
/// to show a dash should check for that separately.
///
/// Negative levels round the same way (`Math.round(-40.5)` is −40, i.e. half-up
/// toward +∞); no real receiver sits there, but the behaviour is defined.
///
/// The level passed in should come from `assessedLevel`, not straight off
/// `totalDbA`.
export function exceedsLimit(
  levelDbA: number | null | undefined,
  limitDbA: number,
  mode: LimitComparison,
): boolean {
  if (levelDbA == null || !Number.isFinite(levelDbA) || !Number.isFinite(limitDbA)) {
    return false;
  }
  const level = mode === 'integer' ? Math.round(levelDbA) : levelDbA;
  return level > limitDbA;
}
