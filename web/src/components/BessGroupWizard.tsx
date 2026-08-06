// BESS group wizard modal — the form half of the experience designed in
// docs/mockups/bess-group.html. Form on the left (general info + row
// sequence editor), live top-down SVG preview on the right (debounced
// ~200 ms after the last keystroke), Apply / Cancel footer.
//
// Edit mode: when `initialGroup` is supplied we pre-populate; Apply
// passes the modified group back so ProjectScreen can re-materialise
// it (preserving per-slot hand-edits via the existing
// `unitOverrides` map on the group itself).

import { Fragment, useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import { notify } from '../lib/notify';
import { pushEscHandler } from '../lib/escStack';
import {
  describeBulk, mapAllSegments, setModeWhereSupported, swapModel,
} from '../lib/bessBulkSwap';
import { clearOverriddenFields } from '../lib/groupOverrides';
import {
  groupToSequence,
  materialiseBessGroup,
  newBessGroupTemplate,
  type CatalogLookup,
} from '../lib/bessGroups';
import { footprintFor, listEntriesByKind } from '../lib/catalog';
import type {
  BessGroup,
  BessRow,
  BessSegment,
  BessSeqItem,
  CatalogScope,
  Project,
  SourceKind,
} from '../lib/types';

interface Props {
  /// Editing an existing group? Pass it here. Creating a new one?
  /// Leave undefined -- the wizard generates a fresh template from
  /// `defaultBessRef` (the project's most likely default BESS model).
  initialGroup?: BessGroup;
  /// Geographic centre to drop a brand-new group at. Ignored when
  /// editing (the existing group's centerLatLng is kept).
  newGroupCentre: [number, number];
  /// The project the wizard runs against -- used to resolve catalog
  /// references for the preview footprints.
  project: Project;
  catalogLookup: CatalogLookup;
  /// Fired on Apply. Group includes any updated unitOverrides (the
  /// wizard never mutates them; they come through unchanged).
  onApply: (group: BessGroup) => void;
  onCancel: () => void;
}

const DEBOUNCE_MS = 200;

export function BessGroupWizard(props: Props) {
  const { project, catalogLookup, newGroupCentre } = props;

  // Build the initial group once (per mount). Subsequent edits live
  // in `group` state -- we never re-derive from props mid-edit.
  const isEdit = Boolean(props.initialGroup);
  const initial = useMemo<BessGroup>(() => {
    const base = props.initialGroup
      ? clone(props.initialGroup)
      : newBessGroupTemplate(
          `bg-${Date.now().toString(36)}`,
          'New BESS group',
          newGroupCentre,
          defaultBessRef(project),
        );
    // Always edit in the recursive sequence model; convert legacy flat groups
    // on open (layout-preserving, see groupToSequence).
    return { ...base, ...groupToSequence(base) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [group, setGroup] = useState<BessGroup>(initial);
  const [expandedId, setExpandedId] = useState<string | null>(initial.sequence?.[0]?.id ?? null);
  const [editingChipKey, setEditingChipKey] = useState<string | null>(null);

  // Debounced copy for the preview so typing doesn't churn the SVG.
  const [debouncedGroup, setDebouncedGroup] = useState<BessGroup>(group);
  useEffect(() => {
    const h = window.setTimeout(() => setDebouncedGroup(group), DEBOUNCE_MS);
    return () => window.clearTimeout(h);
  }, [group]);

  const materialised = useMemo(
    () => materialiseBessGroup(debouncedGroup, catalogLookup),
    [debouncedGroup, catalogLookup],
  );

  // ===== Mutators (return new group; setGroup applies) =====

  const setName = (name: string) => setGroup((g) => ({ ...g, name }));
  const setRotation = (deg: number) =>
    setGroup((g) => ({ ...g, rotationDeg: Number.isFinite(deg) ? deg : 0 }));
  // Top-level 2-D repeat of the whole sequence ("Repeat whole sequence").
  const setTop = (patch: Partial<Pick<BessGroup, 'repeatDown' | 'gapDownM' | 'repeatRight' | 'gapRightM'>>) =>
    setGroup((g) => ({ ...g, ...patch }));

  // Sequence-tree mutator (functional, so it always reads the latest tree).
  const setSeq = useCallback(
    (fn: (s: BessSeqItem[]) => BessSeqItem[]) => setGroup((g) => ({ ...g, sequence: fn(g.sequence ?? []) })),
    [],
  );
  const mkId = (p: string) => `${group.id}-${p}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const newRowItem = (): BessSeqItem => {
    const def = defaultBessRef(project);
    return {
      kind: 'row', id: mkId('row'), gapAfterM: 2,
      row: {
        id: mkId('row'),
        segments: def ? [{
          id: mkId('seg'), catalogScope: def.catalogScope, modelId: def.modelId,
          count: 8, spacingWithinM: 1.5, gapAfterM: 0, rotationDeg: 0, alignment: 'middle',
        }] : [],
        rowRepeat: 1, gapBetweenCopiesM: 2,
      },
    };
  };
  const newGroupItem = (): BessSeqItem => ({
    kind: 'group', id: mkId('grp'), name: '',
    repeatDown: 1, gapDownM: 2, repeatRight: 1, gapRightM: 2, gapAfterM: 2, items: [],
  });

  const ops: SeqOps = {
    project, expandedId, setExpandedId, editingChipKey, setEditingChipKey,
    patchItem: (id, patch) => setSeq((s) => patchItemById(s, id, patch)),
    patchRow: (id, patch) => setSeq((s) => mapItemById(s, id, (it) =>
      it.kind === 'row' ? { ...it, row: { ...it.row, ...patch } } : it)),
    updateSegment: (id, segIdx, patch) => setSeq((s) => mapItemById(s, id, (it) =>
      it.kind === 'row'
        ? { ...it, row: { ...it.row, segments: it.row.segments.map((sg, j) => (j === segIdx ? { ...sg, ...patch } : sg)) } }
        : it)),
    addSegment: (id) => setSeq((s) => mapItemById(s, id, (it) => {
      if (it.kind !== 'row') return it;
      const def = defaultBessRef(project) ?? defaultRefForKind(project, 'bess') ?? { catalogScope: 'global' as const, modelId: '' };
      const newSeg: BessSegment = { id: mkId('seg'), catalogScope: def.catalogScope, modelId: def.modelId, count: 1, spacingWithinM: 1.5, gapAfterM: 0, rotationDeg: 0, alignment: 'middle' };
      const prev = it.row.segments.map((sg, idx) =>
        idx === it.row.segments.length - 1 && (sg.gapAfterM === 0 || sg.gapAfterM === undefined) ? { ...sg, gapAfterM: 3 } : sg);
      return { ...it, row: { ...it.row, segments: [...prev, newSeg] } };
    })),
    removeSegment: (id, segIdx) => setSeq((s) => mapItemById(s, id, (it) =>
      it.kind === 'row' ? { ...it, row: { ...it.row, segments: it.row.segments.filter((_, j) => j !== segIdx) } } : it)),
    duplicateItem: (id) => setSeq((s) => {
      const orig = findItem(s, id);
      return orig ? insertRelative(s, cloneItem(orig, () => mkId('dup')), { mode: 'after', id }) : s;
    }),
    removeItem: (id) => setSeq((s) => removeItemById(s, id).items),
    wrapInGroup: (id) => setSeq((s) => mapItemById(s, id, (it) => ({
      kind: 'group', id: mkId('grp'), name: '',
      repeatDown: 1, gapDownM: 2, repeatRight: 1, gapRightM: 2,
      gapAfterM: it.gapAfterM, items: [{ ...it, gapAfterM: 0 }],
    }))),
    ungroup: (id) => setSeq((s) => ungroupById(s, id)),
    addRow: (containerId) => setSeq((s) => insertRelative(s, newRowItem(), containerId ? { mode: 'into', id: containerId } : { mode: 'root-end' })),
    addGroup: (containerId) => setSeq((s) => insertRelative(s, newGroupItem(), containerId ? { mode: 'into', id: containerId } : { mode: 'root-end' })),
    move: (dId, target) => setSeq((s) => moveItem(s, dId, target)),
  };

  const seq = group.sequence ?? [];
  const rowCount = countRows(seq);
  const droppedOverrideCount = materialised.droppedOverrideKeys.length;

  // Distinct (kind, model) slices currently in the group, with live unit counts
  // from the materialised preview — drives the bulk model swap.
  const modelGroups = useMemo(() => {
    const map = new Map<string, { key: string; kind: SourceKind; scope: CatalogScope; modelId: string; count: number; name: string }>();
    for (const s of materialised.sources) {
      const key = `${s.kind}::${s.catalogScope}:${s.modelId}`;
      let g = map.get(key);
      if (!g) {
        const entry = catalogLookup(s.catalogScope, s.modelId);
        g = { key, kind: s.kind, scope: s.catalogScope, modelId: s.modelId, count: 0, name: entry?.displayName ?? s.modelId };
        map.set(key, g);
      }
      g.count++;
    }
    return [...map.values()];
  }, [materialised, catalogLookup]);

  // Rewrite every segment of `fromScope:fromModel` to a new model across the
  // whole sequence (nested groups included). Mode resets to the new model's
  // default, since the old mode name may not exist on it.
  const swapModelTo = useCallback(
    (fromScope: CatalogScope, fromModel: string, toScope: CatalogScope, toModel: string) => {
      const defMode = catalogLookup(toScope, toModel)?.defaultMode;
      setGroup((g) => {
        const r = swapModel(
          g.sequence ?? [],
          { scope: fromScope, modelId: fromModel },
          { scope: toScope, modelId: toModel, mode: defMode ?? undefined },
        );
        // I4: "change all" deliberately overwrites manual per-unit edits of the
        // same fields. Leaving them would re-apply the old model over the new
        // one on the next materialisation, so the swap would look like it
        // silently failed on exactly the units the user had tuned.
        return clearOverriddenFields(
          { ...g, sequence: r.sequence },
          ['modelOverride', 'modeOverride'],
        );
      });
    },
    [catalogLookup],
  );

  // I6: set the mode on one model's segments. Every segment in the row shares
  // that model, so this can't skip anything — the skip path belongs to the
  // group-wide control below.
  const setModeForModel = useCallback(
    (scope: CatalogScope, modelId: string, mode: string) => {
      setGroup((g) => clearOverriddenFields({
        ...g,
        sequence: mapAllSegments(g.sequence ?? [], (sg) =>
          sg.catalogScope === scope && sg.modelId === modelId
            ? { ...sg, modeOverride: mode }
            : sg),
      }, ['modeOverride']));
    },
    [],
  );

  // Modes offered by every model currently in the group, and the union of their
  // names — the choices for the group-wide "set every unit to…" control.
  const modesFor = useCallback(
    (scope: CatalogScope, modelId: string) =>
      (catalogLookup(scope, modelId)?.modes ?? []).map((md) => md.name),
    [catalogLookup],
  );
  const allModeNames = useMemo(() => {
    const names = new Set<string>();
    for (const g of modelGroups) for (const n of modesFor(g.scope, g.modelId)) names.add(n);
    return [...names].sort();
  }, [modelGroups, modesFor]);

  // I6: apply one mode name across every model in the group. Models without
  // that mode are left completely alone and reported, rather than silently
  // dropped or forced onto a mode they don't have.
  const setModeEverywhere = useCallback(
    (mode: string) => {
      setGroup((g) => {
        const r = setModeWhereSupported(g.sequence ?? [], mode, modesFor);
        notify.info(describeBulk(r, `set to "${mode}"`));
        return clearOverriddenFields({ ...g, sequence: r.sequence }, ['modeOverride']);
      });
    },
    [modesFor],
  );

  // Esc unwinds one layer at a time: an open segment editor closes first, and
  // only a second press abandons the whole group. Closing the window from
  // under an open sub-panel loses the edit the user was looking at, which is
  // the opposite of what Esc is for. (The footer has always promised this key
  // worked; until now nothing listened for it.)
  //
  // Esc inside a numeric field is handled by NumberDraft, which stops
  // propagation so reverting a field never also closes a panel.
  const { onCancel } = props;
  useEffect(() => pushEscHandler(() => {
    if (editingChipKey !== null) setEditingChipKey(null);
    else onCancel();
  }), [editingChipKey, onCancel]);

  /// I11 — per-unit manual edits (drag a single unit, change one unit's mode
  /// or elevation) are stored as `unitOverrides` and deliberately SURVIVE a
  /// re-materialise, so tweaking the layout doesn't silently discard them.
  /// That makes them invisible and sticky, hence an explicit way out.
  const overrideCount = Object.keys(group.unitOverrides ?? {}).length;
  async function resetOverrides() {
    const ok = await notify.confirm({
      title: `Discard manual edits on ${overrideCount} unit${overrideCount === 1 ? '' : 's'}?`,
      body: 'Individually moved, re-modelled or re-elevated units go back to what '
        + 'this group\'s settings produce. The layout itself is unchanged. '
        + 'Takes effect when you save.',
      confirmLabel: 'Discard manual edits',
      danger: true,
    });
    if (!ok) return;
    setGroup((g) => ({ ...g, unitOverrides: {} }));
  }

  return (
    <div role="dialog" aria-modal="true" style={shellStyle}>
      <div style={modalStyle}>
        <header style={headerStyle}>
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {isEdit ? `Edit BESS group — ${group.name}` : 'BESS group — New'}
          </h3>
          <button type="button" onClick={props.onCancel} style={closeBtnStyle} aria-label="Close">×</button>
        </header>

        <div style={bodyStyle}>
          {/* Left: form */}
          <div style={formColStyle}>
            <section style={sectionStyle}>
              <h4 style={sectionTitleStyle}>General</h4>
              <label style={fieldStyle}>
                <span style={fieldLabelStyle}>Group name</span>
                <input type="text" value={group.name}
                  onChange={(e) => setName(e.target.value)} style={inputStyle} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ ...fieldStyle, flex: '0 0 160px' }}>
                  <span style={fieldLabelStyle}>Rotation (° from north)</span>
                  <NumberDraft value={group.rotationDeg} step={1}
                    onCommit={(v) => setRotation(v)} />
                </label>
                <div style={{ flex: 1, alignSelf: 'flex-end', paddingBottom: 8, fontSize: 11, color: 'var(--ink-soft)' }}>
                  {isEdit
                    ? 'Drag the on-map rotation handle for visual adjustment.'
                    : 'On Apply, the group drops in the centre of the map view — drag it into place.'}
                </div>
              </div>

              {/* Only shown when there is something to discard, so it can't be
                  mistaken for a general "reset the group" button. */}
              {isEdit && overrideCount > 0 && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 10, marginTop: 2,
                  padding: '7px 9px', borderRadius: 6,
                  background: 'var(--paper-2)', border: '1px solid var(--light)',
                }}>
                  <div style={{ flex: 1, fontSize: 11, color: 'var(--ink-soft)' }}>
                    <b>{overrideCount}</b> unit{overrideCount === 1 ? ' has' : 's have'} manual
                    edits (moved, re-modelled or re-elevated individually). These are kept
                    when the layout changes.
                  </div>
                  <button type="button" onClick={() => { void resetOverrides(); }} style={btnStyle}>
                    Reset overrides
                  </button>
                </div>
              )}

              {/* Top-level 2-D repeat of the whole sequence. */}
              <span style={fieldLabelStyle}>Repeat whole sequence</span>
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginTop: 2 }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>↓</span> down ×
                  <NumberDraft value={group.repeatDown ?? 1} min={1} step={1} integer onCommit={(v) => setTop({ repeatDown: Math.max(1, Math.round(v)) })} />
                  gap <NumberDraft value={group.gapDownM ?? 5} min={0} step={0.1} disabled={(group.repeatDown ?? 1) <= 1} onCommit={(v) => setTop({ gapDownM: Math.max(0, v) })} /> m
                </span>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700 }}>→</span> right ×
                  <NumberDraft value={group.repeatRight ?? 1} min={1} step={1} integer onCommit={(v) => setTop({ repeatRight: Math.max(1, Math.round(v)) })} />
                  gap <NumberDraft value={group.gapRightM ?? 5} min={0} step={0.1} disabled={(group.repeatRight ?? 1) <= 1} onCommit={(v) => setTop({ gapRightM: Math.max(0, v) })} /> m
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--ink-soft)', marginTop: 4 }}>
                Tiles the entire sequence in a grid — stacked down and/or repeated across. 1 × 1 = no tiling.
              </div>
            </section>

            <section style={sectionStyle}>
              <h4 style={sectionTitleStyle}>
                Row sequence
                <span style={badgeStyle}>
                  {rowCount} row{rowCount === 1 ? '' : 's'} ·
                  {' '}{materialised.sources.length} unit{materialised.sources.length === 1 ? '' : 's'}
                </span>
              </h4>
              <p style={hintStyle}>
                Build rows in order; wrap a run in a <em>repeat group</em> (⟳) to repeat it — groups can
                nest and tile down/across. Drag the ⠿ handle to reorder, or drop a row/group onto a group
                to nest it. Empty rows act as pure spacers.
              </p>
              <div style={{ marginTop: 6 }}>
                <SeqList items={seq} containerId={null} ops={ops} depth={0} />
              </div>
            </section>

            {modelGroups.length > 0 && (
              <section style={sectionStyle}>
                <h4 style={sectionTitleStyle}>Change all</h4>
                <p style={hintStyle}>
                  Change every unit of a model across the whole group at once — pick a
                  replacement of the same kind, or just switch its mode. Swapping the
                  model resets the mode to the new model's default, since the old mode
                  name may not exist on it.
                </p>
                {modelGroups.map((g) => {
                  const choices = listEntriesByKind(project, g.kind)
                    .filter((c) => !(c._scope === g.scope && c.id === g.modelId));
                  const kindLabel = g.kind === 'wtg' ? 'WTG' : g.kind === 'bess' ? 'BESS' : 'Aux';
                  return (
                    <div key={g.key} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
                      <span style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                        <b>{kindLabel}</b> · {g.name}{' '}
                        <span style={{ color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>×{g.count}</span>
                      </span>
                      <select
                        value=""
                        disabled={choices.length === 0}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          const [scope, ...rest] = e.target.value.split(':');
                          swapModelTo(g.scope, g.modelId, scope as CatalogScope, rest.join(':'));
                        }}
                        style={{ ...inputStyle, maxWidth: 200 }}
                      >
                        <option value="">change model…</option>
                        {choices.map((c) => (
                          <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>{c.displayName}</option>
                        ))}
                      </select>
                      <select
                        value=""
                        disabled={modesFor(g.scope, g.modelId).length < 2}
                        title={modesFor(g.scope, g.modelId).length < 2
                          ? 'This model has only one mode'
                          : 'Set the mode for every unit of this model'}
                        onChange={(e) => {
                          if (!e.target.value) return;
                          setModeForModel(g.scope, g.modelId, e.target.value);
                          e.currentTarget.value = '';
                        }}
                        style={{ ...inputStyle, maxWidth: 150 }}
                      >
                        <option value="">change mode…</option>
                        {modesFor(g.scope, g.modelId).map((n) => (
                          <option key={n} value={n}>{n}</option>
                        ))}
                      </select>
                    </div>
                  );
                })}
                {allModeNames.length > 0 && modelGroups.length > 1 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                    <span style={{ fontSize: 12, flex: 1, minWidth: 0 }}>
                      <b>Every unit in the group</b>
                    </span>
                    <select
                      value=""
                      onChange={(e) => {
                        if (!e.target.value) return;
                        setModeEverywhere(e.target.value);
                        e.currentTarget.value = '';
                      }}
                      style={{ ...inputStyle, maxWidth: 200 }}
                      title="Apply one mode across every model; models without it are left alone"
                    >
                      <option value="">set mode…</option>
                      {allModeNames.map((n) => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                  </div>
                )}
              </section>
            )}

            <section style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Summary</h4>
              <div style={summaryTileStyle}>
                <Stat k="Rows" v={rowCount} />
                <Stat k="Total units" v={materialised.sources.length} />
                <Stat k="BESS units" v={materialised.counts.bess} />
                <Stat k="Auxiliary units" v={materialised.counts.auxiliary} />
                <Stat k="Bounding box" v={`${materialised.bboxWidthM.toFixed(1)} × ${materialised.bboxLengthM.toFixed(1)} m`} />
              </div>
              {droppedOverrideCount > 0 && (
                <div style={warningStyle}>
                  ⚠ {droppedOverrideCount} hand-edit{droppedOverrideCount === 1 ? '' : 's'} attached to
                  slots that no longer exist will be dropped on Apply.
                </div>
              )}
            </section>
          </div>

          {/* Right: live preview */}
          <div style={previewColStyle}>
            <div style={previewHeaderStyle}>Layout preview · top-down (debounced)</div>
            <div style={previewCanvasStyle}>
              <PreviewSvg
                materialised={materialised}
                rotationDeg={debouncedGroup.rotationDeg}
                catalogLookup={catalogLookup}
              />
            </div>
            <div style={previewLegendStyle}>
              <LegendSwatch fill="#dbeafe" stroke="#1e3a8a" label="BESS" />
              <LegendSwatch fill="#fed7aa" stroke="#7c2d12" label="Auxiliary" />
              <LegendSwatch fill="#f2cb00" stroke="#1f2937" label="Group centre" />
            </div>
          </div>
        </div>

        <footer style={footerStyle}>
          <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>
            <kbd style={kbdStyle}>Esc</kbd>
            {editingChipKey !== null ? ' closes the segment editor' : ' cancels'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={props.onCancel} style={btnStyle}>Cancel</button>
            <button type="button" onClick={() => props.onApply(group)} style={primaryBtnStyle}>
              {isEdit ? 'Save changes' : 'Apply group'}
              {materialised.sources.length > 0 && ` · ${materialised.sources.length} sources`}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

// ===== Recursive sequence tree: pure helpers =====

function findItem(items: BessSeqItem[], id: string): BessSeqItem | null {
  for (const it of items) {
    if (it.id === id) return it;
    if (it.kind === 'group') {
      const found = findItem(it.items, id);
      if (found) return found;
    }
  }
  return null;
}

function containsItem(item: BessSeqItem, id: string): boolean {
  if (item.id === id) return true;
  return item.kind === 'group' && item.items.some((c) => containsItem(c, id));
}

function removeItemById(items: BessSeqItem[], id: string): { items: BessSeqItem[]; removed: BessSeqItem | null } {
  let removed: BessSeqItem | null = null;
  const walk = (list: BessSeqItem[]): BessSeqItem[] =>
    list.flatMap((it): BessSeqItem[] => {
      if (it.id === id) { removed = it; return []; }
      if (it.kind === 'group') return [{ ...it, items: walk(it.items) }];
      return [it];
    });
  return { items: walk(items), removed };
}

/// Shallow-merge a patch into the item with `id` (anywhere in the tree).
function patchItemById(items: BessSeqItem[], id: string, patch: Record<string, unknown>): BessSeqItem[] {
  return items.map((it): BessSeqItem => {
    if (it.id === id) return { ...it, ...patch } as BessSeqItem;
    if (it.kind === 'group') return { ...it, items: patchItemById(it.items, id, patch) };
    return it;
  });
}

/// Replace the item with `id` via `fn` (anywhere in the tree).
function mapItemById(items: BessSeqItem[], id: string, fn: (it: BessSeqItem) => BessSeqItem): BessSeqItem[] {
  return items.map((it): BessSeqItem => {
    if (it.id === id) return fn(it);
    if (it.kind === 'group') return { ...it, items: mapItemById(it.items, id, fn) };
    return it;
  });
}

// `mapAllSegments` now lives in `lib/bessBulkSwap.ts` alongside the bulk
// model/mode helpers, so the "change all" logic is unit-testable.

/// Dissolve the group with `id`, lifting its children up one level in place.
function ungroupById(items: BessSeqItem[], id: string): BessSeqItem[] {
  return items.flatMap((it): BessSeqItem[] => {
    if (it.id === id && it.kind === 'group') return it.items;
    if (it.kind === 'group') return [{ ...it, items: ungroupById(it.items, id) }];
    return [it];
  });
}

/// Deep-clone an item with fresh ids (item id, and for rows the row + segment
/// ids) so a duplicate gets its own stable slot keys.
function cloneItem(item: BessSeqItem, mkId: () => string): BessSeqItem {
  if (item.kind === 'group') {
    return { ...item, id: mkId(), items: item.items.map((c) => cloneItem(c, mkId)) };
  }
  return {
    ...item, id: mkId(),
    row: { ...item.row, id: mkId(), segments: item.row.segments.map((s) => ({ ...s, id: mkId() })) },
  };
}

/// Count row items in the tree (for the summary badge).
function countRows(items: BessSeqItem[]): number {
  return items.reduce((n, it) => n + (it.kind === 'row' ? 1 : countRows(it.items)), 0);
}

type DropTarget =
  | { mode: 'before' | 'after'; id: string }
  | { mode: 'into'; id: string }
  | { mode: 'root-end' };

function insertRelative(items: BessSeqItem[], item: BessSeqItem, target: DropTarget): BessSeqItem[] {
  if (target.mode === 'root-end') return [...items, item];
  const walk = (list: BessSeqItem[]): BessSeqItem[] => {
    const out: BessSeqItem[] = [];
    for (const it of list) {
      if (target.mode === 'into' && it.id === target.id && it.kind === 'group') {
        out.push({ ...it, items: [...it.items, item] });
        continue;
      }
      if ((target.mode === 'before' || target.mode === 'after') && it.id === target.id) {
        const self = it.kind === 'group' ? { ...it, items: walk(it.items) } : it;
        if (target.mode === 'before') { out.push(item, self); } else { out.push(self, item); }
        continue;
      }
      out.push(it.kind === 'group' ? { ...it, items: walk(it.items) } : it);
    }
    return out;
  };
  return walk(items);
}

/// Move the item `dragId` to `target` (drag-and-drop). Rejected if the target
/// is inside the dragged item's own subtree (can't nest into yourself).
function moveItem(items: BessSeqItem[], dragId: string, target: DropTarget): BessSeqItem[] {
  if ('id' in target && target.id === dragId) return items;
  const dragged = findItem(items, dragId);
  if (!dragged) return items;
  if ('id' in target && containsItem(dragged, target.id)) return items;
  const { items: without, removed } = removeItemById(items, dragId);
  if (!removed) return items;
  return insertRelative(without, removed, target);
}

// ===== Recursive sequence tree: UI =====

/// Everything the recursive tree needs to render + mutate, passed down once so
/// the cards don't prop-drill a dozen callbacks each.
interface SeqOps {
  project: Project;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  editingChipKey: string | null;
  setEditingChipKey: (k: string | null) => void;
  patchItem: (id: string, patch: Record<string, unknown>) => void;
  patchRow: (id: string, patch: Partial<BessRow>) => void;
  updateSegment: (rowItemId: string, segIdx: number, patch: Partial<BessSegment>) => void;
  addSegment: (rowItemId: string) => void;
  removeSegment: (rowItemId: string, segIdx: number) => void;
  duplicateItem: (id: string) => void;
  removeItem: (id: string) => void;
  wrapInGroup: (id: string) => void;
  ungroup: (groupId: string) => void;
  addRow: (containerId: string | null) => void;
  addGroup: (containerId: string | null) => void;
  move: (dragId: string, target: DropTarget) => void;
}

function dragId(e: DragEvent): string {
  return e.dataTransfer.getData('text/plain');
}

/// A thin drop strip between / around items. Highlights on drag-over.
function DropLine(p: { onDrop: (id: string) => void; end?: boolean }) {
  const [over, setOver] = useState(false);
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); const id = dragId(e); if (id) p.onDrop(id); }}
      style={{
        height: over ? 14 : (p.end ? 8 : 6),
        margin: '1px 0',
        borderRadius: 4,
        background: over ? 'rgba(242,203,0,.35)' : 'transparent',
        border: over ? '1px dashed var(--accent-deep, #caa800)' : '1px dashed transparent',
        transition: 'height 80ms',
      }}
    />
  );
}

function SeqList(p: { items: BessSeqItem[]; containerId: string | null; ops: SeqOps; depth: number }) {
  const { items, containerId, ops, depth } = p;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((it, i) => (
        <Fragment key={it.id}>
          <DropLine onDrop={(id) => ops.move(id, { mode: 'before', id: it.id })} />
          {it.kind === 'row'
            ? <RowItemCard item={it} index={i} count={items.length}
                prevId={items[i - 1]?.id} nextId={items[i + 1]?.id} ops={ops} />
            : <GroupCard item={it} ops={ops} depth={depth} />}
          {i < items.length - 1 && (
            <InterRowGap valueM={it.gapAfterM ?? 2} onChange={(v) => ops.patchItem(it.id, { gapAfterM: v })} />
          )}
        </Fragment>
      ))}
      <DropLine end onDrop={(id) => ops.move(id, containerId ? { mode: 'into', id: containerId } : { mode: 'root-end' })} />
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button type="button" onClick={() => ops.addRow(containerId)} style={addRowBtnStyle}>+ Add row</button>
        <button type="button" onClick={() => ops.addGroup(containerId)} style={addGroupBtnStyle}>+ Add repeat group</button>
      </div>
    </div>
  );
}

/// Drag handle + group action shared by row + group cards.
function ItemHandle(p: { id: string; onGroup?: () => void }) {
  return (
    <div
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; }}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '2px 2px 0' }}
    >
      <span title="Drag to reorder / nest" style={{ cursor: 'grab', color: '#9aa6b2', fontSize: 13, lineHeight: 1 }}>⠿</span>
      {p.onGroup && (
        <button type="button" title="Wrap in a repeat group" onClick={p.onGroup}
          style={{ border: '1px solid var(--line2, #d1d5db)', background: '#fff', borderRadius: 5, fontSize: 10, padding: '1px 4px', cursor: 'pointer', color: '#6a5a00' }}>⟳</button>
      )}
    </div>
  );
}

function RowItemCard(p: { item: BessSeqItem & { kind: 'row' }; index: number; count: number; prevId?: string; nextId?: string; ops: SeqOps }) {
  const { item, index, count, prevId, nextId, ops } = p;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
      <ItemHandle id={item.id} onGroup={() => ops.wrapInGroup(item.id)} />
      <div style={{ flex: 1 }}>
        <BessRowCard
          row={item.row}
          idx={index}
          isLast={index === count - 1}
          isExpanded={ops.expandedId === item.id}
          project={ops.project}
          editingChipKey={ops.editingChipKey}
          setEditingChipKey={ops.setEditingChipKey}
          onToggleExpand={() => ops.setExpandedId(ops.expandedId === item.id ? null : item.id)}
          onChange={(patch) => ops.patchRow(item.id, patch)}
          onUpdateSegment={(sIdx, patch) => ops.updateSegment(item.id, sIdx, patch)}
          onAddSegment={() => ops.addSegment(item.id)}
          onRemoveSegment={(sIdx) => ops.removeSegment(item.id, sIdx)}
          onDuplicate={() => ops.duplicateItem(item.id)}
          onDelete={() => ops.removeItem(item.id)}
          onMoveUp={() => prevId && ops.move(item.id, { mode: 'before', id: prevId })}
          onMoveDown={() => nextId && ops.move(item.id, { mode: 'after', id: nextId })}
        />
      </div>
    </div>
  );
}

function GroupCard(p: { item: BessSeqItem & { kind: 'group' }; ops: SeqOps; depth: number }) {
  const { item, ops, depth } = p;
  const railShade = depth % 2 === 0 ? '#F2CB00' : '#e3b94a';
  return (
    <div style={{ display: 'flex', alignItems: 'stretch', gap: 4 }}>
      <ItemHandle id={item.id} />
      <div
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; }}
        onDrop={(e) => { e.stopPropagation(); const id = dragId(e); if (id) ops.move(id, { mode: 'into', id: item.id }); }}
        // overflow MUST stay visible so a segment-edit popover opened on a row
        // inside this group can extend past the card's lower edge (the modal's
        // left column scrolls to reveal it). The rail + header below round their
        // own corners so dropping the clip doesn't square off the card.
        style={{ flex: 1, position: 'relative', border: '1px solid #ecd24d', borderRadius: 9, background: depth % 2 === 0 ? '#fffdf2' : '#fffaf0', overflow: 'visible' }}
      >
        <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 5, background: railShade, borderTopLeftRadius: 8, borderBottomLeftRadius: 8 }} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '7px 9px 7px 13px', background: '#fdf6cf', borderBottom: '1px solid #f0e08a', borderTopLeftRadius: 8, borderTopRightRadius: 8 }}>
          <input
            value={item.name ?? ''}
            placeholder="Repeat group"
            onChange={(e) => ops.patchItem(item.id, { name: e.target.value })}
            style={{ fontWeight: 800, fontSize: 12, color: '#6a5a00', border: '1px solid transparent', background: 'transparent', borderRadius: 4, padding: '2px 4px', width: 110 }}
          />
          <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <AxisCtrl arrow="↓" rep={item.repeatDown ?? 1} gap={item.gapDownM ?? 2}
              onRep={(v) => ops.patchItem(item.id, { repeatDown: Math.max(1, Math.round(v)) })}
              onGap={(v) => ops.patchItem(item.id, { gapDownM: Math.max(0, v) })} />
            <AxisCtrl arrow="→" rep={item.repeatRight ?? 1} gap={item.gapRightM ?? 2}
              onRep={(v) => ops.patchItem(item.id, { repeatRight: Math.max(1, Math.round(v)) })}
              onGap={(v) => ops.patchItem(item.id, { gapRightM: Math.max(0, v) })} />
            <button type="button" title="Ungroup" onClick={() => ops.ungroup(item.id)}
              style={{ border: '1px solid #f0c9c9', background: '#fff', color: '#b91c1c', borderRadius: 5, fontSize: 11, padding: '3px 7px', cursor: 'pointer' }}>ungroup</button>
            <button type="button" title="Delete group + contents" onClick={() => ops.removeItem(item.id)}
              style={{ border: '1px solid var(--line2,#d1d5db)', background: '#fff', borderRadius: 5, fontSize: 11, padding: '3px 7px', cursor: 'pointer' }}>✕</button>
          </span>
        </div>
        <div style={{ padding: '8px 9px 9px 13px' }}>
          {item.items.length === 0 && (
            <div style={{ fontSize: 11, color: '#9a8800', fontStyle: 'italic', padding: '2px 0 6px' }}>
              Empty group — drag rows here, or add below.
            </div>
          )}
          <SeqList items={item.items} containerId={item.id} ops={ops} depth={depth + 1} />
        </div>
      </div>
    </div>
  );
}

/// Compact "↓ ×N gap M" axis control for a group's down/right replication.
function AxisCtrl(p: { arrow: string; rep: number; gap: number; onRep: (v: number) => void; onGap: (v: number) => void }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#6a5a00', fontWeight: 700 }}>
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{p.arrow}</span>×
      <NumberDraft value={p.rep} min={1} step={1} integer onCommit={p.onRep} />
      <span style={{ fontWeight: 500 }}>gap</span>
      <NumberDraft value={p.gap} min={0} step={0.1} onCommit={p.onGap} />
      <span style={{ fontWeight: 500 }}>m</span>
    </span>
  );
}

// ===== Row card sub-component =====

interface RowCardProps {
  row: BessRow;
  idx: number;
  isLast: boolean;
  isExpanded: boolean;
  project: Project;
  editingChipKey: string | null;
  setEditingChipKey: (k: string | null) => void;
  onToggleExpand: () => void;
  onChange: (patch: Partial<BessRow>) => void;
  onUpdateSegment: (segIdx: number, patch: Partial<BessSegment>) => void;
  onAddSegment: () => void;
  onRemoveSegment: (segIdx: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function BessRowCard(p: RowCardProps) {
  const { row, idx, isLast } = p;
  const summaryText = describeRow(row);

  return (
    <div style={p.isExpanded ? rowCardActiveStyle : rowCardStyle}>
      <div style={rowCardHeaderStyle} onClick={p.onToggleExpand}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <button type="button" onClick={(e) => { e.stopPropagation(); p.onMoveUp(); }}
            disabled={idx === 0} style={moveArrowStyle} title="Move up" aria-label="Move up">▲</button>
          <button type="button" onClick={(e) => { e.stopPropagation(); p.onMoveDown(); }}
            disabled={isLast} style={moveArrowStyle} title="Move down" aria-label="Move down">▼</button>
        </div>
        <span style={{ flex: 1, fontWeight: 600, fontSize: 13 }}>Row {idx + 1}</span>
        <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontFamily: 'var(--font-mono)' }}>
          {summaryText}
        </span>
      </div>
      {p.isExpanded && (
        <>
          <div style={rowCardBodyStyle}>
            <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600 }}>
              Segments · click a segment to edit its model / count / spacing / orientation
            </div>
            <div style={patternRowStyle}>
              {row.segments.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontStyle: 'italic' }}>
                  (empty row — pure spacer)
                </span>
              )}
              {row.segments.map((seg, sIdx) => (
                <SegmentChip
                  key={seg.id}
                  segment={seg}
                  isLastInRow={sIdx === row.segments.length - 1}
                  project={p.project}
                  editingKey={p.editingChipKey}
                  setEditingKey={p.setEditingChipKey}
                  chipKey={`${idx}-${sIdx}`}
                  onChange={(patch) => p.onUpdateSegment(sIdx, patch)}
                  onRemove={() => p.onRemoveSegment(sIdx)}
                />
              ))}
              <button type="button" onClick={p.onAddSegment} style={ghostBtnTinyStyle}>+ add segment</button>
            </div>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle} title="Repeats the segment sequence WITHIN this one row. E.g. [BESS×8, INV×1] × 3 gives BESS×8 INV BESS×8 INV BESS×8 INV inline.">
                Repeat segment sequence × N (within row)
              </span>
              <NumberDraft value={row.segmentSequenceRepeat ?? 1} min={1} step={1} integer
                onCommit={(v) => p.onChange({ segmentSequenceRepeat: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Gap between segment sequences (m)</span>
              <NumberDraft
                value={row.gapBetweenSegmentSequencesM
                  ?? ((row.segments.length > 0 && row.segments[row.segments.length - 1].gapAfterM > 0)
                    ? row.segments[row.segments.length - 1].gapAfterM
                    : 3)}
                min={0} step={0.1}
                disabled={(row.segmentSequenceRepeat ?? 1) <= 1}
                onCommit={(v) => p.onChange({ gapBetweenSegmentSequencesM: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Repeat row × N (stacks rows down)</span>
              <NumberDraft value={row.rowRepeat} min={1} step={1} integer
                onCommit={(v) => p.onChange({ rowRepeat: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Gap between row copies (m)</span>
              <NumberDraft value={row.gapBetweenCopiesM} min={0} step={0.1}
                disabled={row.rowRepeat <= 1}
                onCommit={(v) => p.onChange({ gapBetweenCopiesM: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle} title="Horizontal alignment of this row within the group's bounding box (the widest row sets the edges). Right-align several rows to flush them to the right edge.">
                Row alignment
              </span>
              <select
                value={row.align ?? 'left'}
                onChange={(e) => p.onChange({ align: e.target.value as 'left' | 'center' | 'right' })}
                style={{ ...inputStyle, fontSize: 12 }}
              >
                <option value="left">Left</option>
                <option value="center">Centre</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle} title="Signed nudge from the alignment anchor: +ve moves the row right (east), −ve moves it left. e.g. Right align with −5 sits the row 5 m inside the right edge.">
                Alignment offset (m, +right)
              </span>
              <NumberDraft value={row.alignOffsetM ?? 0} step={0.1}
                onCommit={(v) => p.onChange({ alignOffsetM: v })} />
            </label>
          </div>
          <div style={rowCardActionsStyle}>
            <button type="button" onClick={p.onDuplicate} style={ghostBtnTinyStyle}>⧉ duplicate template</button>
            <button type="button" onClick={p.onDelete} style={{ ...ghostBtnTinyStyle, color: 'var(--red)' }}>
              ✕ remove
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function describeRow(row: BessRow): string {
  if (row.segments.length === 0) return 'spacer';
  const totalUnits = row.segments.reduce((acc, s) => acc + Math.max(0, Math.floor(s.count)), 0);
  const repeatTxt = row.rowRepeat > 1 ? ` · row × ${row.rowRepeat}` : '';
  const segDesc = row.segments.map((s) => `${s.count}×${s.catalogScope.charAt(0).toUpperCase()}`).join(' + ');
  const align = row.align ?? 'left';
  const off = row.alignOffsetM ?? 0;
  const alignTxt = (align !== 'left' || off !== 0)
    ? ` · ${align === 'right' ? '⇥ right' : align === 'center' ? '↔ centre' : '⇤ left'}${off ? ` ${off > 0 ? '+' : ''}${off}m` : ''}`
    : '';
  return `${segDesc} (${totalUnits} unit${totalUnits === 1 ? '' : 's'})${repeatTxt}${alignTxt}`;
}

// ===== Inter-row gap control (rendered between row cards) =====

function InterRowGap(props: { valueM: number; onChange: (v: number) => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 12px 4px 32px',
      // Indented + with a left rail so it's visually clear this gap
      // sits BETWEEN rows rather than being a row itself.
      borderLeft: '2px dashed var(--light)',
      marginLeft: 12,
    }}>
      <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600 }}>↕ gap to next row (m)</span>
      <NumberDraft
        value={props.valueM} min={0} step={0.1}
        onCommit={props.onChange}
        style={{ width: 80 }}
      />
    </div>
  );
}

// ===== Segment chip with click-to-edit popover =====

interface SegmentChipProps {
  segment: BessSegment;
  isLastInRow: boolean;
  project: Project;
  chipKey: string;
  editingKey: string | null;
  setEditingKey: (k: string | null) => void;
  onChange: (patch: Partial<BessSegment>) => void;
  onRemove: () => void;
}

function SegmentChip(p: SegmentChipProps) {
  // Pull all BESS + aux entries the user can reference. Personal +
  // global only -- 'local' is deprecated for new entries (task #23).
  const candidates = useMemo(() => [
    ...listEntriesByKind(p.project, 'bess'),
    ...listEntriesByKind(p.project, 'auxiliary'),
  ].filter((e) => e._scope !== 'local'), [p.project]);

  const current = candidates.find((c) =>
    c._scope === p.segment.catalogScope && c.id === p.segment.modelId);
  const isEditing = p.editingKey === p.chipKey;
  const isBess = current?.kind === 'bess';
  const isAux = current?.kind === 'auxiliary';
  const chipBase = isBess ? unitChipBessStyle : isAux ? unitChipAuxStyle : unitChipMissingStyle;
  // Show count + name on the chip face.
  const label = `${current?.displayName ?? '(missing)'} × ${p.segment.count}`;
  // Available modes from the current entry; null if missing.
  const modeOptions = current?.modes?.map((m) => m.name) ?? [];

  return (
    <span style={{ position: 'relative' }}>
      <button
        type="button"
        style={{ ...chipBase, padding: '4px 10px' }}
        onClick={() => p.setEditingKey(isEditing ? null : p.chipKey)}
        title={current?.displayName ?? `Missing: ${p.segment.modelId}`}
      >
        {isBess ? 'B · ' : isAux ? 'A · ' : '? '}{label}
        {(() => {
          const rot = p.segment.rotationDeg ?? (p.segment.orientation === 'across' ? 90 : 0);
          return rot ? (
            <span style={{ marginLeft: 4, fontSize: 9, opacity: 0.7 }}>{rot}°</span>
          ) : null;
        })()}
      </button>
      {isEditing && (
        <div style={segmentMenuStyle} onClick={(e) => e.stopPropagation()}>
          <div style={menuHeaderStyle}>Edit segment</div>

          <label style={menuFieldStyle}>
            <span style={fieldLabelStyle}>Model</span>
            <select
              value={`${p.segment.catalogScope}:${p.segment.modelId}`}
              onChange={(e) => {
                const [scope, ...rest] = e.target.value.split(':');
                const newRef = { catalogScope: scope as CatalogScope, modelId: rest.join(':') };
                // Reset modeOverride when changing models (the previous
                // mode name likely doesn't exist on the new model).
                p.onChange({ ...newRef, modeOverride: undefined });
              }}
              style={{ ...inputStyle, fontSize: 12 }}
              autoFocus
            >
              <optgroup label="BESS">
                {candidates.filter((c) => c.kind === 'bess').map((c) => (
                  <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>
                    {c.displayName} {c._scope === 'personal' ? '· personal' : ''}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Auxiliary (inverter / transformer / other)">
                {candidates.filter((c) => c.kind === 'auxiliary').map((c) => (
                  <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>
                    {c.displayName} {c._scope === 'personal' ? '· personal' : ''}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>

          {modeOptions.length > 1 && (
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Mode</span>
              <select
                value={p.segment.modeOverride ?? current?.defaultMode ?? ''}
                onChange={(e) => p.onChange({ modeOverride: e.target.value })}
                style={{ ...inputStyle, fontSize: 12 }}
              >
                {modeOptions.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Count</span>
              <NumberDraft value={p.segment.count} min={0} step={1} integer
                onCommit={(v) => p.onChange({ count: v })} />
            </label>
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Spacing within (m)</span>
              <NumberDraft value={p.segment.spacingWithinM} min={0} step={0.1}
                onCommit={(v) => p.onChange({ spacingWithinM: v })} />
            </label>
          </div>

          {!p.isLastInRow && (
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Gap to next segment (m)</span>
              <NumberDraft value={p.segment.gapAfterM} min={0} step={0.1}
                onCommit={(v) => p.onChange({ gapAfterM: v })} />
            </label>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Rotation (°)</span>
              <NumberDraft
                value={p.segment.rotationDeg ?? (p.segment.orientation === 'across' ? 90 : 0)}
                min={0} step={5}
                onCommit={(v) => p.onChange({ rotationDeg: v })} />
            </label>
            <label style={menuFieldStyle}>
              <span style={fieldLabelStyle}>Align in row</span>
              <select
                value={p.segment.alignment ?? 'middle'}
                onChange={(e) => p.onChange({ alignment: e.target.value as 'top' | 'middle' | 'bottom' })}
                style={{ ...inputStyle, fontSize: 12 }}
              >
                <option value="top">Top</option>
                <option value="middle">Middle</option>
                <option value="bottom">Bottom</option>
              </select>
            </label>
          </div>
          <div style={{ fontSize: 10, color: 'var(--ink-soft)', marginTop: -2 }}>
            0° = long axis along the row, 90° = across. Align sets how units sit
            when a row mixes depths.
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <button type="button" onClick={() => { p.onRemove(); p.setEditingKey(null); }}
              style={{ ...ghostBtnTinyStyle, color: 'var(--red)' }}>
              ✕ remove segment
            </button>
            <button type="button" onClick={() => p.setEditingKey(null)}
              style={ghostBtnTinyStyle}>
              Done
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ===== Preview SVG =====

interface PreviewProps {
  materialised: ReturnType<typeof materialiseBessGroup>;
  rotationDeg: number;
  catalogLookup: CatalogLookup;
}

function PreviewSvg({ materialised, rotationDeg, catalogLookup }: PreviewProps) {
  // Project each source into a local-metres frame relative to the
  // group centre (which is at the centroid of the bbox -- handled by
  // the materialiser). We invert the geographic projection by
  // assuming all sources are close to the centre: dx = (lng - cLng) *
  // cos(lat0) * R; dy = -(lat - cLat) * R.
  if (materialised.sources.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--ink-soft)', fontSize: 13 }}>
        No units to preview yet — add a row with a pattern.
      </div>
    );
  }
  const R = 6371008.8;
  // Estimate centre as the average of source lat/lngs (matches what
  // materialiseBessGroup does).
  let sumLat = 0, sumLng = 0;
  for (const s of materialised.sources) { sumLat += s.latLng[0]; sumLng += s.latLng[1]; }
  const cLat = sumLat / materialised.sources.length;
  const cLng = sumLng / materialised.sources.length;
  const lat0Rad = (cLat * Math.PI) / 180;
  const cosLat = Math.cos(lat0Rad);
  const toLocal = (lat: number, lng: number): [number, number] => [
    (lng - cLng) * (Math.PI / 180) * R * cosLat,
    -(lat - cLat) * (Math.PI / 180) * R,
  ];
  // Project all sources to local metres. The SVG viewBox auto-fits.
  const pts = materialised.sources.map((s) => {
    const [x, y] = toLocal(s.latLng[0], s.latLng[1]);
    const entry = catalogLookup(s.catalogScope, s.modelId);
    const fp = entry ? footprintFor(entry) : { widthM: 5.1, lengthM: 1.7 };
    return { source: s, x, y, fp };
  });
  // Bbox in local metres
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    // Each rect is drawn rotated by its yaw, so fit the viewBox to the rotated
    // bounding box (otherwise a 90°-rotated unit clips at the edges).
    const yaw = ((p.source.yawDeg ?? rotationDeg) * Math.PI) / 180;
    const ex = Math.abs(p.fp.widthM * Math.cos(yaw)) + Math.abs(p.fp.lengthM * Math.sin(yaw));
    const ey = Math.abs(p.fp.widthM * Math.sin(yaw)) + Math.abs(p.fp.lengthM * Math.cos(yaw));
    minX = Math.min(minX, p.x - ex / 2);
    maxX = Math.max(maxX, p.x + ex / 2);
    minY = Math.min(minY, p.y - ey / 2);
    maxY = Math.max(maxY, p.y + ey / 2);
  }
  // Padding
  const padM = Math.max(1, (maxX - minX) * 0.08);
  const vbMinX = minX - padM, vbMinY = minY - padM;
  const vbW = (maxX - minX) + 2 * padM;
  const vbH = (maxY - minY) + 2 * padM;
  // Rotation is already baked into the source positions; preview just
  // shows the result. Render each source as a rotated rect (the
  // rotation is mostly about layout, but rendering the actual rect
  // orientation makes the array look right).
  const rotRad = (rotationDeg * Math.PI) / 180;
  const cosR = Math.cos(rotRad), sinR = Math.sin(rotRad);
  return (
    <svg viewBox={`${vbMinX} ${vbMinY} ${vbW} ${vbH}`} width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      {pts.map((p, i) => {
        const entry = catalogLookup(p.source.catalogScope, p.source.modelId);
        const kind = entry?.kind ?? 'bess';
        const fill = kind === 'auxiliary' ? '#fed7aa' : '#dbeafe';
        const stroke = kind === 'auxiliary' ? '#7c2d12' : '#1e3a8a';
        // Rotate the rect about its own centre by the unit's full yaw (group
        // rotation + the segment's in-row rotation) so per-segment rotation
        // shows in the preview, matching what the map draws.
        return (
          <g key={i} transform={`translate(${p.x} ${p.y}) rotate(${p.source.yawDeg ?? rotationDeg})`}>
            <rect
              x={-p.fp.widthM / 2} y={-p.fp.lengthM / 2}
              width={p.fp.widthM} height={p.fp.lengthM}
              fill={fill} stroke={stroke} strokeWidth={0.1}
            />
          </g>
        );
      })}
      {/* Group centre pin */}
      <circle cx={0} cy={0} r={Math.max(0.5, vbW * 0.012)} fill="#f2cb00" stroke="#1f2937" strokeWidth={0.15} />
      {/* North arrow in the corner -- accounts for rotation */}
      <g transform={`translate(${vbMinX + vbW * 0.92} ${vbMinY + vbH * 0.12})`}>
        <line x1={0} y1={vbH * 0.05} x2={0} y2={-vbH * 0.06} stroke="#1f2937" strokeWidth={vbW * 0.004} />
        <text x={0} y={vbH * 0.085} textAnchor="middle" fontSize={vbW * 0.025} fill="#374151" fontFamily="Inter">N</text>
      </g>
      {/* (rotRad / cosR / sinR currently unused at render time; the per-
          source rotation handles the visual. Kept here in case we re-add
          a global rotation around (0,0) later.) */}
      {void [rotRad, cosR, sinR]}
    </svg>
  );
}

// ===== Backspace-tolerant number input =====
//
// The naive `<input type="number" value={n} onChange={(e) => set(+e.target.value)}>`
// pattern has two problems when paired with a clamp like `Math.max(1, +'')`:
//   1. Pressing backspace to clear the field immediately snaps the value
//      back to 1 (or 0), so the user can't actually type a fresh number.
//   2. Intermediate states like "" or "-" are invalid numbers, so the
//      onChange would have to special-case them anyway.
//
// `NumberDraft` holds a local string draft while the input is focused,
// only commits on Enter / blur, and reverts to the prior value if the
// user leaves the field empty or invalid. Outside callers see only
// validated commits via onCommit(value).

function NumberDraft(props: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  /// Round to an integer on commit. Used for counts / repeat fields.
  integer?: boolean;
  disabled?: boolean;
  /// Optional override of the input element's inline style; merged
  /// over the default monospace style.
  style?: React.CSSProperties;
}) {
  const [draft, setDraft] = useState<string>(String(props.value));
  const [focused, setFocused] = useState(false);

  // Re-sync from props when the value changes externally AND we're not
  // mid-edit (focused). Keeps live preview accurate when a sibling
  // input mutates state through us indirectly.
  useEffect(() => {
    if (!focused) setDraft(String(props.value));
  }, [props.value, focused]);

  function commit() {
    const trimmed = draft.trim();
    if (trimmed === '') {
      setDraft(String(props.value));
      return;
    }
    const n = +trimmed;
    if (!Number.isFinite(n)) {
      setDraft(String(props.value));
      return;
    }
    let v = props.integer ? Math.round(n) : n;
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    setDraft(String(v));
    if (v !== props.value) props.onCommit(v);
  }

  return (
    <input
      type="number"
      value={draft}
      step={props.step}
      min={props.min}
      max={props.max}
      disabled={props.disabled}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); }
        else if (e.key === 'Escape') {
          // Revert this field only. Without stopping propagation the wizard's
          // Esc handler would also close a panel, so one keypress would undo
          // the edit AND lose the panel it was made in.
          e.stopPropagation();
          setDraft(String(props.value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      style={{
        ...inputStyle,
        fontFamily: 'var(--font-mono)',
        opacity: props.disabled ? 0.4 : 1,
        ...(props.style ?? {}),
      }}
    />
  );
}

// ===== Helpers =====

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/// Pick a sensible default BESS reference for the project: first BESS
/// entry resolvable from any scope, in scope-priority order (personal,
/// then global, since local is deprecated for new groups).
function defaultBessRef(project: Project): { catalogScope: CatalogScope; modelId: string } | null {
  const all = listEntriesByKind(project, 'bess')
    .filter((e) => e._scope !== 'local');
  // Prefer personal if present (user's own catalog), else global.
  const personal = all.find((e) => e._scope === 'personal');
  const global = all.find((e) => e._scope === 'global');
  const pick = personal ?? global ?? all[0];
  if (!pick) return null;
  return { catalogScope: pick._scope as CatalogScope, modelId: pick.id };
}

function defaultRefForKind(project: Project, kind: SourceKind): { catalogScope: CatalogScope; modelId: string } | null {
  const all = listEntriesByKind(project, kind).filter((e) => e._scope !== 'local');
  const pick = all.find((e) => e._scope === 'personal') ?? all.find((e) => e._scope === 'global') ?? all[0];
  if (!pick) return null;
  return { catalogScope: pick._scope as CatalogScope, modelId: pick.id };
}

// ===== Tiny presentational components =====

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span>{k}</span><span style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{v}</span>
    </div>
  );
}

function LegendSwatch({ fill, stroke, label }: { fill: string; stroke: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--ink-soft)' }}>
      <span style={{
        display: 'inline-block', width: 10, height: 10, borderRadius: 2,
        background: fill, border: `1px solid ${stroke}`,
      }} />
      {label}
    </span>
  );
}

// ===== Inline styles =====

const shellStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(15, 23, 42, 0.4)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 9000, padding: 20,
};
const modalStyle: React.CSSProperties = {
  background: 'var(--paper, #fff)', border: '1px solid var(--light)',
  borderRadius: 10, boxShadow: 'var(--shadow-2)', overflow: 'hidden',
  width: '100%', maxWidth: 1200, maxHeight: '92vh', display: 'flex', flexDirection: 'column',
};
const headerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '14px 20px', borderBottom: '1px solid var(--light)',
};
const closeBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', fontSize: 22, color: 'var(--ink-soft)', cursor: 'pointer',
};
const bodyStyle: React.CSSProperties = {
  display: 'grid', gridTemplateColumns: '1fr 460px', flex: 1, minHeight: 0,
};
const formColStyle: React.CSSProperties = {
  padding: '16px 20px 20px', borderRight: '1px solid var(--light)', overflow: 'auto',
};
const previewColStyle: React.CSSProperties = {
  background: 'var(--slate-1, #eef1f5)', padding: '16px 20px', overflow: 'auto',
};
const previewHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--ink-soft)', marginBottom: 8,
};
const previewCanvasStyle: React.CSSProperties = {
  width: '100%', aspectRatio: '1 / 0.9',
  background: 'var(--paper, #fff)', border: '1px solid var(--light)', borderRadius: 6,
  overflow: 'hidden',
};
const previewLegendStyle: React.CSSProperties = {
  marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 12,
};
const footerStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  padding: '12px 20px', borderTop: '1px solid var(--light)', background: '#fafbfc',
};
const sectionStyle: React.CSSProperties = { marginBottom: 18 };
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: 'var(--ink-soft)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
};
const badgeStyle: React.CSSProperties = {
  background: 'var(--slate-1)', padding: '1px 8px', borderRadius: 99,
  fontSize: 10, color: 'var(--ink-soft)', fontWeight: 500, textTransform: 'none', letterSpacing: 0,
};
const fieldStyle: React.CSSProperties = { display: 'block', marginBottom: 8 };
const fieldStyleSm: React.CSSProperties = { display: 'block', margin: 0 };
const fieldLabelStyle: React.CSSProperties = {
  display: 'block', fontSize: 11, color: 'var(--ink-soft)', fontWeight: 600, marginBottom: 3,
};
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', border: '1px solid var(--light)', borderRadius: 4,
  background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, outline: 'none', fontFamily: 'inherit',
};
// `overflow: 'visible'` (and the position:relative below) so the segment-
// edit popover can extend below the card without being clipped. The
// previous `overflow: 'hidden'` was clipping the popover's lower fields
// (count / spacing / gap-to-next / orientation), leaving only the Model
// dropdown visible. The cost of dropping the clip is that the header's
// gray background and the actions row's tint can technically poke 1 px
// past the rounded corners -- imperceptible at default border weights.
const rowCardStyle: React.CSSProperties = {
  border: '1px solid var(--light)', borderRadius: 6, background: 'var(--paper)',
  overflow: 'visible',
  position: 'relative',
};
const rowCardActiveStyle: React.CSSProperties = {
  ...rowCardStyle, borderColor: 'var(--ink)',
};
const rowCardHeaderStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
  padding: '6px 10px', background: 'var(--slate-1)', borderBottom: '1px solid var(--light)',
  cursor: 'pointer',
};
const rowCardBodyStyle: React.CSSProperties = {
  padding: '10px 12px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
};
const rowCardActionsStyle: React.CSSProperties = {
  display: 'flex', gap: 4, justifyContent: 'flex-end',
  padding: '6px 10px', borderTop: '1px solid var(--light)', background: '#fafbfc',
};
const moveArrowStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: '0 2px',
  fontSize: 9, color: 'var(--ink-soft)', cursor: 'pointer',
  lineHeight: 1,
};
const patternRowStyle: React.CSSProperties = {
  gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 4,
  padding: '6px 8px', background: 'var(--slate-1)', borderRadius: 4,
  alignItems: 'center', minHeight: 36,
};
const unitChipBaseStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 3,
  padding: '2px 8px', borderRadius: 3, fontSize: 11, fontWeight: 500, cursor: 'pointer',
};
const unitChipBessStyle: React.CSSProperties = {
  ...unitChipBaseStyle, background: '#dbeafe', border: '1px solid #93c5fd', color: '#1e3a8a',
};
const unitChipAuxStyle: React.CSSProperties = {
  ...unitChipBaseStyle, background: '#fed7aa', border: '1px solid #fdba74', color: '#7c2d12',
};
const unitChipMissingStyle: React.CSSProperties = {
  ...unitChipBaseStyle, background: '#fee2e2', border: '1px dashed #dc2626', color: '#991b1b',
};
// Segment-editor popover that opens when the user clicks a segment chip.
// Taller than the old single-select chipMenu because the segment form
// has model + mode + count + spacing + gap + orientation in one place.
// High zIndex so it sits above sibling row cards when the popover
// overflows downward into the next row.
const segmentMenuStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 100,
  background: 'var(--paper)', border: '1px solid var(--light)', borderRadius: 6,
  padding: 10, display: 'flex', flexDirection: 'column', gap: 8,
  width: 320, maxWidth: 'calc(100vw - 40px)',
  // Cap height to the viewport and scroll internally so the lower fields stay
  // reachable on short screens even when the popover can't fully fit below the
  // chip. (The group card no longer clips it; this just handles the viewport.)
  maxHeight: 'calc(100vh - 120px)', overflowY: 'auto',
  boxShadow: 'var(--shadow-2)',
};
const menuHeaderStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)',
  textTransform: 'uppercase', letterSpacing: '0.06em',
  borderBottom: '1px solid var(--light)', paddingBottom: 6,
};
const menuFieldStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 3,
};
const addRowBtnStyle: React.CSSProperties = {
  flex: 1, padding: 9, border: '1px dashed var(--light)', borderRadius: 6,
  background: 'transparent', color: 'var(--ink-soft)', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
};
const addGroupBtnStyle: React.CSSProperties = {
  flex: 1, padding: 9, border: '1px dashed #caa800', borderRadius: 6,
  background: '#fffdf2', color: '#6a5a00', fontSize: 12.5, fontWeight: 500, cursor: 'pointer',
};
const hintStyle: React.CSSProperties = {
  margin: '6px 0 0', fontSize: 11, color: 'var(--ink-soft)', lineHeight: 1.5,
};
const summaryTileStyle: React.CSSProperties = {
  background: 'var(--yellow-soft, #fff4b3)', border: '1px solid var(--yellow)',
  padding: '10px 12px', borderRadius: 6, fontSize: 12, lineHeight: 1.6,
};
const warningStyle: React.CSSProperties = {
  marginTop: 8, padding: '6px 10px', borderRadius: 4,
  background: 'rgba(245, 158, 11, 0.12)', color: '#92400e',
  fontSize: 12, border: '1px solid rgba(245, 158, 11, 0.4)',
};
const btnStyle: React.CSSProperties = {
  padding: '7px 14px', borderRadius: 4, border: '1px solid var(--light)',
  background: 'var(--paper)', color: 'var(--ink)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
};
const primaryBtnStyle: React.CSSProperties = {
  ...btnStyle, background: 'var(--ink)', color: 'var(--paper)', borderColor: 'var(--ink)',
};
const ghostBtnTinyStyle: React.CSSProperties = {
  background: 'transparent', border: 'none', padding: '2px 6px', borderRadius: 3,
  color: 'var(--ink-soft)', fontSize: 11, cursor: 'pointer',
};
const kbdStyle: React.CSSProperties = {
  background: 'var(--slate-1)', padding: '1px 5px', borderRadius: 3,
  fontSize: 11, fontFamily: 'var(--font-mono)',
};
