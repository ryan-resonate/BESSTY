// Wind-speed-dependent receiver limits.
//
// A wind-farm condition is usually a limit CURVE, not a number: the permitted
// level rises with wind speed because the background it sits in does too. A
// single scalar per period cannot express that, so a receiver may carry a grid
// of period × integer wind speed.
//
// One rule, and it is the same rule the assessed-level work landed on: every
// pass/fail site resolves through `resolveLimit` here (re-exported by
// `lib/limits.ts`). A surface that reaches into `limitTable` itself, or that
// keeps calling `limitForPeriod`, judges against a different number than the
// surface beside it — and both look right in isolation.
//
// The lookup is deliberately gated by the project setting rather than by the
// mere presence of a table. A stored table silently overriding the scalar
// limits would change every verdict on a project whose editor is hidden.

import type { LimitTable, Period, Project, Receiver } from './types';
import { limitForPeriod } from './types';
import { PERIODS } from './modes';

export function windSpeedLimitsEnabled(project: Project): boolean {
  return project.settings?.compliance?.windSpeedLimits === true;
}

/// Where a resolved limit came from. Surfaced so the UI can explain a number
/// the user didn't type — particularly `clamped`, which is the one case where
/// the limit shown is not a value in the table.
export type LimitSource = 'scalar' | 'table' | 'clamped';

export interface ResolvedLimit {
  db: number;
  source: LimitSource;
  /// The table wind speed actually used. Only set for table hits; differs from
  /// the requested speed exactly when `source` is `'clamped'`.
  atWindSpeed?: number;
}

/// Wind speeds are binned to integers — 8 m/s means the 7.5–8.5 m/s bin (Q16),
/// and the same binning decides which column of a limit table applies.
export function windSpeedBin(windSpeed: number): number {
  return Math.round(windSpeed);
}

/// Is this table usable — at least one wind speed, and every period row the
/// same length as `windSpeeds`?
///
/// A ragged table is rejected rather than padded: padding invents limits, and a
/// limit nobody entered is the worst possible thing to judge a project against.
export function isUsableTable(t: LimitTable | undefined): t is LimitTable {
  if (!t || !Array.isArray(t.windSpeeds) || t.windSpeeds.length === 0) return false;
  if (!t.windSpeeds.every((w) => Number.isFinite(w))) return false;
  return PERIODS.every((p) => {
    const row = t.limits?.[p];
    return Array.isArray(row) && row.length === t.windSpeeds.length
      && row.every((v) => Number.isFinite(v));
  });
}

/// The limit for one receiver, period and wind speed.
///
/// A wind speed the table doesn't name resolves to its NEAREST wind speed
/// rather than falling back to the scalar limit or being interpolated:
///
///   - Off the ends, limit curves plateau, so the nearest end is the intended
///     reading. Mixing a table limit at 10 m/s with a scalar limit at 25 m/s in
///     the same column would be incoherent.
///   - In an interior gap (a sparse table), interpolating would INVENT a limit.
///     A limit is a set value, not a measurement; 39 dB at 9 m/s is not implied
///     by 38 at 8 and 40 at 10, it is made up.
///
/// A tie takes the LOWER wind speed. Limit curves rise with wind speed, so that
/// is the stricter of the two — and it is fixed here rather than left to array
/// order, where it would depend on how the table happened to be sorted.
///
/// Either way `source` reports `'clamped'`, so a surface can say the wind speed
/// is off the table instead of presenting the number as if it were entered.
export function resolveLimit(
  project: Project,
  receiver: Receiver,
  period: Period = project.scenario.period,
  windSpeed: number = project.scenario.windSpeed,
): ResolvedLimit {
  const table = receiver.limitTable;
  if (!windSpeedLimitsEnabled(project) || !isUsableTable(table)) {
    return { db: limitForPeriod(receiver, period), source: 'scalar' };
  }
  const want = windSpeedBin(windSpeed);
  const exact = table.windSpeeds.indexOf(want);
  if (exact >= 0) {
    return { db: table.limits[period][exact], source: 'table', atWindSpeed: want };
  }
  // Nearest wind speed, ties to the lower one. `windSpeeds` is kept ascending
  // by `normaliseTable`, but this does not assume it — a hand-edited document
  // should not produce nonsense, and the tie-break must not depend on order.
  let bestIdx = 0;
  let bestGap = Infinity;
  for (let i = 0; i < table.windSpeeds.length; i++) {
    const gap = Math.abs(table.windSpeeds[i] - want);
    const tie = gap === bestGap && table.windSpeeds[i] < table.windSpeeds[bestIdx];
    if (gap < bestGap || tie) { bestGap = gap; bestIdx = i; }
  }
  return {
    db: table.limits[period][bestIdx],
    source: 'clamped',
    atWindSpeed: table.windSpeeds[bestIdx],
  };
}

/// The scalar form, for the many call sites that just want the number.
export function limitFor(
  project: Project,
  receiver: Receiver,
  period?: Period,
  windSpeed?: number,
): number {
  return resolveLimit(project, receiver, period, windSpeed).db;
}

/// Sort a table by ascending wind speed, dropping duplicate speeds (last wins)
/// and any column whose speed isn't finite. Keeps every period row in step.
export function normaliseTable(t: LimitTable): LimitTable {
  const byWs = new Map<number, { day: number; evening: number; night: number }>();
  for (let i = 0; i < t.windSpeeds.length; i++) {
    const ws = windSpeedBin(t.windSpeeds[i]);
    if (!Number.isFinite(ws)) continue;
    byWs.set(ws, {
      day: t.limits.day?.[i] ?? NaN,
      evening: t.limits.evening?.[i] ?? NaN,
      night: t.limits.night?.[i] ?? NaN,
    });
  }
  const windSpeeds = [...byWs.keys()].sort((a, b) => a - b);
  return {
    windSpeeds,
    limits: {
      day: windSpeeds.map((w) => byWs.get(w)!.day),
      evening: windSpeeds.map((w) => byWs.get(w)!.evening),
      night: windSpeeds.map((w) => byWs.get(w)!.night),
    },
  };
}

/// An empty table spanning `windSpeeds`, seeded from the receiver's scalar
/// limits — so switching the feature on starts from what the project already
/// says rather than from blanks the user must retype.
export function tableFromScalars(r: Receiver, windSpeeds: number[]): LimitTable {
  const ws = [...new Set(windSpeeds.map(windSpeedBin))].sort((a, b) => a - b);
  return {
    windSpeeds: ws,
    limits: {
      day: ws.map(() => limitForPeriod(r, 'day')),
      evening: ws.map(() => limitForPeriod(r, 'evening')),
      night: ws.map(() => limitForPeriod(r, 'night')),
    },
  };
}

// ------------------------------------------------------------------ pasting

/** Split on any line ending, dropping trailing blank lines (Excel adds one). */
function toLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/// Excel puts a copied range on the clipboard as TSV. Users also paste CSV out
/// of a report, so a line with no tabs falls back to commas.
function splitCells(line: string): string[] {
  return (line.includes('\t') ? line.split('\t') : line.split(',')).map((c) => c.trim());
}

function parseNumber(raw: string): number | null {
  if (raw === '') return null;
  // Tolerate thousands separators and a trailing unit ("42 dB", "1,013").
  const cleaned = raw.replace(/,(?=\d{3}\b)/g, '').replace(/\s*d?B?\(?[ACZ]?\)?$/i, '').trim();
  // A cell holding ONLY a unit — "dB", "dBA", a stray "A" from a merged header
  // — is consumed entirely by the strip above, and `Number('')` is 0. Without
  // this line that becomes an accepted 0 dB limit: a value nobody entered,
  // which is the one thing this module exists to prevent.
  if (cleaned === '') return null;
  const v = Number(cleaned);
  return Number.isFinite(v) ? v : null;
}

export type LimitPasteResult =
  | { ok: true; table: LimitTable; note?: string }
  | { ok: false; reason: string };

/// Parse a pasted grid for ONE receiver: a header row of wind speeds and one
/// row per period.
///
/// Accepts the row labels being present or absent. With labels, rows are
/// matched by name so the user can paste them in any order; without, they are
/// taken as day / evening / night in that order and a note says so — guessing
/// silently would be how a night limit ends up enforced during the day.
export function parseLimitGrid(text: string): LimitPasteResult {
  const lines = toLines(text);
  if (lines.length === 0) return { ok: false, reason: 'Nothing to paste.' };
  const rows = lines.map(splitCells);

  const header = rows[0];
  // A leading corner cell ("", "Receiver", "Period") is common when the block
  // was copied with its row labels.
  const headerHasCorner = parseNumber(header[0]) == null;
  const speeds = (headerHasCorner ? header.slice(1) : header).map(parseNumber);
  if (speeds.length === 0 || speeds.some((s) => s == null)) {
    return {
      ok: false,
      reason: 'The first row must be the wind speeds (e.g. 3, 4, 5 …), one per column.',
    };
  }
  const windSpeeds = (speeds as number[]).map(windSpeedBin);

  const body = rows.slice(1).filter((r) => r.some((c) => c !== ''));
  if (body.length < 3) {
    return {
      ok: false,
      reason: `Expected three rows of limits (day, evening, night); found ${body.length}.`,
    };
  }

  const limits: Record<Period, number[]> = { day: [], evening: [], night: [] };
  const labelled = body.every((r) => parseNumber(r[0]) == null);
  let note: string | undefined;

  if (labelled) {
    for (const p of PERIODS) {
      const row = body.find((r) => r[0].trim().toLowerCase().startsWith(p[0] === 'e' ? 'even' : p));
      if (!row) return { ok: false, reason: `No row labelled "${p}".` };
      const vals = row.slice(1).map(parseNumber);
      if (vals.length !== windSpeeds.length || vals.some((v) => v == null)) {
        return {
          ok: false,
          reason: `The "${p}" row has ${vals.length} values but there are `
            + `${windSpeeds.length} wind speeds.`,
        };
      }
      limits[p] = vals as number[];
    }
  } else {
    note = 'Rows were unlabelled — read as day, evening, night in that order.';
    for (let i = 0; i < 3; i++) {
      const cells = headerHasCorner && parseNumber(body[i][0]) == null
        ? body[i].slice(1) : body[i];
      const vals = cells.map(parseNumber);
      if (vals.length !== windSpeeds.length || vals.some((v) => v == null)) {
        return {
          ok: false,
          reason: `Row ${i + 1} has ${vals.length} values but there are `
            + `${windSpeeds.length} wind speeds.`,
        };
      }
      limits[PERIODS[i]] = vals as number[];
    }
  }

  return { ok: true, table: normaliseTable({ windSpeeds, limits }), note };
}

// ------------------------------------------------------- bulk (many receivers)

/// One receiver's row out of a bulk block: wind-speed columns × receiver rows,
/// for a single period (decision B).
export interface BulkLimitRow {
  name: string;
  values: number[];
}

export interface BulkLimitBlock {
  windSpeeds: number[];
  rows: BulkLimitRow[];
}

export type BulkParseResult =
  | { ok: true; block: BulkLimitBlock }
  | { ok: false; reason: string };

/// Parse a bulk block: header row of wind speeds (with a corner cell), then one
/// row per receiver, named in the first column.
export function parseBulkLimits(text: string): BulkParseResult {
  const lines = toLines(text);
  if (lines.length < 2) {
    return { ok: false, reason: 'Expected a header row of wind speeds and at least one receiver row.' };
  }
  const rows = lines.map(splitCells);
  const header = rows[0];
  const speeds = header.slice(1).map(parseNumber);
  if (speeds.length === 0 || speeds.some((s) => s == null)) {
    return {
      ok: false,
      reason: 'The header row must be a corner cell followed by wind speeds (e.g. "", 3, 4, 5 …).',
    };
  }
  const windSpeeds = (speeds as number[]).map(windSpeedBin);

  const out: BulkLimitRow[] = [];
  for (const r of rows.slice(1)) {
    if (r.every((c) => c === '')) continue;
    const name = r[0].trim();
    if (name === '') return { ok: false, reason: 'A receiver row has no name in its first column.' };
    const vals = r.slice(1).map(parseNumber);
    if (vals.length !== windSpeeds.length || vals.some((v) => v == null)) {
      return {
        ok: false,
        reason: `"${name}" has ${vals.filter((v) => v != null).length} limits but there are `
          + `${windSpeeds.length} wind speeds.`,
      };
    }
    out.push({ name, values: vals as number[] });
  }
  if (out.length === 0) return { ok: false, reason: 'No receiver rows found.' };
  return { ok: true, block: { windSpeeds, rows: out } };
}

export interface BulkMatch {
  /// Receiver id → the row that will be written to it.
  matched: Map<string, BulkLimitRow>;
  /// Rows whose name matched no receiver, or that collided with another row on
  /// the same receiver — see `matchBulkRows`. Either way the row was not used,
  /// which is what the importer reports.
  unmatchedRows: string[];
  /// Receivers the file said nothing about. Reported rather than left silently
  /// on stale limits — "not in the file" and "unchanged on purpose" look
  /// identical afterwards, and only one of them is what the user meant.
  missingReceivers: string[];
}

/// Match rows to receivers by name: exact first, then case-insensitive and
/// whitespace-trimmed. Ambiguous matches are left unmatched rather than guessed
/// — in BOTH directions.
///
/// One row naming two receivers was always refused. Two rows naming the SAME
/// receiver used to be last-wins: both counted as used, so neither appeared in
/// `unmatchedRows`, and the importer reported a clean success. A spreadsheet
/// with a corrected row above a stale one — the single most common way these
/// blocks are edited — would then write the stale limit and say nothing. Worse,
/// a later LOOSE match overwrote an earlier EXACT one, inverting the precedence
/// this function documents.
///
/// Both rows are now refused and reported. Refusing is right rather than merely
/// safe: the file genuinely does not say which limit the user meant, and a
/// limit nobody chose is exactly what must never reach a receiver.
export function matchBulkRows(rows: BulkLimitRow[], receivers: Receiver[]): BulkMatch {
  const matched = new Map<string, BulkLimitRow>();
  const usedRows = new Set<BulkLimitRow>();
  /// Receiver ids more than one row claimed, and every row that claimed them.
  const contested = new Map<string, BulkLimitRow[]>();
  const byExact = new Map<string, Receiver[]>();
  const byLoose = new Map<string, Receiver[]>();
  const push = (m: Map<string, Receiver[]>, k: string, r: Receiver) => {
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  };
  for (const r of receivers) {
    push(byExact, r.name, r);
    push(byLoose, r.name.trim().toLowerCase(), r);
  }

  const claim = (id: string, row: BulkLimitRow) => {
    const held = matched.get(id);
    if (held && held !== row) {
      // Second claim on this receiver: neither row wins.
      contested.set(id, [...(contested.get(id) ?? [held]), row]);
      return;
    }
    matched.set(id, row);
    usedRows.add(row);
  };

  for (const row of rows) {
    const exact = byExact.get(row.name);
    if (exact?.length === 1) {
      claim(exact[0].id, row);
      continue;
    }
    const loose = byLoose.get(row.name.trim().toLowerCase());
    if (loose?.length === 1) claim(loose[0].id, row);
  }

  // Drop every contested receiver and un-use the rows that claimed it, so they
  // surface as unmatched and the receiver surfaces as missing. The importer's
  // "imported with gaps" path then names both.
  for (const [id, rowsForId] of contested) {
    matched.delete(id);
    for (const r of rowsForId) usedRows.delete(r);
  }

  return {
    matched,
    unmatchedRows: rows.filter((r) => !usedRows.has(r)).map((r) => r.name),
    missingReceivers: receivers.filter((r) => !matched.has(r.id)).map((r) => r.name),
  };
}

/// Write one period's bulk block onto the receivers it matched, preserving the
/// other two periods of any table already there.
///
/// A receiver whose existing table spans different wind speeds is REPLACED at
/// the incoming speeds, with the untouched periods re-read at those speeds (or
/// left at their scalar limit where the old table doesn't reach). Merging two
/// different wind-speed axes any other way invents limits.
export function applyBulkLimits(
  project: Project,
  period: Period,
  block: BulkLimitBlock,
  matched: Map<string, BulkLimitRow>,
): Receiver[] {
  const ws = block.windSpeeds.map(windSpeedBin);
  return project.receivers.map((r) => {
    const row = matched.get(r.id);
    if (!row) return r;
    const existing = isUsableTable(r.limitTable) ? r.limitTable : undefined;
    const readOther = (p: Period): number[] => ws.map((w) => {
      if (!existing) return limitForPeriod(r, p);
      const i = existing.windSpeeds.indexOf(w);
      return i >= 0 ? existing.limits[p][i] : limitForPeriod(r, p);
    });
    const limits = {
      day: period === 'day' ? [...row.values] : readOther('day'),
      evening: period === 'evening' ? [...row.values] : readOther('evening'),
      night: period === 'night' ? [...row.values] : readOther('night'),
    };
    return { ...r, limitTable: normaliseTable({ windSpeeds: ws, limits }) };
  });
}
