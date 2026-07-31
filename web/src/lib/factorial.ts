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

import type { Project, Source, SourceKind } from './types';

/// One option on an axis: a model plus the mode to run it in. The same model
/// may appear more than once under different modes.
export interface Candidate {
  catalogScope: Source['catalogScope'];
  modelId: string;
  mode: string | null;
  /// Display label, e.g. "Megapack 2 XL — night".
  label: string;
}

/// What an axis controls. Either every source of a kind, or just the members of
/// one BESS group — a group typically holds BOTH batteries and inverters, so
/// "the inverters inside Row A" has to be expressible independently of "the
/// inverters inside Row B".
export type AxisScope =
  | { kind: 'all'; sourceKind: SourceKind }
  | { kind: 'group'; groupId: string; sourceKind: SourceKind };

export interface AxisScopeOption {
  scope: AxisScope;
  label: string;
  sourceIds: string[];
}

/// Every scope worth offering, given what the project actually contains.
/// Scopes with no members are omitted — an axis you cannot populate is noise.
export function axisScopeOptions(project: Project): AxisScopeOption[] {
  const out: AxisScopeOption[] = [];
  const groups = project.bessGroups ?? [];
  for (const sourceKind of ['bess', 'auxiliary'] as SourceKind[]) {
    const all = project.sources.filter((s) => s.kind === sourceKind);
    if (all.length > 0) {
      out.push({
        scope: { kind: 'all', sourceKind },
        label: `All ${sourceKind === 'bess' ? 'BESS' : 'auxiliary'} (${all.length})`,
        sourceIds: all.map((s) => s.id),
      });
    }
    for (const g of groups) {
      const ids = all.filter((s) => s.groupId === g.id).map((s) => s.id);
      if (ids.length === 0) continue;
      out.push({
        scope: { kind: 'group', groupId: g.id, sourceKind },
        label: `${g.name} — ${sourceKind === 'bess' ? 'BESS' : 'auxiliary'} (${ids.length})`,
        sourceIds: ids,
      });
    }
  }
  return out;
}

/// Stable key for a scope, for use as a select value.
export function scopeKey(s: AxisScope): string {
  return s.kind === 'all' ? `all:${s.sourceKind}` : `group:${s.groupId}:${s.sourceKind}`;
}

export interface AxisSpec {
  /// Source ids this axis controls.
  sourceIds: string[];
  candidates: Candidate[];
}

/// Sources claimed by BOTH axes.
///
/// `projectForCombo` resolves a conflict by letting axis 1 win, which would
/// mean axis 2 silently does nothing for those units — a study that looks like
/// it varied something it did not. Callers must refuse to run while this is
/// non-empty.
export function axisOverlap(a: AxisSpec, b: AxisSpec): string[] {
  const set = new Set(a.sourceIds);
  return b.sourceIds.filter((id) => set.has(id));
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
