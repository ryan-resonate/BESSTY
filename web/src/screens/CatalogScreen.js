import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// Catalog screen — manages source models in two databases:
//
//   - **Global** — shared across every project on this device.
//   - **Local**  — lives on a single project; only visible when the screen
//                  is reached from within a project (URL `?project=<id>`).
//
// Tabs at the top switch between the two. Add / edit / delete buttons hit
// whichever scope is active.
import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { deleteGlobalEntry, loadGlobalCatalog, localCatalogOf, upsertGlobalEntry, withLocalEntry, withoutLocalEntry, } from '../lib/catalog';
import { loadProject, saveProject } from '../lib/storage';
import { parseCatalogXlsx } from '../lib/xlsxImport';
const KIND_ORDER = ['wtg', 'bess', 'auxiliary'];
const KIND_LABEL = {
    wtg: 'Wind turbines',
    bess: 'BESS',
    auxiliary: 'Auxiliary',
};
export function CatalogScreen() {
    // Optional `?project=<id>` query selects a project for the Local tab.
    const location = useLocation();
    const projectId = useMemo(() => new URLSearchParams(location.search).get('project'), [location.search]);
    const [project, setProject] = useState(() => projectId ? loadProject(projectId) : null);
    const [scope, setScope] = useState(projectId ? 'local' : 'global');
    const [globalEntries, setGlobalEntries] = useState(() => loadGlobalCatalog());
    const [editing, setEditing] = useState(null);
    function refreshGlobal() {
        setGlobalEntries(loadGlobalCatalog());
    }
    function persistProject(p) {
        setProject(p);
        if (projectId)
            saveProject(projectId, p);
    }
    function activeEntries() {
        if (scope === 'local')
            return project ? localCatalogOf(project) : [];
        return globalEntries;
    }
    function handleDelete(e) {
        if (!confirm(`Delete catalog entry "${e.displayName}"?`))
            return;
        if (scope === 'global') {
            deleteGlobalEntry(e.id);
            refreshGlobal();
        }
        else if (project) {
            persistProject(withoutLocalEntry(project, e.id));
        }
    }
    function handleSave(updated, targetScope) {
        if (targetScope === 'global') {
            upsertGlobalEntry(updated);
            refreshGlobal();
        }
        else if (project) {
            persistProject(withLocalEntry(project, updated));
        }
        setEditing(null);
    }
    function copyToOtherScope(e) {
        if (scope === 'global' && project) {
            persistProject(withLocalEntry(project, { ...e, origin: 'user' }));
        }
        else if (scope === 'local') {
            upsertGlobalEntry({ ...e, origin: 'user' });
            refreshGlobal();
        }
    }
    const entries = activeEntries();
    return (_jsxs("div", { className: "catalog-screen", children: [_jsxs("div", { className: "catalog-header", children: [_jsxs("div", { children: [_jsx("h2", { children: "Catalog" }), _jsxs("div", { className: "subtitle", children: ["Source-model database. ", _jsx("b", { children: "Global" }), " is shared across every project on this device; ", _jsx("b", { children: "Local" }), " belongs to one project. The two are independent \u2014 copy entries between them as needed."] })] }), _jsxs("div", { style: { display: 'flex', gap: 8 }, children: [_jsxs(Link, { to: projectId ? `/projects/${projectId}` : '/projects', className: "btn", children: ["\u2190 ", projectId ? 'Project' : 'Projects'] }), _jsx(UploadButton, { onLoaded: (es) => {
                                    if (scope === 'global') {
                                        es.forEach(upsertGlobalEntry);
                                        refreshGlobal();
                                    }
                                    else if (project) {
                                        let next = project;
                                        for (const e of es)
                                            next = withLocalEntry(next, e);
                                        persistProject(next);
                                    }
                                } }), _jsx("button", { className: "btn primary", onClick: () => setEditing({ entry: blankEntry('wtg'), targetScope: scope }), children: "+ Add entry" })] })] }), _jsxs("div", { className: "seg", style: { display: 'inline-flex', marginBottom: 16 }, children: [_jsxs("button", { className: scope === 'global' ? 'on' : '', onClick: () => setScope('global'), children: ["Global (", globalEntries.length, ")"] }), project && (_jsxs("button", { className: scope === 'local' ? 'on' : '', onClick: () => setScope('local'), children: [project.name, " \u00B7 Local (", localCatalogOf(project).length, ")"] })), !project && (_jsx("button", { disabled: true, title: "Open this screen from inside a project to edit its local catalog", children: "Local catalog (open from a project)" }))] }), KIND_ORDER.map((kind) => {
                const ofKind = entries.filter((e) => e.kind === kind);
                return (_jsxs("section", { className: "catalog-section", children: [_jsxs("h3", { children: [KIND_LABEL[kind], " ", _jsxs("span", { className: "muted", children: ["\u00B7 ", ofKind.length] })] }), ofKind.length === 0 && (_jsxs("div", { className: "empty-state", style: { padding: 20, marginBottom: 12 }, children: ["No ", KIND_LABEL[kind].toLowerCase(), " entries in this ", scope, " catalog."] })), ofKind.length > 0 && (_jsxs("table", { className: "catalog-table", children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Display name" }), _jsx("th", { children: "Modes" }), _jsx("th", { children: "Bands" }), _jsx("th", { children: "Source" }), _jsx("th", { children: "Origin" }), _jsx("th", {})] }) }), _jsx("tbody", { children: ofKind.map((e) => (_jsxs("tr", { children: [_jsxs("td", { children: [_jsx("div", { style: { fontWeight: 600 }, children: e.displayName }), _jsxs("div", { className: "muted", style: { fontSize: 11, fontFamily: 'var(--font-mono)' }, children: [e.id, e.kind === 'auxiliary' && e.auxiliaryType ? ` · ${e.auxiliaryType}` : '', e.kind === 'wtg' && e.rotorDiameterM ? ` · rotor ${e.rotorDiameterM} m` : ''] })] }), _jsx("td", { children: e.modes.length }), _jsxs("td", { children: [e.modes[0]?.bandSystem === 'oneThirdOctave' ? '1/3-oct' : 'oct', _jsxs("span", { className: "muted", children: [" \u00B7 ", e.modes[0]?.frequencies.length] })] }), _jsx("td", { className: "muted", style: { fontSize: 11 }, children: e.source ?? '—' }), _jsx("td", { children: _jsx("span", { className: `origin-pill ${e.origin}`, children: e.origin }) }), _jsxs("td", { style: { textAlign: 'right', whiteSpace: 'nowrap' }, children: [_jsx("button", { className: "btn small", onClick: () => setEditing({ entry: e, targetScope: scope }), children: "Edit" }), (scope === 'global' ? !!project : true) && (_jsx("button", { className: "btn small", onClick: () => copyToOtherScope(e), title: scope === 'global' ? 'Copy to project local' : 'Push to global', children: scope === 'global' ? '→ Local' : '→ Global' })), _jsx("button", { className: "btn small", style: { color: 'var(--red)' }, onClick: () => handleDelete(e), children: "\u2715" })] })] }, e.id))) })] }))] }, kind));
            }), editing && (_jsx(CatalogEntryEditor, { entry: editing.entry, onClose: () => setEditing(null), onSave: (e) => handleSave(e, editing.targetScope) }))] }));
}
const OCT_DEFAULT = [63, 125, 250, 500, 1000, 2000, 4000, 8000];
function blankEntry(kind) {
    return {
        id: `new-${Date.now().toString(36)}`,
        kind,
        displayName: 'New entry',
        defaultMode: 'default',
        modes: [{
                name: 'default',
                bandSystem: 'octave',
                frequencies: OCT_DEFAULT.slice(),
                spectra: kind === 'wtg'
                    ? { '8': new Array(8).fill(80) }
                    : { broadband: new Array(8).fill(80) },
                windSpeeds: kind === 'wtg' ? [8] : undefined,
            }],
        origin: 'user',
    };
}
function UploadButton(props) {
    const inputRef = useRef(null);
    const [busy, setBusy] = useState(false);
    return (_jsxs(_Fragment, { children: [_jsx("button", { className: "btn", disabled: busy, onClick: () => inputRef.current?.click(), children: busy ? 'Parsing…' : '↑ Upload xlsx' }), _jsx("input", { ref: inputRef, type: "file", accept: ".xlsx,.xlsm,.xlsb", style: { display: 'none' }, onChange: async (e) => {
                    const file = e.target.files?.[0];
                    if (!file)
                        return;
                    setBusy(true);
                    try {
                        const entries = await parseCatalogXlsx(file);
                        if (entries.length === 0) {
                            alert('No catalog entries found in that file.');
                        }
                        else {
                            props.onLoaded(entries);
                        }
                    }
                    catch (err) {
                        alert(`Import failed: ${err}`);
                    }
                    setBusy(false);
                    e.target.value = '';
                } })] }));
}
// ============== Frequency picker (start / end dropdowns) ==============
const OCTAVE_BANDS_HZ = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
const ONE_THIRD_OCTAVE_BANDS_HZ = [
    10, 12.5, 16, 20, 25, 31.5, 40,
    50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
    500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
    4000, 5000, 6300, 8000, 10000,
];
function bandList(bandSystem) {
    return bandSystem === 'oneThirdOctave' ? ONE_THIRD_OCTAVE_BANDS_HZ : OCTAVE_BANDS_HZ;
}
function formatHz(f) {
    if (f >= 1000) {
        const k = f / 1000;
        // 1k, 1.25k, 1.6k, 2k, 2.5k etc
        return Number.isInteger(k) ? `${k}k` : `${k}k`;
    }
    return Number.isInteger(f) ? String(f) : String(f);
}
function FrequencyRangePicker(props) {
    const all = bandList(props.bandSystem);
    // Snap the entry's first/last frequency to whichever standard band is
    // closest, so the dropdowns always have a valid selection even after a
    // manual edit elsewhere.
    function nearestIdx(target) {
        let bestI = 0;
        let bestD = Infinity;
        for (let i = 0; i < all.length; i++) {
            const d = Math.abs(Math.log(all[i]) - Math.log(target));
            if (d < bestD) {
                bestD = d;
                bestI = i;
            }
        }
        return bestI;
    }
    const startIdx = props.frequencies.length > 0 ? nearestIdx(props.frequencies[0]) : 0;
    const endIdx = props.frequencies.length > 0 ? nearestIdx(props.frequencies[props.frequencies.length - 1]) : all.length - 1;
    function setRange(s, e) {
        if (s > e)
            [s, e] = [e, s];
        props.onChange(all.slice(s, e + 1));
    }
    return (_jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "From (lowest band)" }), _jsx("select", { value: startIdx, onChange: (ev) => setRange(+ev.target.value, endIdx), children: all.map((f, i) => _jsxs("option", { value: i, children: [formatHz(f), " Hz"] }, f)) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "To (highest band)" }), _jsx("select", { value: endIdx, onChange: (ev) => setRange(startIdx, +ev.target.value), children: all.map((f, i) => _jsxs("option", { value: i, children: [formatHz(f), " Hz"] }, f)) })] })] }));
}
/// Edit (or create) a single catalog entry.
export function CatalogEntryEditor(props) {
    const [draft, setDraft] = useState(structuredClone(props.entry));
    const [activeModeIdx, setActiveModeIdx] = useState(0);
    function update(k, v) {
        setDraft((d) => ({ ...d, [k]: v }));
    }
    function updateMode(idx, patch) {
        setDraft((d) => ({
            ...d,
            modes: d.modes.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
        }));
    }
    function addMode() {
        const base = draft.modes[0] ?? blankEntry(draft.kind).modes[0];
        setDraft((d) => ({
            ...d,
            modes: [...d.modes, { ...base, name: `mode ${d.modes.length + 1}`, spectra: { ...base.spectra } }],
        }));
        setActiveModeIdx(draft.modes.length);
    }
    function removeMode(idx) {
        if (draft.modes.length <= 1)
            return;
        setDraft((d) => ({ ...d, modes: d.modes.filter((_, i) => i !== idx) }));
        setActiveModeIdx(0);
    }
    const m = draft.modes[activeModeIdx];
    const wsKeys = m && m.windSpeeds && m.windSpeeds.length > 0
        ? m.windSpeeds.map((w) => String(w))
        : ['broadband'];
    return (_jsx("div", { className: "modal-backdrop", onClick: props.onClose, children: _jsxs("div", { className: "modal", onClick: (e) => e.stopPropagation(), style: { maxWidth: 800 }, children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { children: draft.id ? `Edit · ${draft.displayName}` : 'New catalog entry' }), _jsx("button", { className: "x-btn", onClick: props.onClose, children: "\u2715" })] }), _jsxs("div", { className: "modal-body", children: [_jsxs("section", { className: "settings-section", children: [_jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Display name" }), _jsx("input", { value: draft.displayName, onChange: (e) => update('displayName', e.target.value) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Kind" }), _jsxs("select", { value: draft.kind, onChange: (e) => update('kind', e.target.value), children: [_jsx("option", { value: "wtg", children: "WTG" }), _jsx("option", { value: "bess", children: "BESS" }), _jsx("option", { value: "auxiliary", children: "Auxiliary" })] })] })] }), draft.kind === 'wtg' && (_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Rotor diameter (m)" }), _jsx("input", { type: "number", min: 20, max: 300, value: draft.rotorDiameterM ?? '', onChange: (e) => update('rotorDiameterM', +e.target.value || undefined) })] })), draft.kind === 'auxiliary' && (_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Sub-type (free text)" }), _jsx("input", { value: draft.auxiliaryType ?? '', onChange: (e) => update('auxiliaryType', e.target.value) })] }))] }), _jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Modes" }), _jsxs("div", { className: "seg block", style: { flexWrap: 'wrap' }, children: [draft.modes.map((md, i) => (_jsx("button", { className: i === activeModeIdx ? 'on' : '', onClick: () => setActiveModeIdx(i), children: md.name }, i))), _jsx("button", { onClick: addMode, children: "+ mode" })] }), m && (_jsxs(_Fragment, { children: [_jsxs("div", { className: "grid-2", style: { marginTop: 6 }, children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Mode name" }), _jsx("input", { value: m.name, onChange: (e) => updateMode(activeModeIdx, { name: e.target.value }) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Band system" }), _jsxs("select", { value: m.bandSystem, onChange: (e) => {
                                                                const next = e.target.value;
                                                                // Re-snap frequency range when band system flips.
                                                                const all = bandList(next);
                                                                updateMode(activeModeIdx, {
                                                                    bandSystem: next,
                                                                    frequencies: all.slice(),
                                                                    spectra: Object.fromEntries(Object.keys(m.spectra).map((k) => [k, all.map(() => 80)])),
                                                                });
                                                            }, children: [_jsx("option", { value: "octave", children: "Octave (16 Hz \u2013 8 kHz)" }), _jsx("option", { value: "oneThirdOctave", children: "One-third octave (10 Hz \u2013 10 kHz)" })] })] })] }), _jsx(FrequencyRangePicker, { bandSystem: m.bandSystem, frequencies: m.frequencies, onChange: (fs) => {
                                                const newSpectra = {};
                                                for (const k of Object.keys(m.spectra)) {
                                                    const old = m.spectra[k];
                                                    const oldFs = m.frequencies;
                                                    newSpectra[k] = fs.map((f) => {
                                                        const oldIdx = oldFs.indexOf(f);
                                                        return oldIdx >= 0 ? old[oldIdx] : 0;
                                                    });
                                                }
                                                updateMode(activeModeIdx, { frequencies: fs, spectra: newSpectra });
                                            } }), draft.kind === 'wtg' && (_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Wind speeds (m/s @ 10 m, comma-separated; blank = broadband)" }), _jsx("input", { value: (m.windSpeeds ?? []).join(', '), onChange: (e) => {
                                                        const ws = e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
                                                        const newSpectra = {};
                                                        if (ws.length === 0) {
                                                            newSpectra['broadband'] = m.frequencies.map(() => 80);
                                                            updateMode(activeModeIdx, { windSpeeds: undefined, spectra: newSpectra });
                                                            return;
                                                        }
                                                        for (const w of ws) {
                                                            const k = String(w);
                                                            newSpectra[k] = m.spectra[k] ?? m.frequencies.map(() => 80);
                                                        }
                                                        updateMode(activeModeIdx, { windSpeeds: ws, spectra: newSpectra });
                                                    } })] })), _jsx("div", { style: { overflowX: 'auto' }, children: _jsxs("table", { className: "catalog-table", style: { fontFamily: 'var(--font-mono)', fontSize: 11 }, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "Hz" }), wsKeys.map((k) => (_jsx("th", { style: { textAlign: 'right' }, children: k === 'broadband' ? 'Lw' : `${k} m/s` }, k)))] }) }), _jsx("tbody", { children: m.frequencies.map((f, i) => (_jsxs("tr", { children: [_jsx("td", { children: formatHz(f) }), wsKeys.map((k) => (_jsx("td", { style: { textAlign: 'right', padding: 2 }, children: _jsx("input", { type: "number", step: 0.1, value: m.spectra[k]?.[i] ?? 0, onChange: (e) => {
                                                                            const next = (m.spectra[k] ?? []).slice();
                                                                            next[i] = +e.target.value;
                                                                            updateMode(activeModeIdx, {
                                                                                spectra: { ...m.spectra, [k]: next },
                                                                            });
                                                                        }, style: { width: 60, fontFamily: 'inherit', fontSize: 11, padding: '2px 4px', textAlign: 'right' } }) }, k)))] }, `${f}-${i}`))) })] }) }), draft.modes.length > 1 && (_jsx("div", { className: "add-row", style: { marginTop: 6 }, children: _jsx("button", { className: "btn small", style: { color: 'var(--red)' }, onClick: () => removeMode(activeModeIdx), children: "Delete this mode" }) }))] }))] }), _jsx("section", { className: "settings-section", children: _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Default mode" }), _jsx("select", { value: draft.defaultMode, onChange: (e) => update('defaultMode', e.target.value), children: draft.modes.map((md) => _jsx("option", { value: md.name, children: md.name }, md.name)) })] }) })] }), _jsxs("div", { className: "modal-footer", children: [_jsx("button", { className: "btn", onClick: props.onClose, children: "Cancel" }), _jsx("button", { className: "btn primary", onClick: () => props.onSave(draft), children: "Save" })] })] }) }));
}
