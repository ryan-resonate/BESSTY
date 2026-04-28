import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MapView } from '../components/MapView';
import { MapControls } from '../components/MapControls';
import { Legend, ResultsDock, StatusBar } from '../components/MapChrome';
import { SettingsModal } from '../components/SettingsModal';
import { SidePanel } from '../components/SidePanel';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { gridDomain } from '../lib/colormap';
import { loadDemForBounds } from '../lib/dem';
import { extrapolateGrid, extrapolateProject, snapshotGrid, snapshotProject, } from '../lib/solver';
import { loadProject, saveProject } from '../lib/storage';
let nextId = 1000;
function newId(prefix) {
    nextId += 1;
    return `${prefix}-${nextId}`;
}
// Pick a default model when adding a new source: first available entry
// (local catalog first, then global) of that kind.
function defaultModelFor(project, kind) {
    const candidates = listEntriesByKind(project, kind);
    if (candidates.length === 0)
        return null;
    const e = candidates[0];
    return { modelId: e.id, scope: e._scope };
}
export function ProjectScreen() {
    const { projectId } = useParams();
    const navigate = useNavigate();
    const [project, setProjectState] = useState(null);
    const [results, setResults] = useState(null);
    const [grid, setGrid] = useState(null);
    const [computing, setComputing] = useState(false);
    const [gridStatus, setGridStatus] = useState('idle');
    const [lastSolveMs, setLastSolveMs] = useState(null);
    const [error, setError] = useState(null);
    // Selection model. `selectedIds` is the set of currently-selected source
    // and receiver IDs (mixed kinds allowed). `selectedGroupId` is non-null
    // when a saved group is the active selection.
    const [selectedIds, setSelectedIds] = useState(new Set());
    const [selectedGroupId, setSelectedGroupId] = useState(null);
    const [addMode, setAddMode] = useState('none');
    const [showSettings, setShowSettings] = useState(false);
    const [cursorLatLng, setCursorLatLng] = useState(null);
    /// Active tab — lifted into ProjectScreen so placing a new object can
    /// auto-switch the panel to Sources / Receivers.
    const [activeTab, setActiveTab] = useState('sources');
    // Esc cancels any active add / measure mode and clears the current
    // selection so the user is back to the default mouse cursor.
    useEffect(() => {
        function onKey(ev) {
            if (ev.key !== 'Escape')
                return;
            setAddMode('none');
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);
    function selectOne(id) {
        setSelectedIds(id ? new Set([id]) : new Set());
        setSelectedGroupId(null);
    }
    function toggleSelection(id) {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
        setSelectedGroupId(null);
    }
    function selectGroup(groupId) {
        if (!project)
            return;
        const g = (project.groups ?? []).find((x) => x.id === groupId);
        if (!g)
            return;
        setSelectedIds(new Set(g.memberIds));
        setSelectedGroupId(groupId);
    }
    function selectFromMap(id, modifiers) {
        if (modifiers?.shift && id)
            toggleSelection(id);
        else
            selectOne(id);
    }
    function selectFromBox(ids, modifiers) {
        setSelectedGroupId(null);
        setSelectedIds((prev) => {
            const next = modifiers?.shift ? new Set(prev) : new Set();
            for (const id of ids)
                next.add(id);
            return next;
        });
    }
    const [baseMap, setBaseMap] = useState('satellite');
    const [showContours, setShowContours] = useState(true);
    const [contourMode, setContourMode] = useState('both');
    const [contourOpacity, setContourOpacity] = useState(0.7);
    const [contourStepDb, setContourStepDb] = useState(5);
    const [contourBounds, setContourBounds] = useState({ min: 25, max: 60, step: 5 });
    const [palette, setPalette] = useState('viridis');
    const [domainMode, setDomainMode] = useState('auto');
    const [fixedDomain, setFixedDomain] = useState({ min: 25, max: 60 });
    const [gridSpacingM, setGridSpacingM] = useState(100);
    const [dem, setDem] = useState(null);
    const [demStatus, setDemStatus] = useState('idle');
    /// 'auto' = AWS Terrain Tiles fetched on load; 'upload' = user GeoTIFF.
    const [demSource, setDemSource] = useState('auto');
    function setDemAndSource(d, source) {
        setDem(d);
        setDemSource(source);
        if (source === 'auto' && d == null) {
            // Reset request — kick the auto-loader effect by clearing status.
            setDemStatus('idle');
        }
        else if (source === 'upload') {
            setDemStatus('ready');
        }
    }
    // Imperative handle to the Leaflet map for the floating MapControls.
    const mapHandleRef = useRef(null);
    function fitCalcArea() {
        const map = mapHandleRef.current;
        if (!map || !project?.calculationArea)
            return;
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
    // Cached point + grid snapshots (gradients) for fast Taylor extrapolation.
    const pointSnapRef = useRef(null);
    const gridSnapRef = useRef(null);
    // Generation counters: each new snapshot request bumps these. When an
    // async result comes back we discard it if a newer request has fired in
    // the meantime — stops a slow run from clobbering the latest geometry.
    const pointGenRef = useRef(0);
    const gridGenRef = useRef(0);
    // Bumps every time a snapshot is refreshed in the background, so the
    // results-dependent UI re-renders against the new exact values.
    const [, setSnapshotVersion] = useState(0);
    // Load project from storage on mount.
    useEffect(() => {
        if (!projectId)
            return;
        const loaded = loadProject(projectId);
        if (!loaded) {
            navigate('/projects', { replace: true });
            return;
        }
        setProjectState(loaded);
        undoStackRef.current = [];
        redoStackRef.current = [];
    }, [projectId, navigate]);
    // ---------- Undo / redo ----------
    // Push every project mutation onto a 50-deep history stack. Ctrl+Z pops
    // the previous state; Ctrl+Shift+Z (or Ctrl+Y) re-pushes it onto the
    // redo stack. The first setProject call after an undo clears the redo
    // stack — standard editor behaviour.
    const undoStackRef = useRef([]);
    const redoStackRef = useRef([]);
    const UNDO_LIMIT = 50;
    function setProject(p) {
        if (project) {
            undoStackRef.current.push(project);
            if (undoStackRef.current.length > UNDO_LIMIT)
                undoStackRef.current.shift();
            redoStackRef.current = [];
        }
        setProjectState(p);
        if (projectId)
            saveProject(projectId, p);
    }
    /// Replace project state without recording it on the undo stack — used by
    /// undo/redo themselves, and by the project-load effect.
    function setProjectQuiet(p) {
        setProjectState(p);
        if (projectId)
            saveProject(projectId, p);
    }
    useEffect(() => {
        function onKey(ev) {
            // Skip if focus is in an editable element — let the field handle Z/Y itself.
            const t = ev.target;
            if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
                return;
            }
            const cmd = ev.ctrlKey || ev.metaKey;
            if (cmd && (ev.key === 'z' || ev.key === 'Z')) {
                ev.preventDefault();
                if (ev.shiftKey) {
                    // Redo
                    const next = redoStackRef.current.pop();
                    if (!next || !project)
                        return;
                    undoStackRef.current.push(project);
                    setProjectQuiet(next);
                }
                else {
                    // Undo
                    const prev = undoStackRef.current.pop();
                    if (!prev || !project)
                        return;
                    redoStackRef.current.push(project);
                    setProjectQuiet(prev);
                }
            }
            else if (cmd && (ev.key === 'y' || ev.key === 'Y')) {
                ev.preventDefault();
                const next = redoStackRef.current.pop();
                if (!next || !project)
                    return;
                undoStackRef.current.push(project);
                setProjectQuiet(next);
            }
            else if (ev.key === 'Delete' || ev.key === 'Backspace') {
                if (selectedIds.size === 0)
                    return;
                ev.preventDefault();
                bulkDeleteSelected();
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [project, projectId, selectedIds]);
    // Auto-load DEM for the project area on first load. Re-load when the calc
    // area changes significantly (handled via demStatus reset on area edit).
    // Skipped entirely when the user has supplied their own GeoTIFF.
    useEffect(() => {
        if (!project || demStatus !== 'idle' || demSource === 'upload')
            return;
        const ca = project.calculationArea;
        if (!ca)
            return;
        setDemStatus('loading');
        const R = 6371008.8;
        const lat0 = (ca.centerLatLng[0] * Math.PI) / 180;
        const dLat = (ca.heightM / 2 / R) * (180 / Math.PI);
        const dLng = (ca.widthM / 2 / (R * Math.cos(lat0))) * (180 / Math.PI);
        const sw = [ca.centerLatLng[0] - dLat, ca.centerLatLng[1] - dLng];
        const ne = [ca.centerLatLng[0] + dLat, ca.centerLatLng[1] + dLng];
        loadDemForBounds(sw, ne)
            .then((r) => { setDem(r); setDemStatus('ready'); })
            .catch((e) => { console.warn('DEM load failed (continuing flat-ground):', e); setDemStatus('error'); });
    }, [project, demStatus, demSource]);
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
    const pointStructuralKey = useMemo(() => {
        if (!project)
            return '';
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
            hasDem: !!dem,
        });
    }, [project, dem]);
    const gridStructuralKey = useMemo(() => {
        if (!project)
            return '';
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
            hasDem: !!dem,
        });
    }, [project, dem, gridSpacingM]);
    useEffect(() => {
        if (!project)
            return;
        setComputing(true);
        setError(null);
        const start = performance.now();
        const handle = setTimeout(() => {
            const gen = ++pointGenRef.current;
            snapshotProject(project, dem)
                .then(({ results, snapshot }) => {
                if (gen !== pointGenRef.current)
                    return; // superseded
                pointSnapRef.current = snapshot;
                setResults(results);
                setLastSolveMs(performance.now() - start);
                setSnapshotVersion((v) => v + 1);
            })
                .catch((e) => { if (gen === pointGenRef.current)
                setError(String(e)); })
                .finally(() => { if (gen === pointGenRef.current)
                setComputing(false); });
        }, 80);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pointStructuralKey]);
    // Grid re-snapshot on grid-relevant changes only. Receivers don't trigger.
    useEffect(() => {
        if (!project || !gridSnapRef.current)
            return; // no grid → nothing to do
        const handle = setTimeout(() => {
            const gen = ++gridGenRef.current;
            const start = performance.now();
            snapshotGrid(project, dem, gridSpacingM, project.settings?.general.defaultReceiverHeight ?? 1.5)
                .then((s) => {
                if (gen !== gridGenRef.current)
                    return; // superseded
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
        if (!project)
            return '';
        return project.sources.map((s) => `${s.id}:${s.latLng[0].toFixed(6)},${s.latLng[1].toFixed(6)}`).join('|');
    }, [project]);
    // Tracks whether the most recent extrapolation breached the per-band/total
    // dB caps. When set we kick a background re-snapshot to refresh gradients.
    const [snapshotStale, setSnapshotStale] = useState(false);
    useEffect(() => {
        if (!project)
            return;
        let staleHere = false;
        const snap = pointSnapRef.current;
        if (snap) {
            const { results: r, stale } = extrapolateProject(project, snap);
            setResults(r);
            if (stale)
                staleHere = true;
        }
        const gridSnap = gridSnapRef.current;
        if (gridSnap) {
            const { grid: g, stale } = extrapolateGrid(project, gridSnap, dem);
            setGrid(g);
            if (stale)
                staleHere = true;
        }
        if (staleHere)
            setSnapshotStale(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sourcePosKey]);
    // When extrapolation breaches the caps, schedule a background re-snapshot
    // so subsequent extrapolations are accurate. Debounced so a continuous
    // drag doesn't fire snapshots faster than they complete.
    useEffect(() => {
        if (!project || !snapshotStale)
            return;
        const handle = setTimeout(() => {
            const pGen = ++pointGenRef.current;
            const start = performance.now();
            snapshotProject(project, dem)
                .then(({ results, snapshot }) => {
                if (pGen !== pointGenRef.current)
                    return;
                pointSnapRef.current = snapshot;
                setResults(results);
                setLastSolveMs(performance.now() - start);
                setSnapshotVersion((v) => v + 1);
                if (gridSnapRef.current) {
                    const gGen = ++gridGenRef.current;
                    const gridStart = performance.now();
                    snapshotGrid(project, dem, gridSpacingM, project.settings?.general.defaultReceiverHeight ?? 1.5)
                        .then((s) => {
                        if (gGen !== gridGenRef.current)
                            return;
                        gridSnapRef.current = s;
                        const { grid: g } = extrapolateGrid(project, s, dem);
                        g.computedMs = performance.now() - gridStart;
                        setGrid(g);
                    })
                        .catch((e) => console.warn('grid re-snapshot failed:', e));
                }
            })
                .catch((e) => { if (pGen === pointGenRef.current)
                setError(String(e)); })
                .finally(() => setSnapshotStale(false));
        }, 200);
        return () => clearTimeout(handle);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [snapshotStale]);
    function runGrid() {
        if (!project)
            return;
        setGridStatus('computing');
        setTimeout(() => {
            const gen = ++gridGenRef.current;
            snapshotGrid(project, dem, gridSpacingM, project.settings?.general.defaultReceiverHeight ?? 1.5)
                .then((s) => {
                if (gen !== gridGenRef.current)
                    return;
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
                .catch((e) => { if (gen === gridGenRef.current) {
                setError(String(e));
                setGridStatus('idle');
            } });
        }, 0);
    }
    function handleAddSource(latLng) {
        if (!project || addMode === 'none' || addMode === 'receiver' || addMode === 'measure')
            return;
        const kind = addMode;
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
    function handleAddReceiver(latLng) {
        if (!project)
            return;
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
    function handleMoveObject(id, latLng) {
        if (!project)
            return;
        const isSource = project.sources.some((s) => s.id === id);
        const isReceiver = project.receivers.some((r) => r.id === id);
        if (!isSource && !isReceiver)
            return;
        const draggedFrom = isSource
            ? project.sources.find((s) => s.id === id).latLng
            : project.receivers.find((r) => r.id === id).latLng;
        const dLat = latLng[0] - draggedFrom[0];
        const dLng = latLng[1] - draggedFrom[1];
        // If the dragged object isn't part of a multi-selection, just move it.
        if (!selectedIds.has(id) || selectedIds.size <= 1) {
            if (isSource) {
                setProject({
                    ...project,
                    sources: project.sources.map((s) => (s.id === id ? { ...s, latLng } : s)),
                });
            }
            else {
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
            sources: project.sources.map((s) => selectedIds.has(s.id) ? { ...s, latLng: [s.latLng[0] + dLat, s.latLng[1] + dLng] } : s),
            receivers: project.receivers.map((r) => selectedIds.has(r.id) ? { ...r, latLng: [r.latLng[0] + dLat, r.latLng[1] + dLng] } : r),
        });
    }
    function handleMoveSource(id, latLng) { handleMoveObject(id, latLng); }
    function handleMoveReceiver(id, latLng) { handleMoveObject(id, latLng); }
    // ---------- Group operations ----------
    function createGroupFromSelection(name, color) {
        if (!project || selectedIds.size === 0)
            return;
        const id = `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
        const newGroup = { id, name, memberIds: Array.from(selectedIds), color };
        setProject({ ...project, groups: [...(project.groups ?? []), newGroup] });
        setSelectedGroupId(id);
    }
    function renameGroup(id, name) {
        if (!project)
            return;
        setProject({
            ...project,
            groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, name } : g)),
        });
    }
    function recolorGroup(id, color) {
        if (!project)
            return;
        setProject({
            ...project,
            groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, color } : g)),
        });
    }
    function deleteGroup(id) {
        if (!project)
            return;
        setProject({
            ...project,
            groups: (project.groups ?? []).filter((g) => g.id !== id),
        });
        if (selectedGroupId === id) {
            setSelectedGroupId(null);
            setSelectedIds(new Set());
        }
    }
    function setGroupMembers(id, memberIds) {
        if (!project)
            return;
        setProject({
            ...project,
            groups: (project.groups ?? []).map((g) => (g.id === id ? { ...g, memberIds } : g)),
        });
    }
    /// Bulk-update a property on every selected source.
    function bulkUpdateSources(patch) {
        if (!project)
            return;
        const p = project;
        setProject({
            ...p,
            sources: p.sources.map((s) => (selectedIds.has(s.id) ? { ...s, ...patch } : s)),
        });
    }
    function bulkUpdateReceivers(patch) {
        if (!project)
            return;
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
        if (!project || selectedIds.size === 0)
            return;
        setProject({
            ...project,
            sources: project.sources.filter((s) => !selectedIds.has(s.id)),
            receivers: project.receivers.filter((r) => !selectedIds.has(r.id)),
            groups: (project.groups ?? []).map((g) => ({
                ...g, memberIds: g.memberIds.filter((mid) => !selectedIds.has(mid)),
            })).filter((g) => g.memberIds.length > 0),
        });
        setSelectedIds(new Set());
        setSelectedGroupId(null);
    }
    function handleResizeCalcArea(widthM, heightM) {
        if (!project || !project.calculationArea)
            return;
        setProject({
            ...project,
            calculationArea: { ...project.calculationArea, widthM, heightM },
        });
        // Calc-area changed → DEM coverage may need to widen; reset DEM status
        // so the fetcher re-runs against the new bounds.
        setDemStatus('idle');
    }
    function handleMoveCalcArea(centerLatLng) {
        if (!project || !project.calculationArea)
            return;
        setProject({
            ...project,
            calculationArea: { ...project.calculationArea, centerLatLng },
        });
        setDemStatus('idle');
    }
    // dB colormap domain — auto-fit to grid (or to receivers if no grid yet)
    // unless the user has chosen a fixed range, in which case the explicit
    // min / max from `contourBounds` is authoritative.
    const dbDomain = useMemo(() => {
        if (domainMode === 'fixed')
            return { min: contourBounds.min, max: contourBounds.max };
        if (grid)
            return gridDomain(grid.dbA);
        if (results && results.length > 0) {
            let min = Infinity, max = -Infinity;
            for (const r of results) {
                if (!isFinite(r.totalDbA))
                    continue;
                if (r.totalDbA < min)
                    min = r.totalDbA;
                if (r.totalDbA > max)
                    max = r.totalDbA;
            }
            if (isFinite(min) && isFinite(max) && max > min)
                return { min, max };
        }
        return { min: 25, max: 60 };
    }, [domainMode, contourBounds, grid, results]);
    if (!project) {
        return _jsx("div", { style: { padding: 32 }, children: "Loading\u2026" });
    }
    const receiverDbList = (results ?? []).map((r) => r.totalDbA);
    return (_jsxs("div", { className: "workspace", children: [_jsx(SidePanel, { project: project, results: results, selectedIds: selectedIds, selectedGroupId: selectedGroupId, activeTab: activeTab, setActiveTab: setActiveTab, onSelect: selectFromMap, onSelectGroup: selectGroup, onClearSelection: () => { setSelectedIds(new Set()); setSelectedGroupId(null); }, onCreateGroup: createGroupFromSelection, onRenameGroup: renameGroup, onRecolorGroup: recolorGroup, onDeleteGroup: deleteGroup, onSetGroupMembers: setGroupMembers, onBulkUpdateSources: bulkUpdateSources, onBulkUpdateReceivers: bulkUpdateReceivers, onBulkDeleteSelected: bulkDeleteSelected, addMode: addMode, setAddMode: setAddMode, setProject: setProject, onRunGrid: runGrid, computing: computing || gridStatus === 'computing', lastSolveMs: lastSolveMs, onOpenSettings: () => setShowSettings(true), setDem: setDemAndSource, demSource: demSource, baseMap: baseMap, setBaseMap: setBaseMap, showContours: showContours, setShowContours: setShowContours, contourMode: contourMode, setContourMode: setContourMode, contourOpacity: contourOpacity, setContourOpacity: setContourOpacity, contourStepDb: contourStepDb, setContourStepDb: setContourStepDb, contourBounds: contourBounds, setContourBounds: setContourBounds, palette: palette, setPalette: setPalette, domainMode: domainMode, setDomainMode: setDomainMode, fixedDomain: fixedDomain, setFixedDomain: setFixedDomain, demStatus: demStatus, demTilesLoaded: dem?.tilesLoaded ?? null, gridSpacingM: gridSpacingM, setGridSpacingM: setGridSpacingM }), _jsxs("div", { className: "map-area", children: [_jsx(MapView, { project: project, results: results, grid: grid, selectedIds: selectedIds, onSelect: selectFromMap, onBoxSelect: selectFromBox, addMode: addMode, baseMap: baseMap, showContours: showContours, contourMode: contourMode, contourOpacity: contourOpacity, contourStepDb: contourStepDb, palette: palette, dbDomain: dbDomain, onAddSource: handleAddSource, onAddReceiver: handleAddReceiver, onMoveSource: handleMoveSource, onMoveReceiver: handleMoveReceiver, onResizeCalcArea: handleResizeCalcArea, onMoveCalcArea: handleMoveCalcArea, onCursorMove: setCursorLatLng, onReady: (m) => { mapHandleRef.current = m; } }), _jsx(MapControls, { project: project, baseMap: baseMap, setBaseMap: setBaseMap, onZoomIn: () => mapHandleRef.current?.zoomIn(), onZoomOut: () => mapHandleRef.current?.zoomOut(), onPan: (dx, dy) => mapHandleRef.current?.panBy([dx, dy], { animate: true }), onHome: fitCalcArea }), _jsx("div", { className: "back-link", children: _jsx(Link, { to: "/projects", children: "\u2190 All projects" }) }), _jsx(StatusBar, { project: project, selectedIds: selectedIds, cursorLatLng: cursorLatLng }), _jsx("div", { className: "map-chrome-stack right", children: _jsx(ResultsDock, { project: project, results: results, grid: grid, computing: computing, lastSolveMs: lastSolveMs, gridStatus: gridStatus, snapshotStale: snapshotStale, onRunGrid: runGrid }) }), _jsx(Legend, { palette: palette, domain: dbDomain, stepDb: contourStepDb, receiverDb: receiverDbList }), error && _jsxs("div", { className: "map-toast error", children: ["solver error: ", error] })] }), showSettings && (_jsx(SettingsModal, { project: project, setProject: setProject, onClose: () => setShowSettings(false), gridSpacingM: gridSpacingM, setGridSpacingM: setGridSpacingM }))] }));
}
