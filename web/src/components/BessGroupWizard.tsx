// BESS group wizard modal — the form half of the experience designed in
// docs/mockups/bess-group.html. Form on the left (general info + row
// sequence editor), live top-down SVG preview on the right (debounced
// ~200 ms after the last keystroke), Apply / Cancel footer.
//
// Edit mode: when `initialGroup` is supplied we pre-populate; Apply
// passes the modified group back so ProjectScreen can re-materialise
// it (preserving per-slot hand-edits via the existing
// `unitOverrides` map on the group itself).

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  materialiseBessGroup,
  newBessGroupTemplate,
  type CatalogLookup,
} from '../lib/bessGroups';
import { footprintFor, listEntriesByKind } from '../lib/catalog';
import type {
  BessGroup,
  BessRow,
  BessRowUnit,
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
    if (props.initialGroup) return clone(props.initialGroup);
    const defaultBess = defaultBessRef(project);
    return newBessGroupTemplate(
      `bg-${Date.now().toString(36)}`,
      'New BESS group',
      newGroupCentre,
      defaultBess,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [group, setGroup] = useState<BessGroup>(initial);
  const [expandedRowIdx, setExpandedRowIdx] = useState<number>(0);
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

  const updateRow = useCallback((idx: number, patch: Partial<BessRow>) => {
    setGroup((g) => ({
      ...g,
      rows: g.rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)),
    }));
  }, []);
  const deleteRow = (idx: number) => setGroup((g) => ({
    ...g, rows: g.rows.filter((_, i) => i !== idx),
  }));
  const duplicateRow = (idx: number) => setGroup((g) => {
    const src = g.rows[idx];
    const copy: BessRow = { ...src, id: `${g.id}-row-${Date.now().toString(36)}` };
    return { ...g, rows: [...g.rows.slice(0, idx + 1), copy, ...g.rows.slice(idx + 1)] };
  });
  const addRow = () => setGroup((g) => {
    const defaultBess = defaultBessRef(project);
    const newRow: BessRow = {
      id: `${g.id}-row-${Date.now().toString(36)}`,
      pattern: defaultBess ? [defaultBess] : [],
      patternRepeat: 8,
      spacingWithinM: 1.5,
      gapToNextRowM: 2,
      rowRepeat: 1,
    };
    return { ...g, rows: [...g.rows, newRow] };
  });
  const moveRow = (from: number, to: number) => setGroup((g) => {
    if (from === to || to < 0 || to >= g.rows.length) return g;
    const rows = [...g.rows];
    const [moved] = rows.splice(from, 1);
    rows.splice(to, 0, moved);
    return { ...g, rows };
  });

  const updatePatternUnit = (rowIdx: number, unitIdx: number, ref: BessRowUnit) =>
    setGroup((g) => ({
      ...g,
      rows: g.rows.map((r, i) => i !== rowIdx ? r : ({
        ...r,
        pattern: r.pattern.map((u, j) => j === unitIdx ? ref : u),
      })),
    }));
  const addPatternUnit = (rowIdx: number) =>
    setGroup((g) => ({
      ...g,
      rows: g.rows.map((r, i) => {
        if (i !== rowIdx) return r;
        const def = defaultBessRef(project)
          ?? defaultRefForKind(project, 'bess')
          ?? { catalogScope: 'global' as const, modelId: '' };
        return { ...r, pattern: [...r.pattern, def] };
      }),
    }));
  const removePatternUnit = (rowIdx: number, unitIdx: number) =>
    setGroup((g) => ({
      ...g,
      rows: g.rows.map((r, i) => i !== rowIdx ? r : ({
        ...r, pattern: r.pattern.filter((_, j) => j !== unitIdx),
      })),
    }));

  const totalRows = group.rows.reduce((acc, r) => acc + r.rowRepeat, 0);
  const droppedOverrideCount = materialised.droppedOverrideKeys.length;

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
            </section>

            <section style={sectionStyle}>
              <h4 style={sectionTitleStyle}>
                Row sequence
                <span style={badgeStyle}>
                  {group.rows.length} template{group.rows.length === 1 ? '' : 's'} ·
                  {' '}{totalRows} physical row{totalRows === 1 ? '' : 's'} ·
                  {' '}{materialised.counts.bess + materialised.counts.auxiliary} unit{(materialised.counts.bess + materialised.counts.auxiliary) === 1 ? '' : 's'}
                </span>
              </h4>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.rows.map((row, idx) => (
                  <BessRowCard
                    key={row.id}
                    row={row}
                    idx={idx}
                    isLast={idx === group.rows.length - 1}
                    isExpanded={expandedRowIdx === idx}
                    project={project}
                    editingChipKey={editingChipKey}
                    setEditingChipKey={setEditingChipKey}
                    onToggleExpand={() => setExpandedRowIdx(expandedRowIdx === idx ? -1 : idx)}
                    onChange={(patch) => updateRow(idx, patch)}
                    onAddPatternUnit={() => addPatternUnit(idx)}
                    onUpdatePatternUnit={(u, ref) => updatePatternUnit(idx, u, ref)}
                    onRemovePatternUnit={(u) => removePatternUnit(idx, u)}
                    onDuplicate={() => duplicateRow(idx)}
                    onDelete={() => deleteRow(idx)}
                    onMoveUp={() => moveRow(idx, idx - 1)}
                    onMoveDown={() => moveRow(idx, idx + 1)}
                  />
                ))}
                <button type="button" onClick={addRow} style={addRowBtnStyle}>
                  + Add row template
                </button>
                <p style={hintStyle}>
                  Reuse: <em>duplicate template</em> clones a row inline for tweaking.
                  For an exactly-identical row repeated N times, set <em>Repeat row × N</em>.
                  An empty pattern makes the row act as a pure spacer.
                </p>
              </div>
            </section>

            <section style={sectionStyle}>
              <h4 style={sectionTitleStyle}>Summary</h4>
              <div style={summaryTileStyle}>
                <Stat k="Row templates" v={group.rows.length} />
                <Stat k="Physical rows" v={totalRows} />
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
            Press <kbd style={kbdStyle}>Esc</kbd> to cancel
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
  onAddPatternUnit: () => void;
  onUpdatePatternUnit: (unitIdx: number, ref: BessRowUnit) => void;
  onRemovePatternUnit: (unitIdx: number) => void;
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
              Pattern · repeats inside one row
            </div>
            <div style={patternRowStyle}>
              {row.pattern.length === 0 && (
                <span style={{ fontSize: 11, color: 'var(--ink-soft)', fontStyle: 'italic' }}>
                  (empty pattern — this row is a pure spacer)
                </span>
              )}
              {row.pattern.map((unit, uIdx) => (
                <UnitChip
                  key={uIdx}
                  unit={unit}
                  project={p.project}
                  editingKey={p.editingChipKey}
                  setEditingKey={p.setEditingChipKey}
                  chipKey={`${idx}-${uIdx}`}
                  onChange={(ref) => p.onUpdatePatternUnit(uIdx, ref)}
                  onRemove={() => p.onRemovePatternUnit(uIdx)}
                />
              ))}
              <span style={patternRepeatBadgeStyle}>× {row.patternRepeat}</span>
              <button type="button" onClick={p.onAddPatternUnit} style={ghostBtnTinyStyle}>+ add unit</button>
            </div>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Pattern repeat × N</span>
              <NumberDraft value={row.patternRepeat} min={1} step={1} integer
                onCommit={(v) => p.onChange({ patternRepeat: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Unit spacing — edge-to-edge (m)</span>
              <NumberDraft value={row.spacingWithinM} min={0} step={0.1}
                onCommit={(v) => p.onChange({ spacingWithinM: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Repeat row × N</span>
              <NumberDraft value={row.rowRepeat} min={1} step={1} integer
                onCommit={(v) => p.onChange({ rowRepeat: v })} />
            </label>
            <label style={fieldStyleSm}>
              <span style={fieldLabelStyle}>Gap to next row (m)</span>
              <NumberDraft value={row.gapToNextRowM} min={0} step={0.1}
                disabled={isLast}
                onCommit={(v) => p.onChange({ gapToNextRowM: v })} />
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
  if (row.pattern.length === 0) return `spacer · gap ${row.gapToNextRowM} m`;
  const totalUnits = row.pattern.length * row.patternRepeat;
  const repeatTxt = row.rowRepeat > 1 ? ` · row × ${row.rowRepeat}` : '';
  return `${totalUnits} unit${totalUnits === 1 ? '' : 's'}${repeatTxt} · gap ${row.gapToNextRowM} m`;
}

// ===== Unit chip with click-to-edit model picker =====

interface UnitChipProps {
  unit: BessRowUnit;
  project: Project;
  chipKey: string;
  editingKey: string | null;
  setEditingKey: (k: string | null) => void;
  onChange: (ref: BessRowUnit) => void;
  onRemove: () => void;
}

function UnitChip(p: UnitChipProps) {
  // Pull all BESS + aux entries the user can reference. Personal +
  // global only -- 'local' is deprecated for new entries (task #23).
  const candidates = useMemo(() => [
    ...listEntriesByKind(p.project, 'bess'),
    ...listEntriesByKind(p.project, 'auxiliary'),
  ].filter((e) => e._scope !== 'local'), [p.project]);

  const current = candidates.find((c) => c._scope === p.unit.catalogScope && c.id === p.unit.modelId);
  const isEditing = p.editingKey === p.chipKey;
  const isBess = current?.kind === 'bess';
  const isAux = current?.kind === 'auxiliary';
  const chipClass = isBess ? unitChipBessStyle : isAux ? unitChipAuxStyle : unitChipMissingStyle;

  return (
    <span style={{ position: 'relative' }}>
      <span
        style={chipClass}
        onClick={() => p.setEditingKey(isEditing ? null : p.chipKey)}
        title={current?.displayName ?? `Missing: ${p.unit.modelId}`}
      >
        {isBess ? 'B · ' : isAux ? 'A · ' : '? '}
        {current?.displayName ?? '(missing)'}
      </span>
      {isEditing && (
        <span style={chipMenuStyle}>
          <select
            value={`${p.unit.catalogScope}:${p.unit.modelId}`}
            onChange={(e) => {
              const [scope, ...rest] = e.target.value.split(':');
              p.onChange({
                catalogScope: scope as CatalogScope,
                modelId: rest.join(':'),
              });
            }}
            style={{ ...inputStyle, fontSize: 12 }}
            autoFocus
            onBlur={() => p.setEditingKey(null)}
          >
            {candidates.map((c) => (
              <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>
                {c.displayName} {c._scope === 'personal' ? '· personal' : ''}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => { p.onRemove(); p.setEditingKey(null); }}
            style={{ ...ghostBtnTinyStyle, color: 'var(--red)' }}>
            ✕ remove unit
          </button>
        </span>
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
    minX = Math.min(minX, p.x - p.fp.widthM / 2);
    maxX = Math.max(maxX, p.x + p.fp.widthM / 2);
    minY = Math.min(minY, p.y - p.fp.lengthM / 2);
    maxY = Math.max(maxY, p.y + p.fp.lengthM / 2);
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
        // Rotate the rect about its own centre to match the group rotation.
        return (
          <g key={i} transform={`translate(${p.x} ${p.y}) rotate(${rotationDeg})`}>
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
const rowCardStyle: React.CSSProperties = {
  border: '1px solid var(--light)', borderRadius: 6, background: 'var(--paper)', overflow: 'hidden',
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
const patternRepeatBadgeStyle: React.CSSProperties = {
  marginLeft: 'auto', padding: '2px 8px', background: 'var(--yellow)', color: 'var(--ink)',
  fontWeight: 600, borderRadius: 99, fontSize: 11, fontFamily: 'var(--font-mono)',
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
const chipMenuStyle: React.CSSProperties = {
  position: 'absolute', top: '100%', left: 0, marginTop: 4, zIndex: 20,
  background: 'var(--paper)', border: '1px solid var(--light)', borderRadius: 4,
  padding: 6, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 240,
  boxShadow: 'var(--shadow-2)',
};
const addRowBtnStyle: React.CSSProperties = {
  width: '100%', padding: 10, border: '1px dashed var(--light)', borderRadius: 6,
  background: 'transparent', color: 'var(--ink-soft)', fontSize: 13, fontWeight: 500, cursor: 'pointer',
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
