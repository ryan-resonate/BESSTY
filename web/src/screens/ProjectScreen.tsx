import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import L from 'leaflet';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MapView, type BaseMap, type ContourMode } from '../components/MapView';
import { Map3DView } from '../components/Map3DView';
import { MapControls } from '../components/MapControls';
import { Legend, ResultsDock, StatusBar } from '../components/MapChrome';
import { SidePanel, type AddMode, type Tab } from '../components/SidePanel';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { gridDomain, type Palette } from '../lib/colormap';
import { loadDemForBounds, type DemRaster } from '../lib/dem';
import {
  GRID_SNAPSHOT_BUDGET_BYTES,
  estimateGridMemoryBytes,
  evaluateGrid,
  extrapolateGrid,
  extrapolateProject,
  snapshotGrid,
  snapshotProject,
  type GridResult,
  type GridSnapshot,
  type PointSnapshot,
  type ReceiverResult,
} from '../lib/solver';
import { useAuthState } from '../lib/auth';
import { useProjectDoc } from '../lib/useProjectDoc';
import { parseDemGeoTiff } from '../lib/demUpload';
import { downloadProjectDem } from '../lib/firestoreStorage';
import type { Barrier, Project, Receiver, Source, SourceKind } from '../lib/types';

let nextId = 1000;
function newId(prefix: string) {
  nextId += 1;
  return `${prefix}-${nextId}`;
}

/// Vertical splitter between the side panel and the map area. Drag with
/// the mouse to resize. Width is stored as a CSS variable on the workspace
/// so the resize doesn't trigger a React re-render on every mousemove —
/// we just write to the DOM and the grid track follows.
function SidePanelSplitter() {
  function onMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const workspace = (e.currentTarget.parentElement) as HTMLElement | null;
    if (!workspace) return;
    workspace.classList.add('dragging-splitter');
    e.currentTarget.classList.add('dragging');
    const startX = e.clientX;
    const startWidth = workspace.getBoundingClientRect().width
      ? parseInt(getComputedStyle(workspace).getPropertyValue('--side-panel-w') || '420', 10) || 420
      : 420;
    const minW = 280;
    const maxW = Math.max(minW + 100, window.innerWidth - 320);
    function onMove(ev: MouseEvent) {
      const dx = ev.clientX - startX;
      const w = Math.max(minW, Math.min(maxW, startWidth + dx));
      workspace!.style.setProperty('--side-panel-w', `${w}px`);
    }
    function onUp() {
      workspace!.classList.remove('dragging-splitter');
      const splitter = workspace!.querySelector('.side-panel-splitter');
      splitter?.classList.remove('dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }
  return (
    <div
      className="side-panel-splitter"
      onMouseDown={onMouseDown}
      title="Drag to resize the side panel"
    />
  );
}

/// Replace any NaN / ±Infinity numeric fields with safe defaults across
/// every part of the project that gets edited via UI inputs. Acts as a
/// final firewall right before the project lands in React state —
/// guarantees that downstream renders never see a non-finite number that
/// could blow up a controlled input. Add new numeric fields here as they
/// get edit-able UI surface.
function sanitizeProject(p: Project): Project {
  const safe = (v: unknown, fallback: number): number => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const fixedReceivers = p.receivers.map((r) => {
    const out = { ...r };
    if (!Number.isFinite(r.heightAboveGroundM)) out.heightAboveGroundM = 1.5;
    if (!Number.isFinite(r.limitDayDbA))     out.limitDayDbA     = 50;
    if (!Number.isFinite(r.limitEveningDbA)) out.limitEveningDbA = 45;
    if (!Number.isFinite(r.limitNightDbA))   out.limitNightDbA   = 40;
    if (!Number.isFinite(r.latLng?.[0]) || !Number.isFinite(r.latLng?.[1])) {
      // Leave latLng as-is — MapView will skip rendering an invalid marker
      // and the receiver list still shows it (so the user can fix it).
    }
    return out;
  });
  const fixedSources = p.sources.map((s) => {
    const out = { ...s };
    if (s.hubHeight != null) out.hubHeight = safe(s.hubHeight, 100);
    if (s.rotorDiameterM != null) out.rotorDiameterM = safe(s.rotorDiameterM, 120);
    if (s.elevationOffset != null) out.elevationOffset = safe(s.elevationOffset, 0);
    if (s.yawDeg != null) out.yawDeg = safe(s.yawDeg, 0);
    return out;
  });
  const ca = p.calculationArea
    ? {
        ...p.calculationArea,
        widthM: safe(p.calculationArea.widthM, 5000),
        heightM: safe(p.calculationArea.heightM, 5000),
        rotationDeg: safe(p.calculationArea.rotationDeg, 0),
        centerLatLng: [
          safe(p.calculationArea.centerLatLng[0], 0),
          safe(p.calculationArea.centerLatLng[1], 0),
        ] as [number, number],
      }
    : p.calculationArea;
  const scenario = {
    ...p.scenario,
    windSpeed: safe(p.scenario.windSpeed, 10),
    windSpeedReferenceHeight: safe(p.scenario.windSpeedReferenceHeight, 10),
  };
  return { ...p, receivers: fixedReceivers, sources: fixedSources, calculationArea: ca, scenario };
}

// Pick a default model when adding a new source: first available entry
// (local catalog first, then personal, then global) of that kind.
function defaultModelFor(
  project: Project,
  kind: SourceKind,
): { modelId: string; scope: 'global' | 'local' | 'personal' } | null {
  const candidates = listEntriesByKind(project, kind);
  if (candidates.length === 0) return null;
  const e = candidates[0];
  return { modelId: e.id, scope: e._scope };
}

/// Stable string fingerprint of a DemRaster, used in the structural keys
/// that drive snapshot recomputation. Discriminates by:
///   - `source` field (filename for uploads, "auto" for AWS tile-based).
///   - bounds (rounded to 4 decimal places ≈ 11 m at the equator -- coarse
///     enough that progressive auto-tile additions don't churn the key,
///     fine enough that any meaningful DEM swap registers).
/// Deliberately omits `tilesLoaded` so partial AWS tile loads don't
/// trigger spurious re-snapshots.
function demFingerprint(d: DemRaster | null): string {
  if (!d) return 'none';
  const src = (d as DemRaster & { source?: string }).source ?? 'auto';
  const b = d.bounds;
  return `${src}:${b.sw[0].toFixed(4)},${b.sw[1].toFixed(4)},${b.ne[0].toFixed(4)},${b.ne[1].toFixed(4)}`;
}

export function ProjectScreen() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  // Persistence: Firestore-backed if the doc exists there, otherwise
  // localStorage fallback. The hook handles debounced saves, real-time
  // collaborator updates, and the "no project anywhere" case.
  const authState = useAuthState();
  const currentUid = authState.user?.uid ?? null;
  const {
    project: persistedProject,
    loading: projectLoading,
    source: projectSource,
    setProject: persistProject,
    saveStatus,
    saveError,
    remoteUpdate,
    dismissRemoteUpdate,
  } = useProjectDoc(projectId, currentUid);
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
  const [show3D, setShow3D] = useState(false);
  const [cursorLatLng, setCursorLatLng] = useState<[number, number] | null>(null);
  /// Active tab — lifted into ProjectScreen so placing a new object can
  /// auto-switch the panel to Sources / Receivers.
  const [activeTab, setActiveTab] = useState<Tab>('sources');

  // Esc cancels any active add / measure mode AND clears the current
  // selection so the user is back to the default mouse cursor with no
  // sticky multi-selection. Skipped when focus is in a text field — Esc
  // there usually means "abandon edit", not "drop selection on the map".
  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      if (ev.key !== 'Escape') return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) {
        // Let the field blur naturally — the keydown listener on the input
        // (e.g. NumericInput) handles its own Esc semantics.
        return;
      }
      setAddMode('none');
      setSelectedIds(new Set());
      setSelectedGroupId(null);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  const [showGridDebug, setShowGridDebug] = useState(false);
  const [contourMode, setContourMode] = useState<ContourMode>('both');
  const [contourOpacity, setContourOpacity] = useState(0.7);
  const [contourStepDb, setContourStepDb] = useState(5);
  const [contourBounds, setContourBounds] = useState({ min: 25, max: 60, step: 5 });
  const [palette, setPalette] = useState<Palette>('viridis');
  const [domainMode, setDomainMode] = useState<'auto' | 'fixed'>('auto');
  const [fixedDomain, setFixedDomain] = useState<{ min: number; max: number }>({ min: 25, max: 60 });
  // Grid spacing — auto-picked from the calc area on first appearance,
  // then frozen against the user's choice once they touch the picker.
  // Available choices live in `GRID_SPACING_CHOICES` (SidePanel) — pick
  // the smallest one that keeps cells per axis ≤ AUTO_TARGET_CELLS so
  // contours stay smooth on a typical 5–10 km wind farm.
  const [gridSpacingM, setGridSpacingMState] = useState(100);
  const gridSpacingTouchedRef = useRef(false);
  function setGridSpacingM(v: number) {
    gridSpacingTouchedRef.current = true;
    setGridSpacingMState(v);
  }

  const [dem, setDem] = useState<DemRaster | null>(null);
  const [demStatus, setDemStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  /// 'auto' = AWS Terrain Tiles fetched on load; 'upload' = user GeoTIFF.
  const [demSource, setDemSource] = useState<'auto' | 'upload'>('auto');

  function setDemAndSource(d: DemRaster | null, source: 'auto' | 'upload') {
    setDem(d);
    setDemSource(source);
    if (source === 'auto' && d == null) {
      // Reset request — kick the auto-loader effect by clearing status.
      setDemStatus('idle');
    } else if (source === 'upload') {
      setDemStatus('ready');
    }
  }

  // Imperative handle to the Leaflet map for the floating MapControls.
  const mapHandleRef = useRef<L.Map | null>(null);
  function fitCalcArea() {
    const map = mapHandleRef.current;
    if (!map || !project?.calculationArea) return;
    const ca = project.calculationArea;
    const R = 6371008.8;
    const lat0 = (ca.centerLatLng[0] * Math.PI) / 180;
    const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
    const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
    map.fitBounds([
      [ca.centerLatLng[0] - dLat, ca.centerLatLng[1] - dLng],
      [ca.centerLatLng[0] + dLat, ca.centerLatLng[1] + dLng],
    ], { animate: true, padding: [40, 40] });
  }

  /// Map-fitter for after-import callback. Pads by 5% so the very-edge
  /// markers don't sit right on the screen edge.
  function fitToBounds(bounds: { sw: [number, number]; ne: [number, number] }) {
    const map = mapHandleRef.current;
    if (!map) return;
    map.fitBounds([bounds.sw, bounds.ne], { animate: true, padding: [60, 60], maxZoom: 16 });
  }

  /// Resize calculation area to wrap every source + receiver with a 10%
  /// buffer on each side. Picks a sensible default centre if the project
  /// had nothing before. Triggered by the Area-tab "Fit to objects" button.
  function fitCalcAreaToObjects() {
    if (!project) return;
    const points: Array<[number, number]> = [];
    for (const s of project.sources) {
      if (Number.isFinite(s.latLng[0]) && Number.isFinite(s.latLng[1])) points.push(s.latLng);
    }
    for (const r of project.receivers) {
      if (Number.isFinite(r.latLng[0]) && Number.isFinite(r.latLng[1])) points.push(r.latLng);
    }
    if (points.length === 0) {
      setError('Add at least one source or receiver before fitting the calculation area.');
      return;
    }
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [la, ln] of points) {
      if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
      if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
    }
    const centreLat = (minLat + maxLat) / 2;
    const centreLng = (minLng + maxLng) / 2;
    // Lat/lng → metres at this latitude.
    const R = 6371008.8;
    const lat0Rad = (centreLat * Math.PI) / 180;
    const heightM = Math.max(500, (maxLat - minLat) * (Math.PI / 180) * R);
    const widthM = Math.max(500, (maxLng - minLng) * (Math.PI / 180) * R * Math.cos(lat0Rad));
    // 10% buffer = scale by 1.1, but enforce a 500 m minimum dimension so a
    // single isolated point doesn't produce a 50 m × 50 m calc area.
    const padded = (m: number) => Math.max(500, m * 1.1);
    setProject({
      ...project,
      calculationArea: {
        centerLatLng: [centreLat, centreLng],
        widthM: padded(widthM),
        heightM: padded(heightM),
        rotationDeg: project.calculationArea?.rotationDeg ?? 0,
      },
    });
    setDemStatus('idle');     // reload DEM for the new bounds
  }

  // Cached point + grid snapshots (gradients) for fast Taylor extrapolation.
  const pointSnapRef = useRef<PointSnapshot | null>(null);
  const gridSnapRef = useRef<GridSnapshot | null>(null);
  // Generation counters: each new snapshot request bumps these. When an
  // async result comes back we discard it if a newer request has fired in
  // the meantime — stops a slow run from clobbering the latest geometry.
  const pointGenRef = useRef(0);
  const gridGenRef = useRef(0);
  // Bumps every time a snapshot is refreshed in the background, so the
  // results-dependent UI re-renders against the new exact values.
  const [, setSnapshotVersion] = useState(0);

  // Sync persisted project (from the hook) into the editor's working
  // state. Fires on initial load and on remote collaborator updates that
  // arrived while we had no unsaved local changes (the hook's banner
  // path catches the conflict case). Resets undo history on every load
  // so the user can't undo their way back to "the previous user's edit".
  useEffect(() => {
    if (persistedProject) {
      // Sanitize on load: any NaN that was previously saved (from a botched
      // import in an older build) gets repaired before it hits the UI.
      setProjectState(sanitizeProject(persistedProject));
      undoStackRef.current = [];
      redoStackRef.current = [];
    }
  }, [persistedProject]);

  // Redirect away if there's no project to load — either the id is
  // garbage or (for a Firestore project) the current user doesn't have
  // permission to read it.
  useEffect(() => {
    if (!projectId) return;
    if (projectLoading) return;
    if (projectSource === 'none') {
      navigate('/projects', { replace: true });
    }
  }, [projectId, projectLoading, projectSource, navigate]);

  // ---------- Undo / redo ----------
  // Push every project mutation onto a 50-deep history stack. Ctrl+Z pops
  // the previous state; Ctrl+Shift+Z (or Ctrl+Y) re-pushes it onto the
  // redo stack. The first setProject call after an undo clears the redo
  // stack — standard editor behaviour.
  const undoStackRef = useRef<Project[]>([]);
  const redoStackRef = useRef<Project[]>([]);
  const UNDO_LIMIT = 50;

  function setProject(p: Project) {
    // Last-ditch sanitizer: strip NaN/Infinity from every numeric receiver
    // and source field before it lands in state. Anything that slips past
    // earlier guards (CSV import edge cases, weird user typing) gets
    // replaced here so render-time inputs never see non-finite values.
    const clean = sanitizeProject(p);
    if (project) {
      undoStackRef.current.push(project);
      if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
      redoStackRef.current = [];
    }
    setProjectState(clean);
    persistProject(clean);
  }

  /// Replace project state without recording it on the undo stack — used by
  /// undo/redo themselves, and by the project-load effect.
  function setProjectQuiet(p: Project) {
    setProjectState(p);
    persistProject(p);
  }

  useEffect(() => {
    function onKey(ev: KeyboardEvent) {
      // Skip if focus is in an editable element — let the field handle Z/Y itself.
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return;
      }
      const cmd = ev.ctrlKey || ev.metaKey;
      if (cmd && (ev.key === 'z' || ev.key === 'Z')) {
        ev.preventDefault();
        if (ev.shiftKey) {
          // Redo
          const next = redoStackRef.current.pop();
          if (!next || !project) return;
          undoStackRef.current.push(project);
          setProjectQuiet(next);
        } else {
          // Undo
          const prev = undoStackRef.current.pop();
          if (!prev || !project) return;
          redoStackRef.current.push(project);
          setProjectQuiet(prev);
        }
      } else if (cmd && (ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault();
        const next = redoStackRef.current.pop();
        if (!next || !project) return;
        undoStackRef.current.push(project);
        setProjectQuiet(next);
      } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
        if (selectedIds.size === 0) return;
        ev.preventDefault();
        bulkDeleteSelected();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, projectId, selectedIds]);

  // Auto-pick a sensible grid spacing the first time we see a calc area.
  // Once the user touches the spacing picker (Settings → Grid spacing or
  // SidePanel Area tab) we never override their choice again. Aim for
  // ~200 cells across the long side: smaller area → finer spacing.
  useEffect(() => {
    if (!project?.calculationArea || gridSpacingTouchedRef.current) return;
    const longSide = Math.max(project.calculationArea.widthM, project.calculationArea.heightM);
    const target = longSide / 200;
    const choices = [25, 50, 100, 200, 300];
    const auto = choices.find((s) => target <= s) ?? 300;
    if (auto !== gridSpacingM) setGridSpacingMState(auto);
    // Don't depend on `gridSpacingM` — that would cause a feedback loop
    // when we update it. Only the calc-area dimensions matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.calculationArea?.widthM, project?.calculationArea?.heightM]);

  // Auto-load DEM for the project area on first load. Re-load when the calc
  // area changes significantly (handled via demStatus reset on area edit).
  // Skipped when the user has supplied their own GeoTIFF in this session OR
  // when the project has a Firebase-Storage-persisted DEM that the effect
  // below is responsible for downloading.
  useEffect(() => {
    if (!project || demStatus !== 'idle' || demSource === 'upload') return;
    if (persistedProject?.dem) return;   // saved DEM takes over via the next effect
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
  }, [project, demStatus, demSource, persistedProject?.dem]);

  // Auto-download a previously persisted DEM from Firebase Storage on
  // project open (or when the persisted DEM reference changes -- e.g. a
  // collaborator uploaded a different one). Uses a generation counter
  // to discard stale responses if the user uploads a new DEM mid-
  // download or navigates away.
  const demLoadGenRef = useRef(0);
  useEffect(() => {
    const persistedDem = persistedProject?.dem;
    if (!persistedDem) return;
    // Already have this exact one loaded? Skip.
    if (demSource === 'upload' && dem != null) {
      const cur = (dem as DemRaster & { source?: string }).source;
      if (cur === persistedDem.filename) return;
    }
    const gen = ++demLoadGenRef.current;
    void (async () => {
      setDemStatus('loading');
      try {
        const file = await downloadProjectDem(persistedDem.storagePath, persistedDem.filename);
        if (gen !== demLoadGenRef.current) return;
        const parsed = await parseDemGeoTiff(file, { epsgOverride: persistedDem.epsg });
        if (gen !== demLoadGenRef.current) return;
        setDemAndSource(parsed, 'upload');
        setDemStatus('ready');
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[BESSTY] saved DEM download failed:', err);
        setDemStatus('error');
      }
    })();
  }, [persistedProject?.dem?.storagePath, persistedProject?.dem?.filename, persistedProject?.dem?.epsg, dem, demSource]);

  // Project state changes are split into two reactive surfaces:
  //
  //   - **Point snapshot** (re-snapshot when this changes): includes everything
  //     that affects per-pair Lp at named receivers — sources, receivers,
  //     barriers, settings, DEM, scenario.
  //   - **Grid snapshot** (re-snapshot when this changes): excludes receiver
  //     state entirely — grid cells are independent virtual receivers, so
  //     moving a real receiver can't change any grid cell.
  //
  // Source-position changes don't enter either key — those are gradient-
  // extrapolated and handled by the sourcePosKey effect below.
  //
  // DEM fingerprinting note: a previous version of these keys included
  // `hasDem: !!dem` (a boolean). That meant swapping from auto-loaded
  // AWS Terrain Tiles to a user-uploaded GeoTIFF (or vice versa) didn't
  // change the key, so the point snapshot never re-ran -- contours
  // updated correctly because the user clicks "Run grid" which always
  // re-snapshots, but the point receivers silently stayed on the
  // previous DEM. `demFingerprint` discriminates by source + bounds so
  // any real DEM swap forces a re-snapshot.
  const pointStructuralKey = useMemo(() => {
    if (!project) return '';
    return JSON.stringify({
      windSpeed: project.scenario.windSpeed,
      sources: project.sources.map((s) => ({
        id: s.id, kind: s.kind, modelId: s.modelId, scope: s.catalogScope,
        mode: s.modeOverride, hub: s.hubHeight, eo: s.elevationOffset,
      })),
      receivers: project.receivers.map((r) => ({
        id: r.id, h: r.heightAboveGroundM, ll: r.latLng,
      })),
      barriers: project.barriers,
      settings: project.settings,
      dem: demFingerprint(dem),
    });
  }, [project, dem]);

  const gridStructuralKey = useMemo(() => {
    if (!project) return '';
    return JSON.stringify({
      windSpeed: project.scenario.windSpeed,
      sources: project.sources.map((s) => ({
        id: s.id, kind: s.kind, modelId: s.modelId, scope: s.catalogScope,
        mode: s.modeOverride, hub: s.hubHeight, eo: s.elevationOffset,
      })),
      barriers: project.barriers,
      ground: project.settings?.ground,
      annexD: project.settings?.annexD,
      gridReceiverHeight: project.settings?.general.defaultReceiverHeight,
      calc: project.calculationArea,
      gridSpacingM,
      dem: demFingerprint(dem),
    });
  }, [project, dem, gridSpacingM]);

  useEffect(() => {
    if (!project) return;
    setComputing(true);
    setError(null);
    const start = performance.now();
    const handle = setTimeout(() => {
      const gen = ++pointGenRef.current;
      snapshotProject(project, dem)
        .then(({ results, snapshot }) => {
          if (gen !== pointGenRef.current) return;       // superseded
          pointSnapRef.current = snapshot;
          setResults(results);
          setLastSolveMs(performance.now() - start);
          setSnapshotVersion((v) => v + 1);
        })
        .catch((e) => { if (gen === pointGenRef.current) setError(String(e)); })
        .finally(() => { if (gen === pointGenRef.current) setComputing(false); });
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointStructuralKey]);

  // Grid re-snapshot on grid-relevant changes only. Receivers don't trigger.
  useEffect(() => {
    if (!project || !gridSnapRef.current) return;        // no grid → nothing to do
    const handle = setTimeout(() => {
      const gen = ++gridGenRef.current;
      const start = performance.now();
      snapshotGrid(project, dem, gridSpacingM,
        project.settings?.general.defaultReceiverHeight ?? 1.5)
        .then((s) => {
          if (gen !== gridGenRef.current) return;        // superseded
          gridSnapRef.current = s;
          const { grid: g } = extrapolateGrid(project, s, dem);
          g.computedMs = performance.now() - start;
          setGrid(g);
        })
        .catch((e) => console.warn('grid re-snapshot failed:', e));
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStructuralKey]);

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
    } else if (grid) {
      // Eval-only mode (no gradient pack — gridSnapRef was never built).
      // Mark stale so the debounced re-snapshot effect below kicks in and
      // re-runs `evaluateGrid`. Without this, dragging a source after a
      // memory-budget fallback would leave the visible grid out of date.
      staleHere = true;
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
      const pGen = ++pointGenRef.current;
      const start = performance.now();
      snapshotProject(project, dem)
        .then(({ results, snapshot }) => {
          if (pGen !== pointGenRef.current) return;
          pointSnapRef.current = snapshot;
          setResults(results);
          setLastSolveMs(performance.now() - start);
          setSnapshotVersion((v) => v + 1);
          // Refresh the grid too, picking the same path Run-grid would take
          // for the current memory budget. If we've previously been in
          // snapshot mode (`gridSnapRef.current` is set) we re-snapshot;
          // otherwise — and only if a grid is already on screen — we
          // re-evaluate without gradients.
          const heightAbove = project.settings?.general.defaultReceiverHeight ?? 1.5;
          const refreshSnapshot = gridSnapRef.current != null;
          const refreshEval = !refreshSnapshot && grid != null;
          if (refreshSnapshot || refreshEval) {
            const gGen = ++gridGenRef.current;
            const gridStart = performance.now();
            const promise = refreshSnapshot
              ? snapshotGrid(project, dem, gridSpacingM, heightAbove).then((s) => {
                  if (gGen !== gridGenRef.current) return;
                  gridSnapRef.current = s;
                  const { grid: g } = extrapolateGrid(project, s, dem);
                  g.computedMs = performance.now() - gridStart;
                  setGrid(g);
                })
              : evaluateGrid(project, dem, gridSpacingM, heightAbove).then((g) => {
                  if (gGen !== gridGenRef.current) return;
                  setGrid(g);
                });
            promise.catch((e) => console.warn('grid re-snapshot failed:', e));
          }
        })
        .catch((e) => { if (pGen === pointGenRef.current) setError(String(e)); })
        .finally(() => setSnapshotStale(false));
    }, 200);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotStale]);

  function runGrid() {
    if (!project) return;
    setGridStatus('computing');
    // Memory pre-flight. The gradient pack scales as
    //   cellCount × effective_sources × packLen × 4 bytes
    // and is by far the largest allocation in the app. If it would exceed
    // our soft budget (600 MB), drop straight to `evaluateGrid` — same
    // visual result, no per-source gradients (so drag-extrapolation falls
    // back to a fresh re-run instead of an instantaneous pure-JS update).
    const est = estimateGridMemoryBytes(project, gridSpacingM);
    const heightAbove = project.settings?.general.defaultReceiverHeight ?? 1.5;
    setTimeout(() => {
      const gen = ++gridGenRef.current;
      // Free the previous gradient pack before allocating the new one —
      // reduces peak memory during the transition (the GC otherwise can
      // hold onto the old buffer while the new one is being built).
      gridSnapRef.current = null;

      if (est.snapshotBytes > GRID_SNAPSHOT_BUDGET_BYTES) {
        const sizeMb = (est.snapshotBytes / 1024 / 1024).toFixed(0);
        console.info(
          `[BESSTY] grid would need ${sizeMb} MB for the gradient pack ` +
          `(${est.cells.toLocaleString()} cells × ${est.effectiveSources} sources). ` +
          `Falling back to evaluate-only mode — drag still works but re-evaluates ` +
          `instead of fast-extrapolating.`,
        );
        evaluateGrid(project, dem, gridSpacingM, heightAbove)
          .then((g) => {
            if (gen !== gridGenRef.current) return;
            setGrid(g);
            setGridStatus('ready');
          })
          .catch((e) => { if (gen === gridGenRef.current) { setError(String(e)); setGridStatus('idle'); } });
        return;
      }

      snapshotGrid(project, dem, gridSpacingM, heightAbove)
        .then((s) => {
          if (gen !== gridGenRef.current) return;
          gridSnapRef.current = s;
          const { grid: g } = extrapolateGrid(project, s, dem);
          g.computedMs = s.computedMs;
          setGrid(g);
          setGridStatus('ready');
        })
        .catch((e) => { if (gen === gridGenRef.current) { setError(String(e)); setGridStatus('idle'); } });
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

  /// Replace a barrier's polyline geometry. Used by the map's barrier
  /// drag handles (both endpoint moves and full-line translations).
  /// Skipped silently if any vertex is non-finite — the map drag layer
  /// can occasionally emit garbage during fast cursor moves and we'd
  /// rather leave the barrier where it was than corrupt project state.
  function handleUpdateBarrier(id: string, polyline: Array<[number, number]>) {
    if (!project) return;
    if (polyline.length < 2) return;
    for (const [la, ln] of polyline) {
      if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    }
    setProject({
      ...project,
      barriers: project.barriers.map((b) => (b.id === id ? { ...b, polylineLatLng: polyline } : b)),
    });
  }

  function handleAddBarrier(a: [number, number], b: [number, number]) {
    if (!project) return;
    if (![a[0], a[1], b[0], b[1]].every(Number.isFinite)) return;
    const id = newId('B');
    const newBarrier: Barrier = {
      id,
      name: `Barrier ${project.barriers.length + 1}`,
      type: 'wall',
      polylineLatLng: [a, b],
      topHeightsM: [5],         // sensible default; user edits in the Barriers tab
      baseFromGroundM: 0,
      surfaceDensityKgM2: 20,   // reflective wall — only matters when reflections land
      absorptionCoeff: 0.2,
    };
    setProject({ ...project, barriers: [...project.barriers, newBarrier] });
    setActiveTab('barriers');
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
  ///
  /// All coordinate writes are NaN-guarded — if anything goes sideways
  /// (Leaflet sometimes emits non-finite coords during fast group drags),
  /// we leave the affected marker at its previous position rather than
  /// corrupting the project state and making it disappear from the map.
  function handleMoveObject(id: string, latLng: [number, number]) {
    if (!project) return;
    if (!Number.isFinite(latLng[0]) || !Number.isFinite(latLng[1])) return;

    const isSource = project.sources.some((s) => s.id === id);
    const isReceiver = project.receivers.some((r) => r.id === id);
    if (!isSource && !isReceiver) return;

    const draggedFrom = isSource
      ? project.sources.find((s) => s.id === id)!.latLng
      : project.receivers.find((r) => r.id === id)!.latLng;
    if (!Number.isFinite(draggedFrom[0]) || !Number.isFinite(draggedFrom[1])) return;
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

    // Group move: apply the same delta to every selected member, but only
    // when the source coords are themselves valid — keeps a stale NaN entry
    // (e.g. from a botched import) from being smeared across the selection.
    function shift(ll: [number, number]): [number, number] {
      if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return ll;
      return [ll[0] + dLat, ll[1] + dLng];
    }
    setProject({
      ...project,
      sources: project.sources.map((s) =>
        selectedIds.has(s.id) ? { ...s, latLng: shift(s.latLng) } : s,
      ),
      receivers: project.receivers.map((r) =>
        selectedIds.has(r.id) ? { ...r, latLng: shift(r.latLng) } : r,
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
  /// Bulk-delete the current selection. No confirmation — the action is
  /// undo-able via Ctrl+Z, and confirmations get in the way of fast
  /// iteration. Cleans up dangling group memberships and drops emptied groups.
  function bulkDeleteSelected() {
    if (!project || selectedIds.size === 0) return;
    setProject({
      ...project,
      sources: project.sources.filter((s) => !selectedIds.has(s.id)),
      receivers: project.receivers.filter((r) => !selectedIds.has(r.id)),
      barriers: project.barriers.filter((b) => !selectedIds.has(b.id)),
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

  // dB colormap domain. `contourBounds` (Min/Max in the Layers tab → Contours)
  // is the single source of truth for both the contour line thresholds and
  // the filled-grid colour scale — editing it updates everything together.
  // The "Auto-fit" button below copies the current grid's measured range
  // into contourBounds; until pressed, the user's manual edits are honoured.
  const dbDomain = useMemo(
    () => ({ min: contourBounds.min, max: contourBounds.max }),
    [contourBounds.min, contourBounds.max],
  );

  /// Replace contourBounds with the grid's actual measured range, snapped
  /// to multiples of 5 dB for cleaner band boundaries. Wired to the
  /// "Auto-fit" button in the Layers tab.
  function autoFitContourBoundsToGrid() {
    const target = grid ? gridDomain(grid.dbA) : null;
    if (target && Number.isFinite(target.min) && Number.isFinite(target.max)) {
      setContourBounds({
        min: Math.floor(target.min / 5) * 5,
        max: Math.ceil(target.max / 5) * 5,
        step: contourBounds.step,
      });
      return;
    }
    // No grid yet — fall back to the receiver point cloud's range.
    if (results && results.length > 0) {
      let mn = Infinity, mx = -Infinity;
      for (const r of results) {
        if (!isFinite(r.totalDbA)) continue;
        if (r.totalDbA < mn) mn = r.totalDbA;
        if (r.totalDbA > mx) mx = r.totalDbA;
      }
      if (isFinite(mn) && isFinite(mx) && mx > mn) {
        setContourBounds({
          min: Math.floor(mn / 5) * 5,
          max: Math.ceil(mx / 5) * 5,
          step: contourBounds.step,
        });
      }
    }
  }

  if (!project) {
    return <div style={{ padding: 32 }}>Loading…</div>;
  }

  const receiverDbList = (results ?? []).map((r) => r.totalDbA);

  return (
    <div className="workspace">
      <SaveIndicator status={saveStatus} error={saveError} source={projectSource} />
      {remoteUpdate && (
        <div style={{
          position: 'fixed', top: 56, left: '50%', transform: 'translateX(-50%)',
          background: '#fef3c7', color: '#78350f', border: '1px solid #f59e0b',
          padding: '8px 14px', borderRadius: 8, fontSize: 13, zIndex: 9999,
          boxShadow: '0 4px 14px rgba(0,0,0,0.10)', display: 'flex',
          alignItems: 'center', gap: 10,
        }}>
          <span>
            Project was modified by{' '}
            <strong>{remoteUpdate.byDisplayName ?? 'another user'}</strong>{' '}
            at {remoteUpdate.at.toLocaleTimeString()}. Your next save will
            overwrite their changes.
          </span>
          <button
            type="button"
            onClick={dismissRemoteUpdate}
            style={{
              background: 'transparent', border: '1px solid #78350f',
              color: '#78350f', padding: '2px 8px', borderRadius: 4,
              fontSize: 12, cursor: 'pointer',
            }}
          >Dismiss</button>
          <button
            type="button"
            onClick={() => { dismissRemoteUpdate(); window.location.reload(); }}
            style={{
              background: '#78350f', color: '#fff', border: 'none',
              padding: '2px 8px', borderRadius: 4, fontSize: 12, cursor: 'pointer',
            }}
          >Reload</button>
        </div>
      )}
      <ErrorBoundary region="Side panel">
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
        setDem={setDemAndSource}
        demSource={demSource}
        baseMap={baseMap} setBaseMap={setBaseMap}
        showContours={showContours} setShowContours={setShowContours}
        showGridDebug={showGridDebug} setShowGridDebug={setShowGridDebug}
        contourMode={contourMode} setContourMode={setContourMode}
        contourOpacity={contourOpacity} setContourOpacity={setContourOpacity}
        contourStepDb={contourStepDb} setContourStepDb={setContourStepDb}
        contourBounds={contourBounds} setContourBounds={setContourBounds}
        palette={palette} setPalette={setPalette}
        domainMode={domainMode} setDomainMode={setDomainMode}
        fixedDomain={fixedDomain} setFixedDomain={setFixedDomain}
        demStatus={demStatus}
        demTilesLoaded={dem?.tilesLoaded ?? null}
        gridSpacingM={gridSpacingM} setGridSpacingM={setGridSpacingM}
        onAfterImport={fitToBounds}
        onFitCalcAreaToObjects={fitCalcAreaToObjects}
        grid={grid}
        onAutoFitContourBounds={autoFitContourBoundsToGrid}
        projectId={projectId}
        currentUid={currentUid ?? undefined}
        currentDisplayName={authState.profile?.displayName ?? authState.user?.email ?? undefined}
        projectSource={projectSource}
        onApplyVersion={(snap) => {
          // Revert flow: restore the snapshot's *content* but keep the
          // current project's ownership and privacy fields, plus the
          // schema-versioning bookkeeping. Anything else would let an
          // old snapshot resurrect the wrong ownerUid / visibility /
          // allowlist, which would be surprising at best and a
          // privacy regression at worst.
          if (!project) return;
          const merged: Project = {
            ...snap,
            schemaVersion: project.schemaVersion,
            ownerUid: project.ownerUid,
            ownerDisplayName: project.ownerDisplayName,
            visibility: project.visibility,
            allowedUserIds: project.allowedUserIds,
            createdAt: project.createdAt,
            // updatedAt / updatedByUid get set by the Firestore write path.
          };
          setProject(merged);
        }}
      />
      </ErrorBoundary>

      <SidePanelSplitter />

      <div className="map-area">
        <ErrorBoundary region="Map">
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
          showGridDebug={showGridDebug}
          contourMode={contourMode}
          contourOpacity={contourOpacity}
          contourStepDb={contourStepDb}
          palette={palette}
          dbDomain={dbDomain}
          onAddSource={handleAddSource}
          onAddReceiver={handleAddReceiver}
          onAddBarrier={handleAddBarrier}
          onUpdateBarrier={handleUpdateBarrier}
          onMoveSource={handleMoveSource}
          onMoveReceiver={handleMoveReceiver}
          onResizeCalcArea={handleResizeCalcArea}
          onMoveCalcArea={handleMoveCalcArea}
          onCursorMove={setCursorLatLng}
          onReady={(m) => { mapHandleRef.current = m; }}
        />

        <MapControls
          project={project}
          baseMap={baseMap} setBaseMap={setBaseMap}
          onZoomIn={() => mapHandleRef.current?.zoomIn()}
          onZoomOut={() => mapHandleRef.current?.zoomOut()}
          onPan={(dx, dy) => mapHandleRef.current?.panBy([dx, dy], { animate: true })}
          onHome={fitCalcArea}
          onOpen3D={() => setShow3D(true)}
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

        <Legend palette={palette} domain={dbDomain} stepDb={contourStepDb} receiverDb={receiverDbList} />

        {error && <div className="map-toast error">solver error: {error}</div>}
        </ErrorBoundary>
      </div>

      {show3D && (
        <Map3DView
          project={project}
          grid={grid}
          palette={palette}
          dbDomain={dbDomain}
          baseMap={baseMap}
          dem={dem}
          contourStepDb={contourStepDb}
          onClose={() => setShow3D(false)}
        />
      )}
    </div>
  );
}

// Tiny "Saving…" / "Saved" / "Save failed" pill, fixed-positioned in the
// top-right of the workspace so it's always visible without taking up
// chrome real estate. Hidden when there's nothing to report (idle) or
// for legacy local projects (writes are synchronous, no async state to
// surface).
function SaveIndicator({
  status, error, source,
}: {
  status: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  error: string | null;
  source: 'firestore' | 'local' | 'none';
}) {
  if (source !== 'firestore') return null;
  if (status === 'idle') return null;

  const styles: Record<string, { bg: string; fg: string; border: string }> = {
    pending: { bg: '#fef3c7', fg: '#78350f', border: '#f59e0b' },
    saving:  { bg: '#fef3c7', fg: '#78350f', border: '#f59e0b' },
    saved:   { bg: 'rgba(16, 185, 129, 0.12)', fg: '#047857', border: 'rgba(16, 185, 129, 0.4)' },
    error:   { bg: 'rgba(239, 68, 68, 0.10)', fg: '#dc2626', border: 'rgba(239, 68, 68, 0.4)' },
  };
  const s = styles[status];
  const label =
    status === 'pending' ? 'Editing…' :
    status === 'saving'  ? 'Saving…' :
    status === 'saved'   ? 'Saved' :
    'Save failed';

  return (
    <div
      role="status"
      title={status === 'error' && error ? error : undefined}
      style={{
        position: 'fixed', top: 56, right: 16, zIndex: 9998,
        background: s.bg, color: s.fg,
        border: `1px solid ${s.border}`,
        padding: '4px 10px', borderRadius: 999,
        fontSize: 11, fontWeight: 600, letterSpacing: '0.02em',
        boxShadow: '0 2px 6px rgba(0,0,0,0.06)',
        userSelect: 'none', pointerEvents: status === 'error' ? 'auto' : 'none',
      }}
    >
      {label}
    </div>
  );
}
