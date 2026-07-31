// I20 — record every approximation a solve applies, so none of them are silent.
//
// BEESTY caps things in several places: it clusters distant sources, resamples
// terrain when a DEM would exceed the grid budget, drops sources past a cutoff
// distance, floors very low grid cells. Each is a reasonable trade, and each
// was invisible. The I13 bug was exactly this failure mode — a cap (4000 debug
// dots) applied by quietly thinning the data, so the output looked plausible
// and misreported reality for months.
//
// In a compliance tool the invisible approximation is the dangerous one. A
// solve now collects notes describing what it capped and what that cost, and
// the UI shows a count the user can open.
//
// Deliberately NOT a logger: notes are returned with the results so they can be
// rendered, exported and reasoned about. Console output is invisible in a
// packaged report.

export type DiagnosticSeverity =
  /// Bounded a resource; numbers essentially unaffected.
  | 'info'
  /// Changed the model in a way that can move levels.
  | 'material';

export interface Diagnostic {
  /// Stable identifier for the cap, e.g. `'terrain.resampled'`. Used to
  /// de-duplicate: a cap that bites on every one of 400 tiles is ONE note.
  code: string;
  severity: DiagnosticSeverity;
  /// One line, plain language, naming the cap and what it cost.
  message: string;
  /// How many times this cap fired (tiles, sources, cells…). 1 unless it
  /// repeated.
  count: number;
}

/// Collects notes during a solve. Cheap to create; pass one down and let each
/// stage report into it.
export class Diagnostics {
  private byCode = new Map<string, Diagnostic>();

  /// Record that a cap fired. Repeat calls with the same `code` increment the
  /// count and keep the FIRST message — the first occurrence carries the
  /// numbers, and 400 near-identical messages help nobody.
  note(code: string, severity: DiagnosticSeverity, message: string, count = 1): void {
    const existing = this.byCode.get(code);
    if (existing) {
      existing.count += count;
      // A cap that turns out to be material anywhere is material overall.
      if (severity === 'material') existing.severity = 'material';
      return;
    }
    this.byCode.set(code, { code, severity, message, count });
  }

  /// Material notes first (they can move levels), then by how often they fired.
  list(): Diagnostic[] {
    return [...this.byCode.values()].sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === 'material' ? -1 : 1;
      return b.count - a.count;
    });
  }

  get size(): number {
    return this.byCode.size;
  }

  /// Fold another collector in — grid tiles solve in a worker and report back
  /// separately, so their notes have to merge without double-counting codes.
  merge(other: Diagnostic[] | Diagnostics): void {
    const items = Array.isArray(other) ? other : other.list();
    for (const d of items) this.note(d.code, d.severity, d.message, d.count);
  }
}

/// Human summary for the dock badge, or `null` when there's nothing to report.
export function summariseDiagnostics(items: readonly Diagnostic[]): string | null {
  if (items.length === 0) return null;
  const material = items.filter((d) => d.severity === 'material').length;
  const n = items.length;
  const noun = `${n} approximation${n === 1 ? '' : 's'}`;
  return material > 0 ? `${noun} · ${material} can move levels` : noun;
}
