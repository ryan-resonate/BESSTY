import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MapView, type BaseMap, type ContourMode } from '../components/MapView';
import { Legend, ResultsDock, StatusBar } from '../components/MapChrome';
import { SettingsModal } from '../components/SettingsModal';
import { SidePanel, type AddMode, type Tab } from '../components/SidePanel';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { gridDomain, type Palette } from '../lib/colormap';
import { loadDemForBounds, type DemRaster } from '../lib/dem';
import {
  extrapolateGrid,
  extrapolateProject,
  snapshotGrid,
  snapshotProject,
  type GridResult,
  type GridSnapshot,
  type PointSnapshot,
  type ReceiverResult,
} from '../lib/solver';
import { loadProject, saveProject } from '../lib/storage';
import type { Project, Receiver, Source, SourceKind } from '../lib/types';

let nextId = 1000;
function newId(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

// Pick a default model when adding a new source: first available entry
// (local catalog first, then global) of that kind.
function defaultModelFor(project: Project, kind: SourceKind): { modelId: string; scope: 'global' | 'local' } | null {
  const candidates = listEntriesByKind(project, kind);
  if (candidates.length === 0) return null;
  const e = candidates[0];
  return { modelId: e.id, scope: e._scope };
}

export function ProjectScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [project, setProjectState] = useState<Project | null>(null);
  const [results, setResults] = useState<ReceiverResult[] | null>(null);
  const [grid, setGrid] = useState<GridResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [gridStatus, setGridStatus] = useState<'idle' | 'computing' | 'ready'>('idle');
  const [lastSolveMs, setLastSolveMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Selection model. `selectedIds` is the set of currently-selected source
  // and receiver IDs (mixed kinds allowed). `selectedGroupId` is non-null
  // when a saved group is the active selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode>('none');
  const [showSettings, setShowSettings] = useState(false);
  const [cursorLatLng, setCursorLatLng] = useState<[number, number] | null>(null);
  /// Active tab — lifted into ProjectScreen so placing a new object can
  /// auto-switch the panel to Sources / Receivers.
  const [activeTab, setActiveTab] = useState<Tab>('sources');

  function selectOne(id: string | null) {
    setSelectedIds(id ? new Set([id]) : new Set());
    setSelectedGroupId(null);
  }
  function toggleSelection(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    setSelectedGroupId(null);
  }
  function selectGroup(groupId: string) {
    if (!project) return;
    const g = (project.groups ?? []).find((x) => x.id === groupId);
    if (!g) return;
    setSelectedIds(new Set(g.memberIds));
    setSelectedGroupId(groupId);
  }
  function selectFromMap(id: string | null, modifiers?: { shift?: boolean }) {
    if (modifiers?.shift && id) toggleSelection(id);
    else selectOne(id);
  }
  function selectFromBox(ids: string[], modifiers?: { shift?: boolean }) {
    setSelectedGroupId(null);
    setSelectedIds((prev) => {
      const next = modifiers?.shift ? new Set(prev) : new Set<string>();
      for (const id of ids) next.add(id);
      return next;
    });
  }

  const [baseMap, setBaseMap] = useState<BaseMap>('satellite');
  const [showContours, setShowContours] = useState(true);
  const [contourMode, setContourMode] = useState<ContourMode>('filled');
  const [contourOpacity, setContourOpacity] = useState(0.7);
  const [palette, setPalette] = useState<Palette>('viridis');
  const [domainMode, setDomainMode] = useState<'auto' | 'fixed'>('auto');
  const [fixedDomain, setFixedDomain] = useState<{ min: number; max: number }>({ min: 25, max: 60 });
  const [gridSpacingM, setGridSpacingM] = useState(100);

  const [dem, setDem] = useState<DemRaster | null>(null);
  const [demStatus, setDemStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  // Cached point + grid snapshots (gradients) for fast Taylor extrapolation.
  const pointSnapRef = useRef<PointSnapshot | null>(null);
  const gridSnapRef = useRef<GridSnapshot | null>(null);
  // Bumps every time a snapshot is refreshed in the background, so the
  // results-dependent UI re-renders against the new exact values.
  const [, setSnapshotVersion] = useState(0);

  // Load project from storage on mount.
  useEffect(() => {
    if (!projectId) return;
    const loaded = loadProject(projectId);
    if (!loaded) {
      navigate('/projects', { replace: true });
      return;
    }
    setProjectState(loaded);
  }, [projectId, navigate]);

  function setProject(p: Project) {
    setProjectState(p);
    if (projectId) saveProject(projectId, p);
  }

  // Auto-load DEM for the project area on first load. Re-load when the calc
  // area changes significantly (handled via demStatus reset on area edit).
  useEffect(() => {
    if (!project || demStatus !== 'idle') return;
    const ca = project.calculationArea;
    if (!ca) return;
    setDemStatus('loading');
    const R = 6371008.8;
    const lat0 = (ca.centerLatLng[0] * Math.PI) / 180;
    const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
    const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
    const sw: [number, number] = [ca.centerLatLng[0] - dLat, ca.centerLatLng[1] - dLng];
    const ne: [number, number] = [ca.centerLatLng[0] + dLat, ca.centerLatLng[1] + dLng];
    loadDemForBounds(sw, ne)
      .then((r) => { setDem(r); setDemStatus('ready'); })
      .catch((e) => { console.warn('DEM load failed (continuing flat-ground):', e); setDemStatus('error'); });
  }, [project, demStatus]);

  // Project state changes that trigger re-evaluation:
  //   - Source/receiver moves and edits → extrapolate from snapshot (fast).
  //   - Add/remove sources/receivers, change wind speed/mode/model, change
  //     barriers, change settings, swap DEM → re-snapshot (exact).
  //
  // We track structural changes via a hash that excludes mutable positions.
  const structuralKey = useMemo(() => {
    if (!project) return '';
    return JSON.stringify({
      windSpeed: project.scenario.windSpeed,
      sources: project.sources.map((s) => ({
        id: s.id, kind: s.kind, modelId: s.modelId, mode: s.modeOverride,
        hub: s.hubHeight, eo: s.elevationOffset,
      })),
      receivers: project.receivers.map((r) => ({
        id: r.id, h: r.heightAboveGroundM,
        // include latLng so that adding/moving a receiver triggers re-snap
        // (receiver-drag isn't covered by the source-only gradient cache).
        ll: r.latLng,
      })),
      barriers: project.barriers,
      settings: project.settings,
      hasDem: !!dem,
    });
  }, [project, dem]);

  // Re-snapshot whenever structure changes, debounced.
  useEffect(() => {
    if (!project) return;
    setComputing(true);
    setError(null);
    const start = performance.now();
    const handle = setTimeout(() => {
      snapshotProject(project, dem)
        .then(({ results, snapshot }) => {
          pointSnapRef.current = snapshot;
          setResults(results);
          setLastSolveMs(performance.now() - start);
          setSnapshotVersion((v) => v + 1);
          // If a grid is currently displayed, refresh its snapshot too so
          // that subsequent extrapolation uses up-to-date gradients.
          if (gridSnapRef.current) {
            const gridStart = performance.now();
            snapshotGrid(project, dem, gridSpacingM,
              project.settings?.general.defaultReceiverHeight ?? 1.5)
              .then((s) => {
                gridSnapRef.current = s;
                const { grid: g } = extrapolateGrid(project, s, dem);
                g.computedMs = performance.now() - gridStart;
                setGrid(g);
              })
              .catch((e) => console.warn('grid re-snapshot failed:', e));
          }
        })
        .catch((e) => setError(String(e)))
        .finally(() => setComputing(false));
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structuralKey]);

  // Source-position changes (drag) → extrapolate immediately from snapshot.
  // Cheap pure-JS arithmetic, no WASM call.
  const sourcePosKey = useMemo(() => {
    if (!project) return '';
    return project.sources.map((s) => `${s.id}:${s.latLng[0].toFixed(6)},${s.latLng[1].toFixed(6)}`).join('|');
  }, [project]);

  // Tracks whether the most recent extrapolation breached the per-band/total
  // dB caps. When set we kick a background re-snapshot to refresh gradients.
  const [snapshotStale, setSnapshotStale] = useState(false);

  useEffect(() => {
    if (!project) return;
    let staleHere = false;
    const snap = pointSnapRef.current;
    if (snap) {
      const { results: r, stale } = extrapolateProject(project, snap);
      setResults(r);
      if (stale) staleHere = true;
    }
    const gridSnap = gridSnapRef.current;
    if (gridSnap) {
      const { grid: g, stale } = extrapolateGrid(project, gridSnap, dem);
      setGrid(g);
      if (stale) staleHere = true;
    }
    if (staleHere) setSnapshotStale(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourcePosKey]);

  // When extrapolation breaches the caps, schedule a background re-snapshot
  // so subsequent extrapolations are accurate. Debounced so a continuous
  // drag doesn't fire snapshots faster than they complete.
  useEffect(() => {
    if (!project || !snapshotStale) return;
    const handle = setTimeout(() => {
      const start = performance.now();
      snapshotProject(project, dem)
        .then(({ results, snapshot }) => {
          pointSnapRef.current = snapshot;
          setResults(results);
          setLastSolveMs(performance.now() - start);
          setSnapshotVersion((v) => v + 1);
          if (gridSnapRef.current) {
            const gridStart = performance.now();
            snapshotGrid(project, dem, gridSpacingM,
              project.settings?.general.defaultReceiverHeight ?? 1.5)
              .then((s) => {
                gridSnapRef.current = s;
                const { grid: g } = extrapolateGrid(project, s, dem);
                g.computedMs = performance.now() - gridStart;
                setGrid(g);
              })
              .catch((e) => console.warn('grid re-snapshot failed:', e));
          }
        })
        .catch((e) => setError(String(e)))
        .finally(() => setSnapshotStale(false));
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotStale]);

  function runGrid() {
    if (!project) return;
    setGridStatus('computing');
    setTimeout(() => {
      snapshotGrid(project, dem, gridSpacingM, project.settings?.general.defaultReceiverHeight ?? 1.5)
        .then((s) => {
          gridSnapRef.current = s;
          const { grid: g } = extrapolateGrid(project, s, dem);
          g.computedMs = s.computedMs;
          setGrid(g);
          setGridStatus('ready');
          if (domainMode === 'fixed') {
            const d = gridDomain(g.dbA);
            setFixedDomain({ min: Math.floor(d.min / 5) * 5, max: Math.ceil(d.max / 5) * 5 });
          }
        })
        .catch((e) => { setError(String(e)); setGridStatus('idle'); });
    }, 0);
  }

  function handleAddSource(latLng: [number, number]) {
    if (!project || addMode === 'none' || addMode === 'receiver' || addMode === 'measure') return;
    const kind = addMode as SourceKind;
    const def = defaultModelFor(project, kind);
    if (!def) {
      setError(`No catalog entry available for ${kind}. Add one in the Catalog screen first.`);
      return;
    }
    const id = newId(kind === 'wtg' ? 'WTG' : kind.toUpperCase());
    // Look up the chosen entry to seed mode + hub-height defaults.
    const entry = lookupEntry(project, {
      id: '', kind, name: '', latLng, modelId: def.modelId, catalogScope: def.scope,
    });
    const newSource = kind === 'wtg'
      ? {
          id, kind, catalogScope: def.scope,
          name: `WTG-${project.sources.length + 1}`,
          latLng, modelId: def.modelId,
          hubHeight: entry?.hubHeights?.[0] ?? 100,
          modeOverride: entry?.defaultMode ?? null,
        }
      : {
          id, kind, catalogScope: def.scope,
          name: `${kind.toUpperCase()}-${project.sources.length + 1}`,
          latLng, modelId: def.modelId, elevationOffset: 0,
          modeOverride: entry?.defaultMode ?? null,
        };
    setProject({ ...project, sources: [...project.sources, newSource] });
    setActiveTab('sources');
    selectOne(id);
  }

  function handleAddReceiver(latLng: [number, number]) {
    if (!project) return;
    const id = newId('R');
    const period = project.scenario.period;
    const defaultLimit = 40;
    const newReceiver = {
      id,
      name: `Receiver ${project.receivers.length + 1}`,
      latLng,
      heightAboveGroundM: 1.5,
      // Three independent limits — the active one is picked by Scenario period.
      limitDayDbA: defaultLimit,
      limitEveningDbA: defaultLimit,
      limitNightDbA: defaultLimit,
      // Back-compat field — legacy `limitDbA` mirrors the night value.
      limitDbA: defaultLimit,
      period,
    };
    setProject({ ...project, receivers: [...project.receivers, newReceiver] });
    setActiveTab('receivers');
    selectOne(id);
  }

  /// Move a single object, OR if the dragged object is in a multi-selection,
  /// translate every selected member by the same lat/lng delta. Source kind
  /// (source vs receiver) is auto-detected from the project.
  function handleMoveObject(id: string, latLng: [number, number]) {
    if (!project) return;

    const isSource = project.sources.some((s) => s.id === id);
    const isReceiver = project.receivers.some((r) => r.id === id);
    if (!isSource && !isReceiver) return;

    const draggedFrom = isSource
      ? project.sources.find((s) => s.id === id)!.latLng
      : project.receivers.find((r) => r.id === id)!.latLng;
    const dLat = latLng[0] - draggedFrom[0];
    const dLng = latLng[1] - draggedFrom[1];

    // If the dragged object isn't part of a multi-selection, just move it.
    if (!selectedIds.has(id) || selectedIds.size <= 1) {
      if (isSource) {
        setProject({
          ...project,
          sources: project.sources.map((s) => (s.id === id ? { ...s, latLng } : s)),
        });
      } else {
        setProject({
          ...project,
          receivers: project.receivers.map((r) => (r.id === id ? { ...r, latLng } : r)),
        });
      }
      return;
    }

    // Group move: apply the same delta to every selected member.
    setProject({
      ...project,
      sources: project.sources.map((s) =>
        selectedIds.has(s.id) ? { ...s, latLng: [s.latLng[0] + dLat, s.latLng[1] + dLng] } : s,
      ),
      receivers: project.receivers.map((r) =>
        selectedIds.has(r.id) ? { ...r, latLng: [r.latLng[0] + dLat, r.latLng[1] + dLng] } : r,
      ),
    });
  }

  function handleMoveSource(id: string, latLng: [number, number]) { handleMoveObject(id, latLng); }
  function handleMoveReceiver(id: string, latLng: [number, number]) { handleMoveObject(id, latLng); }

  // ---------- Group operations ----------

  function createGroupFromSelection(name: string, color?: string) {
    if (!project || selectedIds.size === 0) return;
    const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    const newGroup = { id, name, memberIds: Array.from(selectedIds), color };
    setProject({ ...project, groups: [...(project.groups ?? []), newGroup] });
    setSelectedGroupId(id);
  }
  function renameGroup(id: string, name: string) {
    if (!project) return;
    setProject({
      ...project,
      groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, name } : g)),
    });
  }
  function recolorGroup(id: string, color: string) {
    if (!project) return;
    setProject({
      ...project,
      groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, color } : g)),
    });
  }
  function deleteGroup(id: string) {
    if (!project) return;
    setProject({
      ...project,
      groups: (project.groups ?? []).filter((g) => g.id !== id),
    });
    if (selectedGroupId === id) {
      setSelectedGroupId(null);
      setSelectedIds(new Set());
    }
  }
  function setGroupMembers(id: string, memberIds: string[]) {
    if (!project) return;
    setProject({
      ...project,
      groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, memberIds } : g)),
    });
  }

  /// Bulk-update a property on every selected source.
  function bulkUpdateSources(patch: Partial<Source>) {
    if (!project) return;
    const p = project;
    setProject({
      ...p,
      sources: p.sources.map((s) => (selectedIds.has(s.id) ? { ...s, ...patch } : s)),
    });
  }
  function bulkUpdateReceivers(patch: Partial<Receiver>) {
    if (!project) return;
    const p = project;
    setProject({
      ...p,
      receivers: p.receivers.map((r) => (selectedIds.has(r.id) ? { ...r, ...patch } : r)),
    });
  }
  function bulkDeleteSelected() {
    if (!project || selectedIds.size === 0) return;
    setProject({
      ...project,
      sources: project.sources.filter((s) => !selectedIds.has(s.id)),
      receivers: project.receivers.filter((r) => !selectedIds.has(r.id)),
      // Clean up any group memberships pointing at deleted ids.
      groups: (project.groups ?? []).map((g) => ({
        ...g, memberIds: g.memberIds.filter((mid) => !selectedIds.has(mid)),
      })).filter((g) => g.memberIds.length > 0),
    });
    setSelectedIds(new Set());
    setSelectedGroupId(null);
  }

  function handleResizeCalcArea(widthM: number, heightM: number) {
    if (!project || !project.calculationArea) return;
    setProject({
      ...project,
      calculationArea: { ...project.calculationArea, widthM, heightM },
    });
    // Calc-area changed → DEM coverage may need to widen; reset DEM status
    // so the fetcher re-runs against the new bounds.
    setDemStatus('idle');
  }
  function handleMoveCalcArea(centerLatLng: [number, number]) {
    if (!project || !project.calculationArea) return;
    setProject({
      ...project,
      calculationArea: { ...project.calculationArea, centerLatLng },
    });
    setDemStatus('idle');
  }

  // dB colormap domain — auto-fit to grid (or to receivers if no grid yet)
  // unless the user has chosen a fixed range.
  const dbDomain = useMemo(() => {
    if (domainMode === 'fixed') return fixedDomain;
    if (grid) return gridDomain(grid.dbA);
    if (results && results.length > 0) {
      let min = Infinity, max = -Infinity;
      for (const r of results) {
        if (!isFinite(r.totalDbA)) continue;
        if (r.totalDbA < min) min = r.totalDbA;
        if (r.totalDbA > max) max = r.totalDbA;
      }
      if (isFinite(min) && isFinite(max) && max > min) return { min, max };
    }
    return { min: 25, max: 60 };
  }, [domainMode, fixedDomain, grid, results]);

  if (!project) {
    return <div style={{ padding: 32 }}>Loading…</div>;
  }

  const receiverDbList = (results ?? []).map((r) => r.totalDbA);

  return (
    <div className="workspace">
      <SidePanel
        project={project}
        results={results}
        selectedIds={selectedIds}
        selectedGroupId={selectedGroupId}
        activeTab={activeTab}
        setActiveTab={setActiveTab}
        onSelect={selectFromMap}
        onSelectGroup={selectGroup}
        onClearSelection={() => { setSelectedIds(new Set()); setSelectedGroupId(null); }}
        onCreateGroup={createGroupFromSelection}
        onRenameGroup={renameGroup}
        onRecolorGroup={recolorGroup}
        onDeleteGroup={deleteGroup}
        onSetGroupMembers={setGroupMembers}
        onBulkUpdateSources={bulkUpdateSources}
        onBulkUpdateReceivers={bulkUpdateReceivers}
        onBulkDeleteSelected={bulkDeleteSelected}
        addMode={addMode}
        setAddMode={setAddMode}
        setProject={setProject}
        onRunGrid={runGrid}
        computing={computing || gridStatus === 'computing'}
        lastSolveMs={lastSolveMs}
        onOpenSettings={() => setShowSettings(true)}
        baseMap={baseMap} setBaseMap={setBaseMap}
        showContours={showContours} setShowContours={setShowContours}
        contourMode={contourMode} setContourMode={setContourMode}
        contourOpacity={contourOpacity} setContourOpacity={setContourOpacity}
        palette={palette} setPalette={setPalette}
        domainMode={domainMode} setDomainMode={setDomainMode}
        fixedDomain={fixedDomain} setFixedDomain={setFixedDomain}
        demStatus={demStatus}
        demTilesLoaded={dem?.tilesLoaded ?? null}
        gridSpacingM={gridSpacingM} setGridSpacingM={setGridSpacingM}
      />

      <div className="map-area">
        <MapView
          project={project}
          results={results}
          grid={grid}
          selectedIds={selectedIds}
          onSelect={selectFromMap}
          onBoxSelect={selectFromBox}
          addMode={addMode}
          baseMap={baseMap}
          showContours={showContours}
          contourMode={contourMode}
          contourOpacity={contourOpacity}
          palette={palette}
          dbDomain={dbDomain}
          onAddSource={handleAddSource}
          onAddReceiver={handleAddReceiver}
          onMoveSource={handleMoveSource}
          onMoveReceiver={handleMoveReceiver}
          onResizeCalcArea={handleResizeCalcArea}
          onMoveCalcArea={handleMoveCalcArea}
          onCursorMove={setCursorLatLng}
        />

        <div className="back-link">
          <Link to="/projects">← All projects</Link>
        </div>

        <StatusBar project={project} selectedIds={selectedIds} cursorLatLng={cursorLatLng} />

        <div className="map-chrome-stack right">
          <ResultsDock
            project={project} results={results} grid={grid}
            computing={computing} lastSolveMs={lastSolveMs}
            gridStatus={gridStatus} snapshotStale={snapshotStale}
            onRunGrid={runGrid}
          />
        </div>

        <Legend palette={palette} domain={dbDomain} receiverDb={receiverDbList} />

        {error && <div className="map-toast error">solver error: {error}</div>}
      </div>

      {showSettings && (
        <SettingsModal
          project={project} setProject={setProject}
          onClose={() => setShowSettings(false)}
          gridSpacingM={gridSpacingM} setGridSpacingM={setGridSpacingM}
        />
      )}
    </div>
  );
}
