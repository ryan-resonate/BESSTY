import { useState } from 'react';
import type { Group, Project, Source, Receiver, SourceKind } from '../lib/types';
import { limitForPeriod } from '../lib/types';
import type { ReceiverResult } from '../lib/solver';
import type { BaseMap, ContourMode } from './MapView';
import type { Palette } from '../lib/colormap';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { ImportObjectsModal } from './ImportObjectsModal';
import { EpsgPicker } from './EpsgPicker';
import { inferGeoTiffCrs, parseDemGeoTiff } from '../lib/demUpload';
import { presetForEpsg } from '../lib/projections';
import type { DemRaster } from '../lib/dem';
import { paletteCss } from '../lib/colormap';

const GROUP_PALETTE = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899',
  '#14b8a6', '#ef4444', '#6366f1', '#84cc16', '#06b6d4',
];

export type AddMode = 'none' | 'wtg' | 'bess' | 'auxiliary' | 'receiver' | 'measure';

export type Tab = 'sources' | 'area' | 'receivers' | 'import' | 'results' | 'layers';

interface Props {
  project: Project;
  results: ReceiverResult[] | null;
  selectedIds: Set<string>;
  selectedGroupId: string | null;
  onSelect(id: string | null, modifiers?: { shift?: boolean }): void;
  onSelectGroup(groupId: string): void;
  onClearSelection(): void;
  onCreateGroup(name: string, color?: string): void;
  onRenameGroup(id: string, name: string): void;
  onRecolorGroup(id: string, color: string): void;
  onDeleteGroup(id: string): void;
  onSetGroupMembers(id: string, memberIds: string[]): void;
  onBulkUpdateSources(patch: Partial<Source>): void;
  onBulkUpdateReceivers(patch: Partial<Receiver>): void;
  onBulkDeleteSelected(): void;
  addMode: AddMode;
  setAddMode(mode: AddMode): void;
  setProject(p: Project): void;
  onRunGrid(): void;
  computing: boolean;
  lastSolveMs: number | null;
  onOpenSettings(): void;
  /// Replace the project's DEM (used by the Import tab's DEM uploader).
  setDem(d: DemRaster | null, source: 'auto' | 'upload'): void;
  /// Source of the currently-active DEM — "auto" means AWS Terrain Tiles,
  /// "upload" means a user-supplied GeoTIFF.
  demSource: 'auto' | 'upload';
  /// Active tab — lifted into ProjectScreen so placement can switch tabs.
  activeTab: Tab;
  setActiveTab(t: Tab): void;

  // Layer/contour settings, plumbed for the Layers tab.
  baseMap: BaseMap;
  setBaseMap(b: BaseMap): void;
  showContours: boolean;
  setShowContours(v: boolean): void;
  contourMode: ContourMode;
  setContourMode(m: ContourMode): void;
  contourOpacity: number;
  setContourOpacity(v: number): void;
  contourStepDb: number;
  setContourStepDb(v: number): void;
  palette: Palette;
  setPalette(p: Palette): void;
  domainMode: 'auto' | 'fixed';
  setDomainMode(m: 'auto' | 'fixed'): void;
  fixedDomain: { min: number; max: number };
  setFixedDomain(d: { min: number; max: number }): void;
  /// Setting the user can edit in the Layers tab to override the
  /// auto-computed contour bounds. `min`/`max`/`step` are in dB.
  contourBounds: { min: number; max: number; step: number };
  setContourBounds(b: { min: number; max: number; step: number }): void;
  demStatus: 'idle' | 'loading' | 'ready' | 'error';
  demTilesLoaded: number | null;
  gridSpacingM: number;
  setGridSpacingM(v: number): void;
}

const TABS: Array<{ id: Tab; label: string; numbered?: number }> = [
  { id: 'sources',   label: 'Sources',   numbered: 1 },
  { id: 'area',      label: 'Area',      numbered: 2 },
  { id: 'receivers', label: 'Receivers', numbered: 3 },
  { id: 'import',    label: 'Import' },
  { id: 'results',   label: 'Results' },
  { id: 'layers',    label: 'Layers' },
];

export function SidePanel(props: Props) {
  const tab = props.activeTab;
  const setTab = props.setActiveTab;
  const { project } = props;

  // Step badge filled when section has content (implicit checklist).
  const filled: Record<Tab, boolean> = {
    sources: project.sources.length > 0,
    area: !!project.calculationArea,
    receivers: project.receivers.length > 0,
    import: false,
    results: false,
    layers: false,
  };

  // Click anywhere in the side panel that isn't an explicit add-mode button
  // cancels any active add-mode. Lets the user "stop placing" by clicking
  // on the panel chrome instead of having to click the same button again.
  function maybeCancelAddMode(ev: React.MouseEvent) {
    if (props.addMode === 'none') return;
    const target = ev.target as HTMLElement;
    if (target.closest('[data-keep-add-mode]')) return;
    props.setAddMode('none');
  }

  return (
    <aside className="side-panel" onClick={maybeCancelAddMode}>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' on' : ''}${filled[t.id] ? ' filled' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.numbered && <span className="step-badge">{t.numbered}</span>}
            {t.label}
          </button>
        ))}
      </div>

      <div className="tab-body">
        {/* Selection card pinned to the top of every tab — shows the
            single-edit / multi-edit / group-edit panel as appropriate. */}
        <SelectionCard {...props} />

        {tab === 'sources' && <SourcesTab {...props} />}
        {tab === 'area' && <AreaTab {...props} />}
        {tab === 'receivers' && <ReceiversTab {...props} />}
        {tab === 'import' && <ImportTab {...props} />}
        {tab === 'results' && <ResultsTab {...props} />}
        {tab === 'layers' && <LayersTab {...props} />}
      </div>
    </aside>
  );
}

// ============== Selection card ==============

function SelectionCard(props: Props) {
  const {
    project, selectedIds, selectedGroupId, onClearSelection, onCreateGroup,
    onRenameGroup, onRecolorGroup, onDeleteGroup,
    onBulkUpdateSources, onBulkUpdateReceivers, onBulkDeleteSelected,
  } = props;

  if (selectedIds.size === 0) return null;

  const selectedSources = project.sources.filter((s) => selectedIds.has(s.id));
  const selectedReceivers = project.receivers.filter((r) => selectedIds.has(r.id));
  const group = selectedGroupId
    ? (project.groups ?? []).find((g) => g.id === selectedGroupId) ?? null
    : null;

  return (
    <section className="sp-section selection-card">
      <h3>
        <span>
          {group ? `Group · ${group.name}` : `${selectedIds.size} selected`}
        </span>
        <button className="x-btn" onClick={onClearSelection} title="Clear selection">✕</button>
      </h3>

      {group ? (
        <GroupEditor
          group={group}
          onRename={(n) => onRenameGroup(group.id, n)}
          onRecolor={(c) => onRecolorGroup(group.id, c)}
          onDelete={() => onDeleteGroup(group.id)}
        />
      ) : (
        <div className="selection-meta">
          {selectedSources.length > 0 && (
            <span className="muted">
              {selectedSources.length} source{selectedSources.length === 1 ? '' : 's'}
            </span>
          )}
          {selectedSources.length > 0 && selectedReceivers.length > 0 && <span className="muted"> · </span>}
          {selectedReceivers.length > 0 && (
            <span className="muted">
              {selectedReceivers.length} receiver{selectedReceivers.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      )}

      {/* Bulk-edit only meaningful for ≥ 2 selected (single selection edits
          inline in the per-tab list). */}
      {selectedIds.size >= 2 && (
        <BulkEditPanel
          project={project}
          selectedSources={selectedSources}
          selectedReceivers={selectedReceivers}
          onBulkUpdateSources={onBulkUpdateSources}
          onBulkUpdateReceivers={onBulkUpdateReceivers}
        />
      )}

      <div className="add-row">
        {!group && selectedIds.size >= 2 && (
          <button
            className="btn small"
            onClick={() => {
              const name = prompt('Name this group', 'New group');
              if (!name) return;
              const used = new Set((project.groups ?? []).map((g) => g.color));
              const colour = GROUP_PALETTE.find((c) => !used.has(c)) ?? GROUP_PALETTE[0];
              onCreateGroup(name.trim() || 'Group', colour);
            }}
          >+ Save as group</button>
        )}
        <button className="btn small" style={{ color: 'var(--red)' }}
          onClick={onBulkDeleteSelected}
          title="Delete selection (Del). Undo with Ctrl+Z."
        >Delete</button>
      </div>
    </section>
  );
}

function GroupEditor(props: {
  group: Group;
  onRename(n: string): void;
  onRecolor(c: string): void;
  onDelete(): void;
}) {
  const { group, onRename, onRecolor, onDelete } = props;
  return (
    <>
      <Field label="Group name">
        <input value={group.name} onChange={(e) => onRename(e.target.value)} />
      </Field>
      <Field label="Colour">
        <div className="palette-row">
          {GROUP_PALETTE.map((c) => (
            <button
              key={c}
              className={`palette-swatch${group.color === c ? ' on' : ''}`}
              title={c}
              onClick={() => onRecolor(c)}
            >
              <span style={{ background: c, width: 36, height: 12, display: 'block', borderRadius: 2 }} />
            </button>
          ))}
        </div>
      </Field>
      <div className="add-row">
        <button className="btn small" style={{ color: 'var(--red)' }} onClick={() => {
          if (confirm(`Delete group "${group.name}"? Members will keep existing.`)) onDelete();
        }}>Delete group</button>
      </div>
    </>
  );
}

function BulkEditPanel(props: {
  project: Project;
  selectedSources: Source[];
  selectedReceivers: Receiver[];
  onBulkUpdateSources(patch: Partial<Source>): void;
  onBulkUpdateReceivers(patch: Partial<Receiver>): void;
}) {
  const { project, selectedSources, selectedReceivers, onBulkUpdateSources, onBulkUpdateReceivers } = props;

  // Buffer the bulk-edit changes locally; the user pushes "Apply" to commit.
  // Until then, no project-state writes (and therefore no recompute) fire.
  const [srcDraft, setSrcDraft] = useState<Partial<Source>>({});
  const [rxDraft, setRxDraft] = useState<Partial<Receiver>>({});

  function setSrc<K extends keyof Source>(k: K, v: Source[K] | undefined) {
    setSrcDraft((d) => {
      const next: Partial<Source> = { ...d };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });
  }
  function setRx<K extends keyof Receiver>(k: K, v: Receiver[K] | undefined) {
    setRxDraft((d) => {
      const next: Partial<Receiver> = { ...d };
      if (v === undefined) delete next[k];
      else next[k] = v;
      return next;
    });
  }
  function apply() {
    if (Object.keys(srcDraft).length > 0) onBulkUpdateSources(srcDraft);
    if (Object.keys(rxDraft).length > 0) onBulkUpdateReceivers(rxDraft);
    setSrcDraft({});
    setRxDraft({});
  }
  function reset() {
    setSrcDraft({});
    setRxDraft({});
  }
  const dirty = Object.keys(srcDraft).length + Object.keys(rxDraft).length > 0;

  const allSourceKinds = new Set(selectedSources.map((s) => s.kind));
  const allWtg = selectedSources.length > 0 && [...allSourceKinds].every((k) => k === 'wtg');
  const allSameKind = selectedSources.length >= 2 && allSourceKinds.size === 1;
  const sharedKind = allSameKind ? [...allSourceKinds][0] : null;

  const sharedKey = selectedSources.length > 0
    ? `${selectedSources[0].catalogScope}:${selectedSources[0].modelId}`
    : null;
  const allSameModel = sharedKey != null
    && selectedSources.every((s) => `${s.catalogScope}:${s.modelId}` === sharedKey);
  const baselineEntry = allSameModel ? lookupEntry(project, selectedSources[0]) : null;

  // Model picker is offered when all selected sources share a kind (not
  // necessarily the same model). All choices are catalog entries of that
  // kind, scoped local-then-global.
  const modelChoices = sharedKind ? listEntriesByKind(project, sharedKind) : [];

  // While the user has a pending model swap in the draft, the mode dropdown
  // should reflect the *target* model's modes — not the current selection's.
  // Fall back to the shared entry of the existing selection when no swap
  // is pending.
  const draftEntry = (() => {
    if (!srcDraft.modelId || !srcDraft.catalogScope) return null;
    const sample = selectedSources[0] ?? null;
    if (!sample) return null;
    return lookupEntry(project, {
      ...sample,
      modelId: srcDraft.modelId,
      catalogScope: srcDraft.catalogScope,
    });
  })();
  const sharedEntry = draftEntry ?? baselineEntry;

  return (
    <div className="bulk-edit">
      {sharedKind && modelChoices.length > 0 && (
        <Field label={`Model — ${selectedSources.length} ${sharedKind}${selectedSources.length === 1 ? '' : 's'}`}>
          <select
            value={srcDraft.catalogScope && srcDraft.modelId ? `${srcDraft.catalogScope}:${srcDraft.modelId}` : ''}
            onChange={(e) => {
              if (!e.target.value) return;
              const [scope, ...rest] = e.target.value.split(':');
              const modelId = rest.join(':');
              const picked = modelChoices.find((c) => c._scope === scope && c.id === modelId);
              setSrc('catalogScope', scope as 'global' | 'local');
              setSrc('modelId', modelId);
              setSrc('modeOverride', picked?.defaultMode ?? null);
            }}
          >
            <option value="" disabled>Choose model…</option>
            {modelChoices.map((m) => (
              <option key={`${m._scope}:${m.id}`} value={`${m._scope}:${m.id}`}>
                {m.displayName}{m._scope === 'local' ? ' · local' : ''}
              </option>
            ))}
          </select>
        </Field>
      )}

      {sharedEntry && (
        <Field label={`Mode (${selectedSources.length} × ${sharedEntry.displayName})`}>
          <select
            value={srcDraft.modeOverride ?? ''}
            onChange={(e) => setSrc('modeOverride', e.target.value || null)}
          >
            <option value="" disabled>Choose mode…</option>
            {sharedEntry.modes.map((m) => (
              <option key={m.name} value={m.name}>{m.name}</option>
            ))}
          </select>
        </Field>
      )}

      {allWtg && (
        <Field label={`Hub height — ${selectedSources.length} WTGs (m)`}>
          <input
            type="number" min={50} max={250} step={1}
            placeholder="—"
            value={srcDraft.hubHeight ?? ''}
            onChange={(e) => setSrc('hubHeight', e.target.value === '' ? undefined : +e.target.value)}
          />
        </Field>
      )}

      {selectedReceivers.length >= 2 && (
        <>
          <div className="meta-line" style={{ marginTop: 6 }}>
            <b>{selectedReceivers.length} receiver{selectedReceivers.length === 1 ? '' : 's'}</b>
            {' '}— blank fields are left untouched on Apply.
          </div>
          <div className="grid-2">
            <Field label="Day limit dB(A)">
              <input
                type="number" min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitDayDbA ?? ''}
                onChange={(e) => setRx('limitDayDbA', e.target.value === '' ? undefined : +e.target.value)}
              />
            </Field>
            <Field label="Evening limit dB(A)">
              <input
                type="number" min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitEveningDbA ?? ''}
                onChange={(e) => setRx('limitEveningDbA', e.target.value === '' ? undefined : +e.target.value)}
              />
            </Field>
          </div>
          <div className="grid-2">
            <Field label="Night limit dB(A)">
              <input
                type="number" min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitNightDbA ?? ''}
                onChange={(e) => setRx('limitNightDbA', e.target.value === '' ? undefined : +e.target.value)}
              />
            </Field>
            <Field label="Height above ground (m)">
              <input
                type="number" min={0} max={300} step={0.5} placeholder="—"
                value={rxDraft.heightAboveGroundM ?? ''}
                onChange={(e) => setRx('heightAboveGroundM', e.target.value === '' ? undefined : +e.target.value)}
              />
            </Field>
          </div>
        </>
      )}

      <div className="add-row" style={{ paddingTop: 6, borderTop: '1px dashed var(--light)', marginTop: 4 }}>
        <button className="btn primary small" disabled={!dirty} onClick={apply}>Apply</button>
        <button className="btn small" disabled={!dirty} onClick={reset}>Reset</button>
      </div>
      <div className="hint">Tip: drag any selected marker to move them all.</div>
    </div>
  );
}

// -------------------- Sources --------------------

function SourcesTab(props: Props) {
  const { project, setProject, results, selectedIds, onSelect, addMode, setAddMode, onSelectGroup } = props;

  function updateSource(id: string, patch: Partial<Source>) {
    setProject({
      ...project,
      sources: project.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  }
  function removeSource(id: string) {
    setProject({ ...project, sources: project.sources.filter((s) => s.id !== id) });
  }
  function updateScenario(patch: Partial<Project['scenario']>) {
    setProject({ ...project, scenario: { ...project.scenario, ...patch } });
  }

  const wtgs = project.sources.filter((s) => s.kind === 'wtg');
  const bess = project.sources.filter((s) => s.kind === 'bess');
  const aux = project.sources.filter((s) => s.kind === 'auxiliary');

  return (
    <>
      <Card title="Scenario">
        <Field label="Project wind speed (m/s @ 10 m)">
          <input
            type="number" min={3} max={20} step={0.5}
            value={project.scenario.windSpeed}
            onChange={(e) => updateScenario({ windSpeed: +e.target.value })}
          />
        </Field>
        <Field label="Period">
          <select
            value={project.scenario.period}
            onChange={(e) => updateScenario({ period: e.target.value as Project['scenario']['period'] })}
          >
            <option value="day">Day</option>
            <option value="evening">Evening</option>
            <option value="night">Night</option>
          </select>
        </Field>
      </Card>

      <Card title="Add to map">
        <div className="add-row">
          <ModeBtn label="+ WTG"  mode="wtg"  current={addMode} onClick={setAddMode} />
          <ModeBtn label="+ BESS" mode="bess" current={addMode} onClick={setAddMode} />
          <ModeBtn label="+ Aux"  mode="auxiliary" current={addMode} onClick={setAddMode} />
        </div>
        {addMode !== 'none' && addMode !== 'measure' && addMode !== 'receiver' && (
          <div className="hint">Click on the map to place a {addMode.toUpperCase()}.</div>
        )}
      </Card>

      <GroupsList
        groups={project.groups ?? []}
        sources={project.sources}
        receivers={project.receivers}
        selectedIds={selectedIds}
        kindFilter="source"
        onSelectGroup={onSelectGroup}
        onSetGroupMembers={props.onSetGroupMembers}
      />

      <CollapsibleCard title="Wind turbines" count={wtgs.length} defaultOpen={wtgs.length > 0}>
        {wtgs.length === 0 && <div className="hint">No WTGs placed.</div>}
        {wtgs.map((s) => (
          <SourceItem
            key={s.id} project={project} source={s} results={results}
            selected={selectedIds.has(s.id)}
            onSelect={(modifiers) => onSelect(s.id, modifiers)}
            onChange={(p) => updateSource(s.id, p)} onRemove={() => removeSource(s.id)}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard title="BESS" count={bess.length} defaultOpen={bess.length > 0}>
        {bess.length === 0 && <div className="hint">No BESS placed.</div>}
        {bess.map((s) => (
          <SourceItem
            key={s.id} project={project} source={s} results={results}
            selected={selectedIds.has(s.id)}
            onSelect={(modifiers) => onSelect(s.id, modifiers)}
            onChange={(p) => updateSource(s.id, p)} onRemove={() => removeSource(s.id)}
          />
        ))}
      </CollapsibleCard>

      <CollapsibleCard title="Auxiliary equipment" count={aux.length} defaultOpen={aux.length > 0}>
        {aux.length === 0 && <div className="hint">Inverters and transformers appear here.</div>}
        {aux.map((s) => (
          <SourceItem
            key={s.id} project={project} source={s} results={results}
            selected={selectedIds.has(s.id)}
            onSelect={(modifiers) => onSelect(s.id, modifiers)}
            onChange={(p) => updateSource(s.id, p)} onRemove={() => removeSource(s.id)}
          />
        ))}
      </CollapsibleCard>
    </>
  );
}

// -------------------- Area --------------------

function AreaTab(props: Props) {
  const { project, setProject, gridSpacingM, setGridSpacingM, addMode, setAddMode } = props;
  const ca = project.calculationArea;
  if (!ca) {
    return (
      <Card title="Calculation area">
        <div className="hint">No calculation area defined.</div>
        <button
          className="btn block"
          onClick={() => setProject({
            ...project,
            calculationArea: {
              centerLatLng: project.sources[0]?.latLng ?? [-33.6, 138.7],
              widthM: 9000, heightM: 7000, rotationDeg: 0,
            },
          })}
        >+ Create default area</button>
      </Card>
    );
  }

  function updateCa(patch: Partial<typeof ca>) {
    setProject({ ...project, calculationArea: { ...ca!, ...patch } });
  }

  function recenterOnSources() {
    if (project.sources.length === 0) return;
    let latSum = 0, lngSum = 0;
    for (const s of project.sources) { latSum += s.latLng[0]; lngSum += s.latLng[1]; }
    updateCa({ centerLatLng: [latSum / project.sources.length, lngSum / project.sources.length] });
  }

  return (
    <>
      <Card title="Calculation area">
        <div className="grid-2">
          <Field label="Centre lat">
            <input type="number" step={0.0001} value={ca.centerLatLng[0]}
              onChange={(e) => updateCa({ centerLatLng: [+e.target.value, ca.centerLatLng[1]] })} />
          </Field>
          <Field label="Centre lng">
            <input type="number" step={0.0001} value={ca.centerLatLng[1]}
              onChange={(e) => updateCa({ centerLatLng: [ca.centerLatLng[0], +e.target.value] })} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Width (m)">
            <input type="number" min={500} max={50000} step={500} value={ca.widthM}
              onChange={(e) => updateCa({ widthM: +e.target.value })} />
          </Field>
          <Field label="Height (m)">
            <input type="number" min={500} max={50000} step={500} value={ca.heightM}
              onChange={(e) => updateCa({ heightM: +e.target.value })} />
          </Field>
        </div>
        <div className="add-row">
          <button className="btn small" onClick={recenterOnSources}>Recentre on sources</button>
        </div>
        <div className="hint">Drag the yellow dashed rectangle on the map (TBD); for now use the inputs above.</div>
      </Card>

      <Card title="Grid">
        <Field label="Spacing (m)">
          <select value={gridSpacingM} onChange={(e) => setGridSpacingM(+e.target.value)}>
            <option value={25}>25 m (fine)</option>
            <option value={50}>50 m</option>
            <option value={100}>100 m (default)</option>
            <option value={200}>200 m (preview)</option>
          </select>
        </Field>
        <div className="hint">
          {Math.round(ca.widthM / gridSpacingM) * Math.round(ca.heightM / gridSpacingM)} cells
          ({Math.round(ca.widthM / gridSpacingM)} × {Math.round(ca.heightM / gridSpacingM)})
        </div>
      </Card>

      <Card title="Tools">
        <div className="add-row">
          <ModeBtn label="📏 Measure tape" mode="measure" current={addMode} onClick={setAddMode} />
        </div>
        {addMode === 'measure' && (
          <div className="hint">Click two points on the map to measure straight-line distance.</div>
        )}
      </Card>
    </>
  );
}

// -------------------- Receivers --------------------

function ReceiversTab(props: Props) {
  const { project, setProject, results, selectedIds, onSelect, addMode, setAddMode, onSelectGroup } = props;

  function updateReceiver(id: string, patch: Partial<Receiver>) {
    setProject({
      ...project,
      receivers: project.receivers.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    });
  }
  function removeReceiver(id: string) {
    setProject({ ...project, receivers: project.receivers.filter((r) => r.id !== id) });
  }

  return (
    <>
      <Card title="Add receivers">
        <div className="add-row">
          <ModeBtn label="+ Receiver" mode="receiver" current={addMode} onClick={setAddMode} />
        </div>
        {addMode === 'receiver' && <div className="hint">Click on the map to place a receiver.</div>}
      </Card>

      <GroupsList
        groups={project.groups ?? []}
        sources={project.sources}
        receivers={project.receivers}
        selectedIds={selectedIds}
        kindFilter="receiver"
        onSelectGroup={onSelectGroup}
        onSetGroupMembers={props.onSetGroupMembers}
      />

      <Card title="Receiver list" count={project.receivers.length}>
        {project.receivers.length === 0 && <div className="hint">No receivers placed.</div>}
        <div className="hint">
          Active period: <b>{project.scenario.period}</b> — limits below are the
          full day / evening / night triplet; the active one is bolded.
        </div>
        {project.receivers.map((r) => {
          const result = results?.find((x) => x.receiverId === r.id);
          const activeLimit = limitForPeriod(r, project.scenario.period);
          const fail = result && result.totalDbA > activeLimit;
          return (
            <div key={r.id}
              className={`item${selectedIds.has(r.id) ? ' selected' : ''}`}
              onClick={(e) => onSelect(r.id, { shift: e.shiftKey })}
            >
              <div className="item-name">{r.name}</div>
              <div className="item-meta">
                limit {activeLimit} dB(A) ·{' '}
                {result && isFinite(result.totalDbA) ? (
                  <span style={{ color: fail ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                    {result.totalDbA.toFixed(1)} dB(A) {fail ? '✗' : '✓'}
                  </span>
                ) : <span className="muted">— run to compute</span>}
              </div>
              <div className="item-controls" onClick={(e) => e.stopPropagation()}>
                <input className="inline-edit" type="number" min={0} max={300} step={0.5}
                  value={r.heightAboveGroundM}
                  onChange={(e) => updateReceiver(r.id, { heightAboveGroundM: +e.target.value })}
                  title="Height above ground (m)" />
                <PeriodLimitInput
                  label="D" period="day" active={project.scenario.period === 'day'}
                  value={r.limitDayDbA}
                  onChange={(v) => updateReceiver(r.id, { limitDayDbA: v })}
                />
                <PeriodLimitInput
                  label="E" period="evening" active={project.scenario.period === 'evening'}
                  value={r.limitEveningDbA}
                  onChange={(v) => updateReceiver(r.id, { limitEveningDbA: v })}
                />
                <PeriodLimitInput
                  label="N" period="night" active={project.scenario.period === 'night'}
                  value={r.limitNightDbA}
                  onChange={(v) => updateReceiver(r.id, { limitNightDbA: v })}
                />
                <button className="x-btn" onClick={() => removeReceiver(r.id)}>✕</button>
              </div>
            </div>
          );
        })}
      </Card>
    </>
  );
}

// -------------------- Import --------------------

function ImportTab(props: Props) {
  const { project, setProject, setDem, demSource } = props;
  const [importOpen, setImportOpen] = useState(false);

  // Two-step DEM upload: (1) user picks file → we sniff the CRS and stash
  // the file for confirmation; (2) user confirms / overrides the CRS and
  // hits "Use this DEM" → we actually parse the raster.
  const [demFile, setDemFile] = useState<File | null>(null);
  const [demEpsg, setDemEpsg] = useState<number>(4326);
  const [demInferredEpsg, setDemInferredEpsg] = useState<number | null>(null);
  const [demBusy, setDemBusy] = useState(false);
  const [demError, setDemError] = useState<string | null>(null);
  const [demName, setDemName] = useState<string | null>(null);

  async function pickDemFile(file: File) {
    setDemError(null);
    setDemFile(file);
    try {
      const inferred = await inferGeoTiffCrs(file);
      setDemInferredEpsg(inferred);
      setDemEpsg(inferred ?? 4326);
    } catch (e) {
      // Couldn't even read the GeoTIFF header — surface the error and
      // keep the picker open with the WGS84 default.
      setDemError(String(e));
      setDemInferredEpsg(null);
      setDemEpsg(4326);
    }
  }

  async function commitDemUpload() {
    if (!demFile) return;
    setDemError(null);
    setDemBusy(true);
    try {
      const dem = await parseDemGeoTiff(demFile, { epsgOverride: demEpsg });
      setDem(dem, 'upload');
      setDemName(demFile.name);
      setDemFile(null);
      setDemInferredEpsg(null);
    } catch (e) {
      setDemError(String(e));
    }
    setDemBusy(false);
  }

  function cancelDemUpload() {
    setDemFile(null);
    setDemInferredEpsg(null);
    setDemError(null);
  }

  return (
    <>
      <Card title="Import objects">
        <div className="hint">
          Receiver and source locations from <b>CSV</b>, <b>KML</b>, or <b>shapefile</b>
          (.zip bundle). The dialog asks which kind to import as — receivers, WTGs,
          BESS, or auxiliary equipment — and lets you map attributes to project fields.
          CSV and shapefile (without .prj) accept any registered projected CRS.
        </div>
        <button className="btn primary block" onClick={() => setImportOpen(true)}>
          📁 Import locations…
        </button>
      </Card>

      <Card title="Digital elevation model">
        <div className="hint">
          DEM is auto-loaded from <b>AWS Terrain Tiles</b> by default. Upload a custom
          GeoTIFF to override it for this project — useful for site-specific LiDAR.
          Both geographic (WGS84) and projected (UTM, MGA, NZTM, …) CRSs are supported.
        </div>
        <div className="meta-line">
          Active source: <b>{demSource === 'upload' ? `upload · ${demName ?? 'GeoTIFF'}` : 'auto (AWS Terrain Tiles)'}</b>
        </div>

        {!demFile ? (
          <div className="add-row">
            <label className="btn small" style={{ cursor: 'pointer' }}>
              ↑ Upload .tif
              <input
                type="file" accept=".tif,.tiff"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) pickDemFile(f);
                  e.target.value = '';
                }}
              />
            </label>
            {demSource === 'upload' && (
              <button className="btn small" onClick={() => { setDem(null, 'auto'); setDemName(null); }}>
                Reset to auto
              </button>
            )}
          </div>
        ) : (
          <div className="settings-section" style={{ marginTop: 8 }}>
            <div className="meta-line">Selected: <b>{demFile.name}</b></div>
            <div className="hint">
              {demInferredEpsg
                ? <>Inferred CRS: <b>EPSG:{demInferredEpsg}</b>
                    {presetForEpsg(demInferredEpsg) ? ` (${presetForEpsg(demInferredEpsg)!.label})` : ' — not in preset list, override below'}.
                    Confirm or override below.</>
                : 'No CRS tag found in the GeoTIFF — pick the source CRS below.'}
            </div>
            <EpsgPicker value={demEpsg} onChange={setDemEpsg} label="DEM CRS" />
            <div className="add-row">
              <button className="btn small primary" disabled={demBusy} onClick={commitDemUpload}>
                {demBusy ? 'Parsing…' : 'Use this DEM'}
              </button>
              <button className="btn small" disabled={demBusy} onClick={cancelDemUpload}>Cancel</button>
            </div>
          </div>
        )}
        {demError && <div className="hint" style={{ color: 'var(--red)' }}>Error: {demError}</div>}
      </Card>

      {importOpen && (
        <ImportObjectsModal
          project={project} setProject={setProject}
          onClose={() => setImportOpen(false)}
        />
      )}
    </>
  );
}


// -------------------- Results --------------------

function ResultsTab(props: Props) {
  const { project, results, computing, lastSolveMs, onRunGrid, onOpenSettings } = props;
  const exceedances = (results ?? []).filter((r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    return rx && r.totalDbA > limitForPeriod(rx, project.scenario.period);
  });
  return (
    <>
      <Card title="Run">
        <button className="btn primary block" disabled={computing} onClick={onRunGrid}>
          {computing ? 'Running grid…' : '▶ Run grid'}
        </button>
        {lastSolveMs != null && (
          <div className="meta-line">point solve: {lastSolveMs.toFixed(0)} ms · {project.sources.length} src × {project.receivers.length} rcv</div>
        )}
      </Card>

      <Card title="Receiver pass / fail">
        <div className="meta-line">
          {project.receivers.length - exceedances.length} of {project.receivers.length} compliant
          {exceedances.length > 0 && <span style={{ color: 'var(--red)' }}> · {exceedances.length} over</span>}
        </div>
      </Card>

      <Card title="Project settings">
        <button className="btn block" onClick={onOpenSettings}>⚙ Open settings</button>
      </Card>
    </>
  );
}

// -------------------- Layers --------------------

const PALETTES: Palette[] = ['viridis', 'magma', 'plasma', 'inferno', 'rdylgn', 'grey'];

function LayersTab(props: Props) {
  const {
    baseMap, setBaseMap, showContours, setShowContours,
    contourMode, setContourMode,
    contourOpacity, setContourOpacity, palette, setPalette,
    contourStepDb, setContourStepDb,
    contourBounds, setContourBounds,
    domainMode, setDomainMode, fixedDomain, setFixedDomain,
    demStatus, demTilesLoaded,
  } = props;
  return (
    <>
      <Card title="Base map">
        <div className="seg block">
          <button className={baseMap === 'satellite' ? 'on' : ''} onClick={() => setBaseMap('satellite')}>Satellite</button>
          <button className={baseMap === 'osm' ? 'on' : ''} onClick={() => setBaseMap('osm')}>OSM</button>
        </div>
      </Card>

      <Card title="Contours">
        <Field label="">
          <label className="row-checkbox">
            <input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} />
            <span>Show contour grid</span>
          </label>
        </Field>
        <Field label="Style">
          <div className="seg block">
            <button className={contourMode === 'filled' ? 'on' : ''} onClick={() => setContourMode('filled')}>Filled</button>
            <button className={contourMode === 'lines' ? 'on' : ''} onClick={() => setContourMode('lines')}>Lines</button>
            <button className={contourMode === 'both' ? 'on' : ''} onClick={() => setContourMode('both')}>Both</button>
          </div>
        </Field>
        <Field label={`Opacity ${(contourOpacity * 100).toFixed(0)}%`}>
          <input type="range" min={0.2} max={0.95} step={0.05} value={contourOpacity}
            onChange={(e) => setContourOpacity(+e.target.value)} />
        </Field>
        <div className="grid-2">
          <Field label="Min (dB)">
            <input type="number" step={1} value={contourBounds.min}
              onChange={(e) => setContourBounds({ ...contourBounds, min: +e.target.value })} />
          </Field>
          <Field label="Max (dB)">
            <input type="number" step={1} value={contourBounds.max}
              onChange={(e) => setContourBounds({ ...contourBounds, max: +e.target.value })} />
          </Field>
        </div>
        <Field label="Step (dB)">
          <select value={contourStepDb} onChange={(e) => {
            const v = +e.target.value;
            setContourStepDb(v);
            setContourBounds({ ...contourBounds, step: v });
          }}>
            <option value={1}>1</option>
            <option value={2}>2</option>
            <option value={2.5}>2.5</option>
            <option value={5}>5 (default)</option>
            <option value={10}>10</option>
          </select>
        </Field>
        <Field label="Palette">
          <div className="palette-row">
            {PALETTES.map((p) => (
              <button key={p}
                className={`palette-swatch${palette === p ? ' on' : ''}`}
                title={p} onClick={() => setPalette(p)}
              >
                <span style={{
                  background: `linear-gradient(90deg, ${paletteCss(p, 0)}, ${paletteCss(p, 0.5)}, ${paletteCss(p, 1)})`,
                  width: 36, height: 12, display: 'block', borderRadius: 2,
                }} />
              </button>
            ))}
          </div>
        </Field>
        <Field label="Domain (dB)">
          <div className="seg block">
            <button className={domainMode === 'auto' ? 'on' : ''} onClick={() => setDomainMode('auto')}>Auto</button>
            <button className={domainMode === 'fixed' ? 'on' : ''} onClick={() => setDomainMode('fixed')}>Fixed</button>
          </div>
        </Field>
        {domainMode === 'fixed' && (
          <div className="grid-2">
            <Field label="Min">
              <input type="number" step={1} value={fixedDomain.min}
                onChange={(e) => setFixedDomain({ ...fixedDomain, min: +e.target.value })} />
            </Field>
            <Field label="Max">
              <input type="number" step={1} value={fixedDomain.max}
                onChange={(e) => setFixedDomain({ ...fixedDomain, max: +e.target.value })} />
            </Field>
          </div>
        )}
      </Card>

      <Card title="Terrain">
        <div className="meta-line">
          DEM:{' '}
          {demStatus === 'idle' && <span className="muted">idle</span>}
          {demStatus === 'loading' && <span className="muted">loading…</span>}
          {demStatus === 'ready' && <span style={{ color: 'var(--green)' }}>{demTilesLoaded} tiles loaded</span>}
          {demStatus === 'error' && <span style={{ color: 'var(--red)' }}>fetch failed</span>}
        </div>
        <div className="hint">Source: AWS Terrain Tiles (NASADEM/SRTM blend, free).</div>
      </Card>
    </>
  );
}

// -------------------- Shared bits --------------------

function Card(props: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="sp-section">
      <h3>
        <span>{props.title}</span>
        {props.count != null && <span className="badge">{props.count}</span>}
      </h3>
      {props.children}
    </section>
  );
}

function CollapsibleCard(props: { title: string; count: number; defaultOpen: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(props.defaultOpen);
  return (
    <section className="sp-section collapsible">
      <h3 onClick={() => setOpen(!open)} style={{ cursor: 'pointer', userSelect: 'none' }}>
        <span><span style={{ display: 'inline-block', width: 10, color: 'var(--mid)' }}>{open ? '▾' : '▸'}</span> {props.title}</span>
        <span className="badge">{props.count}</span>
      </h3>
      {open && <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{props.children}</div>}
    </section>
  );
}

function Field(props: { label: string; children: React.ReactNode }) {
  return (
    <label className="fld">
      {props.label && <span>{props.label}</span>}
      {props.children}
    </label>
  );
}

function ModeBtn(props: { label: string; mode: AddMode; current: AddMode; onClick(m: AddMode): void }) {
  return (
    <button
      data-keep-add-mode
      className={`btn small${props.current === props.mode ? ' active' : ''}`}
      onClick={() => props.onClick(props.current === props.mode ? 'none' : props.mode)}
    >{props.label}</button>
  );
}

function PeriodLimitInput(props: {
  label: string;
  period: 'day' | 'evening' | 'night';
  active: boolean;
  value: number;
  onChange(v: number): void;
}) {
  return (
    <span title={`${props.period} limit dB(A)`} style={{
      display: 'inline-flex', alignItems: 'center', gap: 2,
      padding: '0 4px', borderRadius: 3,
      background: props.active ? 'var(--yellow)' : 'transparent',
      border: props.active ? '1px solid var(--ink)' : '1px solid transparent',
    }}>
      <span style={{
        fontSize: 9, fontFamily: 'var(--font-mono)',
        fontWeight: props.active ? 700 : 500,
        color: 'var(--ink-soft)',
      }}>{props.label}</span>
      <input
        type="number" min={20} max={80} step={1}
        value={props.value}
        onChange={(e) => props.onChange(+e.target.value)}
        style={{
          width: 36,
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          fontWeight: props.active ? 700 : 500,
          border: 'none', background: 'transparent', padding: 0, outline: 'none',
        }}
      />
    </span>
  );
}

function GroupsList(props: {
  groups: Group[];
  sources: Source[];
  receivers: Receiver[];
  selectedIds: Set<string>;
  /// Show groups whose members include at least one item of this kind.
  /// Mixed groups appear under both filters.
  kindFilter: 'source' | 'receiver';
  onSelectGroup(id: string): void;
  onSetGroupMembers(id: string, memberIds: string[]): void;
}) {
  const { groups, sources, receivers, selectedIds, kindFilter, onSelectGroup, onSetGroupMembers } = props;
  const sourceIds = new Set(sources.map((s) => s.id));
  const receiverIds = new Set(receivers.map((r) => r.id));
  const matching = groups.filter((g) => g.memberIds.some((id) =>
    kindFilter === 'source' ? sourceIds.has(id) : receiverIds.has(id),
  ));
  if (matching.length === 0) return null;

  const nameOf = (id: string): string => {
    const s = sources.find((x) => x.id === id);
    if (s) return s.name;
    const r = receivers.find((x) => x.id === id);
    if (r) return r.name;
    return id;
  };

  return (
    <CollapsibleCard title="Groups" count={matching.length} defaultOpen>
      {matching.map((g) => (
        <ExpandableGroupItem
          key={g.id} group={g}
          memberNames={g.memberIds.map((id) => ({ id, name: nameOf(id) }))}
          selectedIds={selectedIds}
          onClickGroup={() => onSelectGroup(g.id)}
          onAddSelectedToGroup={() => {
            const next = Array.from(new Set([...g.memberIds, ...Array.from(selectedIds)]));
            onSetGroupMembers(g.id, next);
          }}
          onRemoveMember={(memberId) => {
            onSetGroupMembers(g.id, g.memberIds.filter((id) => id !== memberId));
          }}
        />
      ))}
    </CollapsibleCard>
  );
}

function ExpandableGroupItem(props: {
  group: Group;
  memberNames: Array<{ id: string; name: string }>;
  selectedIds: Set<string>;
  onClickGroup(): void;
  onAddSelectedToGroup(): void;
  onRemoveMember(id: string): void;
}) {
  const { group: g, memberNames, selectedIds, onClickGroup, onAddSelectedToGroup, onRemoveMember } = props;
  const [open, setOpen] = useState(false);
  const inGroup = memberNames.length;
  const selectionAddable = Array.from(selectedIds).some(
    (id) => !g.memberIds.includes(id),
  );
  return (
    <div className="item" style={{ gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          className="x-btn"
          style={{ width: 14, padding: 0, color: 'var(--mid)' }}
          onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
          title={open ? 'Collapse' : 'Expand'}
        >{open ? '▾' : '▸'}</button>
        <div className="item-name" style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }}
          onClick={onClickGroup}>
          {g.color && (
            <span style={{
              display: 'inline-block', width: 10, height: 10, borderRadius: 2,
              background: g.color, border: '1px solid var(--ink)',
            }} />
          )}
          {g.name}
        </div>
        <div className="item-meta">{inGroup}</div>
      </div>
      {open && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 18 }}>
            {memberNames.length === 0 && <span className="hint">No members.</span>}
            {memberNames.map((m) => (
              <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                <span style={{ flex: 1 }}>{m.name}</span>
                <button
                  className="x-btn"
                  onClick={(e) => { e.stopPropagation(); onRemoveMember(m.id); }}
                  title="Remove from group"
                >✕</button>
              </div>
            ))}
          </div>
          {selectionAddable && (
            <div className="add-row" style={{ paddingLeft: 18 }}>
              <button className="btn small" onClick={onAddSelectedToGroup}>
                + Add selection to group
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function SourceItem(props: {
  project: Project;
  source: Source;
  results: ReceiverResult[] | null;
  selected: boolean;
  onSelect(modifiers?: { shift?: boolean }): void;
  onChange(p: Partial<Source>): void;
  onRemove(): void;
}) {
  const { project, source: s, selected, onSelect, onChange, onRemove } = props;
  const candidates = listEntriesByKind(project, s.kind);
  const entry = lookupEntry(project, s);
  const modes = entry?.modes ?? [];
  return (
    <div
      className={`item${selected ? ' selected' : ''}`}
      onClick={(e) => onSelect({ shift: e.shiftKey })}
    >
      <div className="item-name">{s.name}</div>
      <div className="item-controls" onClick={(e) => e.stopPropagation()}>
        <select
          value={`${s.catalogScope}:${s.modelId}`}
          onChange={(e) => {
            const [scope, ...rest] = e.target.value.split(':');
            const modelId = rest.join(':');
            const picked = candidates.find((c) => c._scope === scope && c.id === modelId);
            onChange({
              catalogScope: scope as 'global' | 'local',
              modelId,
              modeOverride: picked?.defaultMode ?? null,
            });
          }}
        >
          {candidates.map((m) => (
            <option key={`${m._scope}:${m.id}`} value={`${m._scope}:${m.id}`}>
              {m.displayName}{m._scope === 'local' ? ' · local' : ''}
            </option>
          ))}
        </select>
        {modes.length > 1 && (
          <select value={s.modeOverride ?? (entry?.defaultMode ?? '')}
            onChange={(e) => onChange({ modeOverride: e.target.value })}>
            {modes.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
          </select>
        )}
        {s.kind === 'wtg' && (
          <input type="number" min={50} max={250} step={1}
            value={s.hubHeight ?? 100}
            onChange={(e) => onChange({ hubHeight: +e.target.value })}
            title="Hub height (m)" />
        )}
        <button className="x-btn" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
      </div>
    </div>
  );
}

export type { SourceKind };
