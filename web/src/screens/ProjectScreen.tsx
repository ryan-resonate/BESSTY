import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import L from 'leaflet';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { MapView, type BaseMap, type ContourMode } from '../components/MapView';
import { Map3DView } from '../components/Map3DView';
import { MapControls } from '../components/MapControls';
import { SettingsWindow } from '../components/SettingsWindow';
import { PdfExportDialog } from '../components/PdfExportDialog';
import { FactorialStudy } from '../components/FactorialStudy';
import { attributionFor, tileUrlFor } from '../components/MapView';
import { Legend, ResultsDock, StatusBar } from '../components/MapChrome';
import { SidePanel, type AddMode, type Tab } from '../components/SidePanel';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { gridDomain, type Palette } from '../lib/colormap';
import { loadDemForBounds, type DemRaster } from '../lib/dem';
import {
  evaluateGridViaWorker,
  cancelGridRun,
  evaluateProject,
  SOLVE_SUPERSEDED,
  type GridResult,
  type ReceiverResult,
} from '../lib/solver';
import { useAuthState } from '../lib/auth';
import { useProjectDoc } from '../lib/useProjectDoc';
import { parseDemGeoTiff } from '../lib/demUpload';
import { downloadProjectDem } from '../lib/firestoreStorage';
import { BessGroupWizard } from '../components/BessGroupWizard';
import {
  materialiseBessGroup,
  withGroupSources,
  withoutGroupSources,
  type CatalogLookup,
} from '../lib/bessGroups';
import type { BessGroup } from '../lib/types';
import type { Barrier, Project, Receiver, Source, SourceKind } from '../lib/types';
import { settingsOf } from '../lib/types';
import { calcAreaCorners } from '../lib/geo';
import { pushEscHandler } from '../lib/escStack';
import { Diagnostics, type Diagnostic } from '../lib/diagnostics';
import {
  buildEnvelope, describePaste as describeObjectPaste, materialisePaste, parseEnvelope,
} from '../lib/clipboardObjects';
import { notify } from '../lib/notify';
import { applyPatchWithGroupOverrides } from '../lib/groupOverrides';

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
    remoteRevision,
    dismissRemoteUpdate,
  } = useProjectDoc(projectId, currentUid);
  const [project, setProjectState] = useState<Project | null>(null);
  const [results, setResults] = useState<ReceiverResult[] | null>(null);
  /// I20: approximations applied by the last solve, surfaced in the dock.
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [grid, setGrid] = useState<GridResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [gridStatus, setGridStatus] = useState<'idle' | 'computing' | 'ready'>('idle');
  /// I12: live tile progress for the running grid solve, or null when idle.
  const [gridProgress, setGridProgress] = useState<{ done: number; total: number } | null>(null);
  const [lastSolveMs, setLastSolveMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Selection model. `selectedIds` is the set of currently-selected source
  // and receiver IDs (mixed kinds allowed). `selectedGroupId` is non-null
  // when a saved group is the active selection.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState<AddMode>('none');
  const [show3D, setShow3D] = useState(false);
  /// I10: floating settings window.
  const [showSettings, setShowSettings] = useState(false);
  /// I15: PDF export dialog. Holds the extent captured when it opened — the
  /// export is a snapshot, so it must not follow the map if it moves behind
  /// the dialog.
  const [showStudy, setShowStudy] = useState(false);
  const [pdfExtent, setPdfExtent] = useState<{ sw: [number, number]; ne: [number, number] } | null>(null);

  function openPdfExport() {
    const map = mapHandleRef.current;
    if (!map) return;
    const b = map.getBounds();
    setPdfExtent({
      sw: [b.getSouth(), b.getWest()],
      ne: [b.getNorth(), b.getEast()],
    });
  }
  /// Active tab — lifted into ProjectScreen so placing a new object can
  /// auto-switch the panel to Sources / Receivers.
  const [activeTab, setActiveTab] = useState<Tab>('sources');

  // Esc cancels any active add / measure mode AND clears the current
  // selection so the user is back to the default mouse cursor with no
  // sticky multi-selection. Skipped when focus is in a text field — Esc
  // there usually means "abandon edit", not "drop selection on the map".
  // Bottom of the Escape stack: exiting add-mode / clearing the selection is
  // what Esc means only when no overlay is open above the map. Registered on
  // mount, so every window and dialog mounted later sits above it.
  useEffect(() => pushEscHandler(() => {
    setAddMode('none');
    setSelectedIds(new Set());
    setSelectedGroupId(null);
  }), []);

  // I5 — Ctrl/Cmd+C / Ctrl/Cmd+V for map objects. Same skip-when-in-a-text-field
  // rule as Esc above: copying text out of an input must keep working.
  //
  // The clipboard carries a JSON envelope, so copy in one project and paste in
  // another (or another tab) works without any shared state. `clipboardFallback`
  // covers browsers/contexts where the Clipboard API is denied.
  const clipboardFallbackRef = useRef<string | null>(null);
  // Mirrored so the (once-mounted) key handler reads current values without
  // re-subscribing on every selection or mouse move.
  const selectedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  // The cursor position updates at rAF rate on every map mousemove. As
  // ProjectScreen state it re-rendered the WHOLE tree — side panel included —
  // for a six-character coordinate label, which is why merely moving the mouse
  // across the map cost frames. It lives in a ref now; StatusBar subscribes
  // and re-renders alone.
  const cursorLatLngRef = useRef<[number, number] | null>(null);
  const cursorListenerRef = useRef<((ll: [number, number] | null) => void) | null>(null);
  const handleCursorMove = useCallback((ll: [number, number] | null) => {
    cursorLatLngRef.current = ll;
    cursorListenerRef.current?.(ll);
  }, []);
  const subscribeCursor = useCallback((cb: (ll: [number, number] | null) => void) => {
    cursorListenerRef.current = cb;
    cb(cursorLatLngRef.current);
    return () => { if (cursorListenerRef.current === cb) cursorListenerRef.current = null; };
  }, []);
  /// Latest-closure mirror of `setProject` for the `[]`-deps clipboard effect
  /// below. That effect captured the FIRST render's `setProject`, whose
  /// closure still saw `project === null` — so a paste applied its content
  /// (the state setter is stable) but never pushed an undo step, and one
  /// Ctrl+Z after a paste jumped back two conceptual edits.
  const setProjectRef = useRef<(p: Project) => void>(() => {});
  useEffect(() => {
    async function onKey(ev: KeyboardEvent) {
      if (!(ev.ctrlKey || ev.metaKey)) return;
      const k = ev.key.toLowerCase();
      if (k !== 'c' && k !== 'v') return;
      const t = ev.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;

      const p = projectRef.current;
      if (!p) return;

      if (k === 'c') {
        const env = buildEnvelope(p, {
          sourceIds: selectedIdsRef.current,
          receiverIds: selectedIdsRef.current,
          barrierIds: selectedIdsRef.current,
        });
        if (!env) return;
        ev.preventDefault();
        const text = JSON.stringify(env);
        clipboardFallbackRef.current = text;
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Denied (insecure context, permissions) — the in-memory buffer still
          // makes same-tab paste work, so say what was lost rather than failing.
          notify.info('Copied within this tab (clipboard access was denied, so '
            + 'pasting into another tab won\'t work).');
          return;
        }
        const n = env.objects.sources.length + env.objects.receivers.length
          + env.objects.barriers.length;
        notify.success(`Copied ${n} object${n === 1 ? '' : 's'}.`);
        return;
      }

      // Paste.
      ev.preventDefault();
      let text: string | null = null;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        text = clipboardFallbackRef.current;
      }
      const env = text ? parseEnvelope(text) : null;
      // Not our content (a spreadsheet cell, a URL) — silently do nothing.
      if (!env) return;
      // Cursor outside the map (or never moved) → fall back to the calc-area
      // centre, then to the copied set's own origin so paste never silently
      // does nothing.
      const anchor = cursorLatLngRef.current
        ?? p.calculationArea?.centerLatLng
        ?? env.origin;
      const out = materialisePaste(env, anchor, newId);
      setProjectRef.current({
        ...p,
        sources: [...p.sources, ...out.sources],
        receivers: [...p.receivers, ...out.receivers],
        barriers: [...(p.barriers ?? []), ...out.barriers],
        bessGroups: [...(p.bessGroups ?? []), ...out.bessGroups],
      });
      setSelectedIds(new Set(out.newIds));
      notify.success(describeObjectPaste(out));
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /// I7 - commit a calc-area drag or rotation. One patch because a corner drag
  /// anchors the opposite corner, which moves the centre as well as resizing.
  function handleEditCalcArea(patch: {
    centerLatLng: [number, number]; widthM: number; heightM: number; rotationDeg: number;
  }) {
    if (!project?.calculationArea) return;
    const before = project.calculationArea;
    setProject({
      ...project,
      calculationArea: { ...before, ...patch },
    });
    // If the area MOVED or RESIZED the DEM may no longer cover it, so reset to
    // 'idle' and let the auto-fetcher re-run — without this the grid keeps
    // solving against the OLD raster, silently, because a DEM miss substitutes
    // ground = 0 rather than erroring. A pure ROTATION is exempt: the fetch
    // bounds come from centre + width/height only, so a refetch would download
    // the identical raster — and since this fires on every handle release, the
    // needless refetch made adjusting the rectangle feel sluggish.
    const movedM = 111_320 * Math.hypot(
      patch.centerLatLng[0] - before.centerLatLng[0],
      (patch.centerLatLng[1] - before.centerLatLng[1])
        * Math.cos((before.centerLatLng[0] * Math.PI) / 180),
    );
    const resized = Math.abs(patch.widthM - before.widthM) > 0.5
      || Math.abs(patch.heightM - before.heightM) > 0.5;
    // demStatus 'error' always retries: after a failed load, nudging the
    // rectangle is the natural "kick it" gesture, and failed tiles are no
    // longer negatively cached (dem.ts), so the retry can actually succeed.
    if (movedM > 0.5 || resized || demStatus === 'error') setDemStatus('idle');
  }

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

  // ===== Display settings (I19) =====
  //
  // One object rather than a dozen useStates, persisted on the project so a
  // reload — or a colleague opening it — restores the same view. Defaults
  // below are what a project with no saved display block opens on, which is
  // also where I8's lines-only contour default lives.
  //
  // Deliberately NOT routed through `setProject`: that pushes onto the undo
  // stack, so dragging the opacity slider would bury 50 real edits and make
  // Ctrl+Z undo a palette change. `setProjectQuiet` persists (debounced 800 ms
  // by useProjectDoc) without touching history.
  const DEFAULT_DISPLAY = {
    baseMap: 'satellite' as BaseMap,
    showContours: true,
    contourMode: 'lines' as ContourMode,   // I8
    contourOpacity: 0.7,
    contourStepDb: 5,
    contourBounds: { min: 25, max: 60, step: 5 },
    palette: 'viridis' as Palette,
    domainMode: 'auto' as 'auto' | 'fixed',
    fixedDomain: { min: 25, max: 60 },
    showReceiverLimits: false,             // I1
    gridSpacingM: 100,
    gridSpacingTouched: false,
  };
  type DisplayState = typeof DEFAULT_DISPLAY;
  const [display, setDisplayState] = useState<DisplayState>(DEFAULT_DISPLAY);
  // Mirror in a ref so `patchDisplay` composes correctly when two settings are
  // changed in the same tick (e.g. auto-fit writes bounds + domain together).
  const displayRef = useRef<DisplayState>(DEFAULT_DISPLAY);
  // Mirrored in an effect rather than assigned during render — a render that
  // React discards must not leave a ref pointing at state that never committed.
  const projectRef = useRef<Project | null>(null);
  useEffect(() => { projectRef.current = project; }, [project]);

  function patchDisplay(p: Partial<DisplayState>) {
    const next = { ...displayRef.current, ...p };
    displayRef.current = next;
    setDisplayState(next);
    const cur = projectRef.current;
    if (cur) {
      setProjectQuiet({ ...cur, settings: { ...settingsOf(cur), display: next } });
    }
  }

  // Same names the rest of the screen already uses, so nothing downstream
  // changes shape.
  const { baseMap, showContours, contourMode, contourOpacity, contourStepDb,
    contourBounds, palette, domainMode, fixedDomain, showReceiverLimits,
    gridSpacingM } = display;
  const setBaseMap = (v: BaseMap) => patchDisplay({ baseMap: v });
  const setShowContours = (v: boolean) => patchDisplay({ showContours: v });
  const setContourMode = (v: ContourMode) => patchDisplay({ contourMode: v });
  const setContourOpacity = (v: number) => patchDisplay({ contourOpacity: v });
  const setContourStepDb = (v: number) => patchDisplay({ contourStepDb: v });
  const setContourBounds = (v: { min: number; max: number; step: number }) =>
    patchDisplay({ contourBounds: v });
  const setPalette = (v: Palette) => patchDisplay({ palette: v });
  const setDomainMode = (v: 'auto' | 'fixed') => patchDisplay({ domainMode: v });
  const setFixedDomain = (v: { min: number; max: number }) => patchDisplay({ fixedDomain: v });
  const setShowReceiverLimits = (v: boolean) => patchDisplay({ showReceiverLimits: v });

  // Diagnostic only — never persisted (a project reopening covered in pink
  // dots looks broken).
  const [showGridDebug, setShowGridDebug] = useState(false);
  /// Item I — Barnes-Hut clustering overlay. Session-only, like the grid-cell
  /// debug layer: a diagnostic, not a view preference worth persisting.
  const [showBhDebug, setShowBhDebug] = useState(false);

  // Grid spacing — auto-picked from the calc area on first appearance,
  // then frozen against the user's choice once they touch the picker.
  // Available choices live in `GRID_SPACING_CHOICES` (SidePanel) — pick
  // the smallest one that keeps cells per axis ≤ AUTO_TARGET_CELLS so
  // contours stay smooth on a typical 5–10 km wind farm. The touched flag
  // persists too, or reopening would auto-pick over a deliberate choice.
  // Declared before the auto-pick effect so it's refreshed first on each commit.
  const gridSpacingTouchedRef = useRef(false);
  useEffect(() => {
    gridSpacingTouchedRef.current = display.gridSpacingTouched;
  }, [display.gridSpacingTouched]);
  function setGridSpacingM(v: number) {
    patchDisplay({ gridSpacingM: v, gridSpacingTouched: true });
  }
  function setGridSpacingMState(v: number) {   // auto-pick path — not a user choice
    patchDisplay({ gridSpacingM: v });
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

  // BESS-group wizard state. `null` = closed; otherwise editing or
  // creating. The wizard owns its own form state; we just hand it the
  // group to edit (or undefined for create) and receive the result on
  // Apply.
  const [bessWizard, setBessWizard] = useState<{ group?: BessGroup } | null>(null);

  // Catalog lookup adapter for the BESS-group materialiser. Resolves a
  // (scope, modelId) pair using the live caches via listEntriesByKind
  // -- the wizard preview re-runs whenever the user changes a row, so
  // an eagerly-resolved snapshot at component mount would go stale.
  const catalogLookup: CatalogLookup = useCallback((scope, modelId) => {
    if (!project) return null;
    return listEntriesByKind(project, 'bess').find((e) => e._scope === scope && e.id === modelId)
        ?? listEntriesByKind(project, 'auxiliary').find((e) => e._scope === scope && e.id === modelId)
        ?? listEntriesByKind(project, 'wtg').find((e) => e._scope === scope && e.id === modelId)
        ?? null;
  }, [project]);

  function openBessGroupWizard(group?: BessGroup) {
    setBessWizard({ group });
  }
  function closeBessGroupWizard() {
    setBessWizard(null);
  }
  function applyBessGroupFromWizard(updated: BessGroup) {
    if (!project) return;
    const materialised = materialiseBessGroup(updated, catalogLookup);
    // Re-save the group with the (possibly updated) unitOverrides;
    // splice the fresh materialised sources into project.sources,
    // replacing any existing children of this group.
    const existingGroups = project.bessGroups ?? [];
    const idx = existingGroups.findIndex((g) => g.id === updated.id);
    const nextGroups = idx >= 0
      ? existingGroups.map((g, i) => i === idx ? updated : g)
      : [...existingGroups, updated];
    const nextSources = withGroupSources(project.sources, updated.id, materialised.sources);
    setProject({
      ...project,
      bessGroups: nextGroups,
      sources: nextSources,
    });
    setBessWizard(null);
  }
  function deleteBessGroup(groupId: string) {
    if (!project) return;
    setProject({
      ...project,
      bessGroups: (project.bessGroups ?? []).filter((g) => g.id !== groupId),
      sources: withoutGroupSources(project.sources, groupId),
    });
  }
  /// Centre-handle drag from the on-map overlay: rewrite the group's
  /// centerLatLng and re-materialise.
  function moveBessGroup(groupId: string, newCentre: [number, number]) {
    if (!project) return;
    const groups = project.bessGroups ?? [];
    const next = groups.map((g) =>
      g.id === groupId ? { ...g, centerLatLng: newCentre } : g,
    );
    const moved = next.find((g) => g.id === groupId);
    if (!moved) return;
    const mat = materialiseBessGroup(moved, catalogLookup);
    setProject({
      ...project,
      bessGroups: next,
      sources: withGroupSources(project.sources, groupId, mat.sources),
    });
  }
  /// Rotation-handle drag from the on-map overlay: rewrite the
  /// group's rotationDeg and re-materialise.
  function rotateBessGroup(groupId: string, newRotationDeg: number) {
    if (!project) return;
    const groups = project.bessGroups ?? [];
    const next = groups.map((g) =>
      g.id === groupId ? { ...g, rotationDeg: newRotationDeg } : g,
    );
    const rotated = next.find((g) => g.id === groupId);
    if (!rotated) return;
    const mat = materialiseBessGroup(rotated, catalogLookup);
    setProject({
      ...project,
      bessGroups: next,
      sources: withGroupSources(project.sources, groupId, mat.sources),
    });
  }

  /// General-group centre-handle drag: translate every member (sources +
  /// receivers) by a lat/lng delta. Unlike BESS groups these have no
  /// parametric recipe — we move the stored positions directly.
  function translateGroup(groupId: string, dLat: number, dLng: number) {
    if (!project) return;
    const group = (project.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    const ids = new Set(group.memberIds);
    setProject({
      ...project,
      sources: project.sources.map((s) =>
        ids.has(s.id) ? { ...s, latLng: [s.latLng[0] + dLat, s.latLng[1] + dLng] as [number, number] } : s),
      receivers: project.receivers.map((r) =>
        ids.has(r.id) ? { ...r, latLng: [r.latLng[0] + dLat, r.latLng[1] + dLng] as [number, number] } : r),
    });
  }

  /// General-group rotation-handle drag: rotate every member about the group's
  /// centroid by an incremental angle (deg clockwise from north — same screen-
  /// clockwise convention the map overlay previewed).
  function rotateGroup(groupId: string, deltaDeg: number) {
    if (!project) return;
    const group = (project.groups ?? []).find((g) => g.id === groupId);
    if (!group) return;
    const ids = new Set(group.memberIds);
    const pts: Array<[number, number]> = [];
    for (const s of project.sources) if (ids.has(s.id)) pts.push(s.latLng);
    for (const r of project.receivers) if (ids.has(r.id)) pts.push(r.latLng);
    if (pts.length === 0) return;
    const cLat = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cLng = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const R = 6371008.8;
    const cosLat = Math.cos((cLat * Math.PI) / 180);
    const rad = (deltaDeg * Math.PI) / 180;
    const cosD = Math.cos(rad), sinD = Math.sin(rad);
    const rot = (ll: [number, number]): [number, number] => {
      const lx = (ll[1] - cLng) * (Math.PI / 180) * R * cosLat;
      const ly = -(ll[0] - cLat) * (Math.PI / 180) * R;
      const rx = lx * cosD - ly * sinD;
      const ry = lx * sinD + ly * cosD;
      return [cLat + (-ry / R) * (180 / Math.PI), cLng + (rx / (R * cosLat)) * (180 / Math.PI)];
    };
    setProject({
      ...project,
      sources: project.sources.map((s) => (ids.has(s.id) ? { ...s, latLng: rot(s.latLng) } : s)),
      receivers: project.receivers.map((r) => (ids.has(r.id) ? { ...r, latLng: rot(r.latLng) } : r)),
    });
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

  // Mirrors `grid != null` so the structural-change effect can tell whether a
  // contour grid is currently on screen WITHOUT taking `grid` as a dependency
  // (which would re-fire the effect on every recompute). Lets a shown grid
  // recompute when barriers/settings/sources change.
  const gridShownRef = useRef(false);
  useEffect(() => { gridShownRef.current = grid != null; }, [grid]);
  // Generation counters: each new solve request bumps these. When an async
  // result comes back we discard it if a newer request has fired in the
  // meantime — stops a slow run from clobbering the latest geometry.
  const pointGenRef = useRef(0);
  const gridGenRef = useRef(0);

  // Sync persisted project (from the hook) into the editor's working
  // state. Fires on initial load and on remote collaborator updates that
  // arrived while we had no unsaved local changes (the hook's banner
  // path catches the conflict case). Resets undo history on every load
  // so the user can't undo their way back to "the previous user's edit".
  const hydratedRevRef = useRef(-1);
  useEffect(() => {
    if (persistedProject) {
      // `persistedProject` changes identity on EVERY local edit — the hook
      // mirrors our own `persistProject` writes straight back out — not just
      // on loads. Hydrating on each edit re-sanitised the project, re-
      // materialised every BESS group, re-rendered the map layers a second
      // time, and (the Ctrl+Z killer) wiped the undo stacks immediately after
      // every push onto them. Only a genuine load — initial open or a remote
      // collaborator's write — bumps `remoteRevision`, so that gates it.
      if (hydratedRevRef.current === remoteRevision) return;
      hydratedRevRef.current = remoteRevision;
      // Sanitize on load: any NaN that was previously saved (from a botched
      // import in an older build) gets repaired before it hits the UI.
      const sanitised = sanitizeProject(persistedProject);
      // Backfill: re-materialise every BESS group so source names that
      // were saved under the pre-fa0ef09 convention (which leaked the
      // internal slotKey, e.g. "New BESS group q0-r0-c0-k0-s...") are
      // refreshed in-place with the current "<group> — <KIND> <n>"
      // display name. Cheap — materialiseBessGroup is pure and runs in
      // sub-ms for realistic group sizes; per-unit overrides
      // (latLngDelta, mode/elevation) are preserved because the
      // materialiser reads them from group.unitOverrides on every run.
      // The refreshed names appear immediately in the UI and persist on
      // the user's next save (no extra write here so we don't spam
      // Firestore on every project open).
      const loadLookup: CatalogLookup = (scope, modelId) =>
        listEntriesByKind(sanitised, 'bess').find((e) => e._scope === scope && e.id === modelId)
          ?? listEntriesByKind(sanitised, 'auxiliary').find((e) => e._scope === scope && e.id === modelId)
          ?? listEntriesByKind(sanitised, 'wtg').find((e) => e._scope === scope && e.id === modelId)
          ?? null;
      let nextSources = sanitised.sources;
      for (const g of sanitised.bessGroups ?? []) {
        const mat = materialiseBessGroup(g, loadLookup);
        nextSources = withGroupSources(nextSources, g.id, mat.sources);
      }
      setProjectState({ ...sanitised, sources: nextSources });
      // I19: restore the saved view. Merged over the defaults so a project
      // saved before this existed — or one saved by an older build missing a
      // field — opens on today's defaults for anything absent.
      const saved = sanitised.settings?.display;
      if (saved) {
        const merged = { ...DEFAULT_DISPLAY, ...saved } as DisplayState;
        displayRef.current = merged;
        setDisplayState(merged);
      }
      undoStackRef.current = [];
      redoStackRef.current = [];
    }
  }, [persistedProject, remoteRevision]);

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

  // Keep the clipboard effect's mirror pointing at THIS render's closure.
  useEffect(() => { setProjectRef.current = setProject; });

  /// Undo/redo restore helper. Display prefs (opacity, palette, layer
  /// toggles) are deliberately not undo steps, but every snapshot embeds the
  /// display it was taken with — restoring one verbatim would silently revert
  /// the SAVED display while the screen keeps showing the live value, and the
  /// project would reopen with stale prefs. Graft the live display on top of
  /// whatever is restored.
  function withCurrentDisplay(p: Project): Project {
    return { ...p, settings: { ...settingsOf(p), display: displayRef.current } };
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
          setProjectQuiet(withCurrentDisplay(next));
        } else {
          // Undo
          const prev = undoStackRef.current.pop();
          if (!prev || !project) return;
          redoStackRef.current.push(project);
          setProjectQuiet(withCurrentDisplay(prev));
        }
      } else if (cmd && (ev.key === 'y' || ev.key === 'Y')) {
        ev.preventDefault();
        const next = redoStackRef.current.pop();
        if (!next || !project) return;
        undoStackRef.current.push(project);
        setProjectQuiet(withCurrentDisplay(next));
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
    // The fetch box has to be the AXIS-ALIGNED bounds of the (possibly rotated)
    // rectangle. Deriving it from width/height alone described the unrotated
    // box, so a rotated calculation area had corners outside the downloaded
    // tiles — and a DEM miss returns 0 m rather than erroring, so those corners
    // silently solved against sea level. `calcAreaCorners` already computes the
    // rotated corners for the PDF; reuse it rather than repeat the maths.
    const corners = calcAreaCorners(ca);
    const lats = corners.map((c) => c[0]);
    const lngs = corners.map((c) => c[1]);
    const sw: [number, number] = [Math.min(...lats), Math.min(...lngs)];
    const ne: [number, number] = [Math.max(...lats), Math.max(...lngs)];
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
      // Topography (ridge sampling / prominence / despike) feeds the grid via
      // cellTopoPack, so a change to these controls must re-run the contour
      // grid — without this the grid silently keeps the old terrain screening.
      topography: project.settings?.topography,
      meteorology: project.settings?.meteorology,
      gridReceiverHeight: project.settings?.general.defaultReceiverHeight,
      calc: project.calculationArea,
      gridSpacingM,
      dem: demFingerprint(dem),
    });
  }, [project, dem, gridSpacingM]);

  // Source-position key: every named source's rounded lat/lng. A drag changes
  // this; the structural keys above deliberately exclude positions, so this is
  // what makes a *settled* drag re-solve the points + grid.
  const sourcePosKey = useMemo(() => {
    if (!project) return '';
    return project.sources.map((s) => `${s.id}:${s.latLng[0].toFixed(6)},${s.latLng[1].toFixed(6)}`).join('|');
  }, [project]);

  // Point-receiver solve — re-runs on any structural change OR a settled source
  // drag. Primal (exact); the solve is fast enough to recompute directly, so
  // there's no snapshot / Taylor-extrapolation layer anymore.
  useEffect(() => {
    if (!project) return;
    setComputing(true);
    setError(null);
    const start = performance.now();
    const handle = setTimeout(() => {
      const gen = ++pointGenRef.current;
      const diag = new Diagnostics();
      evaluateProject(project, dem, diag)
        .then((results) => {
          if (gen !== pointGenRef.current) return;       // superseded
          setResults(results);
          setDiagnostics(diag.list());                   // I20
          setLastSolveMs(performance.now() - start);
        })
        .catch((e) => {
          // A superseded solve is the normal case when edits arrive faster than
          // the solve completes (P1 kills the stale worker job) — not an error
          // to show the user.
          if (gen !== pointGenRef.current) return;
          if (String((e as Error)?.message ?? e).includes(SOLVE_SUPERSEDED)) return;
          setError(String(e));
        })
        .finally(() => { if (gen === pointGenRef.current) setComputing(false); });
    }, 80);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointStructuralKey, sourcePosKey]);

  // Contour-grid recompute on any grid-relevant change OR a settled source
  // drag — but only when a grid is already on screen. Always the primal
  // per-tile worker path. 600 ms debounce (vs 80 ms for points) so a burst of
  // nudges coalesces into one regrid — the grid is the heavy solve. Receivers
  // never trigger this.
  //
  // This used to run SILENTLY (no status, no progress) and never superseded
  // the worker: the single grid worker queues jobs, so consecutive settled
  // drags stacked multi-second solves back to back while the UI chewed a core
  // with no explanation — the reported "moving things while solving a grid"
  // jank. The worker layer now terminates the stale job when a new one posts
  // (newest geometry wins), and this path drives the same status + progress
  // surface as a manual run so the recompute is visible and cancellable.
  useEffect(() => {
    if (!project || !gridShownRef.current) return;
    const handle = setTimeout(() => {
      const gen = ++gridGenRef.current;
      const height = project.settings?.general.defaultReceiverHeight ?? 1.5;
      setGridStatus('computing');
      setGridProgress(null);
      evaluateGridViaWorker(project, dem, gridSpacingM, height, (done, total) => {
        if (gen === gridGenRef.current) setGridProgress({ done, total });
      })
        .then((g) => {
          if (gen !== gridGenRef.current) return;        // superseded
          setGrid(g);
          setGridStatus('ready');
          setGridProgress(null);
        })
        .catch((e) => {
          if (gen !== gridGenRef.current) return;        // superseded / cancelled
          console.warn('grid recompute failed:', e);
          // Keep the stale grid on screen rather than wedging in 'computing'.
          setGridStatus('ready');
          setGridProgress(null);
        });
    }, 600);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridStructuralKey, sourcePosKey]);

  function runGrid() {
    if (!project) return;
    setGridStatus('computing');
    setGridProgress(null);
    const heightAbove = project.settings?.general.defaultReceiverHeight ?? 1.5;
    // Primal, per-tile clustered, on the Web Worker.
    setTimeout(() => {
      const gen = ++gridGenRef.current;
      const gridDiag = new Diagnostics();
      evaluateGridViaWorker(project, dem, gridSpacingM, heightAbove, (done, total) => {
        // Late progress from a superseded or cancelled run must not resurrect
        // the progress bar.
        if (gen === gridGenRef.current) setGridProgress({ done, total });
      }, gridDiag)
        .then((g) => {
          if (gen !== gridGenRef.current) return;
          setGrid(g);
          setGridStatus('ready');
          setGridProgress(null);
          // I20: fold the grid's approximations in beside the receiver solve's,
          // deduped by code — the two paths share several caps.
          setDiagnostics((prev) => {
            const merged = new Diagnostics();
            merged.merge(prev);
            merged.merge(gridDiag);
            return merged.list();
          });
        })
        .catch((e) => {
          if (gen !== gridGenRef.current) return;   // cancelled / superseded
          setError(String(e));
          setGridStatus('idle');
          setGridProgress(null);
        });
    }, 0);
  }

  /// I12 — kill the running grid. Bumping the generation makes the in-flight
  /// promise's handlers no-ops, so the terminated worker's rejection is
  /// swallowed rather than surfacing as an error the user didn't cause.
  function cancelGrid() {
    gridGenRef.current++;
    cancelGridRun();
    setGridStatus('idle');
    setGridProgress(null);
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

  function handleAddBarrierPolyline(polyline: Array<[number, number]>) {
    if (!project) return;
    if (polyline.length < 2) return;
    for (const [la, ln] of polyline) {
      if (!Number.isFinite(la) || !Number.isFinite(ln)) return;
    }
    const id = newId('B');
    const newBarrier: Barrier = {
      id,
      name: `Barrier ${project.barriers.length + 1}`,
      type: 'wall',
      polylineLatLng: polyline,
      topHeightsM: [5],         // sensible default; user edits in the Barriers tab
      baseFromGroundM: 0,
      surfaceDensityKgM2: 20,   // reflective wall — only matters when reflections land
      absorptionCoeff: 0.1,
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

  function handleMoveSource(id: string, latLng: [number, number]) {
    // BESS-group members need extra bookkeeping: shifting the source's
    // latLng alone is fine for the immediate render, but the next
    // materialise call (wizard apply, rotation drag, parameter edit)
    // would snap the unit back to its parametric position. We persist
    // the drag by accumulating into group.unitOverrides[slotKey]
    // .latLngDelta -- which the materialiser then re-applies on every
    // subsequent regeneration. handleMoveObject still runs so the
    // immediate UI / solver state updates without waiting for the
    // next materialise.
    if (!project) { handleMoveObject(id, latLng); return; }
    const src = project.sources.find((s) => s.id === id);
    if (!src?.groupId || !src.slotKey) {
      handleMoveObject(id, latLng);
      return;
    }
    const group = (project.bessGroups ?? []).find((g) => g.id === src.groupId);
    if (!group) { handleMoveObject(id, latLng); return; }
    // Delta from the CURRENT latLng (which already reflects any prior
    // accumulated drag) to the NEW latLng -- this is the incremental
    // shift to add on top of the existing override.
    const incLat = latLng[0] - src.latLng[0];
    const incLng = latLng[1] - src.latLng[1];
    const prior = group.unitOverrides?.[src.slotKey]?.latLngDelta ?? [0, 0];
    const nextDelta: [number, number] = [prior[0] + incLat, prior[1] + incLng];
    const nextOverrides = {
      ...(group.unitOverrides ?? {}),
      [src.slotKey]: {
        ...(group.unitOverrides?.[src.slotKey] ?? {}),
        latLngDelta: nextDelta,
      },
    };
    const nextGroups = (project.bessGroups ?? []).map((g) =>
      g.id === group.id ? { ...g, unitOverrides: nextOverrides } : g,
    );
    // Apply the source latLng update AND the group override together
    // in a single setProject so we don't race a snapshot recompute.
    setProject({
      ...project,
      sources: project.sources.map((s) => (s.id === id ? { ...s, latLng } : s)),
      bessGroups: nextGroups,
    });
  }
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
    // I4: group members record the edit as a per-unit override too, or the next
    // re-materialisation discards it.
    setProject(applyPatchWithGroupOverrides(project, [...selectedIds], patch));
  }
  /// Bulk-update a property on a SUBSET of sources (by id). Powers the
  /// per-kind/per-model bulk editor, where a mixed selection retargets each
  /// type independently (e.g. all BESS → model X, all transformers → model Y).
  function bulkUpdateSourcesByIds(ids: string[], patch: Partial<Source>) {
    if (!project || ids.length === 0) return;
    setProject(applyPatchWithGroupOverrides(project, ids, patch));
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
        onBulkUpdateSourcesByIds={bulkUpdateSourcesByIds}
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
        showBhDebug={showBhDebug} setShowBhDebug={setShowBhDebug}
        onOpenSettings={() => setShowSettings(true)}
        onOpenPdfExport={openPdfExport}
        onOpenStudy={() => setShowStudy(true)}
        showReceiverLimits={showReceiverLimits} setShowReceiverLimits={setShowReceiverLimits}
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
        onOpenBessGroupWizard={openBessGroupWizard}
        onDeleteBessGroup={deleteBessGroup}
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
          showBhDebug={showBhDebug}
          gridSpacingM={gridSpacingM}
          showReceiverLimits={showReceiverLimits}
          contourMode={contourMode}
          contourOpacity={contourOpacity}
          contourStepDb={contourStepDb}
          palette={palette}
          dbDomain={dbDomain}
          onAddSource={handleAddSource}
          onAddReceiver={handleAddReceiver}
          onAddBarrierPolyline={handleAddBarrierPolyline}
          onUpdateBarrier={handleUpdateBarrier}
          onMoveSource={handleMoveSource}
          onMoveReceiver={handleMoveReceiver}
          onEditCalcArea={handleEditCalcArea}
          onCursorMove={handleCursorMove}
          onReady={(m) => { mapHandleRef.current = m; }}
          onOpenBessGroupWizard={openBessGroupWizard}
          onMoveBessGroup={moveBessGroup}
          onRotateBessGroup={rotateBessGroup}
          selectedGroupId={selectedGroupId}
          onTranslateGroup={translateGroup}
          onRotateGroup={rotateGroup}
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

        <StatusBar project={project} selectedIds={selectedIds} subscribeCursor={subscribeCursor} />

        <div className="map-chrome-stack right">
          <ResultsDock
            project={project} results={results} grid={grid}
            computing={computing} lastSolveMs={lastSolveMs}
            gridStatus={gridStatus}
            onRunGrid={runGrid}
            gridProgress={gridProgress}
            onCancelGrid={cancelGrid}
            diagnostics={diagnostics}
          />
        </div>

        <Legend palette={palette} domain={dbDomain} stepDb={contourStepDb} receiverDb={receiverDbList} />

        {error && <div className="map-toast error">solver error: {error}</div>}
        </ErrorBoundary>
      </div>

      {showStudy && (
        <FactorialStudy project={project} dem={dem} onClose={() => setShowStudy(false)} />
      )}

      {pdfExtent && (
        <PdfExportDialog
          project={project}
          results={results}
          grid={grid}
          extent={pdfExtent}
          palette={palette}
          dbDomain={dbDomain}
          contourStepDb={contourStepDb}
          showContours={showContours}
          tileUrl={(z, x, y) => tileUrlFor(baseMap, z, x, y)}
          attribution={attributionFor(baseMap)}
          onClose={() => setPdfExtent(null)}
        />
      )}

      {showSettings && (
        <SettingsWindow
          project={project}
          setProject={setProject}
          gridSpacingM={gridSpacingM}
          setGridSpacingM={setGridSpacingM}
          onClose={() => setShowSettings(false)}
        />
      )}

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

      {bessWizard && (
        <BessGroupWizard
          initialGroup={bessWizard.group}
          newGroupCentre={
            mapHandleRef.current
              ? [mapHandleRef.current.getCenter().lat, mapHandleRef.current.getCenter().lng]
              : (project.calculationArea?.centerLatLng ?? [-25.4, 152.4])
          }
          project={project}
          catalogLookup={catalogLookup}
          onApply={applyBessGroupFromWizard}
          onCancel={closeBessGroupWizard}
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
