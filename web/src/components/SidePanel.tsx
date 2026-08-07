import { useEffect, useState } from 'react';
import { notify } from '../lib/notify';
import type {
  Annotation, CustomContourLine, Group, Project, ProjectSettings, Source, Receiver, SourceKind,
  ReferenceLayer, ReferenceLayerStyle, ReferenceFeature, ReferencePointShape,
} from '../lib/types';
import { DEFAULT_REFERENCE_STYLE } from '../lib/types';
import { annotationsOf, dimensionLabel } from '../lib/annotations';
import { weightingFor, weightingLabel } from '../lib/weighting';
import {
  DEFAULT_TONALITY_PENALTY_DB, describeTonalBands, tonalityBlocked, tonalityMethodInfo,
  tonalityMethods, tonalitySettingsFor,
  type TonalityMethod,
} from '../lib/tonality';
import { limitForPeriod, settingsOf } from '../lib/types';
import { assessedLevel, exceedsLimit, limitComparisonFor } from '../lib/limits';
import type { ReceiverResult } from '../lib/solver';
import type { BaseMap, ContourMode } from './MapView';
import type { Palette } from '../lib/colormap';
import { containerHeightFor, footprintFor, listEntriesByKind, lookupEntry } from '../lib/catalog';
import { ImportObjectsModal } from './ImportObjectsModal';
import { ReferenceImportModal } from './ReferenceImportModal';
import { DxfImportModal } from './DxfImportModal';
import { nextBarrierIndexFor } from '../lib/dxfImport';
import { ProjectMetaPanel } from './ProjectMetaPanel';
import { EpsgPicker } from './EpsgPicker';
import { NumericInput } from './NumericInput';
import { inferGeoTiffCrs, parseDemGeoTiff } from '../lib/demUpload';
import {
  DEM_MAX_BYTES,
  deleteProjectDem,
  uploadProjectDem,
} from '../lib/firestoreStorage';
import { presetForEpsg } from '../lib/projections';
import {
  defaultFilenameStem,
  exportContoursKml,
  exportContoursShp,
  exportGridGeoTiff,
  exportPerSourceContribCsv,
  exportPerSourceContribXlsx,
  exportReceiversCsv,
  exportReceiversXlsx,
  exportSourcesShp,
  exportSpectraCsv,
  exportSpectraXlsx,
  triggerDownload,
} from '../lib/exporters';
import type { GridResult } from '../lib/solver';
import {
  buildContourLines, clampLineWidth, customTracesFrom, steppedTracesFrom, unionContourLevels,
  CUSTOM_LABEL_MAX,
} from '../lib/contourLines';
import { makeBandsForRange } from '../lib/colormap';
import type { DemRaster } from '../lib/dem';
import { paletteCss } from '../lib/colormap';

const GROUP_PALETTE = [
  '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899',
  '#14b8a6', '#ef4444', '#6366f1', '#84cc16', '#06b6d4',
];

/// Small badge appended to a catalog entry's display name in the source
/// picker dropdowns. Empty for global entries (the common case) so they
/// stay tidy; explicit for the scoped ones so the user knows where the
/// model lives and who can see it.
function scopeSuffix(scope: 'global' | 'local' | 'personal'): string {
  if (scope === 'local')    return ' · local';
  if (scope === 'personal') return ' · personal';
  return '';
}

export type AddMode = 'none' | 'wtg' | 'bess' | 'auxiliary' | 'receiver' | 'measure' | 'barrier'
  | 'annotation' | 'dimension';

/// No 'settings' tab: settings live in the floating window, opened from the
/// ⚙ in this panel's tab row.
export type Tab = 'sources' | 'area' | 'receivers' | 'barriers' | 'import' | 'results' | 'layers' | 'project';

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
  onBulkUpdateSourcesByIds(ids: string[], patch: Partial<Source>): void;
  onBulkUpdateReceivers(patch: Partial<Receiver>): void;
  onBulkDeleteSelected(): void;
  addMode: AddMode;
  setAddMode(mode: AddMode): void;
  setProject(p: Project): void;
  onRunGrid(): void;
  computing: boolean;
  lastSolveMs: number | null;
  /// Replace the project's DEM (used by the Import tab's DEM uploader).
  setDem(d: DemRaster | null, source: 'auto' | 'upload'): void;
  /// Source of the currently-active DEM — "auto" means AWS Terrain Tiles,
  /// "upload" means a user-supplied GeoTIFF.
  demSource: 'auto' | 'upload';
  /// The active elevation raster, for the DXF import's "Z is an absolute top
  /// level" option: a barrier stores height ABOVE ground, so the terrain under
  /// each vertex has to be subtracted from the drawing's level.
  dem?: DemRaster | null;
  /// Active tab — lifted into ProjectScreen so placement can switch tabs.
  activeTab: Tab;
  setActiveTab(t: Tab): void;

  /// Project-level metadata (versions, privacy) needs these. Optional
  /// so the SidePanel still type-checks for callers that don't expose
  /// the cloud-project context (none today, but keeps it loose-coupled).
  projectId?: string;
  currentUid?: string;
  currentDisplayName?: string;
  /// Where the live project lives — 'firestore' enables the Project tab's
  /// version + privacy controls; anything else shows a "local project"
  /// note instead.
  projectSource?: 'firestore' | 'none';
  /// I10: open the floating settings window.
  onOpenSettings?(): void;
  /// I15: open the PDF export dialog (captures the current viewport).
  onOpenPdfExport?(): void;
  /// I14: open the factorial configuration study.
  onOpenStudy?(): void;
  /// Called when the user reverts to a saved version. The handler should
  /// merge the snapshot's content into the live project while preserving
  /// current ownership + privacy metadata. Wired up in ProjectScreen.
  onApplyVersion?: (snapshot: Project) => void;

  /// Open the BESS-group wizard. Pass a group to edit, or omit to
  /// create a new one (lands at the current map centre).
  onOpenBessGroupWizard?: (group?: import('../lib/types').BessGroup) => void;
  /// Delete an entire BESS group, including its materialised sources.
  onDeleteBessGroup?: (groupId: string) => void;

  // Layer/contour settings, plumbed for the Layers tab.
  baseMap: BaseMap;
  setBaseMap(b: BaseMap): void;
  showContours: boolean;
  setShowContours(v: boolean): void;
  /// Debug overlay — show every grid cell centre as a small dot. Lets
  /// the user verify alignment between the raster, contours, and the
  /// underlying source/receiver positions when something looks off.
  showGridDebug?: boolean;
  showReceiverLimits?: boolean;
  setShowReceiverLimits?(v: boolean): void;
  setShowGridDebug?(v: boolean): void;
  /// I: Barnes-Hut clustering overlay — tile boundaries labelled with the
  /// effective source count the solver actually used for each.
  showBhDebug?: boolean;
  setShowBhDebug?(v: boolean): void;
  contourMode: ContourMode;
  setContourMode(m: ContourMode): void;
  contourOpacity: number;
  setContourOpacity(v: number): void;
  contourStepDb: number;
  setContourStepDb(v: number): void;
  palette: Palette;
  setPalette(p: Palette): void;
  /// Legacy fields kept on the prop interface so existing call sites still
  /// type-check while we phase the auto/fixed-domain toggle out — both
  /// `contourBounds` (Min/Max in the Layers tab) now drives the colour
  /// scale directly, so these are no longer consulted.
  domainMode?: 'auto' | 'fixed';
  setDomainMode?(m: 'auto' | 'fixed'): void;
  fixedDomain?: { min: number; max: number };
  setFixedDomain?(d: { min: number; max: number }): void;
  /// Setting the user can edit in the Layers tab to override the
  /// auto-computed contour bounds. `min`/`max`/`step` are in dB.
  contourBounds: { min: number; max: number; step: number };
  /// User-named compliance lines (Layers → Custom lines).
  customContours?: CustomContourLine[];
  setCustomContours?(v: CustomContourLine[]): void;
  /// Figure annotations (Layers → Annotations).
  selectedAnnotationId?: string | null;
  onSelectAnnotation?(id: string | null): void;
  onUpdateAnnotation?(id: string, patch: Partial<Annotation>): void;
  onRemoveAnnotation?(id: string): void;
  setContourBounds(b: { min: number; max: number; step: number }): void;
  demStatus: 'idle' | 'loading' | 'ready' | 'error';
  demTilesLoaded: number | null;
  gridSpacingM: number;
  setGridSpacingM(v: number): void;
  /// Called by the import modal after sources / receivers are added so
  /// the parent can recentre the map on the new items.
  onAfterImport?(bounds: { sw: [number, number]; ne: [number, number] }): void;
  /// Called when the user hits "Fit to objects" in the Area tab — sets
  /// the calculation area to encompass every source + receiver, padded
  /// by 10% so contour bands aren't clipped at the edges.
  onFitCalcAreaToObjects?(): void;
  /// Latest contour grid — needed by the Results tab's GeoTIFF / KML / SHP
  /// exporters. Null when no grid has been computed yet.
  grid: GridResult | null;
  /// Replace contour Min/Max with the grid's measured range. Wired to the
  /// "Auto-fit" button in the Layers tab.
  onAutoFitContourBounds?(): void;
}

const TABS: Array<{ id: Tab; label: string; numbered?: number }> = [
  { id: 'sources',   label: 'Sources',   numbered: 1 },
  { id: 'area',      label: 'Area',      numbered: 2 },
  { id: 'receivers', label: 'Receivers', numbered: 3 },
  { id: 'barriers',  label: 'Barriers' },
  { id: 'import',    label: 'Import' },
  { id: 'project',   label: 'Project' },
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
    barriers: project.barriers.length > 0,
    import: false,
    project: false,
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
      {/* Tabs and the gear share one row. The gear is a SIBLING of the tab
          list, not a member of it: inside the list it took part in the wrap,
          so on a narrow panel it rode the last wrapped row and appeared under
          the tabs instead of beside them. */}
      <div className="tab-strip">
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
        {props.onOpenSettings && (
          <button
            className="gear-btn"
            title="Settings"
            aria-label="Settings"
            onClick={() => props.onOpenSettings?.()}
          >⚙</button>
        )}
      </div>

      <div className="tab-body">
        {/* Selection card pinned to the top of every tab — shows the
            single-edit / multi-edit / group-edit panel as appropriate. */}
        <SelectionCard {...props} />

        {tab === 'sources' && <SourcesTab {...props} />}
        {tab === 'area' && <AreaTab {...props} />}
        {tab === 'receivers' && <ReceiversTab {...props} />}
        {tab === 'barriers' && <BarriersTab {...props} />}
        {tab === 'import' && <ImportTab {...props} />}
        {tab === 'project' && props.projectId && props.currentUid && (
          <ProjectMetaPanel
            projectId={props.projectId}
            project={project}
            currentUid={props.currentUid}
            currentDisplayName={props.currentDisplayName ?? ''}
            source={props.projectSource ?? 'none'}
            onApplyVersion={(snap) => props.onApplyVersion?.(snap)}
          />
        )}
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
    onBulkUpdateSources, onBulkUpdateSourcesByIds, onBulkUpdateReceivers, onBulkDeleteSelected,
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
          onBulkUpdateSourcesByIds={onBulkUpdateSourcesByIds}
          onBulkUpdateReceivers={onBulkUpdateReceivers}
        />
      )}

      <div className="add-row">
        {!group && selectedIds.size >= 2 && (
          <button
            className="btn small"
            onClick={async () => {
              const name = await notify.prompt({
                title: 'Name this group',
                label: 'Group name',
                defaultValue: 'New group',
                confirmLabel: 'Create',
              });
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
        <button className="btn small" style={{ color: 'var(--red)' }} onClick={async () => {
          const ok = await notify.confirm({
            title: `Delete group "${group.name}"?`,
            body: 'Members will keep existing — only the grouping is removed.',
            confirmLabel: 'Delete group',
            danger: true,
          });
          if (ok) onDelete();
        }}>Delete group</button>
      </div>
    </>
  );
}

interface ModelGroup {
  key: string;
  kind: Source['kind'];
  modelId: string;
  ids: string[];
  sample: Source;
  entry: ReturnType<typeof lookupEntry>;
}
type ModelDraft = { catalogScope?: Source['catalogScope']; modelId?: string; modeOverride?: string | null };

function BulkEditPanel(props: {
  project: Project;
  selectedSources: Source[];
  selectedReceivers: Receiver[];
  onBulkUpdateSources(patch: Partial<Source>): void;
  onBulkUpdateSourcesByIds(ids: string[], patch: Partial<Source>): void;
  onBulkUpdateReceivers(patch: Partial<Receiver>): void;
}) {
  const { project, selectedSources, selectedReceivers, onBulkUpdateSourcesByIds, onBulkUpdateReceivers } = props;
  // Limits are read in the project's assessment weighting, so their labels
  // have to say which one — a "Night limit dB(A)" field over a dB(C) project
  // is a wrong number waiting to happen.
  const unit = weightingLabel(weightingFor(project));

  // Group the selection by (kind, current model) so a mixed multi-type
  // selection can retarget each type independently — e.g. all BESS → model X,
  // all transformers → model Y, all inverters → model Z. (A single shared
  // model is just one group, so the common case is unchanged.)
  const modelGroups: ModelGroup[] = (() => {
    const map = new Map<string, ModelGroup>();
    for (const s of selectedSources) {
      const key = `${s.kind}::${s.catalogScope}:${s.modelId}`;
      let g = map.get(key);
      if (!g) {
        g = { key, kind: s.kind, modelId: s.modelId, ids: [], sample: s, entry: lookupEntry(project, s) };
        map.set(key, g);
      }
      g.ids.push(s.id);
    }
    return [...map.values()];
  })();
  const wtgIds = selectedSources.filter((s) => s.kind === 'wtg').map((s) => s.id);

  // Buffered drafts (committed on Apply, so no recompute fires mid-edit):
  //  - one model/mode draft per (kind,model) group, keyed by group.key
  //  - one WTG-only draft (hub height / rotor) applied to the WTG subset
  //  - one receiver draft applied to all selected receivers
  const [modelDrafts, setModelDrafts] = useState<Record<string, ModelDraft>>({});
  const [wtgDraft, setWtgDraft] = useState<Partial<Source>>({});
  const [rxDraft, setRxDraft] = useState<Partial<Receiver>>({});

  function setModel(key: string, patch: ModelDraft) {
    setModelDrafts((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }
  function setWtg<K extends keyof Source>(k: K, v: Source[K] | undefined) {
    setWtgDraft((d) => {
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
  const modelDirty = Object.values(modelDrafts).some(
    (d) => d && (d.modelId != null || d.modeOverride !== undefined),
  );
  const dirty = modelDirty || Object.keys(wtgDraft).length > 0 || Object.keys(rxDraft).length > 0;

  function apply() {
    for (const g of modelGroups) {
      const d = modelDrafts[g.key];
      if (!d) continue;
      const patch: Partial<Source> = {};
      if (d.modelId != null && d.catalogScope != null) {
        patch.modelId = d.modelId;
        patch.catalogScope = d.catalogScope;
      }
      if (d.modeOverride !== undefined) patch.modeOverride = d.modeOverride;
      if (Object.keys(patch).length > 0) onBulkUpdateSourcesByIds(g.ids, patch);
    }
    if (wtgIds.length > 0 && Object.keys(wtgDraft).length > 0) onBulkUpdateSourcesByIds(wtgIds, wtgDraft);
    if (Object.keys(rxDraft).length > 0) onBulkUpdateReceivers(rxDraft);
    setModelDrafts({});
    setWtgDraft({});
    setRxDraft({});
  }
  function reset() {
    setModelDrafts({});
    setWtgDraft({});
    setRxDraft({});
  }

  return (
    <div className="bulk-edit">
      {modelGroups.length > 1 && (
        <div className="meta-line" style={{ marginBottom: 4 }}>
          <b>{modelGroups.length} source types selected</b> — change each below.
        </div>
      )}
      {modelGroups.map((g) => (
        <ModelGroupEditor
          key={g.key}
          project={project}
          group={g}
          draft={modelDrafts[g.key] ?? {}}
          onSet={(patch) => setModel(g.key, patch)}
        />
      ))}

      {wtgIds.length > 0 && (
        <div className="grid-2">
          <Field label={`Hub height — ${wtgIds.length} WTG${wtgIds.length === 1 ? '' : 's'} (m)`}>
            <NumericInput min={50} max={250} step={1} placeholder="—"
              value={wtgDraft.hubHeight}
              allowEmpty
              onChange={() => undefined}
              onChangeOptional={(v) => setWtg('hubHeight', v)}
            />
          </Field>
          <Field label={`Rotor diameter — ${wtgIds.length} WTG${wtgIds.length === 1 ? '' : 's'} (m)`}>
            <NumericInput min={50} max={300} step={1} placeholder="—"
              value={wtgDraft.rotorDiameterM}
              allowEmpty
              onChange={() => undefined}
              onChangeOptional={(v) => setWtg('rotorDiameterM', v)}
            />
          </Field>
        </div>
      )}

      {selectedReceivers.length >= 2 && (
        <>
          <div className="meta-line" style={{ marginTop: 6 }}>
            <b>{selectedReceivers.length} receiver{selectedReceivers.length === 1 ? '' : 's'}</b>
            {' '}— blank fields are left untouched on Apply.
          </div>
          <div className="grid-2">
            <Field label={`Day limit ${unit}`}>
              <NumericInput min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitDayDbA}
                allowEmpty onChange={() => undefined}
                onChangeOptional={(v) => setRx('limitDayDbA', v)}
              />
            </Field>
            <Field label={`Evening limit ${unit}`}>
              <NumericInput min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitEveningDbA}
                allowEmpty onChange={() => undefined}
                onChangeOptional={(v) => setRx('limitEveningDbA', v)}
              />
            </Field>
          </div>
          <div className="grid-2">
            <Field label={`Night limit ${unit}`}>
              <NumericInput min={20} max={80} step={1} placeholder="—"
                value={rxDraft.limitNightDbA}
                allowEmpty onChange={() => undefined}
                onChangeOptional={(v) => setRx('limitNightDbA', v)}
              />
            </Field>
            <Field label="Height above ground (m)">
              <NumericInput min={0} max={300} step={0.5} placeholder="—"
                value={rxDraft.heightAboveGroundM}
                allowEmpty onChange={() => undefined}
                onChangeOptional={(v) => setRx('heightAboveGroundM', v)}
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

/// One model/mode bulk editor for a single (kind, current-model) slice of the
/// selection. Buffered: writes into the parent's per-group draft; nothing
/// commits until the panel's shared Apply. Blank = leave untouched.
function ModelGroupEditor(props: {
  project: Project;
  group: ModelGroup;
  draft: ModelDraft;
  onSet(patch: ModelDraft): void;
}) {
  const { project, group, draft, onSet } = props;
  const choices = listEntriesByKind(project, group.kind);
  // Mode list reflects the TARGET model when a swap is pending, else current.
  const targetEntry = (draft.modelId && draft.catalogScope)
    ? lookupEntry(project, { ...group.sample, catalogScope: draft.catalogScope, modelId: draft.modelId })
    : group.entry;
  const kindLabel = group.kind === 'wtg' ? 'WTG' : group.kind === 'bess' ? 'BESS' : 'Aux';
  const currentName = group.entry?.displayName ?? group.modelId ?? '(unknown model)';
  const modelValue = draft.catalogScope && draft.modelId ? `${draft.catalogScope}:${draft.modelId}` : '';

  return (
    <div style={{ borderTop: '1px dashed var(--light)', paddingTop: 6, marginTop: 6 }}>
      <div className="meta-line" style={{ fontSize: 11 }}>
        <b>{kindLabel}</b> · {currentName} <span className="muted">× {group.ids.length}</span>
      </div>
      <Field label="Change model to">
        <select
          value={modelValue}
          onChange={(e) => {
            if (!e.target.value) {
              onSet({ catalogScope: undefined, modelId: undefined, modeOverride: undefined });
              return;
            }
            const [scope, ...rest] = e.target.value.split(':');
            const modelId = rest.join(':');
            const picked = choices.find((c) => c._scope === scope && c.id === modelId);
            onSet({
              catalogScope: scope as Source['catalogScope'],
              modelId,
              modeOverride: picked?.defaultMode ?? null,
            });
          }}
        >
          <option value="">(no change)</option>
          {choices.map((c) => (
            <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>
              {c.displayName}{scopeSuffix(c._scope)}
            </option>
          ))}
        </select>
      </Field>
      {targetEntry && targetEntry.modes.length > 0 && (
        <Field label="Change mode to">
          <select
            value={draft.modeOverride ?? ''}
            onChange={(e) => onSet({ modeOverride: e.target.value || undefined })}
          >
            <option value="">(no change)</option>
            {targetEntry.modes.map((md) => (
              <option key={md.name} value={md.name}>{md.name}</option>
            ))}
          </select>
        </Field>
      )}
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
          <NumericInput min={3} max={20} step={0.5}
            value={project.scenario.windSpeed}
            fallback={10}
            onChange={(v) => updateScenario({ windSpeed: v })}
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
          {/* BESS group sits between BESS and Aux as a peer button. Not a
              ModeBtn -- it opens the wizard immediately instead of toggling
              a click-on-map placement mode. */}
          {props.onOpenBessGroupWizard && (
            <button
              data-keep-add-mode
              className="btn small"
              type="button"
              onClick={() => props.onOpenBessGroupWizard?.()}
              title="Open the BESS-group / array wizard"
            >+ BESS group</button>
          )}
          <ModeBtn label="+ Aux"  mode="auxiliary" current={addMode} onClick={setAddMode} />
        </div>
        {addMode !== 'none' && addMode !== 'measure' && addMode !== 'receiver' && (
          <div className="hint">Click on the map to place a {addMode.toUpperCase()}.</div>
        )}
      </Card>

      {project.bessGroups && project.bessGroups.length > 0 && (
        <Card title={`BESS groups (${project.bessGroups.length})`}>
          {project.bessGroups.map((g) => {
            const count = project.sources.filter((s) => s.groupId === g.id).length;
            return (
              <div key={g.id} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 8px', border: '1px solid var(--light)',
                borderRadius: 4, marginBottom: 6,
              }}>
                <div style={{ flex: 1, fontSize: 12 }}>
                  <div style={{ fontWeight: 600 }}>{g.name}</div>
                  <div style={{ color: 'var(--ink-soft)', fontSize: 11 }}>
                    {count} unit{count === 1 ? '' : 's'} · rotation {g.rotationDeg}°
                  </div>
                </div>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => props.onOpenBessGroupWizard?.(g)}
                  title="Edit group"
                >Edit</button>
                <button
                  className="btn small"
                  type="button"
                  onClick={async () => {
                    const ok = await notify.confirm({
                      title: `Delete BESS group "${g.name}"?`,
                      body: `Its ${count} unit${count === 1 ? '' : 's'} will be deleted too.`,
                      confirmLabel: 'Delete group + units',
                      danger: true,
                    });
                    if (ok) props.onDeleteBessGroup?.(g.id);
                  }}
                  style={{ color: 'var(--red)' }}
                  title="Delete group + all its units"
                >✕</button>
              </div>
            );
          })}
        </Card>
      )}

      <GroupsList
        groups={project.groups ?? []}
        sources={project.sources}
        receivers={project.receivers}
        selectedIds={selectedIds}
        kindFilter="source"
        onSelectGroup={onSelectGroup}
        onSetGroupMembers={props.onSetGroupMembers}
      />

      <CollapsibleCard title="Wind turbines" count={wtgs.length}
        persistKey="sources.wtg" defaultOpen={false}>
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

      <CollapsibleCard title="BESS" count={bess.length}
        persistKey="sources.bess" defaultOpen={false}>
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

      <CollapsibleCard title="Auxiliary equipment" count={aux.length}
        persistKey="sources.auxiliary" defaultOpen={false}>
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
            <NumericInput step={0.0001} value={ca.centerLatLng[0]}
              fallback={ca.centerLatLng[0]}
              onChange={(v) => updateCa({ centerLatLng: [v, ca.centerLatLng[1]] })} />
          </Field>
          <Field label="Centre lng">
            <NumericInput step={0.0001} value={ca.centerLatLng[1]}
              fallback={ca.centerLatLng[1]}
              onChange={(v) => updateCa({ centerLatLng: [ca.centerLatLng[0], v] })} />
          </Field>
        </div>
        <div className="grid-2">
          <Field label="Width (m)">
            <NumericInput min={500} max={50000} step={500} value={ca.widthM}
              fallback={5000}
              onChange={(v) => updateCa({ widthM: v })} />
          </Field>
          <Field label="Height (m)">
            <NumericInput min={500} max={50000} step={500} value={ca.heightM}
              fallback={5000}
              onChange={(v) => updateCa({ heightM: v })} />
          </Field>
        </div>
        <div className="add-row">
          <button className="btn small" onClick={recenterOnSources}>Recentre on sources</button>
          {props.onFitCalcAreaToObjects && (
            <button
              className="btn small"
              onClick={props.onFitCalcAreaToObjects}
              title="Resize the calculation area to wrap every source + receiver, with a 10% buffer."
            >Fit to objects</button>
          )}
        </div>
        <div className="hint">Drag the yellow dashed rectangle on the map to move it; drag a corner handle to resize. The inputs above always reflect the current geometry.</div>
      </Card>

      <Card title="Grid">
        <Field label="Spacing (m)">
          <select value={gridSpacingM} onChange={(e) => setGridSpacingM(+e.target.value)}>
            <option value={25}>25 m</option>
            <option value={50}>50 m</option>
            <option value={100}>100 m</option>
            <option value={200}>200 m</option>
            <option value={300}>300 m</option>
          </select>
        </Field>
        <div className="hint">
          {Math.round(ca.widthM / gridSpacingM) * Math.round(ca.heightM / gridSpacingM)} cells
          ({Math.round(ca.widthM / gridSpacingM)} × {Math.round(ca.heightM / gridSpacingM)})
          <br />
          Default spacing is auto-picked from the calc-area size on first
          creation; pick a value to override and your choice sticks.
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
  // Levels and limits are both read in the project's assessment weighting, so
  // the label has to follow it rather than being spelled dB(A) in the source.
  const unit = weightingLabel(weightingFor(project));

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
          const fail = exceedsLimit(assessedLevel(result), activeLimit, limitComparisonFor(project));
          return (
            <div key={r.id}
              className={`item${selectedIds.has(r.id) ? ' selected' : ''}`}
              onClick={(e) => onSelect(r.id, { shift: e.shiftKey })}
            >
              <div className="item-name" onClick={(e) => e.stopPropagation()}>
                {/* Always-editable name; the visible chrome stays subtle so
                    it still reads as the row title until you click in. */}
                <input
                  className="inline-edit-name"
                  value={r.name}
                  onChange={(e) => updateReceiver(r.id, { name: e.target.value })}
                  placeholder="Receiver name"
                  title="Receiver name (click to edit)"
                />
              </div>
              <div className="item-meta">
                limit {activeLimit} {unit} ·{' '}
                {result && isFinite(result.totalDbA) ? (
                  <span style={{ color: fail ? 'var(--red)' : 'var(--green)', fontWeight: 600 }}>
                    {result.totalDbA.toFixed(1)} {unit} {fail ? '✗' : '✓'}
                  </span>
                ) : <span className="muted">— run to compute</span>}
                {/* A penalised level has to show its working: the number judged
                    against the limit is not the number solved. */}
                {result?.tonality?.tonal && (
                  <span
                    className="tonal-flag"
                    title={
                      `Tonal: ${describeTonalBands(result.tonality.bands)}`
                      + (result.tonalityPenaltyDb
                        ? ` · +${result.tonalityPenaltyDb} dB penalty applied`
                        : ' · no penalty applied (switch it on in Settings)')
                    }
                  >
                    ♪{result.tonalityPenaltyDb
                      ? ` +${result.tonalityPenaltyDb} → ${(result.assessedDbA ?? result.totalDbA).toFixed(1)}`
                      : ''}
                  </span>
                )}
              </div>
              <div className="item-controls" onClick={(e) => e.stopPropagation()}>
                <span className="inline-unit" title="Height above ground (m)">
                  <NumericInput className="inline-edit" min={0} max={300} step={0.5}
                    value={r.heightAboveGroundM} fallback={1.5}
                    onChange={(v) => updateReceiver(r.id, { heightAboveGroundM: v })}
                    title="Height above ground (m)" />
                  <span className="inline-unit-label">m</span>
                </span>
                <PeriodLimitInput
                  label="D" period="day" active={project.scenario.period === 'day'}
                  value={r.limitDayDbA} unit={unit}
                  onChange={(v) => updateReceiver(r.id, { limitDayDbA: v })}
                />
                <PeriodLimitInput
                  label="E" period="evening" active={project.scenario.period === 'evening'}
                  value={r.limitEveningDbA} unit={unit}
                  onChange={(v) => updateReceiver(r.id, { limitEveningDbA: v })}
                />
                <PeriodLimitInput
                  label="N" period="night" active={project.scenario.period === 'night'}
                  value={r.limitNightDbA} unit={unit}
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
  const [dxfOpen, setDxfOpen] = useState(false);

  // Two-step DEM upload: (1) user picks file → we sniff the CRS and stash
  // the file for confirmation; (2) user confirms / overrides the CRS and
  // hits "Use this DEM" → we actually parse the raster. Then for cloud
  // projects we also upload to Firebase Storage so the DEM persists.
  const [demFile, setDemFile] = useState<File | null>(null);
  const [demEpsg, setDemEpsg] = useState<number>(4326);
  const [demInferredEpsg, setDemInferredEpsg] = useState<number | null>(null);
  const [demBusy, setDemBusy] = useState(false);
  const [demError, setDemError] = useState<string | null>(null);
  const [demName, setDemName] = useState<string | null>(
    project.dem?.filename ?? null,
  );
  const [demUploadProgress, setDemUploadProgress] = useState<number | null>(null);

  // Keep the display name in sync when the project doc updates from a
  // remote source (collaborator uploaded a DEM in another tab).
  useEffect(() => {
    if (project.dem?.filename) setDemName(project.dem.filename);
  }, [project.dem?.filename]);

  async function pickDemFile(file: File) {
    setDemError(null);
    if (file.size > DEM_MAX_BYTES) {
      setDemError(
        `DEM is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is ` +
        `${(DEM_MAX_BYTES / 1024 / 1024).toFixed(0)} MB. ` +
        `Re-export at a coarser resolution or smaller area.`,
      );
      return;
    }
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
    setDemUploadProgress(null);
    try {
      // Parse first so we fail fast on bad/corrupt GeoTIFFs without
      // having uploaded a useless file to Storage.
      const dem = await parseDemGeoTiff(demFile, { epsgOverride: demEpsg });
      setDem(dem, 'upload');
      setDemName(demFile.name);

      // Persist to Firebase Storage if this is a cloud-backed project.
      // Local-only projects keep the in-memory DEM but skip the upload
      // -- they can't reference a Storage path from a non-Firestore doc.
      if (props.projectSource === 'firestore' && props.projectId && props.currentUid) {
        try {
          setDemUploadProgress(0);
          const meta = await uploadProjectDem(
            props.projectId,
            demFile,
            { onProgress: (frac) => setDemUploadProgress(frac) },
          );
          // If there was a previous DEM at a different path, clean it up
          // so we don't leak storage. Fire-and-forget; the rules already
          // gate this to project editors.
          const oldPath = project.dem?.storagePath;
          if (oldPath && oldPath !== meta.storagePath) {
            void deleteProjectDem(oldPath).catch(() => {});
          }
          setProject({
            ...project,
            dem: {
              storagePath: meta.storagePath,
              filename: meta.filename,
              sizeBytes: meta.sizeBytes,
              epsg: demEpsg,
              uploadedAt: new Date().toISOString(),
              uploadedByUid: props.currentUid,
            },
          });
        } catch (uploadErr) {
          // Upload failed but the in-memory DEM works for this session.
          // Surface a warning but don't reject the parse.
          setDemError(
            `DEM loaded for this session but cloud save failed: ${String(uploadErr)}. ` +
            `Other users won't see this DEM until the upload succeeds.`,
          );
        }
      }

      setDemFile(null);
      setDemInferredEpsg(null);
      setDemUploadProgress(null);
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

      <Card title="Import a drawing (DXF)">
        <div className="hint">
          Takes the site layout straight from a CAD drawing. Each layer maps to
          either <b>reference geometry</b> (drawn, never affects levels) or
          <b> walls</b> (which screen sound). A DXF states neither its coordinate
          system nor, reliably, its units, so the dialog asks — showing how big
          your site would be under each reading.
        </div>
        <button className="btn block" onClick={() => setDxfOpen(true)}>
          📐 Import DXF…
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
              <button className="btn small" onClick={() => {
                setDem(null, 'auto');
                setDemName(null);
                // Also clear the persisted DEM reference (and storage object).
                if (project.dem) {
                  const oldPath = project.dem.storagePath;
                  const { dem: _drop, ...rest } = project;
                  setProject(rest as Project);
                  void deleteProjectDem(oldPath).catch(() => {});
                }
              }}>
                Reset to auto
              </button>
            )}
            {demUploadProgress != null && (
              <div className="hint" style={{ marginTop: 6 }}>
                Uploading DEM to cloud… {Math.round(demUploadProgress * 100)}%
              </div>
            )}
            {project.dem && demSource === 'upload' && demUploadProgress == null && (
              <div className="hint" style={{ marginTop: 6, color: 'var(--ink-soft, #475569)' }}>
                Cloud-saved · {(project.dem.sizeBytes / 1024 / 1024).toFixed(1)} MB
              </div>
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
          onAfterImport={props.onAfterImport}
        />
      )}

      {dxfOpen && (
        <DxfImportModal
          nextBarrierIndex={nextBarrierIndexFor(project.barriers ?? [])}
          groundAt={props.dem ? (ll) => props.dem!.elevation(ll[0], ll[1]) : null}
          onClose={() => setDxfOpen(false)}
          onImport={(result) => {
            const layers: ReferenceLayer[] = result.referenceFeaturesByLayer.map((l, i) => ({
              id: `rl-dxf-${Date.now().toString(36)}-${i}`,
              name: l.layer,
              visible: true,
              kind: 'vector' as const,
              style: { ...DEFAULT_REFERENCE_STYLE, showLabels: l.features.some((f) => f.label) },
              features: l.features,
            }));
            setProject({
              ...project,
              barriers: [...(project.barriers ?? []), ...result.barriers],
              referenceLayers: [...(project.referenceLayers ?? []), ...layers],
            });
            // Fly to what was imported, so a wrong CRS is visible at once
            // rather than being discovered later as an empty map.
            //
            // Accumulated in a loop, never via `Math.min(...pts)`: spreading an
            // array of a few hundred thousand vertices — which a drawing full
            // of symbol blocks reaches — throws RangeError, and it would throw
            // AFTER the project had been updated, leaving the import applied,
            // the toast unshown and the dialog open.
            let minLat = Infinity; let minLng = Infinity;
            let maxLat = -Infinity; let maxLng = -Infinity;
            const see = (p: [number, number]) => {
              if (p[0] < minLat) minLat = p[0];
              if (p[0] > maxLat) maxLat = p[0];
              if (p[1] < minLng) minLng = p[1];
              if (p[1] > maxLng) maxLng = p[1];
            };
            for (const b of result.barriers) for (const p of b.polylineLatLng) see(p);
            for (const l of result.referenceFeaturesByLayer) {
              for (const f of l.features) for (const p of f.coords) see(p);
            }
            if (Number.isFinite(minLat) && props.onAfterImport) {
              props.onAfterImport({ sw: [minLat, minLng], ne: [maxLat, maxLng] });
            }
            notify.success(result.summary.join(' · '), { title: 'DXF imported' });
          }}
        />
      )}
    </>
  );
}


// -------------------- Results --------------------

function ResultsTab(props: Props) {
  const { project, results, grid, computing, lastSolveMs, onRunGrid, contourBounds } = props;
  const limitMode = limitComparisonFor(project);
  const exceedances = (results ?? []).filter((r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    return rx && exceedsLimit(assessedLevel(r), limitForPeriod(rx, project.scenario.period), limitMode);
  });

  // `computing` matters as much as `hasResults`: changing the weighting
  // relabels immediately but re-solves on a debounce, and an export fired in
  // that window writes dB(C) headers over A-weighted numbers.
  const hasResults = (results?.length ?? 0) > 0 && !computing;
  const hasGrid = grid != null;

  /// Grid-gated exports stay clickable with no grid — a `disabled` button
  /// gives zero feedback and reads as broken. Clicking explains instead.
  function requireGrid(): boolean {
    if (hasGrid) return true;
    notify.info(
      'These exports package the computed contour grid. Run a grid solve first, then export.',
      { title: 'No contour grid yet' },
    );
    return false;
  }
  const mutedWhenNoGrid = hasGrid ? undefined : { opacity: 0.55 };
  const gridHint = hasGrid ? undefined : 'Needs a computed contour grid — click for details';

  function download(blob: Blob, suffix: string, ext: string) {
    triggerDownload(`${defaultFilenameStem(project, suffix)}.${ext}`, blob);
  }

  function exportContours(format: 'kml' | 'shp') {
    if (!grid) return;
    // Build the line set with the same dB bands the user is currently
    // viewing so the export matches the on-screen contours exactly.
    const bands = makeBandsForRange(contourBounds.min, contourBounds.max, contourBounds.step);
    const thresholds = bands.map((b) => b.lo);
    // Custom lines ride along when their own export flag is set, tagged with
    // their name so a consumer can tell a compliance line from a palette step.
    const custom = (props.customContours ?? [])
      .filter((c) => c.export && Number.isFinite(c.levelDb));
    const traced = buildContourLines(grid, unionContourLevels(thresholds, custom));
    const named = customTracesFrom(traced, custom).map((c) => c.set);
    const sets = [
      // A level a named line already covers is not also written as a stepped
      // contour — the geometry is identical, so it would be one contour
      // appearing as two features.
      ...steppedTracesFrom(traced, thresholds, named.map((s) => s.threshold)),
      ...named,
    ];
    if (format === 'kml') {
      download(exportContoursKml(project, sets), 'contours', 'kml');
    } else {
      download(exportContoursShp(project, sets), 'contours', 'zip');
    }
  }

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

      {tonalityBlocked(project.scenario.bandSystem, tonalitySettingsFor(project)) && (
        <Card title="Tonality">
          <div className="hint" style={{ color: 'var(--red)', fontStyle: 'normal' }}>
            ⚠ {tonalityBlocked(project.scenario.bandSystem, tonalitySettingsFor(project))}
          </div>
        </Card>
      )}

      <Card title="Receiver pass / fail">
        <div className="meta-line">
          {project.receivers.length - exceedances.length} of {project.receivers.length} compliant
          {exceedances.length > 0 && <span style={{ color: 'var(--red)' }}> · {exceedances.length} over</span>}
        </div>
      </Card>

      <Card title="Export">
        <div className="hint">
          Receiver totals + per-source contributions + per-band spectra each export
          as <b>CSV</b> or <b>XLSX</b>. Contour lines export as <b>KML</b> or <b>shapefile</b>
          (.zip bundle). The grid raster exports as <b>GeoTIFF</b> in WGS84.
        </div>

        <div className="meta-line"><b>Receiver totals + compliance</b></div>
        <div className="add-row">
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportReceiversCsv(project, results), 'receivers', 'csv')}>
            ↓ CSV
          </button>
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportReceiversXlsx(project, results), 'receivers', 'xlsx')}>
            ↓ XLSX
          </button>
        </div>

        <div className="meta-line" style={{ marginTop: 8 }}><b>Per-source contributions</b></div>
        <div className="add-row">
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportPerSourceContribCsv(project, results), 'contributions', 'csv')}>
            ↓ CSV
          </button>
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportPerSourceContribXlsx(project, results), 'contributions', 'xlsx')}>
            ↓ XLSX
          </button>
        </div>

        <div className="meta-line" style={{ marginTop: 8 }}>
          <b>Per-band spectra</b>{' '}
          <span className="muted">
            ({project.scenario.bandSystem === 'oneThirdOctave' ? '31 × ⅓-octave' : '10 × octave'})
          </span>
        </div>
        <div className="add-row">
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportSpectraCsv(project, results), 'spectra', 'csv')}>
            ↓ CSV
          </button>
          <button className="btn small" disabled={!hasResults} onClick={() => download(exportSpectraXlsx(project, results), 'spectra', 'xlsx')}>
            ↓ XLSX
          </button>
        </div>

        <div className="meta-line" style={{ marginTop: 8 }}>
          <b>Source locations</b>{' '}
          <span className="muted">({project.sources.length} objects, incl. group members)</span>
        </div>
        <div className="add-row">
          <button
            className="btn small"
            disabled={project.sources.length === 0}
            onClick={() => download(exportSourcesShp(project), 'sources', 'zip')}
          >
            ↓ Shapefile
          </button>
        </div>

        <div className="meta-line" style={{ marginTop: 8 }}><b>Contour lines</b></div>
        <div className="add-row">
          <button className="btn small" style={mutedWhenNoGrid} title={gridHint} onClick={() => { if (requireGrid()) exportContours('kml'); }}>↓ KML</button>
          <button className="btn small" style={mutedWhenNoGrid} title={gridHint} onClick={() => { if (requireGrid()) exportContours('shp'); }}>↓ Shapefile</button>
        </div>

        <div className="meta-line" style={{ marginTop: 8 }}><b>Grid raster</b></div>
        <div className="add-row">
          <button
            className="btn small primary block"
            onClick={() => props.onOpenPdfExport?.()}
            disabled={!props.onOpenPdfExport}
            title="Report-quality snapshot: basemap image with vector contours and receivers"
          >📄 Export PDF…</button>
          <button
            className="btn small block"
            onClick={() => props.onOpenStudy?.()}
            disabled={!props.onOpenStudy}
            title="Compare battery × inverter configurations across your receivers"
          >⊞ Compare configurations…</button>
          <button className="btn small" style={mutedWhenNoGrid} title={gridHint} onClick={() => { if (requireGrid() && grid) download(exportGridGeoTiff(grid), 'grid', 'tif'); }}>
            ↓ GeoTIFF
          </button>
        </div>
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
    onAutoFitContourBounds,
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

      <Card title="Receivers">
        <Field label="">
          <label className="row-checkbox">
            <input
              type="checkbox"
              checked={!!props.showReceiverLimits}
              onChange={(e) => props.setShowReceiverLimits?.(e.target.checked)}
            />
            <span>Show limits on markers</span>
          </label>
        </Field>
        <div className="hint">
          Adds the active period's limit under each receiver's level. The
          pass/fail colour already uses it — this just shows the number you're
          being judged against.
        </div>
      </Card>

      <Card title="Contours">
        <Field label="">
          <label className="row-checkbox">
            <input type="checkbox" checked={showContours} onChange={(e) => setShowContours(e.target.checked)} />
            <span>Show contour grid</span>
          </label>
        </Field>
        {props.setShowGridDebug && (
          <Field label="">
            <label className="row-checkbox">
              <input
                type="checkbox"
                checked={!!props.showGridDebug}
                onChange={(e) => props.setShowGridDebug?.(e.target.checked)}
              />
              <span>Debug: show grid cell centres</span>
            </label>
          </Field>
        )}
        {props.setShowBhDebug && (
          <Field label="">
            <label className="row-checkbox">
              <input
                type="checkbox"
                checked={!!props.showBhDebug}
                onChange={(e) => props.setShowBhDebug?.(e.target.checked)}
              />
              <span>Debug: Barnes-Hut clustering</span>
            </label>
            <div className="hint" style={{ marginTop: 4 }}>
              Shows how the solver <b>grouped your sources</b> for the contour
              grid. The grid is computed in square tiles, and each tile decides
              for itself which sources to keep separate and which to merge —
              so this draws one box per tile with what that tile actually used.
              <br /><br />
              The label reads <b>n</b>, the number of sources the tile solved,
              and <b>(Nc)</b> when N of those are <b>cluster stand-ins</b>: one
              virtual source replacing a whole group of real ones, placed at
              their combined acoustic centre and carrying their summed sound
              power. A tile far from the site can treat the whole array as a
              single stand-in without changing its answer; a tile sitting among
              the units cannot, because its nearest sources dominate.
              <br /><br />
              Colour is how much merging happened — <span style={{ color: '#16a34a' }}>green</span> mostly
              merged, <span style={{ color: '#ef4444' }}>red</span> barely.
              Expect green far out and red over the array. <b>A far tile that
              stays red is the bug this view exists to reveal.</b>
              <br /><br />
              <b>Click a tile</b> to see the grouping itself: each stand-in it
              accepted is outlined as a dashed purple box over the region it
              replaced, with a dot at its centre labelled by how many real
              sources it stands for and their combined sound power. Raise
              <b> Tree acceptance θ</b> (Settings → Performance) and more tiles
              turn green.
            </div>
          </Field>
        )}
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
            <NumericInput step={1} value={contourBounds.min}
              fallback={25}
              onChange={(v) => setContourBounds({ ...contourBounds, min: v })} />
          </Field>
          <Field label="Max (dB)">
            <NumericInput step={1} value={contourBounds.max}
              fallback={60}
              onChange={(v) => setContourBounds({ ...contourBounds, max: v })} />
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
        <div className="hint">
          Min / Max above drive both the contour line thresholds and the
          filled-grid colour scale. Press <b>Auto-fit</b> to clamp them to
          the current grid's measured range (snapped to 5 dB).
        </div>
        <div className="add-row">
          <button
            className="btn small"
            onClick={() => onAutoFitContourBounds?.()}
            disabled={!onAutoFitContourBounds}
          >Auto-fit to grid</button>
        </div>
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
      </Card>

      <CustomContourCard
        lines={props.customContours ?? []}
        setLines={props.setCustomContours}
      />

      <AnnotationsCard {...props} />

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

      <ReferenceLayersCard
        project={props.project}
        setProject={props.setProject}
        onAfterImport={props.onAfterImport}
      />
    </>
  );
}

// -------------------- Custom contour lines --------------------

/// Colours offered for a new line. Compliance lines want to read as
/// deliberate against any palette, so these are saturated and dark enough to
/// survive a white halo on satellite imagery.
const CUSTOM_LINE_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0891b2', '#2563eb', '#7c3aed', '#111827'];

/// Preset swatches, plus the OS colour picker behind a toggle.
///
/// The presets are what almost every line wants and they are one click; the
/// full picker is a modal OS dialog, which is a lot of ceremony to reach the
/// same eight colours. So the presets lead and the picker is opened
/// deliberately — and it stays open while it holds a non-preset colour, since
/// hiding it would leave that colour unreachable.
function ColorChoice(props: { value: string; onChange(v: string): void }) {
  const isPreset = CUSTOM_LINE_COLORS.some((c) => c.toLowerCase() === props.value.toLowerCase());
  const [custom, setCustom] = useState(!isPreset);
  return (
    <div className="color-choice">
      {CUSTOM_LINE_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          className={`color-swatch${c.toLowerCase() === props.value.toLowerCase() ? ' on' : ''}`}
          style={{ background: c }}
          title={c}
          aria-label={`Use ${c}`}
          onClick={() => { props.onChange(c); setCustom(false); }}
        />
      ))}
      <button
        type="button"
        className={`color-swatch more${custom ? ' on' : ''}`}
        title="More colours"
        aria-label="More colours"
        onClick={() => setCustom((v) => !v)}
      >…</button>
      {(custom || !isPreset) && (
        <input
          type="color"
          value={props.value}
          title="Pick any colour"
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </div>
  );
}

/// A text input that commits on blur or Enter rather than on every keystroke.
///
/// The map keys its contour redraw on the line's fields, and the redraw empties
/// the overlay synchronously before refilling it from a worker — so committing
/// per character made every contour on screen blink once per letter typed. The
/// same shape as `NumberDraft` in the BESS wizard, for text.
function TextDraft(props: {
  value: string;
  onCommit(v: string): void;
  placeholder?: string;
  maxLength?: number;
}) {
  const [draft, setDraft] = useState(props.value);
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setDraft(props.value); }, [props.value, focused]);
  const commit = () => { if (draft !== props.value) props.onCommit(draft); };
  return (
    <input
      type="text"
      value={draft}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { setFocused(false); commit(); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setDraft(props.value); (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

function CustomContourCard(props: {
  lines: CustomContourLine[];
  setLines?(v: CustomContourLine[]): void;
}) {
  const { lines, setLines } = props;
  if (!setLines) return null;

  const patch = (id: string, p: Partial<CustomContourLine>) =>
    setLines(lines.map((l) => (l.id === id ? { ...l, ...p } : l)));
  const remove = (id: string) => setLines(lines.filter((l) => l.id !== id));
  const add = () => {
    const n = lines.length;
    setLines([...lines, {
      id: `cl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      label: 'Limit',
      levelDb: 40,
      color: CUSTOM_LINE_COLORS[n % CUSTOM_LINE_COLORS.length],
      widthPx: 2.5,
      dashed: true,
      export: true,
    }]);
  };

  return (
    <Card title="Custom lines">
      <div className="hint">
        Named iso-lines at levels you choose — a night limit, a boundary
        criterion. Drawn over the stepped contours in their own style, and
        they stay visible when the contour grid is switched off.
      </div>
      {lines.length === 0 && (
        <div className="meta-line muted">None yet.</div>
      )}
      {lines.map((l) => (
        <div key={l.id} className="custom-line-row">
          <div className="grid-2">
            <Field label="Name">
              {/* Capped to the shapefile's LABEL field width, so what is typed
                  is what every export carries: the KML kept the full name while
                  the DBF silently cut it at 40 characters, and the two exports
                  of one figure disagreed about the same line. */}
              <TextDraft
                value={l.label}
                maxLength={CUSTOM_LABEL_MAX}
                placeholder="Night limit"
                onCommit={(v) => patch(l.id, { label: v })}
              />
            </Field>
            <Field label="Level (dB)">
              <NumericInput
                step={0.5}
                value={l.levelDb}
                fallback={40}
                onChange={(v) => patch(l.id, { levelDb: v })}
              />
            </Field>
          </div>
          <ColorChoice value={l.color} onChange={(v) => patch(l.id, { color: v })} />
          <div className="custom-line-style">
            <label title="Line width (px)">
              <span className="muted">w</span>
              <NumericInput
                min={0.5}
                max={12}
                step={0.5}
                value={l.widthPx}
                fallback={2.5}
                onChange={(v) => patch(l.id, { widthPx: clampLineWidth(v) })}
              />
            </label>
            <label className="row-checkbox">
              <input
                type="checkbox"
                checked={l.dashed}
                onChange={(e) => patch(l.id, { dashed: e.target.checked })}
              />
              <span>Dashed</span>
            </label>
            <label className="row-checkbox" title="Include in KML / shapefile / PDF exports">
              <input
                type="checkbox"
                checked={l.export}
                onChange={(e) => patch(l.id, { export: e.target.checked })}
              />
              <span>Export</span>
            </label>
            <button className="x-btn" title="Remove this line" onClick={() => remove(l.id)}>✕</button>
          </div>
        </div>
      ))}
      <div className="add-row">
        <button className="btn small" onClick={add}>+ Custom line</button>
      </div>
    </Card>
  );
}

// -------------------- Annotations --------------------

function AnnotationsCard(props: Props) {
  const {
    project, addMode, setAddMode, selectedAnnotationId,
    onSelectAnnotation, onUpdateAnnotation, onRemoveAnnotation,
  } = props;
  if (!onUpdateAnnotation || !onRemoveAnnotation) return null;
  const annotations = annotationsOf(project);

  return (
    <Card title="Annotations">
      <div className="hint">
        Notes and dimensions drawn on the figure and carried into the PDF at
        9 pt. They are drawing furniture — the solver never sees them.
      </div>
      <div className="add-row">
        <button
          className={`btn small${addMode === 'annotation' ? ' active' : ''}`}
          onClick={() => setAddMode(addMode === 'annotation' ? 'none' : 'annotation')}
        >{addMode === 'annotation' ? 'Click the map…' : '+ Note'}</button>
        <button
          className={`btn small${addMode === 'dimension' ? ' active' : ''}`}
          onClick={() => setAddMode(addMode === 'dimension' ? 'none' : 'dimension')}
        >{addMode === 'dimension' ? 'Click two points…' : '+ Dimension'}</button>
      </div>
      {annotations.length === 0 && <div className="meta-line muted">None yet.</div>}
      {annotations.map((a) => {
        const sel = a.id === selectedAnnotationId;
        return (
          <div
            key={a.id}
            className={`custom-line-row${sel ? ' selected' : ''}`}
            onClick={() => onSelectAnnotation?.(a.id)}
          >
            {a.kind === 'text' ? (
              <Field label="Note text">
                <textarea
                  rows={2}
                  value={a.text}
                  placeholder="e.g. Substation under separate assessment"
                  onChange={(e) => onUpdateAnnotation(a.id, { text: e.target.value })}
                />
              </Field>
            ) : (
              <Field label="Dimension label">
                <input
                  type="text"
                  value={a.label ?? ''}
                  placeholder={dimensionLabel({ ...a, label: undefined })}
                  // Empty means "use the measurement", but `|| undefined` also
                  // swallowed "0" — so a label could never begin with a zero,
                  // and the keystroke visibly vanished.
                  onChange={(e) => onUpdateAnnotation(
                    a.id, { label: e.target.value === '' ? undefined : e.target.value },
                  )}
                />
              </Field>
            )}
            <div className="custom-line-style">
              <span className="muted">
                {a.kind === 'text'
                  ? (a.leaderTo ? 'note with leader' : 'note')
                  : `measures ${dimensionLabel({ ...a, label: undefined })}`}
              </span>
              {a.kind === 'text' && (
                <button
                  className="btn small"
                  title={a.leaderTo
                    ? 'Remove the leader line'
                    : 'Add a leader line, then drag its end to what it points at'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (a.leaderTo) { onUpdateAnnotation(a.id, { leaderTo: undefined }); return; }
                    // Start the leader a short way off so both ends are
                    // separately grabbable straight away.
                    onUpdateAnnotation(a.id, {
                      leaderTo: [a.latLng[0] - 0.0004, a.latLng[1] + 0.0006],
                    });
                  }}
                >{a.leaderTo ? 'Drop leader' : 'Add leader'}</button>
              )}
              <button
                className="x-btn"
                title="Remove this annotation"
                onClick={(e) => { e.stopPropagation(); onRemoveAnnotation(a.id); }}
              >✕</button>
            </div>
          </div>
        );
      })}
    </Card>
  );
}

// -------------------- Reference layers --------------------

function refCountByType(features: ReferenceFeature[]): string {
  let p = 0, l = 0, g = 0;
  for (const f of features) { if (f.type === 'point') p++; else if (f.type === 'line') l++; else g++; }
  const parts: string[] = [];
  if (g) parts.push(`${g} poly`);
  if (l) parts.push(`${l} line`);
  if (p) parts.push(`${p} pt`);
  return parts.join(' · ') || '0';
}

function ReferenceLayersCard(props: {
  project: Project;
  setProject(p: Project): void;
  onAfterImport?(bounds: { sw: [number, number]; ne: [number, number] }): void;
}) {
  const { project, setProject, onAfterImport } = props;
  const layers = project.referenceLayers ?? [];
  const [importOpen, setImportOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  const setLayers = (next: ReferenceLayer[]) => setProject({ ...project, referenceLayers: next });
  const patchLayer = (id: string, patch: Partial<ReferenceLayer>) =>
    setLayers(layers.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const patchStyle = (id: string, patch: Partial<ReferenceLayerStyle>) =>
    setLayers(layers.map((l) => (l.id === id ? { ...l, style: { ...l.style, ...patch } } : l)));
  const removeLayer = (id: string) => setLayers(layers.filter((l) => l.id !== id));
  // Drag-to-reorder: move src to just before the dropped-on target.
  const reorder = (srcId: string, targetId: string) => {
    if (srcId === targetId) return;
    const src = layers.find((l) => l.id === srcId);
    if (!src) return;
    const rest = layers.filter((l) => l.id !== srcId);
    const ti = rest.findIndex((l) => l.id === targetId);
    const next = rest.slice();
    next.splice(ti < 0 ? rest.length : ti, 0, src);
    setLayers(next);
  };

  return (
    <Card title="Reference layers" count={layers.length}>
      <div className="add-row">
        <button className="btn small block" onClick={() => setImportOpen(true)}>
          📐 Import reference geometry…
        </button>
      </div>
      {layers.length === 0 && (
        <div className="hint">
          Property boundaries, site context, access tracks — purely visual, <b>never solved</b>.
          Import points / lines / polygons from a shapefile.
        </div>
      )}
      {layers.length > 1 && (
        <div className="hint" style={{ marginBottom: 4 }}>Drag ⠿ to reorder (top layer draws on top).</div>
      )}
      {layers.map((l) => {
        const expanded = expandedId === l.id;
        const hasPoint = l.features.some((f) => f.type === 'point');
        const hasPoly = l.features.some((f) => f.type === 'polygon');
        const showFill = hasPoly || hasPoint;
        return (
          <div key={l.id} className="item"
            style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6, opacity: dragId === l.id ? 0.5 : 1 }}
            onDragOver={(e) => { if (dragId && dragId !== l.id) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (dragId) reorder(dragId, l.id); setDragId(null); }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                draggable
                onDragStart={() => setDragId(l.id)}
                onDragEnd={() => setDragId(null)}
                title="Drag to reorder"
                style={{ cursor: 'grab', color: '#9aa6b2', fontSize: 14, userSelect: 'none', padding: '0 2px' }}
              >⠿</span>
              <button className="btn small" title={l.visible ? 'Hide' : 'Show'}
                style={{ opacity: l.visible ? 1 : 0.4 }}
                onClick={() => patchLayer(l.id, { visible: !l.visible })}>👁</button>
              <span style={{ width: 14, height: 14, borderRadius: 3, background: l.style.stroke, border: '1px solid rgba(0,0,0,.2)' }} />
              <input className="inline-edit-name" value={l.name} style={{ flex: 1, minWidth: 0 }}
                onChange={(e) => patchLayer(l.id, { name: e.target.value })} />
              <span className="muted" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{refCountByType(l.features)}</span>
              <button className="btn small" title="Style" onClick={() => setExpandedId(expanded ? null : l.id)}>▾</button>
              <button className="btn small" title="Delete" style={{ color: 'var(--red)' }} onClick={() => removeLayer(l.id)}>🗑</button>
            </div>
            {expanded && (
              <div className="grid-2" style={{ paddingLeft: 4 }}>
                <Field label="Stroke">
                  <input type="color" value={l.style.stroke} onChange={(e) => patchStyle(l.id, { stroke: e.target.value })} />
                </Field>
                {showFill && (
                  <Field label="Fill">
                    <input type="color" value={l.style.fill} onChange={(e) => patchStyle(l.id, { fill: e.target.value })} />
                  </Field>
                )}
                <Field label={`Stroke width ${l.style.weight}px`}>
                  <input type="range" min={1} max={8} step={1} value={l.style.weight}
                    onChange={(e) => patchStyle(l.id, { weight: +e.target.value })} />
                </Field>
                <Field label={`Opacity ${(l.style.opacity * 100).toFixed(0)}%`}>
                  <input type="range" min={0.1} max={1} step={0.05} value={l.style.opacity}
                    onChange={(e) => patchStyle(l.id, { opacity: +e.target.value })} />
                </Field>
                {showFill && (
                  <Field label={`Fill opacity ${(l.style.fillOpacity * 100).toFixed(0)}%`}>
                    <input type="range" min={0} max={1} step={0.05} value={l.style.fillOpacity}
                      onChange={(e) => patchStyle(l.id, { fillOpacity: +e.target.value })} />
                  </Field>
                )}
                {hasPoint && (
                  <>
                    <Field label="Point shape">
                      <select value={l.style.pointShape ?? 'circle'}
                        onChange={(e) => patchStyle(l.id, { pointShape: e.target.value as ReferencePointShape })}>
                        <option value="circle">Circle</option>
                        <option value="square">Square</option>
                        <option value="triangle">Triangle</option>
                      </select>
                    </Field>
                    <Field label={`Point size ${l.style.pointSizePx ?? 5}px`}>
                      <input type="range" min={2} max={16} step={1} value={l.style.pointSizePx ?? 5}
                        onChange={(e) => patchStyle(l.id, { pointSizePx: +e.target.value })} />
                    </Field>
                  </>
                )}
                <Field label="Labels">
                  <label className="row-checkbox">
                    <input type="checkbox" checked={l.style.showLabels}
                      onChange={(e) => patchStyle(l.id, { showLabels: e.target.checked })} />
                    <span>Show</span>
                  </label>
                </Field>
              </div>
            )}
          </div>
        );
      })}
      {importOpen && (
        <ReferenceImportModal
          onClose={() => setImportOpen(false)}
          onImport={(layer, bounds) => {
            setLayers([...layers, layer]);
            if (bounds && onAfterImport) onAfterImport(bounds);
          }}
        />
      )}
    </Card>
  );
}

// -------------------- Barriers --------------------

function BarriersTab(props: Props) {
  const { project, setProject, addMode, setAddMode, selectedIds, onSelect } = props;

  function updateBarrier(id: string, patch: Partial<Project['barriers'][number]>) {
    setProject({
      ...project,
      barriers: project.barriers.map((b) => (b.id === id ? { ...b, ...patch } : b)),
    });
  }
  function removeBarrier(id: string) {
    setProject({ ...project, barriers: project.barriers.filter((b) => b.id !== id) });
  }

  return (
    <>
      <Card title="Add barriers">
        <div className="add-row">
          <ModeBtn label="+ Barrier" mode="barrier" current={addMode} onClick={setAddMode} />
        </div>
        {addMode === 'barrier' && (
          <div className="hint">
            Click to drop each wall vertex. <b>Right-click</b>, double-click or
            Enter finishes; clicking the <b>first vertex</b> (it turns green)
            closes the wall into a ring. Backspace removes the last vertex;
            Esc cancels mid-draw. A two-click wall is a straight segment.
          </div>
        )}
        <div className="hint">
          Barriers are polyline walls characterised by their top height. The
          solver applies <code>Abar</code> (ISO 9613-2 §7.4) along every
          source → receiver path that the wall intersects, with the per-band
          Dz combined with Agr per the convention chosen in Settings.
        </div>
      </Card>

      <Card title="Barrier list" count={project.barriers.length}>
        {project.barriers.length === 0 && <div className="hint">No barriers yet.</div>}
        {project.barriers.map((b) => (
          <div
            key={b.id}
            className={`item${selectedIds.has(b.id) ? ' selected' : ''}`}
            onClick={(e) => onSelect(b.id, { shift: e.shiftKey })}
          >
            <div className="item-name" onClick={(e) => e.stopPropagation()}>
              <input
                className="inline-edit-name"
                value={b.name}
                onChange={(e) => updateBarrier(b.id, { name: e.target.value })}
                placeholder="Barrier name"
              />
            </div>
            <div className="item-meta">
              {b.polylineLatLng.length >= 2
                ? `${segmentLengthM(b.polylineLatLng).toFixed(0)} m long`
                : 'incomplete'}
              {' · '}top {b.topHeightsM[0]?.toFixed(1) ?? '—'} m
            </div>
            <div className="item-controls" onClick={(e) => e.stopPropagation()}>
              <span className="inline-unit" title="Top height (m above local ground)">
                <NumericInput className="inline-edit" min={0} max={50} step={0.5}
                  value={b.topHeightsM[0] ?? 5} fallback={5}
                  onChange={(v) => updateBarrier(b.id, { topHeightsM: [v] })}
                  title="Top height (m)" />
                <span className="inline-unit-label">m</span>
              </span>
              {/* I18: absorption. Only matters when reflections are on, but
                  it's a property of the wall, so it lives with the wall. */}
              <span className="inline-unit" title="Sound absorption coefficient α (ISO 9613-2 §7.5): fraction of energy NOT reflected. 0 = hard, 0.1 = typical barrier. This is NOT an NRC — see Help → Barrier absorption. Only used when Reflections is on.">
                <NumericInput className="inline-edit" min={0} max={1} step={0.05}
                  value={b.absorptionCoeff ?? 0.1} fallback={0.1}
                  // alpha is a fraction of energy: outside [0,1] is not a value, it is a typo.
                  onChange={(v) => updateBarrier(b.id, { absorptionCoeff: Math.min(1, Math.max(0, v)) })}
                  title="Absorption α" />
                <span className="inline-unit-label">α</span>
              </span>
              <button className="x-btn" onClick={() => removeBarrier(b.id)}>✕</button>
            </div>
          </div>
        ))}
      </Card>
    </>
  );
}

/// Approximate total ground-length of a barrier polyline (sum of every
/// segment). Used purely for display in the barrier-list meta line.
function segmentLengthM(poly: Array<[number, number]>): number {
  if (poly.length < 2) return 0;
  const R = 6371008.8;
  let total = 0;
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i];
    const b = poly[i + 1];
    const lat0 = (a[0] * Math.PI) / 180;
    const dLat = ((b[0] - a[0]) * Math.PI) / 180 * R;
    const dLng = ((b[1] - a[1]) * Math.PI) / 180 * R * Math.cos(lat0);
    total += Math.sqrt(dLat * dLat + dLng * dLng);
  }
  return total;
}

// -------------------- Settings --------------------

/// Live-edit Settings tab. Each control commits to project state on the
/// fly — the structural-key effect in ProjectScreen debounces re-evals so
/// rapid edits don't flood the solver.
/// I10 — the 15 settings sections, grouped into 5 tabs.
///
/// Compliance is deliberately separate from Calculation: "which standard" and
/// "how we round before judging" are different decisions, often owned by
/// different people, and burying a jurisdiction rule under acoustics settings
/// is how it gets missed by whoever inherits the project.
export const SETTINGS_TABS = [
  { id: 'calculation', label: 'Calculation' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'environment', label: 'Environment' },
  { id: 'sources', label: 'Sources' },
  { id: 'performance', label: 'Performance' },
] as const;

export type SettingsTabId = typeof SETTINGS_TABS[number]['id'];

export interface SettingsTabProps {
  project: Project;
  setProject(p: Project): void;
  gridSpacingM: number;
  setGridSpacingM(v: number): void;
  /// Which group of sections to show. Omitted = Calculation.
  tab?: SettingsTabId;
}

export function SettingsTab(props: SettingsTabProps) {
  const { project, setProject, gridSpacingM, setGridSpacingM } = props;
  const tab = props.tab ?? 'calculation';
  const settings: ProjectSettings = settingsOf(project);

  // Local draft for the band-system picker (which lives on the scenario
  // not the settings). Other settings commit immediately.
  const [draftBandSystem, setDraftBandSystem] = useState(project.scenario.bandSystem);
  // Re-sync if the project changes from elsewhere (e.g. import).
  useEffect(() => { setDraftBandSystem(project.scenario.bandSystem); }, [project.scenario.bandSystem]);

  function update(patch: Partial<ProjectSettings>) {
    setProject({ ...project, settings: { ...settings, ...patch } });
  }
  function commitBandSystem(bs: 'octave' | 'oneThirdOctave') {
    setDraftBandSystem(bs);
    setProject({ ...project, scenario: { ...project.scenario, bandSystem: bs } });
  }

  const propagation = settings.propagation ?? { maxContributionDistanceM: 20000, treeAcceptanceTheta: 0.25 };
  const topography = settings.topography ?? { despikeStrength: 'low' as const };
  const tonality = tonalitySettingsFor(project);

  return (
    <>
      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Band system</span></h3>
        <Field label="Solve in">
          <select
            value={draftBandSystem}
            onChange={(e) => commitBandSystem(e.target.value as 'octave' | 'oneThirdOctave')}
          >
            <option value="octave">Octave (10 bands · 16 Hz – 8 kHz)</option>
            <option value="oneThirdOctave">One-third octave (31 bands · 10 Hz – 10 kHz)</option>
          </select>
        </Field>
        <div className="hint">
          Octave is faster; one-third octave catches narrowband content. Source
          data in the other band system is folded automatically.
        </div>
      </section>
      )}

      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Assessment weighting</span></h3>
        <Field label="Levels are reported in">
          <select
            value={settings.assessment?.weighting ?? 'A'}
            onChange={(e) => update({
              assessment: {
                ...settings.assessment,
                weighting: e.target.value as 'A' | 'C' | 'Z',
              },
            })}
          >
            <option value="A">dB(A) — A-weighted (default)</option>
            <option value="C">dB(C) — C-weighted</option>
            <option value="Z">dB(Z) — un-weighted</option>
          </select>
        </Field>
        <div className="hint">
          Applies to every reported level, the contour grid and the receiver
          limits, which are read in the same weighting. Changing it re-runs the
          grid: it changes the numbers, not just the label. A <b>dB(C) − dB(A)</b>
          column is exported whatever this is set to, as a low-frequency
          screening indicator.
        </div>
      </section>
      )}

      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Tonality</span></h3>
        <Field label="">
          <label className="row-checkbox">
            <input
              type="checkbox"
              checked={tonality.enabled}
              onChange={async (e) => {
                const on = e.target.checked;
                const octave = project.scenario.bandSystem !== 'oneThirdOctave';
                const enable = (extra?: Partial<Project>) => setProject({
                  ...project,
                  ...extra,
                  settings: {
                    ...settings,
                    assessment: {
                      ...settings.assessment,
                      tonality: { ...settings.assessment?.tonality, enabled: on },
                    },
                  },
                });
                // Asked HERE, at the moment the user wants the feature, rather
                // than reported afterwards as "not assessable" on every
                // receiver. In octave bands the screen cannot say anything at
                // all, so switching on without switching the band system is
                // almost never what was meant.
                if (on && octave) {
                  const alsoSwitch = await notify.confirm({
                    title: 'Tonality needs one-third-octave bands',
                    body: 'This project solves in octave bands, where a tone is smeared '
                      + 'across a whole band — no receiver could be assessed. Switch the '
                      + 'project to one-third octave as well? This re-runs the solve.',
                    confirmLabel: 'Switch and turn on',
                    cancelLabel: 'Turn on anyway',
                  });
                  enable(alsoSwitch
                    ? { scenario: { ...project.scenario, bandSystem: 'oneThirdOctave' } }
                    : undefined);
                  return;
                }
                enable();
              }}
            />
            <span>Screen receivers for tonality</span>
          </label>
        </Field>
        {tonalityBlocked(project.scenario.bandSystem, tonality) && (
          <div className="hint" style={{ color: 'var(--red)', fontStyle: 'normal' }}>
            ⚠ {tonalityBlocked(project.scenario.bandSystem, tonality)}
          </div>
        )}
        <Field label="Screening method">
          <select
            disabled={!tonality.enabled}
            value={tonality.method}
            onChange={(e) => update({
              assessment: {
                ...settings.assessment,
                tonality: { ...settings.assessment?.tonality, method: e.target.value as TonalityMethod },
              },
            })}
          >
            {tonalityMethods().map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </Field>
        <div className="hint">{tonalityMethodInfo(tonality.method).summary}</div>
        <div className="hint" style={{ marginTop: 4 }}>
          Screened on the level <b>reaching each receiver</b>, not on the source
          spectrum: air absorption reshapes a spectrum with distance, so a tone
          that is obvious at 50 m may be gone at 2 km. Needs one-third-octave
          bands; at octave resolution it reports "not assessable" rather than a
          clean pass.
        </div>
        <Field label="">
          <label className="row-checkbox">
            <input
              type="checkbox"
              disabled={!tonality.enabled}
              checked={tonality.applyPenalty}
              onChange={(e) => update({
                assessment: {
                  ...settings.assessment,
                  tonality: { ...settings.assessment?.tonality, applyPenalty: e.target.checked },
                },
              })}
            />
            <span>Add a penalty to flagged receivers</span>
          </label>
        </Field>
        {tonality.enabled && tonality.applyPenalty && (
          <Field label="Penalty (dB)">
            <NumericInput
              min={0} max={20} step={1}
              value={tonality.penaltyDb}
              fallback={DEFAULT_TONALITY_PENALTY_DB}
              onChange={(v) => update({
                assessment: {
                  ...settings.assessment,
                  tonality: { ...settings.assessment?.tonality, penaltyDb: Math.max(0, v) },
                },
              })}
            />
          </Field>
        )}
        <div className="hint">
          Off by default — the screen reports a tone either way. Switched on,
          the penalty is added before the level is compared with the limit, and
          every pass/fail badge and export follows it. Contours never carry it:
          a grid cell has no assessment to attach it to.
        </div>
      </section>
      )}

      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Standard</span></h3>
        <Field label="ISO 9613-2 edition">
          <select
            value={settings.standard ?? '2024'}
            onChange={(e) => update({ standard: e.target.value as '1996' | '2024' })}
          >
            <option value="2024">2024 (default)</option>
            <option value="1996">1996</option>
          </select>
        </Field>
        <div className="hint">
          Existing projects were computed with 2024. See Help → Settings for
          what changes between editions.
        </div>
      </section>
      )}

      {tab === 'environment' && (
      <section className="sp-section">
        <h3><span>Ground</span></h3>
        <Field label="Default ground factor G (0 = hard, 1 = porous)">
          <NumericInput min={0} max={1} step={0.05}
            value={settings.ground.defaultG} fallback={0.5}
            onChange={(v) => update({ ground: { ...settings.ground, defaultG: v } })}
          />
        </Field>
        <div className="hint">Annex D rules cap G at 0.5 for wind turbine sources regardless of this setting.</div>
      </section>
      )}

      {tab === 'sources' && (
      <section className="sp-section">
        <h3><span>Source containers</span></h3>
        <Field label="Use in receiver calculations">
          <input
            type="checkbox"
            checked={settings.containers?.receiverCalc ?? false}
            onChange={(e) => update({
              containers: { ...settings.containers, receiverCalc: e.target.checked },
            })}
          />
        </Field>
        <Field label="Use in grid / contour maps">
          <input
            type="checkbox"
            checked={settings.containers?.grid ?? false}
            onChange={(e) => update({
              containers: { ...settings.containers, grid: e.target.checked },
            })}
          />
        </Field>
        <Field label="Source clearance above roof (m)">
          <NumericInput min={0} max={5} step={0.1}
            value={settings.containers?.roofOffsetM ?? 0.3} fallback={0.3}
            onChange={(v) => update({
              containers: { ...settings.containers, roofOffsetM: v },
            })}
          />
        </Field>
        <div className="hint">
          Models each BESS / auxiliary unit as a screening box, so units shade
          each other within a row. Off by default; worth ~1–2 dB inside about
          100 m and near zero by 200 m. Help → Settings covers where the
          dimensions come from and why the two toggles are separate.
        </div>
      </section>
      )}

      {tab === 'sources' && (
      <section className="sp-section">
        <h3><span>Reflections</span></h3>
        <Field label="Use in receiver calculations">
          <input
            type="checkbox"
            checked={settings.reflections?.receiverCalc ?? false}
            onChange={(e) => update({
              reflections: { ...settings.reflections, receiverCalc: e.target.checked },
            })}
          />
        </Field>
        <Field label="Use in grid / contour maps">
          <input
            type="checkbox"
            checked={settings.reflections?.grid ?? false}
            onChange={(e) => update({
              reflections: { ...settings.reflections, grid: e.target.checked },
            })}
          />
        </Field>
        <Field label="Maximum order">
          <select
            value={String(settings.reflections?.maxOrder ?? 3)}
            onChange={(e) => update({
              reflections: { ...settings.reflections, maxOrder: +e.target.value },
            })}
          >
            <option value="1">1 — single bounce</option>
            <option value="2">2</option>
            <option value="3">3 (default)</option>
          </select>
        </Field>
        <div className="hint">
          Specular reflection off barriers and, when Source containers is on,
          container facades. Off by default — switching it on <b>will</b> raise
          levels at receivers facing a wall or a container row. Each barrier
          carries its own α (Barriers tab; default 0.1, <b>not</b> an NRC).
          Treat results as provisional. Help → Barrier absorption and Help →
          Methodology cover α, the path budget and the automatic order
          reduction.
        </div>
      </section>
      )}

      {tab === 'compliance' && (
      <section className="sp-section">
        <h3><span>Limit comparison</span></h3>
        <Field label="Compare levels">
          <select
            value={settings.limitComparison ?? 'integer'}
            onChange={(e) => update({ limitComparison: e.target.value as 'integer' | 'exact' })}
          >
            <option value="integer">Rounded to integer (default)</option>
            <option value="exact">Exact</option>
          </select>
        </Field>
        <div className="hint">
          Rounded: <b>40.4 dB → 40, so it passes a 40 dB limit</b>; 40.6 → 41
          fails. Only the level rounds, never the limit, and displayed numbers
          never change — this sets the pass/fail colour only. Use <b>Exact</b>
          where the jurisdiction compares unrounded.
        </div>
      </section>
      )}

      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Solid-angle correction (DΩ)</span></h3>
        <Field label="DΩ (dB)">
          <select
            value={(settings.dOmegaDb ?? 0).toString()}
            onChange={(e) => update({ dOmegaDb: +e.target.value })}
          >
            <option value="0">0 dB — strict ISO 9613-2 / IEC 61400-11 (default; matches SoundPlan)</option>
            <option value="3">+3 dB — hemispherical / common practice</option>
          </select>
        </Field>
        <div className="hint">
          Added to every band per Eq (1) <code>Lp = Lw + DΩ + Dc − A</code>.
          <b> 0 dB</b> is strict ISO (IEC 61400-11 WTG data already encodes the
          hemispherical reflection); <b>+3 dB</b> matches CONCAWE / AS 4959
          practice.
        </div>
      </section>
      )}

      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Meteorological correction (Cmet, §8)</span></h3>
        <Field label="C₀ (dB)">
          <NumericInput min={0} max={10} step={0.5}
            value={settings.meteorology?.c0Db ?? 0}
            fallback={0}
            onChange={(v) => update({ meteorology: { c0Db: Math.max(0, v) } })}
          />
        </Field>
        <div className="hint">
          Long-term correction <b>subtracted</b> from the downwind level:
          <code> Cmet = C₀·[1 − 10(hs+hr)/dp]</code>, zero within 10(hs+hr).
          <b> 0 dB</b> (default) is pure downwind, matching SoundPLAN and the
          validation set; typical values from local met statistics are 0–5 dB.
        </div>
      </section>
      )}

      {tab === 'environment' && (
      <section className="sp-section">
        <h3><span>Atmosphere (ISO 9613-1 Aatm)</span></h3>
        <div className="grid-2">
          <Field label="Temperature (°C)">
            <NumericInput min={-30} max={50} step={1}
              value={settings.atmosphere?.temperatureC ?? 10}
              fallback={10}
              onChange={(v) => update({
                atmosphere: {
                  temperatureC: v,
                  relativeHumidityPct: settings.atmosphere?.relativeHumidityPct ?? 70,
                  pressureKpa: settings.atmosphere?.pressureKpa ?? 101.325,
                },
              })}
            />
          </Field>
          <Field label="Relative humidity (%)">
            <NumericInput min={1} max={100} step={1}
              value={settings.atmosphere?.relativeHumidityPct ?? 70}
              fallback={70}
              onChange={(v) => update({
                atmosphere: {
                  temperatureC: settings.atmosphere?.temperatureC ?? 10,
                  relativeHumidityPct: v,
                  pressureKpa: settings.atmosphere?.pressureKpa ?? 101.325,
                },
              })}
            />
          </Field>
        </div>
        <div className="hint">
          Drives the atmospheric absorption coefficient α(f) per ISO 9613-1
          (closed-form, evaluated inside the WASM solver). The default
          (10 °C / 70 % RH) is the ISO 9613-2 reference.
        </div>
      </section>
      )}

      {/* The old "barrier convention" selector is gone: the engine implements the
          single literal-ISO combination (Abar = Dz − Agr, with Agr always carried
          separately), so there is nothing to choose. `barrierConvention` is still
          tolerated in stored projects and ignored. */}
      {tab === 'calculation' && (
      <section className="sp-section">
        <h3><span>Barrier diffraction</span></h3>
        <Field label="Diffraction limit Dz (dB) — general sources">
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              value={settings.barrierDiffractionCapDb == null ? 'off' : 'on'}
              onChange={(e) => {
                if (e.target.value === 'off') {
                  update({ barrierDiffractionCapDb: null });
                } else {
                  // Default to a conservative 2 dB when first switched on —
                  // the value the user mentioned as a typical project cap.
                  update({ barrierDiffractionCapDb: settings.barrierDiffractionCapDb ?? 2 });
                }
              }}
            >
              <option value="off">No limit (ISO §7.4 default — 20 / 25 dB)</option>
              <option value="on">Limit Dz to…</option>
            </select>
            {settings.barrierDiffractionCapDb != null && (
              <NumericInput min={0} max={25} step={0.5}
                value={settings.barrierDiffractionCapDb} fallback={2}
                onChange={(v) => update({ barrierDiffractionCapDb: v })}
              />
            )}
          </div>
        </Field>
        <div className="hint">
          Caps per-band Dz for BESS / auxiliary / generic sources; common
          project values are <b>2</b> or <b>5</b> dB. Wind turbines use the
          Annex D cap instead. <b>If barrier attenuation looks lower than your
          geometry suggests, check this first.</b>
        </div>
      </section>
      )}

      {tab === 'sources' && (
      <section className="sp-section">
        <h3><span>Annex D — wind turbines</span></h3>
        <Field label="Barrier Abar cap (dB)">
          <NumericInput min={0} max={25} step={0.5}
            value={settings.annexD.barrierAbarCapDb} fallback={3.0}
            onChange={(v) => update({ annexD: { ...settings.annexD, barrierAbarCapDb: v } })}
          />
        </Field>
        <label className="fld checkbox">
          <input
            type="checkbox"
            checked={settings.annexD.useElevatedSourceForBarrier}
            onChange={(e) => update({ annexD: { ...settings.annexD, useElevatedSourceForBarrier: e.target.checked } })}
          />
          <span>Use tip height as barrier source (Annex D.3)</span>
        </label>
        <label className="fld checkbox">
          <input
            type="checkbox"
            checked={settings.annexD.applyConcaveCorrection}
            onChange={(e) => update({ annexD: { ...settings.annexD, applyConcaveCorrection: e.target.checked } })}
          />
          <span>Apply concave-ground correction (Annex D.5, −3 dB)</span>
        </label>
        <Field label="WT receiver minimum height (m)">
          <NumericInput min={1} max={20} step={0.5}
            value={settings.annexD.wtReceiverHeightMin} fallback={4.0}
            onChange={(v) => update({ annexD: { ...settings.annexD, wtReceiverHeightMin: v } })}
          />
        </Field>
      </section>
      )}

      {tab === 'sources' && (
      <section className="sp-section">
        <h3><span>General sources</span></h3>
        <Field label="Default receiver height (m) for non-WT calcs">
          <NumericInput min={1} max={5} step={0.1}
            value={settings.general.defaultReceiverHeight} fallback={1.5}
            onChange={(v) => update({ general: { ...settings.general, defaultReceiverHeight: v } })}
          />
        </Field>
      </section>
      )}

      {tab === 'performance' && (
      <section className="sp-section">
        <h3><span>Contour grid spacing</span></h3>
        <Field label="Grid spacing (m)">
          <select value={gridSpacingM} onChange={(e) => setGridSpacingM(+e.target.value)}>
            <option value={25}>25 m</option>
            <option value={50}>50 m</option>
            <option value={100}>100 m</option>
            <option value={200}>200 m</option>
            <option value={300}>300 m</option>
          </select>
        </Field>
        <div className="hint">
          Default spacing is auto-picked from the calc-area size on first
          creation; pick a value to override and your choice sticks.
        </div>
      </section>
      )}

      {tab === 'performance' && (
      <section className="sp-section">
        <h3><span>Propagation cutoffs</span></h3>
        <div className="grid-2">
          <Field label="Max contribution distance (m)">
            <NumericInput min={0} step={50}
              value={propagation.maxContributionDistanceM} fallback={20000}
              onChange={(v) => update({
                propagation: { ...propagation, maxContributionDistanceM: v },
              })}
            />
          </Field>
          <Field label="Tree acceptance θ (0.1–3.0)">
            <NumericInput min={0.1} max={3} step={0.05}
              value={propagation.treeAcceptanceTheta} fallback={0.25}
              onChange={(v) => update({
                propagation: { ...propagation, treeAcceptanceTheta: v },
              })}
            />
          </Field>
        </div>
        <div className="hint">
          <b>Max distance:</b> sources beyond this from a receiver are skipped;
          <b> 0</b> disables. <b>Tree acceptance θ:</b> a source cluster whose
          bounding-box diagonal over its distance falls below θ collapses to one
          virtual source. Lower = more literal, slower. Values ≥ 1 have no error
          guarantee at all and are a stress test, not a setting for reportable
          results — see Help → Methodology. Watch the effect with Layers →
          Debug → Barnes-Hut clustering.
        </div>
      </section>
      )}

      {tab === 'environment' && (
      <section className="sp-section">
        <h3><span>Topography (DEM)</span></h3>
        {/* The old "min ridge prominence" knob is gone: ridge selection is now
            the engine's own hull over the elevation raster, not a web-side
            pre-filter. Stored values are tolerated and ignored. */}
        <Field label="DEM despike">
          <select
            value={topography.despikeStrength ?? 'low'}
            onChange={(e) => update({
              topography: {
                ...topography,
                despikeStrength: e.target.value as 'off' | 'low' | 'medium',
              },
            })}
          >
            <option value="off">Off</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
          </select>
        </Field>
        <div className="hint">
          With a DEM loaded, the elevation raster is handed to the solver, which
          samples the ground profile along every source→receiver line itself and
          diffracts over any ridge that breaks the line of sight — so hills shield
          like a wall. Sampling follows the DEM's own resolution; there is nothing
          to tune.
          <br />
          <b>DEM despike:</b> a peak-preserving (Hampel) filter applied when the
          raster is built, removing isolated DEM blunders without lowering genuine
          crests. <b>Low</b> suits most public DEMs; <b>Medium</b> for noisy data;
          <b>Off</b> for clean LiDAR.
        </div>
      </section>
      )}


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

function CollapsibleCard(props: {
  title: string; count: number; defaultOpen: boolean; children: React.ReactNode;
  /// Optional localStorage key. When set, the open/closed state survives
  /// across reloads — useful for sub-cards (Wind turbines / BESS / Aux)
  /// that the user typically wants kept collapsed by default but expanded
  /// once they've opted in.
  persistKey?: string;
}) {
  const fullKey = props.persistKey ? `bessty.collapse.${props.persistKey}` : null;
  // Initial state: read from localStorage if a persistKey is provided,
  // otherwise honour `defaultOpen`. Lazy-init so we hit localStorage once.
  const [open, setOpen] = useState<boolean>(() => {
    if (!fullKey) return props.defaultOpen;
    try {
      const raw = localStorage.getItem(fullKey);
      if (raw === '1') return true;
      if (raw === '0') return false;
    } catch { /* swallow */ }
    return props.defaultOpen;
  });
  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      if (fullKey) {
        try { localStorage.setItem(fullKey, next ? '1' : '0'); } catch { /* swallow */ }
      }
      return next;
    });
  }
  return (
    <section className="sp-section collapsible">
      <h3 onClick={toggle} style={{ cursor: 'pointer', userSelect: 'none' }}>
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
  /// How the limit is written — the project's assessment weighting.
  unit: string;
  onChange(v: number): void;
}) {
  // Anything non-finite (NaN coming through from a botched import) renders
  // as an empty field rather than crashing the controlled input. The
  // onChange guard ensures the user can't introduce NaN by editing — empty
  // entries fall back to a sensible per-period default.
  const safeValue = Number.isFinite(props.value) ? props.value : '';
  const fallback = props.period === 'day' ? 50 : props.period === 'evening' ? 45 : 40;
  return (
    <span title={`${props.period} limit ${props.unit}`} style={{
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
        value={safeValue}
        onChange={(e) => {
          const n = +e.target.value;
          props.onChange(Number.isFinite(n) ? n : fallback);
        }}
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
  const [openBox, setOpenBox] = useState(false);
  const boxable = s.kind === 'bess' || s.kind === 'auxiliary';

  // Catalog-resolved container dimensions, shown as input placeholders so a
  // blank field visibly means "inherit" rather than "zero". Note the axis swap:
  // the box's LONG axis is the footprint's `widthM` (see `resolveContainer`).
  const fp = entry
    ? footprintFor(entry)
    : (s.kind === 'bess' ? { widthM: 5.1, lengthM: 1.7 } : { widthM: 2.0, lengthM: 1.5 });
  const defBox = {
    lengthM: fp.widthM,
    widthM: fp.lengthM,
    heightM: entry ? containerHeightFor(entry) : (s.kind === 'bess' ? 2.6 : 2.2),
  };
  const boxOn = s.container?.enabled !== false;
  const cset = project.settings?.containers;
  const boxUsedAnywhere = (cset?.receiverCalc ?? false) || (cset?.grid ?? false);

  function patchBox(p: Partial<NonNullable<Source['container']>>) {
    onChange({ container: { ...s.container, ...p } });
  }
  // A plain function, NOT a component: declaring a component inside the render
  // gives it a new identity every pass, so React would remount the input on each
  // keystroke and the field would lose focus after one character.
  function boxDim(k: 'lengthM' | 'widthM' | 'heightM', label: string) {
    return (
      <Field label={label}>
        <input
          type="number" step="0.1" min="0.1" max="50" style={{ width: 72 }}
          placeholder={defBox[k].toFixed(1)}
          value={s.container?.[k] ?? ''}
          onChange={(e) => {
            const v = +e.target.value;
            patchBox({ [k]: Number.isFinite(v) && v > 0 ? v : undefined });
          }}
        />
      </Field>
    );
  }

  return (
    <div
      className={`item${selected ? ' selected' : ''}`}
      style={openBox ? { flexDirection: 'column', alignItems: 'stretch', gap: 6 } : undefined}
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
              catalogScope: scope as 'global' | 'local' | 'personal',
              modelId,
              modeOverride: picked?.defaultMode ?? null,
            });
          }}
        >
          {candidates.map((m) => (
            <option key={`${m._scope}:${m.id}`} value={`${m._scope}:${m.id}`}>
              {m.displayName}{scopeSuffix(m._scope)}
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
          <>
            <NumericInput min={50} max={250} step={1}
              value={s.hubHeight ?? 100}
              fallback={100}
              onChange={(v) => onChange({ hubHeight: v })}
              title="Hub height (m)" />
            <NumericInput min={50} max={300} step={1}
              value={s.rotorDiameterM ?? entry?.rotorDiameterM ?? 120}
              fallback={entry?.rotorDiameterM ?? 120}
              onChange={(v) => onChange({ rotorDiameterM: v })}
              title="Rotor diameter (m) — feeds Annex D.3 elevated source for barriers" />
          </>
        )}
        {boxable && (
          <button
            className="btn small"
            title="Container (screening box)"
            style={{ opacity: boxOn ? 1 : 0.45 }}
            onClick={() => setOpenBox(!openBox)}
          >▤{openBox ? '▾' : '▸'}</button>
        )}
        <button className="x-btn" onClick={(e) => { e.stopPropagation(); onRemove(); }}>✕</button>
      </div>
      {openBox && boxable && (
        <div style={{ paddingLeft: 4 }} onClick={(e) => e.stopPropagation()}>
          <Field label="Model as a container">
            <input
              type="checkbox"
              checked={boxOn}
              onChange={(e) => patchBox({ enabled: e.target.checked ? undefined : false })}
            />
          </Field>
          {boxOn && (
            <>
              <div className="grid-2">
                {boxDim('lengthM', 'Length (m)')}
                {boxDim('widthM', 'Width (m)')}
                {boxDim('heightM', 'Height (m)')}
                {s.groupId == null && (
                  <Field label="Bearing (°)">
                    <input
                      type="number" step="1" min="0" max="359" style={{ width: 72 }}
                      placeholder="0"
                      value={s.container?.bearingDeg ?? ''}
                      onChange={(e) => {
                        const v = +e.target.value;
                        patchBox({ bearingDeg: Number.isFinite(v) ? v : undefined });
                      }}
                    />
                  </Field>
                )}
              </div>
              <div className="hint">
                Blank inherits the catalog product
                ({defBox.lengthM.toFixed(1)} × {defBox.widthM.toFixed(1)} × {defBox.heightM.toFixed(1)} m).
                {s.groupId != null
                  ? ' Orientation follows the BESS group’s row heading.'
                  : ' Bearing is the long axis, clockwise from north.'}
              </div>
            </>
          )}
          {!boxUsedAnywhere && (
            <div className="hint" style={{ color: 'var(--warn, #b26a00)' }}>
              Source containers is off for this project — these dimensions are
              stored but not modelled. Turn it on in Settings → Source containers.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export type { SourceKind };
