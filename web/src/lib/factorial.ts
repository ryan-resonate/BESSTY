// I14 — factorial configuration study: battery candidates × inverter
// candidates, everything else held constant.
//
// The one rule that matters: THE PROJECT IS NEVER MUTATED. Each combination is
// solved against a cloned, swapped copy; the live document is untouched, so a
// study can be run mid-edit without risk and cancelled without cleanup. The
// gate test asserts the project JSON is byte-identical after a run.
//
// Results are transient by design — re-run to refresh. Persisting them would
// mean invalidating them on every source edit, and a stale matrix that looks
// current is worse than no matrix.

import type { Project, Source } from './types';

/// One option on an axis: a model plus the mode to run it in. The same model
/// may appear more than once under different modes.
export interface Candidate {
  catalogScope: Source['catalogScope'];
  modelId: string;
  mode: string | null;
  /// Display label, e.g. "Megapack 2 XL — night".
  label: string;
}

export interface AxisSpec {
  /// Source ids this axis controls.
  sourceIds: string[];
  candidates: Candidate[];
}

export interface Combo {
  battery: Candidate;
  inverter: Candidate;
  batteryIdx: number;
  inverterIdx: number;
}

/// Every (battery, inverter) pair, batteries varying fastest so the matrix
/// reads batteries-across-the-top as locked.
export function enumerateCombos(battery: AxisSpec, inverter: AxisSpec): Combo[] {
  const out: Combo[] = [];
  inverter.candidates.forEach((inv, i) => {
    battery.candidates.forEach((bat, b) => {
      out.push({ battery: bat, inverter: inv, batteryIdx: b, inverterIdx: i });
    });
  });
  return out;
}

/// A copy of `project` with the axis members swapped to this combination.
///
/// Returns a NEW project; the input is not touched at any depth that matters
/// (sources are replaced, not edited in place).
export function projectForCombo(
  project: Project,
  battery: AxisSpec,
  inverter: AxisSpec,
  combo: Combo,
): Project {
  const bat = new Set(battery.sourceIds);
  const inv = new Set(inverter.sourceIds);
  const sources = project.sources.map((s) => {
    const c = bat.has(s.id) ? combo.battery : inv.has(s.id) ? combo.inverter : null;
    if (!c) return s;
    return {
      ...s,
      catalogScope: c.catalogScope,
      modelId: c.modelId,
      modeOverride: c.mode,
    };
  });
  return { ...project, sources };
}

export interface ComboResult {
  combo: Combo;
  /// Receiver id → total dB(A). Missing = no result for that receiver.
  byReceiver: Map<string, number>;
}

/// Worst (highest) level across the selected receivers, or null if none solved.
export function worstOf(r: ComboResult, receiverIds: readonly string[]): number | null {
  let worst: number | null = null;
  for (const id of receiverIds) {
    const v = r.byReceiver.get(id);
    if (v == null || !Number.isFinite(v)) continue;
    if (worst == null || v > worst) worst = v;
  }
  return worst;
}

/// Candidate label from a catalog display name and mode.
export function candidateLabel(displayName: string, mode: string | null): string {
  return mode ? `${displayName} — ${mode}` : displayName;
}

/// Deep-equality check used by the gate test: did the run leave the project
/// exactly as it found it?
export function projectFingerprint(project: Project): string {
  return JSON.stringify(project);
}
