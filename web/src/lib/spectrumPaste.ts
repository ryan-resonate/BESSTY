// Paste a range of levels from Excel into a spectrum grid.
//
// Excel puts a copied range on the clipboard as TSV: a horizontal range is one
// line of tab-separated values, a vertical range is one value per line. Both are
// the same thing to us — a list of levels to drop into consecutive bands — so we
// accept either and reject only a genuine 2-D block, where "which way do these
// go?" has no honest answer.
//
// Blank cells are preserved as `null` (leave that band untouched) rather than
// dropped. Dropping them would shift every subsequent value up a band, quietly
// assigning the wrong level to the wrong frequency — the kind of error that
// survives review because the numbers all look plausible.

export type PastedValue = number | null;

export type SpectrumPasteResult =
  | { ok: true; values: PastedValue[]; orientation: 'row' | 'column' | 'single' }
  | { ok: false; reason: string };

/** Split on any line ending, dropping trailing blank lines (Excel adds one). */
function toLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines;
}

/// Parse clipboard text into a list of levels.
///
/// Accepts a single row (tab-separated), a single column (one per line), or a
/// single value. A block with both multiple rows AND multiple columns is
/// rejected — the caller should tell the user to paste one row or column.
export function parseSpectrumPaste(text: string): SpectrumPasteResult {
  const lines = toLines(text);
  if (lines.length === 0) return { ok: false, reason: 'Nothing to paste.' };

  const rows = lines.map((l) => l.split('\t'));
  const widest = Math.max(...rows.map((r) => r.length));

  let tokens: string[];
  let orientation: 'row' | 'column' | 'single';
  if (rows.length === 1 && widest === 1) {
    tokens = rows[0];
    orientation = 'single';
  } else if (rows.length === 1) {
    tokens = rows[0];
    orientation = 'row';
  } else if (widest === 1) {
    tokens = rows.map((r) => r[0]);
    orientation = 'column';
  } else {
    return {
      ok: false,
      reason: `That looks like a ${rows.length} × ${widest} block. Paste a single row or column of levels.`,
    };
  }

  const values: PastedValue[] = [];
  for (const raw of tokens) {
    const t = raw.trim();
    if (t === '') { values.push(null); continue; }   // blank → leave the band alone
    const n = Number(t);
    if (!Number.isFinite(n)) {
      return { ok: false, reason: `"${t}" isn't a number — nothing was pasted.` };
    }
    values.push(n);
  }
  // An all-blank paste is not an error, but it isn't a paste either.
  if (values.every((v) => v === null)) {
    return { ok: false, reason: 'Those cells are empty — nothing to paste.' };
  }
  return { ok: true, values, orientation };
}

export interface SpectrumPasteApplied {
  /// The column's new values, length unchanged.
  next: number[];
  /// How many values were written.
  written: number;
  /// Values that fell past the last band and were ignored.
  overflow: number;
  /// Blank cells in the paste that were skipped, leaving the band as it was.
  skipped: number;
}

/// Write `values` into `existing` starting at `startIndex`, running forward.
/// Cells before the start are untouched; values past the end are ignored.
export function applySpectrumPaste(
  existing: readonly number[],
  startIndex: number,
  values: readonly PastedValue[],
  bandCount: number,
): SpectrumPasteApplied {
  const next = Array.from({ length: bandCount }, (_, i) => existing[i] ?? 0);
  let written = 0;
  let overflow = 0;
  let skipped = 0;
  for (let k = 0; k < values.length; k++) {
    const target = startIndex + k;
    if (target >= bandCount) { overflow++; continue; }
    const v = values[k];
    if (v === null) { skipped++; continue; }
    next[target] = v;
    written++;
  }
  return { next, written, overflow, skipped };
}

/// Human summary for the toast, or `null` when the paste was unremarkable
/// (everything landed, nothing skipped) and doesn't need announcing.
export function describePaste(a: SpectrumPasteApplied, bandCount: number): string | null {
  const bits: string[] = [];
  if (a.overflow > 0) {
    bits.push(`${a.overflow} value${a.overflow === 1 ? '' : 's'} past the last band ignored`);
  }
  if (a.skipped > 0) {
    bits.push(`${a.skipped} blank cell${a.skipped === 1 ? '' : 's'} left unchanged`);
  }
  if (bits.length === 0) return null;
  return `${a.written} of ${bandCount} bands filled — ${bits.join('; ')}.`;
}
