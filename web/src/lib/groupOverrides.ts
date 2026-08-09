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

/// A bulk edit: either one patch for every target, or a function computing the
/// patch from the source it applies to.
///
/// The function form exists for edits that have to READ each target before they
/// can write it — setting just the night mode has to keep whatever day and
/// evening were already resolving to, and those can differ across a selection.
/// A single shared patch can only overwrite.
export type BulkSourcePatch = Partial<Source> | ((s: Source) => Partial<Source>);

/// Apply `patch` to every source in `ids`, recording it as a per-unit override
/// for any target that belongs to a BESS group.
///
/// Sources outside a group are patched normally — nothing regenerates them, so
/// there is nothing to survive.
export function applyPatchWithGroupOverrides(
  project: Project,
  ids: readonly string[],
  patch: BulkSourcePatch,
): Project {
  const idSet = new Set(ids);
  if (idSet.size === 0) return project;
  const patchFor = typeof patch === 'function' ? patch : () => patch;

  // Each target's patch is computed once and reused for its override, so the
  // stored override cannot drift from what the live source was given.
  const patches = new Map<string, Partial<Source>>();
  const sources = project.sources.map((s) => {
    if (!idSet.has(s.id)) return s;
    const p = patchFor(s);
    patches.set(s.id, p);
    return { ...s, ...p };
  });

  // slotKey → override, per group id, for the targets that are group members
  // AND whose patch contains something worth persisting. Built before the map
  // below so a patch that survives no regeneration (a rename, say) leaves every
  // group object untouched rather than replacing it with an equal copy.
  const bySlot = new Map<string, Array<{ slot: string; override: BessUnitOverride }>>();
  for (const s of project.sources) {
    if (!idSet.has(s.id) || !s.groupId || !s.slotKey) continue;
    const override = patchToOverride(patches.get(s.id) ?? {});
    if (!override) continue;
    const list = bySlot.get(s.groupId) ?? [];
    list.push({ slot: s.slotKey, override });
    bySlot.set(s.groupId, list);
  }
  if (bySlot.size === 0) return { ...project, sources };

  const bessGroups = (project.bessGroups ?? []).map((g) => {
    const slots = bySlot.get(g.id);
    if (!slots) return g;
    const next: BessGroup['unitOverrides'] = { ...(g.unitOverrides ?? {}) };
    for (const { slot, override } of slots) {
      // Merge, don't replace — a unit may already carry a position nudge that
      // this edit says nothing about.
      next[slot] = { ...(next[slot] ?? {}), ...override };
    }
    return { ...g, unitOverrides: next };
  });

  return { ...project, sources, bessGroups };
}

/// One targeted bulk edit: a patch (or per-source patch function) aimed at a
/// specific set of source ids.
export interface BulkOp {
  ids: readonly string[];
  patch: BulkSourcePatch;
}

/// Fold several targeted edits into ONE edit over the union of their targets.
///
/// The bulk editor's Apply used to issue one project update per drafted group
/// (plus one for the WTG-only fields), each computed from the same stale
/// render snapshot — so with two or more drafts the last write silently
/// discarded every earlier one. Merging first means one update, one undo step,
/// and no ordering to get wrong.
///
/// Ops apply in array order: where two target the same source, later ops win
/// per FIELD, matching what sequential applications would have produced had
/// they composed correctly.
export function mergeBulkOps(ops: readonly BulkOp[]): BulkOp | null {
  const live = ops.filter((op) => op.ids.length > 0);
  if (live.length === 0) return null;
  if (live.length === 1) return live[0];
  const sets = live.map((op) => new Set(op.ids));
  const ids = [...new Set(live.flatMap((op) => op.ids))];
  return {
    ids,
    patch: (s: Source) => {
      let merged: Partial<Source> = {};
      for (let i = 0; i < live.length; i++) {
        if (!sets[i].has(s.id)) continue;
        const p = live[i].patch;
        merged = { ...merged, ...(typeof p === 'function' ? p(s) : p) };
      }
      return merged;
    },
  };
}

/// Drop the given override FIELDS from every slot of a group — or, with
/// `slotFilter`, only from the slots it accepts.
///
/// This is the "change all overwrites manual edits" path: after a wizard bulk
/// model or mode swap, per-unit overrides of those same fields must go, or the
/// stale override immediately re-applies over the new value and the bulk edit
/// looks like it silently failed on exactly the units the user had tuned.
/// Other override fields (a position nudge) are untouched.
///
/// `slotFilter` exists because a bulk edit scoped to ONE model must not wipe
/// hand-set modes on units of other models in the same group: a night-Off on
/// an inverter has nothing to do with changing the BESS fan curve, and losing
/// it puts a source back into a period the user took it out of.
export function clearOverriddenFields(
  group: BessGroup,
  fields: ReadonlyArray<keyof BessUnitOverride>,
  slotFilter?: (slotKey: string) => boolean,
): BessGroup {
  const cur = group.unitOverrides;
  if (!cur) return group;
  const next: BessGroup['unitOverrides'] = {};
  for (const [slot, ov] of Object.entries(cur)) {
    if (slotFilter && !slotFilter(slot)) { next[slot] = ov; continue; }
    const copy = { ...ov } as Record<string, unknown>;
    for (const f of fields) delete copy[f as string];
    // Drop slots whose override is now empty rather than leaving `{}` behind.
    if (Object.keys(copy).length > 0) next[slot] = copy as BessUnitOverride;
  }
  return { ...group, unitOverrides: next };
}
