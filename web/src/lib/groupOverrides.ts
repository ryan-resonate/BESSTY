// I4 — make selection-based edits stick to BESS-group members.
//
// A group's units are MATERIALISED from its sequence: change a group parameter
// and every unit is regenerated. So patching a materialised source directly is
// a write to a temporary object — the next re-materialisation throws it away,
// and the user's careful per-unit edit silently vanishes.
//
// The fix isn't to detach edited units from their group (locked decision: never
// detach). It's to record the edit in `group.unitOverrides[slotKey]`, which the
// materialiser re-applies after every regeneration. The patch therefore goes to
// two places: the live source, so the UI updates now, and the override map, so
// it survives.
//
// The reverse direction — the wizard's "change all" deliberately overwriting a
// manual edit — is `clearOverriddenFields` below.

import type { BessGroup, BessUnitOverride, Project, Source } from './types';

/// Translate a `Source` patch into the equivalent per-unit override.
///
/// Only fields the materialiser knows how to re-apply are carried; anything
/// else is a live-only edit that a regeneration will legitimately reset (and
/// which the caller has already applied to the source).
///
/// `latLng` is deliberately excluded: the override stores a DELTA from the
/// materialised slot position, which can't be derived from an absolute
/// coordinate without knowing where the slot would land. Map drags already
/// write `latLngDelta` through their own path.
export function patchToOverride(patch: Partial<Source>): BessUnitOverride | null {
  const o: BessUnitOverride = {};
  let any = false;
  if (patch.elevationOffset !== undefined) { o.elevationOffset = patch.elevationOffset; any = true; }
  if (patch.modeOverride !== undefined) { o.modeOverride = patch.modeOverride; any = true; }
  if (patch.modelId !== undefined && patch.catalogScope !== undefined) {
    o.modelOverride = { catalogScope: patch.catalogScope, modelId: patch.modelId };
    any = true;
  }
  return any ? o : null;
}

/// Apply `patch` to every source in `ids`, recording it as a per-unit override
/// for any target that belongs to a BESS group.
///
/// Sources outside a group are patched normally — nothing regenerates them, so
/// there is nothing to survive.
export function applyPatchWithGroupOverrides(
  project: Project,
  ids: readonly string[],
  patch: Partial<Source>,
): Project {
  const idSet = new Set(ids);
  if (idSet.size === 0) return project;

  const sources = project.sources.map((s) => (idSet.has(s.id) ? { ...s, ...patch } : s));

  const override = patchToOverride(patch);
  if (!override) return { ...project, sources };

  // slotKey lists per group id, for the targets that are group members.
  const bySlot = new Map<string, string[]>();
  for (const s of project.sources) {
    if (!idSet.has(s.id) || !s.groupId || !s.slotKey) continue;
    const list = bySlot.get(s.groupId) ?? [];
    list.push(s.slotKey);
    bySlot.set(s.groupId, list);
  }
  if (bySlot.size === 0) return { ...project, sources };

  const bessGroups = (project.bessGroups ?? []).map((g) => {
    const slots = bySlot.get(g.id);
    if (!slots) return g;
    const next: BessGroup['unitOverrides'] = { ...(g.unitOverrides ?? {}) };
    for (const slot of slots) {
      // Merge, don't replace — a unit may already carry a position nudge that
      // this edit says nothing about.
      next[slot] = { ...(next[slot] ?? {}), ...override };
    }
    return { ...g, unitOverrides: next };
  });

  return { ...project, sources, bessGroups };
}

/// Drop the given override FIELDS from every slot of a group.
///
/// This is the "change all overwrites manual edits" path: after a wizard bulk
/// model or mode swap, per-unit overrides of those same fields must go, or the
/// stale override immediately re-applies over the new value and the bulk edit
/// looks like it silently failed on exactly the units the user had tuned.
/// Other override fields (a position nudge) are untouched.
export function clearOverriddenFields(
  group: BessGroup,
  fields: ReadonlyArray<keyof BessUnitOverride>,
): BessGroup {
  const cur = group.unitOverrides;
  if (!cur) return group;
  const next: BessGroup['unitOverrides'] = {};
  for (const [slot, ov] of Object.entries(cur)) {
    const copy = { ...ov } as Record<string, unknown>;
    for (const f of fields) delete copy[f as string];
    // Drop slots whose override is now empty rather than leaving `{}` behind.
    if (Object.keys(copy).length > 0) next[slot] = copy as BessUnitOverride;
  }
  return { ...group, unitOverrides: next };
}
