import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { useState } from 'react';
import { limitForPeriod } from '../lib/types';
import { listEntriesByKind, lookupEntry } from '../lib/catalog';
import { ImportObjectsModal } from './ImportObjectsModal';
import { EpsgPicker } from './EpsgPicker';
import { inferGeoTiffCrs, parseDemGeoTiff } from '../lib/demUpload';
import { presetForEpsg } from '../lib/projections';
import { paletteCss } from '../lib/colormap';
const GROUP_PALETTE = [
    '#3b82f6', '#10b981', '#8b5cf6', '#f59e0b', '#ec4899',
    '#14b8a6', '#ef4444', '#6366f1', '#84cc16', '#06b6d4',
];
const TABS = [
    { id: 'sources', label: 'Sources', numbered: 1 },
    { id: 'area', label: 'Area', numbered: 2 },
    { id: 'receivers', label: 'Receivers', numbered: 3 },
    { id: 'import', label: 'Import' },
    { id: 'results', label: 'Results' },
    { id: 'layers', label: 'Layers' },
];
export function SidePanel(props) {
    const tab = props.activeTab;
    const setTab = props.setActiveTab;
    const { project } = props;
    // Step badge filled when section has content (implicit checklist).
    const filled = {
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
    function maybeCancelAddMode(ev) {
        if (props.addMode === 'none')
            return;
        const target = ev.target;
        if (target.closest('[data-keep-add-mode]'))
            return;
        props.setAddMode('none');
    }
    return (_jsxs("aside", { className: "side-panel", onClick: maybeCancelAddMode, children: [_jsx("div", { className: "tabs", children: TABS.map((t) => (_jsxs("button", { className: `tab${tab === t.id ? ' on' : ''}${filled[t.id] ? ' filled' : ''}`, onClick: () => setTab(t.id), children: [t.numbered && _jsx("span", { className: "step-badge", children: t.numbered }), t.label] }, t.id))) }), _jsxs("div", { className: "tab-body", children: [_jsx(SelectionCard, { ...props }), tab === 'sources' && _jsx(SourcesTab, { ...props }), tab === 'area' && _jsx(AreaTab, { ...props }), tab === 'receivers' && _jsx(ReceiversTab, { ...props }), tab === 'import' && _jsx(ImportTab, { ...props }), tab === 'results' && _jsx(ResultsTab, { ...props }), tab === 'layers' && _jsx(LayersTab, { ...props })] })] }));
}
// ============== Selection card ==============
function SelectionCard(props) {
    const { project, selectedIds, selectedGroupId, onClearSelection, onCreateGroup, onRenameGroup, onRecolorGroup, onDeleteGroup, onBulkUpdateSources, onBulkUpdateReceivers, onBulkDeleteSelected, } = props;
    if (selectedIds.size === 0)
        return null;
    const selectedSources = project.sources.filter((s) => selectedIds.has(s.id));
    const selectedReceivers = project.receivers.filter((r) => selectedIds.has(r.id));
    const group = selectedGroupId
        ? (project.groups ?? []).find((g) => g.id === selectedGroupId) ?? null
        : null;
    return (_jsxs("section", { className: "sp-section selection-card", children: [_jsxs("h3", { children: [_jsx("span", { children: group ? `Group · ${group.name}` : `${selectedIds.size} selected` }), _jsx("button", { className: "x-btn", onClick: onClearSelection, title: "Clear selection", children: "\u2715" })] }), group ? (_jsx(GroupEditor, { group: group, onRename: (n) => onRenameGroup(group.id, n), onRecolor: (c) => onRecolorGroup(group.id, c), onDelete: () => onDeleteGroup(group.id) })) : (_jsxs("div", { className: "selection-meta", children: [selectedSources.length > 0 && (_jsxs("span", { className: "muted", children: [selectedSources.length, " source", selectedSources.length === 1 ? '' : 's'] })), selectedSources.length > 0 && selectedReceivers.length > 0 && _jsx("span", { className: "muted", children: " \u00B7 " }), selectedReceivers.length > 0 && (_jsxs("span", { className: "muted", children: [selectedReceivers.length, " receiver", selectedReceivers.length === 1 ? '' : 's'] }))] })), selectedIds.size >= 2 && (_jsx(BulkEditPanel, { project: project, selectedSources: selectedSources, selectedReceivers: selectedReceivers, onBulkUpdateSources: onBulkUpdateSources, onBulkUpdateReceivers: onBulkUpdateReceivers })), _jsxs("div", { className: "add-row", children: [!group && selectedIds.size >= 2 && (_jsx("button", { className: "btn small", onClick: () => {
                            const name = prompt('Name this group', 'New group');
                            if (!name)
                                return;
                            const used = new Set((project.groups ?? []).map((g) => g.color));
                            const colour = GROUP_PALETTE.find((c) => !used.has(c)) ?? GROUP_PALETTE[0];
                            onCreateGroup(name.trim() || 'Group', colour);
                        }, children: "+ Save as group" })), _jsx("button", { className: "btn small", style: { color: 'var(--red)' }, onClick: onBulkDeleteSelected, title: "Delete selection (Del). Undo with Ctrl+Z.", children: "Delete" })] })] }));
}
function GroupEditor(props) {
    const { group, onRename, onRecolor, onDelete } = props;
    return (_jsxs(_Fragment, { children: [_jsx(Field, { label: "Group name", children: _jsx("input", { value: group.name, onChange: (e) => onRename(e.target.value) }) }), _jsx(Field, { label: "Colour", children: _jsx("div", { className: "palette-row", children: GROUP_PALETTE.map((c) => (_jsx("button", { className: `palette-swatch${group.color === c ? ' on' : ''}`, title: c, onClick: () => onRecolor(c), children: _jsx("span", { style: { background: c, width: 36, height: 12, display: 'block', borderRadius: 2 } }) }, c))) }) }), _jsx("div", { className: "add-row", children: _jsx("button", { className: "btn small", style: { color: 'var(--red)' }, onClick: () => {
                        if (confirm(`Delete group "${group.name}"? Members will keep existing.`))
                            onDelete();
                    }, children: "Delete group" }) })] }));
}
function BulkEditPanel(props) {
    const { project, selectedSources, selectedReceivers, onBulkUpdateSources, onBulkUpdateReceivers } = props;
    // Buffer the bulk-edit changes locally; the user pushes "Apply" to commit.
    // Until then, no project-state writes (and therefore no recompute) fire.
    const [srcDraft, setSrcDraft] = useState({});
    const [rxDraft, setRxDraft] = useState({});
    function setSrc(k, v) {
        setSrcDraft((d) => {
            const next = { ...d };
            if (v === undefined)
                delete next[k];
            else
                next[k] = v;
            return next;
        });
    }
    function setRx(k, v) {
        setRxDraft((d) => {
            const next = { ...d };
            if (v === undefined)
                delete next[k];
            else
                next[k] = v;
            return next;
        });
    }
    function apply() {
        if (Object.keys(srcDraft).length > 0)
            onBulkUpdateSources(srcDraft);
        if (Object.keys(rxDraft).length > 0)
            onBulkUpdateReceivers(rxDraft);
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
        if (!srcDraft.modelId || !srcDraft.catalogScope)
            return null;
        const sample = selectedSources[0] ?? null;
        if (!sample)
            return null;
        return lookupEntry(project, {
            ...sample,
            modelId: srcDraft.modelId,
            catalogScope: srcDraft.catalogScope,
        });
    })();
    const sharedEntry = draftEntry ?? baselineEntry;
    return (_jsxs("div", { className: "bulk-edit", children: [sharedKind && modelChoices.length > 0 && (_jsx(Field, { label: `Model — ${selectedSources.length} ${sharedKind}${selectedSources.length === 1 ? '' : 's'}`, children: _jsxs("select", { value: srcDraft.catalogScope && srcDraft.modelId ? `${srcDraft.catalogScope}:${srcDraft.modelId}` : '', onChange: (e) => {
                        if (!e.target.value)
                            return;
                        const [scope, ...rest] = e.target.value.split(':');
                        const modelId = rest.join(':');
                        const picked = modelChoices.find((c) => c._scope === scope && c.id === modelId);
                        setSrc('catalogScope', scope);
                        setSrc('modelId', modelId);
                        setSrc('modeOverride', picked?.defaultMode ?? null);
                    }, children: [_jsx("option", { value: "", disabled: true, children: "Choose model\u2026" }), modelChoices.map((m) => (_jsxs("option", { value: `${m._scope}:${m.id}`, children: [m.displayName, m._scope === 'local' ? ' · local' : ''] }, `${m._scope}:${m.id}`)))] }) })), sharedEntry && (_jsx(Field, { label: `Mode (${selectedSources.length} × ${sharedEntry.displayName})`, children: _jsxs("select", { value: srcDraft.modeOverride ?? '', onChange: (e) => setSrc('modeOverride', e.target.value || null), children: [_jsx("option", { value: "", disabled: true, children: "Choose mode\u2026" }), sharedEntry.modes.map((m) => (_jsx("option", { value: m.name, children: m.name }, m.name)))] }) })), allWtg && (_jsx(Field, { label: `Hub height — ${selectedSources.length} WTGs (m)`, children: _jsx("input", { type: "number", min: 50, max: 250, step: 1, placeholder: "\u2014", value: srcDraft.hubHeight ?? '', onChange: (e) => setSrc('hubHeight', e.target.value === '' ? undefined : +e.target.value) }) })), selectedReceivers.length >= 2 && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "meta-line", style: { marginTop: 6 }, children: [_jsxs("b", { children: [selectedReceivers.length, " receiver", selectedReceivers.length === 1 ? '' : 's'] }), ' ', "\u2014 blank fields are left untouched on Apply."] }), _jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Day limit dB(A)", children: _jsx("input", { type: "number", min: 20, max: 80, step: 1, placeholder: "\u2014", value: rxDraft.limitDayDbA ?? '', onChange: (e) => setRx('limitDayDbA', e.target.value === '' ? undefined : +e.target.value) }) }), _jsx(Field, { label: "Evening limit dB(A)", children: _jsx("input", { type: "number", min: 20, max: 80, step: 1, placeholder: "\u2014", value: rxDraft.limitEveningDbA ?? '', onChange: (e) => setRx('limitEveningDbA', e.target.value === '' ? undefined : +e.target.value) }) })] }), _jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Night limit dB(A)", children: _jsx("input", { type: "number", min: 20, max: 80, step: 1, placeholder: "\u2014", value: rxDraft.limitNightDbA ?? '', onChange: (e) => setRx('limitNightDbA', e.target.value === '' ? undefined : +e.target.value) }) }), _jsx(Field, { label: "Height above ground (m)", children: _jsx("input", { type: "number", min: 0, max: 300, step: 0.5, placeholder: "\u2014", value: rxDraft.heightAboveGroundM ?? '', onChange: (e) => setRx('heightAboveGroundM', e.target.value === '' ? undefined : +e.target.value) }) })] })] })), _jsxs("div", { className: "add-row", style: { paddingTop: 6, borderTop: '1px dashed var(--light)', marginTop: 4 }, children: [_jsx("button", { className: "btn primary small", disabled: !dirty, onClick: apply, children: "Apply" }), _jsx("button", { className: "btn small", disabled: !dirty, onClick: reset, children: "Reset" })] }), _jsx("div", { className: "hint", children: "Tip: drag any selected marker to move them all." })] }));
}
// -------------------- Sources --------------------
function SourcesTab(props) {
    const { project, setProject, results, selectedIds, onSelect, addMode, setAddMode, onSelectGroup } = props;
    function updateSource(id, patch) {
        setProject({
            ...project,
            sources: project.sources.map((s) => (s.id === id ? { ...s, ...patch } : s)),
        });
    }
    function removeSource(id) {
        setProject({ ...project, sources: project.sources.filter((s) => s.id !== id) });
    }
    function updateScenario(patch) {
        setProject({ ...project, scenario: { ...project.scenario, ...patch } });
    }
    const wtgs = project.sources.filter((s) => s.kind === 'wtg');
    const bess = project.sources.filter((s) => s.kind === 'bess');
    const aux = project.sources.filter((s) => s.kind === 'auxiliary');
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: "Scenario", children: [_jsx(Field, { label: "Project wind speed (m/s @ 10 m)", children: _jsx("input", { type: "number", min: 3, max: 20, step: 0.5, value: project.scenario.windSpeed, onChange: (e) => updateScenario({ windSpeed: +e.target.value }) }) }), _jsx(Field, { label: "Period", children: _jsxs("select", { value: project.scenario.period, onChange: (e) => updateScenario({ period: e.target.value }), children: [_jsx("option", { value: "day", children: "Day" }), _jsx("option", { value: "evening", children: "Evening" }), _jsx("option", { value: "night", children: "Night" })] }) })] }), _jsxs(Card, { title: "Add to map", children: [_jsxs("div", { className: "add-row", children: [_jsx(ModeBtn, { label: "+ WTG", mode: "wtg", current: addMode, onClick: setAddMode }), _jsx(ModeBtn, { label: "+ BESS", mode: "bess", current: addMode, onClick: setAddMode }), _jsx(ModeBtn, { label: "+ Aux", mode: "auxiliary", current: addMode, onClick: setAddMode })] }), addMode !== 'none' && addMode !== 'measure' && addMode !== 'receiver' && (_jsxs("div", { className: "hint", children: ["Click on the map to place a ", addMode.toUpperCase(), "."] }))] }), _jsx(GroupsList, { groups: project.groups ?? [], sources: project.sources, receivers: project.receivers, selectedIds: selectedIds, kindFilter: "source", onSelectGroup: onSelectGroup, onSetGroupMembers: props.onSetGroupMembers }), _jsxs(CollapsibleCard, { title: "Wind turbines", count: wtgs.length, defaultOpen: wtgs.length > 0, children: [wtgs.length === 0 && _jsx("div", { className: "hint", children: "No WTGs placed." }), wtgs.map((s) => (_jsx(SourceItem, { project: project, source: s, results: results, selected: selectedIds.has(s.id), onSelect: (modifiers) => onSelect(s.id, modifiers), onChange: (p) => updateSource(s.id, p), onRemove: () => removeSource(s.id) }, s.id)))] }), _jsxs(CollapsibleCard, { title: "BESS", count: bess.length, defaultOpen: bess.length > 0, children: [bess.length === 0 && _jsx("div", { className: "hint", children: "No BESS placed." }), bess.map((s) => (_jsx(SourceItem, { project: project, source: s, results: results, selected: selectedIds.has(s.id), onSelect: (modifiers) => onSelect(s.id, modifiers), onChange: (p) => updateSource(s.id, p), onRemove: () => removeSource(s.id) }, s.id)))] }), _jsxs(CollapsibleCard, { title: "Auxiliary equipment", count: aux.length, defaultOpen: aux.length > 0, children: [aux.length === 0 && _jsx("div", { className: "hint", children: "Inverters and transformers appear here." }), aux.map((s) => (_jsx(SourceItem, { project: project, source: s, results: results, selected: selectedIds.has(s.id), onSelect: (modifiers) => onSelect(s.id, modifiers), onChange: (p) => updateSource(s.id, p), onRemove: () => removeSource(s.id) }, s.id)))] })] }));
}
// -------------------- Area --------------------
function AreaTab(props) {
    const { project, setProject, gridSpacingM, setGridSpacingM, addMode, setAddMode } = props;
    const ca = project.calculationArea;
    if (!ca) {
        return (_jsxs(Card, { title: "Calculation area", children: [_jsx("div", { className: "hint", children: "No calculation area defined." }), _jsx("button", { className: "btn block", onClick: () => setProject({
                        ...project,
                        calculationArea: {
                            centerLatLng: project.sources[0]?.latLng ?? [-33.6, 138.7],
                            widthM: 9000, heightM: 7000, rotationDeg: 0,
                        },
                    }), children: "+ Create default area" })] }));
    }
    function updateCa(patch) {
        setProject({ ...project, calculationArea: { ...ca, ...patch } });
    }
    function recenterOnSources() {
        if (project.sources.length === 0)
            return;
        let latSum = 0, lngSum = 0;
        for (const s of project.sources) {
            latSum += s.latLng[0];
            lngSum += s.latLng[1];
        }
        updateCa({ centerLatLng: [latSum / project.sources.length, lngSum / project.sources.length] });
    }
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: "Calculation area", children: [_jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Centre lat", children: _jsx("input", { type: "number", step: 0.0001, value: ca.centerLatLng[0], onChange: (e) => updateCa({ centerLatLng: [+e.target.value, ca.centerLatLng[1]] }) }) }), _jsx(Field, { label: "Centre lng", children: _jsx("input", { type: "number", step: 0.0001, value: ca.centerLatLng[1], onChange: (e) => updateCa({ centerLatLng: [ca.centerLatLng[0], +e.target.value] }) }) })] }), _jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Width (m)", children: _jsx("input", { type: "number", min: 500, max: 50000, step: 500, value: ca.widthM, onChange: (e) => updateCa({ widthM: +e.target.value }) }) }), _jsx(Field, { label: "Height (m)", children: _jsx("input", { type: "number", min: 500, max: 50000, step: 500, value: ca.heightM, onChange: (e) => updateCa({ heightM: +e.target.value }) }) })] }), _jsx("div", { className: "add-row", children: _jsx("button", { className: "btn small", onClick: recenterOnSources, children: "Recentre on sources" }) }), _jsx("div", { className: "hint", children: "Drag the yellow dashed rectangle on the map (TBD); for now use the inputs above." })] }), _jsxs(Card, { title: "Grid", children: [_jsx(Field, { label: "Spacing (m)", children: _jsxs("select", { value: gridSpacingM, onChange: (e) => setGridSpacingM(+e.target.value), children: [_jsx("option", { value: 25, children: "25 m (fine)" }), _jsx("option", { value: 50, children: "50 m" }), _jsx("option", { value: 100, children: "100 m (default)" }), _jsx("option", { value: 200, children: "200 m (preview)" })] }) }), _jsxs("div", { className: "hint", children: [Math.round(ca.widthM / gridSpacingM) * Math.round(ca.heightM / gridSpacingM), " cells (", Math.round(ca.widthM / gridSpacingM), " \u00D7 ", Math.round(ca.heightM / gridSpacingM), ")"] })] }), _jsxs(Card, { title: "Tools", children: [_jsx("div", { className: "add-row", children: _jsx(ModeBtn, { label: "\uD83D\uDCCF Measure tape", mode: "measure", current: addMode, onClick: setAddMode }) }), addMode === 'measure' && (_jsx("div", { className: "hint", children: "Click two points on the map to measure straight-line distance." }))] })] }));
}
// -------------------- Receivers --------------------
function ReceiversTab(props) {
    const { project, setProject, results, selectedIds, onSelect, addMode, setAddMode, onSelectGroup } = props;
    function updateReceiver(id, patch) {
        setProject({
            ...project,
            receivers: project.receivers.map((r) => (r.id === id ? { ...r, ...patch } : r)),
        });
    }
    function removeReceiver(id) {
        setProject({ ...project, receivers: project.receivers.filter((r) => r.id !== id) });
    }
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: "Add receivers", children: [_jsx("div", { className: "add-row", children: _jsx(ModeBtn, { label: "+ Receiver", mode: "receiver", current: addMode, onClick: setAddMode }) }), addMode === 'receiver' && _jsx("div", { className: "hint", children: "Click on the map to place a receiver." })] }), _jsx(GroupsList, { groups: project.groups ?? [], sources: project.sources, receivers: project.receivers, selectedIds: selectedIds, kindFilter: "receiver", onSelectGroup: onSelectGroup, onSetGroupMembers: props.onSetGroupMembers }), _jsxs(Card, { title: "Receiver list", count: project.receivers.length, children: [project.receivers.length === 0 && _jsx("div", { className: "hint", children: "No receivers placed." }), _jsxs("div", { className: "hint", children: ["Active period: ", _jsx("b", { children: project.scenario.period }), " \u2014 limits below are the full day / evening / night triplet; the active one is bolded."] }), project.receivers.map((r) => {
                        const result = results?.find((x) => x.receiverId === r.id);
                        const activeLimit = limitForPeriod(r, project.scenario.period);
                        const fail = result && result.totalDbA > activeLimit;
                        return (_jsxs("div", { className: `item${selectedIds.has(r.id) ? ' selected' : ''}`, onClick: (e) => onSelect(r.id, { shift: e.shiftKey }), children: [_jsx("div", { className: "item-name", children: r.name }), _jsxs("div", { className: "item-meta", children: ["limit ", activeLimit, " dB(A) \u00B7", ' ', result && isFinite(result.totalDbA) ? (_jsxs("span", { style: { color: fail ? 'var(--red)' : 'var(--green)', fontWeight: 600 }, children: [result.totalDbA.toFixed(1), " dB(A) ", fail ? '✗' : '✓'] })) : _jsx("span", { className: "muted", children: "\u2014 run to compute" })] }), _jsxs("div", { className: "item-controls", onClick: (e) => e.stopPropagation(), children: [_jsx("input", { className: "inline-edit", type: "number", min: 0, max: 300, step: 0.5, value: r.heightAboveGroundM, onChange: (e) => updateReceiver(r.id, { heightAboveGroundM: +e.target.value }), title: "Height above ground (m)" }), _jsx(PeriodLimitInput, { label: "D", period: "day", active: project.scenario.period === 'day', value: r.limitDayDbA, onChange: (v) => updateReceiver(r.id, { limitDayDbA: v }) }), _jsx(PeriodLimitInput, { label: "E", period: "evening", active: project.scenario.period === 'evening', value: r.limitEveningDbA, onChange: (v) => updateReceiver(r.id, { limitEveningDbA: v }) }), _jsx(PeriodLimitInput, { label: "N", period: "night", active: project.scenario.period === 'night', value: r.limitNightDbA, onChange: (v) => updateReceiver(r.id, { limitNightDbA: v }) }), _jsx("button", { className: "x-btn", onClick: () => removeReceiver(r.id), children: "\u2715" })] })] }, r.id));
                    })] })] }));
}
// -------------------- Import --------------------
function ImportTab(props) {
    const { project, setProject, setDem, demSource } = props;
    const [importOpen, setImportOpen] = useState(false);
    // Two-step DEM upload: (1) user picks file → we sniff the CRS and stash
    // the file for confirmation; (2) user confirms / overrides the CRS and
    // hits "Use this DEM" → we actually parse the raster.
    const [demFile, setDemFile] = useState(null);
    const [demEpsg, setDemEpsg] = useState(4326);
    const [demInferredEpsg, setDemInferredEpsg] = useState(null);
    const [demBusy, setDemBusy] = useState(false);
    const [demError, setDemError] = useState(null);
    const [demName, setDemName] = useState(null);
    async function pickDemFile(file) {
        setDemError(null);
        setDemFile(file);
        try {
            const inferred = await inferGeoTiffCrs(file);
            setDemInferredEpsg(inferred);
            setDemEpsg(inferred ?? 4326);
        }
        catch (e) {
            // Couldn't even read the GeoTIFF header — surface the error and
            // keep the picker open with the WGS84 default.
            setDemError(String(e));
            setDemInferredEpsg(null);
            setDemEpsg(4326);
        }
    }
    async function commitDemUpload() {
        if (!demFile)
            return;
        setDemError(null);
        setDemBusy(true);
        try {
            const dem = await parseDemGeoTiff(demFile, { epsgOverride: demEpsg });
            setDem(dem, 'upload');
            setDemName(demFile.name);
            setDemFile(null);
            setDemInferredEpsg(null);
        }
        catch (e) {
            setDemError(String(e));
        }
        setDemBusy(false);
    }
    function cancelDemUpload() {
        setDemFile(null);
        setDemInferredEpsg(null);
        setDemError(null);
    }
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: "Import objects", children: [_jsxs("div", { className: "hint", children: ["Receiver and source locations from ", _jsx("b", { children: "CSV" }), ", ", _jsx("b", { children: "KML" }), ", or ", _jsx("b", { children: "shapefile" }), "(.zip bundle). The dialog asks which kind to import as \u2014 receivers, WTGs, BESS, or auxiliary equipment \u2014 and lets you map attributes to project fields. CSV and shapefile (without .prj) accept any registered projected CRS."] }), _jsx("button", { className: "btn primary block", onClick: () => setImportOpen(true), children: "\uD83D\uDCC1 Import locations\u2026" })] }), _jsxs(Card, { title: "Digital elevation model", children: [_jsxs("div", { className: "hint", children: ["DEM is auto-loaded from ", _jsx("b", { children: "AWS Terrain Tiles" }), " by default. Upload a custom GeoTIFF to override it for this project \u2014 useful for site-specific LiDAR. Both geographic (WGS84) and projected (UTM, MGA, NZTM, \u2026) CRSs are supported."] }), _jsxs("div", { className: "meta-line", children: ["Active source: ", _jsx("b", { children: demSource === 'upload' ? `upload · ${demName ?? 'GeoTIFF'}` : 'auto (AWS Terrain Tiles)' })] }), !demFile ? (_jsxs("div", { className: "add-row", children: [_jsxs("label", { className: "btn small", style: { cursor: 'pointer' }, children: ["\u2191 Upload .tif", _jsx("input", { type: "file", accept: ".tif,.tiff", style: { display: 'none' }, onChange: (e) => {
                                            const f = e.target.files?.[0];
                                            if (f)
                                                pickDemFile(f);
                                            e.target.value = '';
                                        } })] }), demSource === 'upload' && (_jsx("button", { className: "btn small", onClick: () => { setDem(null, 'auto'); setDemName(null); }, children: "Reset to auto" }))] })) : (_jsxs("div", { className: "settings-section", style: { marginTop: 8 }, children: [_jsxs("div", { className: "meta-line", children: ["Selected: ", _jsx("b", { children: demFile.name })] }), _jsx("div", { className: "hint", children: demInferredEpsg
                                    ? _jsxs(_Fragment, { children: ["Inferred CRS: ", _jsxs("b", { children: ["EPSG:", demInferredEpsg] }), presetForEpsg(demInferredEpsg) ? ` (${presetForEpsg(demInferredEpsg).label})` : ' — not in preset list, override below', ". Confirm or override below."] })
                                    : 'No CRS tag found in the GeoTIFF — pick the source CRS below.' }), _jsx(EpsgPicker, { value: demEpsg, onChange: setDemEpsg, label: "DEM CRS" }), _jsxs("div", { className: "add-row", children: [_jsx("button", { className: "btn small primary", disabled: demBusy, onClick: commitDemUpload, children: demBusy ? 'Parsing…' : 'Use this DEM' }), _jsx("button", { className: "btn small", disabled: demBusy, onClick: cancelDemUpload, children: "Cancel" })] })] })), demError && _jsxs("div", { className: "hint", style: { color: 'var(--red)' }, children: ["Error: ", demError] })] }), importOpen && (_jsx(ImportObjectsModal, { project: project, setProject: setProject, onClose: () => setImportOpen(false) }))] }));
}
// -------------------- Results --------------------
function ResultsTab(props) {
    const { project, results, computing, lastSolveMs, onRunGrid, onOpenSettings } = props;
    const exceedances = (results ?? []).filter((r) => {
        const rx = project.receivers.find((x) => x.id === r.receiverId);
        return rx && r.totalDbA > limitForPeriod(rx, project.scenario.period);
    });
    return (_jsxs(_Fragment, { children: [_jsxs(Card, { title: "Run", children: [_jsx("button", { className: "btn primary block", disabled: computing, onClick: onRunGrid, children: computing ? 'Running grid…' : '▶ Run grid' }), lastSolveMs != null && (_jsxs("div", { className: "meta-line", children: ["point solve: ", lastSolveMs.toFixed(0), " ms \u00B7 ", project.sources.length, " src \u00D7 ", project.receivers.length, " rcv"] }))] }), _jsx(Card, { title: "Receiver pass / fail", children: _jsxs("div", { className: "meta-line", children: [project.receivers.length - exceedances.length, " of ", project.receivers.length, " compliant", exceedances.length > 0 && _jsxs("span", { style: { color: 'var(--red)' }, children: [" \u00B7 ", exceedances.length, " over"] })] }) }), _jsx(Card, { title: "Project settings", children: _jsx("button", { className: "btn block", onClick: onOpenSettings, children: "\u2699 Open settings" }) })] }));
}
// -------------------- Layers --------------------
const PALETTES = ['viridis', 'magma', 'plasma', 'inferno', 'rdylgn', 'grey'];
function LayersTab(props) {
    const { baseMap, setBaseMap, showContours, setShowContours, contourMode, setContourMode, contourOpacity, setContourOpacity, palette, setPalette, contourStepDb, setContourStepDb, contourBounds, setContourBounds, domainMode, setDomainMode, fixedDomain, setFixedDomain, demStatus, demTilesLoaded, } = props;
    return (_jsxs(_Fragment, { children: [_jsx(Card, { title: "Base map", children: _jsxs("div", { className: "seg block", children: [_jsx("button", { className: baseMap === 'satellite' ? 'on' : '', onClick: () => setBaseMap('satellite'), children: "Satellite" }), _jsx("button", { className: baseMap === 'osm' ? 'on' : '', onClick: () => setBaseMap('osm'), children: "OSM" })] }) }), _jsxs(Card, { title: "Contours", children: [_jsx(Field, { label: "", children: _jsxs("label", { className: "row-checkbox", children: [_jsx("input", { type: "checkbox", checked: showContours, onChange: (e) => setShowContours(e.target.checked) }), _jsx("span", { children: "Show contour grid" })] }) }), _jsx(Field, { label: "Style", children: _jsxs("div", { className: "seg block", children: [_jsx("button", { className: contourMode === 'filled' ? 'on' : '', onClick: () => setContourMode('filled'), children: "Filled" }), _jsx("button", { className: contourMode === 'lines' ? 'on' : '', onClick: () => setContourMode('lines'), children: "Lines" }), _jsx("button", { className: contourMode === 'both' ? 'on' : '', onClick: () => setContourMode('both'), children: "Both" })] }) }), _jsx(Field, { label: `Opacity ${(contourOpacity * 100).toFixed(0)}%`, children: _jsx("input", { type: "range", min: 0.2, max: 0.95, step: 0.05, value: contourOpacity, onChange: (e) => setContourOpacity(+e.target.value) }) }), _jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Min (dB)", children: _jsx("input", { type: "number", step: 1, value: contourBounds.min, onChange: (e) => setContourBounds({ ...contourBounds, min: +e.target.value }) }) }), _jsx(Field, { label: "Max (dB)", children: _jsx("input", { type: "number", step: 1, value: contourBounds.max, onChange: (e) => setContourBounds({ ...contourBounds, max: +e.target.value }) }) })] }), _jsx(Field, { label: "Step (dB)", children: _jsxs("select", { value: contourStepDb, onChange: (e) => {
                                const v = +e.target.value;
                                setContourStepDb(v);
                                setContourBounds({ ...contourBounds, step: v });
                            }, children: [_jsx("option", { value: 1, children: "1" }), _jsx("option", { value: 2, children: "2" }), _jsx("option", { value: 2.5, children: "2.5" }), _jsx("option", { value: 5, children: "5 (default)" }), _jsx("option", { value: 10, children: "10" })] }) }), _jsx(Field, { label: "Palette", children: _jsx("div", { className: "palette-row", children: PALETTES.map((p) => (_jsx("button", { className: `palette-swatch${palette === p ? ' on' : ''}`, title: p, onClick: () => setPalette(p), children: _jsx("span", { style: {
                                        background: `linear-gradient(90deg, ${paletteCss(p, 0)}, ${paletteCss(p, 0.5)}, ${paletteCss(p, 1)})`,
                                        width: 36, height: 12, display: 'block', borderRadius: 2,
                                    } }) }, p))) }) }), _jsx(Field, { label: "Domain (dB)", children: _jsxs("div", { className: "seg block", children: [_jsx("button", { className: domainMode === 'auto' ? 'on' : '', onClick: () => setDomainMode('auto'), children: "Auto" }), _jsx("button", { className: domainMode === 'fixed' ? 'on' : '', onClick: () => setDomainMode('fixed'), children: "Fixed" })] }) }), domainMode === 'fixed' && (_jsxs("div", { className: "grid-2", children: [_jsx(Field, { label: "Min", children: _jsx("input", { type: "number", step: 1, value: fixedDomain.min, onChange: (e) => setFixedDomain({ ...fixedDomain, min: +e.target.value }) }) }), _jsx(Field, { label: "Max", children: _jsx("input", { type: "number", step: 1, value: fixedDomain.max, onChange: (e) => setFixedDomain({ ...fixedDomain, max: +e.target.value }) }) })] }))] }), _jsxs(Card, { title: "Terrain", children: [_jsxs("div", { className: "meta-line", children: ["DEM:", ' ', demStatus === 'idle' && _jsx("span", { className: "muted", children: "idle" }), demStatus === 'loading' && _jsx("span", { className: "muted", children: "loading\u2026" }), demStatus === 'ready' && _jsxs("span", { style: { color: 'var(--green)' }, children: [demTilesLoaded, " tiles loaded"] }), demStatus === 'error' && _jsx("span", { style: { color: 'var(--red)' }, children: "fetch failed" })] }), _jsx("div", { className: "hint", children: "Source: AWS Terrain Tiles (NASADEM/SRTM blend, free)." })] })] }));
}
// -------------------- Shared bits --------------------
function Card(props) {
    return (_jsxs("section", { className: "sp-section", children: [_jsxs("h3", { children: [_jsx("span", { children: props.title }), props.count != null && _jsx("span", { className: "badge", children: props.count })] }), props.children] }));
}
function CollapsibleCard(props) {
    const [open, setOpen] = useState(props.defaultOpen);
    return (_jsxs("section", { className: "sp-section collapsible", children: [_jsxs("h3", { onClick: () => setOpen(!open), style: { cursor: 'pointer', userSelect: 'none' }, children: [_jsxs("span", { children: [_jsx("span", { style: { display: 'inline-block', width: 10, color: 'var(--mid)' }, children: open ? '▾' : '▸' }), " ", props.title] }), _jsx("span", { className: "badge", children: props.count })] }), open && _jsx("div", { style: { display: 'flex', flexDirection: 'column', gap: 6 }, children: props.children })] }));
}
function Field(props) {
    return (_jsxs("label", { className: "fld", children: [props.label && _jsx("span", { children: props.label }), props.children] }));
}
function ModeBtn(props) {
    return (_jsx("button", { "data-keep-add-mode": true, className: `btn small${props.current === props.mode ? ' active' : ''}`, onClick: () => props.onClick(props.current === props.mode ? 'none' : props.mode), children: props.label }));
}
function PeriodLimitInput(props) {
    return (_jsxs("span", { title: `${props.period} limit dB(A)`, style: {
            display: 'inline-flex', alignItems: 'center', gap: 2,
            padding: '0 4px', borderRadius: 3,
            background: props.active ? 'var(--yellow)' : 'transparent',
            border: props.active ? '1px solid var(--ink)' : '1px solid transparent',
        }, children: [_jsx("span", { style: {
                    fontSize: 9, fontFamily: 'var(--font-mono)',
                    fontWeight: props.active ? 700 : 500,
                    color: 'var(--ink-soft)',
                }, children: props.label }), _jsx("input", { type: "number", min: 20, max: 80, step: 1, value: props.value, onChange: (e) => props.onChange(+e.target.value), style: {
                    width: 36,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 10,
                    fontWeight: props.active ? 700 : 500,
                    border: 'none', background: 'transparent', padding: 0, outline: 'none',
                } })] }));
}
function GroupsList(props) {
    const { groups, sources, receivers, selectedIds, kindFilter, onSelectGroup, onSetGroupMembers } = props;
    const sourceIds = new Set(sources.map((s) => s.id));
    const receiverIds = new Set(receivers.map((r) => r.id));
    const matching = groups.filter((g) => g.memberIds.some((id) => kindFilter === 'source' ? sourceIds.has(id) : receiverIds.has(id)));
    if (matching.length === 0)
        return null;
    const nameOf = (id) => {
        const s = sources.find((x) => x.id === id);
        if (s)
            return s.name;
        const r = receivers.find((x) => x.id === id);
        if (r)
            return r.name;
        return id;
    };
    return (_jsx(CollapsibleCard, { title: "Groups", count: matching.length, defaultOpen: true, children: matching.map((g) => (_jsx(ExpandableGroupItem, { group: g, memberNames: g.memberIds.map((id) => ({ id, name: nameOf(id) })), selectedIds: selectedIds, onClickGroup: () => onSelectGroup(g.id), onAddSelectedToGroup: () => {
                const next = Array.from(new Set([...g.memberIds, ...Array.from(selectedIds)]));
                onSetGroupMembers(g.id, next);
            }, onRemoveMember: (memberId) => {
                onSetGroupMembers(g.id, g.memberIds.filter((id) => id !== memberId));
            } }, g.id))) }));
}
function ExpandableGroupItem(props) {
    const { group: g, memberNames, selectedIds, onClickGroup, onAddSelectedToGroup, onRemoveMember } = props;
    const [open, setOpen] = useState(false);
    const inGroup = memberNames.length;
    const selectionAddable = Array.from(selectedIds).some((id) => !g.memberIds.includes(id));
    return (_jsxs("div", { className: "item", style: { gap: 4 }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx("button", { className: "x-btn", style: { width: 14, padding: 0, color: 'var(--mid)' }, onClick: (e) => { e.stopPropagation(); setOpen((o) => !o); }, title: open ? 'Collapse' : 'Expand', children: open ? '▾' : '▸' }), _jsxs("div", { className: "item-name", style: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, cursor: 'pointer' }, onClick: onClickGroup, children: [g.color && (_jsx("span", { style: {
                                    display: 'inline-block', width: 10, height: 10, borderRadius: 2,
                                    background: g.color, border: '1px solid var(--ink)',
                                } })), g.name] }), _jsx("div", { className: "item-meta", children: inGroup })] }), open && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 2, paddingLeft: 18 }, children: [memberNames.length === 0 && _jsx("span", { className: "hint", children: "No members." }), memberNames.map((m) => (_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }, children: [_jsx("span", { style: { flex: 1 }, children: m.name }), _jsx("button", { className: "x-btn", onClick: (e) => { e.stopPropagation(); onRemoveMember(m.id); }, title: "Remove from group", children: "\u2715" })] }, m.id)))] }), selectionAddable && (_jsx("div", { className: "add-row", style: { paddingLeft: 18 }, children: _jsx("button", { className: "btn small", onClick: onAddSelectedToGroup, children: "+ Add selection to group" }) }))] }))] }));
}
function SourceItem(props) {
    const { project, source: s, selected, onSelect, onChange, onRemove } = props;
    const candidates = listEntriesByKind(project, s.kind);
    const entry = lookupEntry(project, s);
    const modes = entry?.modes ?? [];
    return (_jsxs("div", { className: `item${selected ? ' selected' : ''}`, onClick: (e) => onSelect({ shift: e.shiftKey }), children: [_jsx("div", { className: "item-name", children: s.name }), _jsxs("div", { className: "item-controls", onClick: (e) => e.stopPropagation(), children: [_jsx("select", { value: `${s.catalogScope}:${s.modelId}`, onChange: (e) => {
                            const [scope, ...rest] = e.target.value.split(':');
                            const modelId = rest.join(':');
                            const picked = candidates.find((c) => c._scope === scope && c.id === modelId);
                            onChange({
                                catalogScope: scope,
                                modelId,
                                modeOverride: picked?.defaultMode ?? null,
                            });
                        }, children: candidates.map((m) => (_jsxs("option", { value: `${m._scope}:${m.id}`, children: [m.displayName, m._scope === 'local' ? ' · local' : ''] }, `${m._scope}:${m.id}`))) }), modes.length > 1 && (_jsx("select", { value: s.modeOverride ?? (entry?.defaultMode ?? ''), onChange: (e) => onChange({ modeOverride: e.target.value }), children: modes.map((m) => _jsx("option", { value: m.name, children: m.name }, m.name)) })), s.kind === 'wtg' && (_jsx("input", { type: "number", min: 50, max: 250, step: 1, value: s.hubHeight ?? 100, onChange: (e) => onChange({ hubHeight: +e.target.value }), title: "Hub height (m)" })), _jsx("button", { className: "x-btn", onClick: (e) => { e.stopPropagation(); onRemove(); }, children: "\u2715" })] })] }));
}
