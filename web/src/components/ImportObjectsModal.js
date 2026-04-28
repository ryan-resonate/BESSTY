import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
// One modal for importing receiver / source location lists from any of:
// CSV, KML, or shapefile bundles. The user picks the file, picks the
// **kind** (Receivers / WTGs / BESS / Auxiliary), maps attributes,
// optionally picks a CRS (CSV always; shapefile if no .prj sidecar),
// and commits.
import { useState } from 'react';
import { guessLocationMapping, parseLocations, reprojectShapefileFeature, } from '../lib/locationImport';
import { listEntriesByKind } from '../lib/catalog';
import { toWgs84 } from '../lib/projections';
import { EpsgPicker } from './EpsgPicker';
let nextId = 7000;
function newId(prefix) { nextId += 1; return `${prefix}-${nextId}`; }
const KIND_LABEL = {
    receiver: 'Receivers',
    wtg: 'Wind turbines',
    bess: 'BESS',
    auxiliary: 'Auxiliary equipment',
};
export function ImportObjectsModal({ project, setProject, initialKind = 'receiver', onClose }) {
    const [parsed, setParsed] = useState(null);
    const [kind, setKind] = useState(initialKind);
    const [mapping, setMapping] = useState({});
    /// CRS the user has selected for the imported coords. Defaults to WGS84.
    /// For CSV → applied to (X, Y) columns. For shapefile-without-prj →
    /// applied to native (x, y) stored on each feature. KML always 4326.
    const [crsEpsg, setCrsEpsg] = useState(4326);
    const [defaultLimitDay, setDefaultLimitDay] = useState(50);
    const [defaultLimitEvening, setDefaultLimitEvening] = useState(45);
    const [defaultLimitNight, setDefaultLimitNight] = useState(40);
    const [defaultHeight, setDefaultHeight] = useState(1.5);
    const [defaultHubHeight, setDefaultHubHeight] = useState(100);
    const [parsing, setParsing] = useState(false);
    const [error, setError] = useState(null);
    function objectKindToImportKind(k) {
        return k === 'receiver' ? 'receiver' : 'source';
    }
    async function handleFile(f) {
        setError(null);
        setParsing(true);
        try {
            const result = await parseLocations(f);
            setParsed(result);
            setMapping(guessLocationMapping(result.attributeNames, objectKindToImportKind(kind), result.format));
            setDefaultHeight(kind === 'receiver' ? 1.5 : 100);
            // Initialise the CRS picker from whatever the parser inferred.
            // KML → 4326 (locked); shapefile w/ prj → 4326 (locked); else WGS84
            // as a sensible default the user can change.
            setCrsEpsg(result.nativeEpsg ?? 4326);
        }
        catch (e) {
            setError(String(e));
        }
        setParsing(false);
    }
    // When the user changes the target kind after parsing, refresh defaults.
    function onKindChange(k) {
        setKind(k);
        if (parsed) {
            setMapping(guessLocationMapping(parsed.attributeNames, objectKindToImportKind(k), parsed.format));
        }
        setDefaultHeight(k === 'receiver' ? 1.5 : 100);
    }
    function applyImport() {
        if (!parsed)
            return;
        const ik = objectKindToImportKind(kind);
        const isCsv = parsed.format === 'csv';
        const isShapefileNoPrj = parsed.format === 'shapefile' && parsed.nativeEpsg !== 4326;
        if (isCsv && (!mapping.x || !mapping.y)) {
            alert('CSV import needs columns assigned to X (longitude / easting) and Y (latitude / northing).');
            return;
        }
        const xCol = mapping.x;
        const yCol = mapping.y;
        const nameCol = mapping.name;
        function latLngFor(f) {
            if (isCsv) {
                const x = parseFloat(String(f.properties[xCol]));
                const y = parseFloat(String(f.properties[yCol]));
                if (!Number.isFinite(x) || !Number.isFinite(y))
                    return null;
                if (crsEpsg === 4326)
                    return [y, x];
                try {
                    return toWgs84(crsEpsg, x, y);
                }
                catch {
                    return null;
                }
            }
            if (isShapefileNoPrj) {
                try {
                    const ll = reprojectShapefileFeature(f, crsEpsg);
                    return ll;
                }
                catch {
                    return null;
                }
            }
            // KML / shapefile-with-prj — geometry already in WGS84.
            return Number.isFinite(f.latLng[0]) && Number.isFinite(f.latLng[1]) ? f.latLng : null;
        }
        if (ik === 'receiver') {
            const limDay = mapping.limitDayDbA;
            const limEve = mapping.limitEveningDbA;
            const limNight = mapping.limitNightDbA;
            const hCol = mapping.heightAboveGroundM;
            const newReceivers = parsed.features.flatMap((f) => {
                const ll = latLngFor(f);
                if (!ll)
                    return [];
                const id = newId('R');
                return [{
                        id,
                        name: nameCol ? String(f.properties[nameCol] || id) : id,
                        latLng: ll,
                        heightAboveGroundM: hCol && f.properties[hCol] != null ? +f.properties[hCol] : defaultHeight,
                        limitDayDbA: limDay && f.properties[limDay] != null ? +f.properties[limDay] : defaultLimitDay,
                        limitEveningDbA: limEve && f.properties[limEve] != null ? +f.properties[limEve] : defaultLimitEvening,
                        limitNightDbA: limNight && f.properties[limNight] != null ? +f.properties[limNight] : defaultLimitNight,
                    }];
            });
            setProject({ ...project, receivers: [...project.receivers, ...newReceivers] });
        }
        else {
            const sk = kind;
            const candidates = listEntriesByKind(project, sk);
            if (candidates.length === 0) {
                alert(`No ${sk} catalog entries available — add one before importing sources of this kind.`);
                return;
            }
            const fallback = candidates[0];
            const modelCol = mapping.modelId;
            const modeCol = mapping.mode;
            const hubCol = mapping.hubHeight;
            const newSources = parsed.features.flatMap((f) => {
                const ll = latLngFor(f);
                if (!ll)
                    return [];
                const id = newId(sk.toUpperCase());
                let chosen = fallback;
                if (modelCol && f.properties[modelCol] != null) {
                    const want = String(f.properties[modelCol]).toLowerCase();
                    const match = candidates.find((c) => c.id.toLowerCase() === want
                        || c.displayName.toLowerCase() === want
                        || c.displayName.toLowerCase().includes(want));
                    if (match)
                        chosen = match;
                }
                const modeName = modeCol && f.properties[modeCol] != null
                    ? (chosen.modes.find((m) => m.name.toLowerCase() === String(f.properties[modeCol]).toLowerCase())?.name ?? chosen.defaultMode)
                    : chosen.defaultMode;
                const base = {
                    id, kind: sk,
                    catalogScope: chosen._scope,
                    name: nameCol ? String(f.properties[nameCol] || id) : id,
                    latLng: ll,
                    modelId: chosen.id,
                    modeOverride: modeName,
                };
                if (sk === 'wtg') {
                    base.hubHeight = hubCol && f.properties[hubCol] != null ? +f.properties[hubCol] : defaultHubHeight;
                }
                else {
                    base.elevationOffset = 0;
                }
                return [base];
            });
            setProject({ ...project, sources: [...project.sources, ...newSources] });
        }
        onClose();
    }
    // Field set per kind. CSV has X/Y; KML and shapefile already carry geometry,
    // so X/Y rows are hidden for those formats.
    const fieldsFor = (k, fmt) => {
        const xy = (fmt === 'csv') ? [
            { key: 'x', label: 'X column (longitude / easting)', required: true },
            { key: 'y', label: 'Y column (latitude / northing)', required: true },
        ] : [];
        if (k === 'receiver') {
            return [
                { key: 'name', label: 'Name attribute' },
                ...xy,
                { key: 'heightAboveGroundM', label: 'Height above ground (m)' },
                { key: 'limitDayDbA', label: 'Day limit dB(A)' },
                { key: 'limitEveningDbA', label: 'Evening limit dB(A)' },
                { key: 'limitNightDbA', label: 'Night limit dB(A)' },
            ];
        }
        return [
            { key: 'name', label: 'Name attribute' },
            ...xy,
            { key: 'modelId', label: 'Catalog model attribute' },
            { key: 'mode', label: 'Mode attribute' },
            { key: 'hubHeight', label: 'Hub height (WTG only)' },
        ];
    };
    // CRS picker is shown for CSV (always) and shapefile-without-prj. KML
    // and shapefile-with-prj are locked to WGS84.
    const showCrsPicker = parsed != null && (parsed.format === 'csv'
        || (parsed.format === 'shapefile' && parsed.nativeEpsg !== 4326));
    const crsLockedNote = parsed?.format === 'kml'
        ? 'KML is always WGS84 (EPSG:4326).'
        : (parsed?.format === 'shapefile' && parsed.shapefileHadPrj)
            ? 'Shapefile reprojected from .prj to WGS84.'
            : null;
    return (_jsx("div", { className: "modal-backdrop", onClick: onClose, children: _jsxs("div", { className: "modal", onClick: (e) => e.stopPropagation(), style: { maxWidth: 720 }, children: [_jsxs("div", { className: "modal-header", children: [_jsx("h2", { children: "Import objects" }), _jsx("button", { className: "x-btn", onClick: onClose, children: "\u2715" })] }), _jsxs("div", { className: "modal-body", children: [_jsxs("section", { className: "settings-section", children: [_jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Import as" }), _jsx("select", { value: kind, onChange: (e) => onKindChange(e.target.value), children: ['receiver', 'wtg', 'bess', 'auxiliary'].map((k) => (_jsx("option", { value: k, children: KIND_LABEL[k] }, k))) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "File" }), _jsx("input", { type: "file", accept: ".csv,.txt,.kml,.zip,.shp", disabled: parsing, onChange: (e) => {
                                                        const f = e.target.files?.[0];
                                                        if (f)
                                                            handleFile(f);
                                                    } })] })] }), _jsxs("div", { className: "hint", children: ["Accepts ", _jsx("b", { children: ".csv" }), ", ", _jsx("b", { children: ".kml" }), ", or a ", _jsx("b", { children: ".zip" }), " containing a shapefile bundle (.shp + .dbf + .prj). CSV defaults to WGS84 lat/lng but accepts any registered projected CRS (UTM, MGA, NZTM, \u2026). KML is always WGS84. Shapefiles auto-reproject from the .prj sidecar when present; otherwise pick a CRS below."] }), parsing && _jsx("div", { className: "hint", children: "Parsing\u2026" }), error && _jsxs("div", { className: "hint", style: { color: 'var(--red)' }, children: ["Error: ", error] })] }), parsed && (_jsxs(_Fragment, { children: [showCrsPicker && (_jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Coordinate system" }), _jsx(EpsgPicker, { value: crsEpsg, onChange: setCrsEpsg, label: "Source CRS", hint: parsed.format === 'csv'
                                                ? 'Pick the CRS the X / Y columns are in. BEESTY reprojects to WGS84 on import.'
                                                : 'Shapefile lacks a usable .prj — pick the CRS its coordinates are in.' })] })), crsLockedNote && (_jsx("section", { className: "settings-section", children: _jsx("div", { className: "hint", children: crsLockedNote }) })), _jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Map attributes" }), _jsxs("div", { className: "hint", children: [parsed.features.length, " feature", parsed.features.length === 1 ? '' : 's', ' · ', parsed.attributeNames.length, " attribute", parsed.attributeNames.length === 1 ? '' : 's', ' · ', parsed.format] }), parsed.warnings.map((w, i) => (_jsxs("div", { className: "hint", style: { color: 'var(--amber)' }, children: ["\u26A0 ", w] }, i))), fieldsFor(kind, parsed.format).map((f) => (_jsxs("label", { className: "fld", children: [_jsxs("span", { children: [f.label, f.required ? ' *' : ''] }), _jsxs("select", { value: mapping[f.key] ?? '', onChange: (e) => setMapping({ ...mapping, [f.key]: e.target.value || null }), children: [_jsx("option", { value: "", children: "\u2014 none \u2014" }), parsed.attributeNames.map((h) => _jsx("option", { value: h, children: h }, h))] })] }, f.key)))] }), kind === 'receiver' && (_jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Defaults (used when the attribute is unmapped or blank)" }), _jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Height (m)" }), _jsx("input", { type: "number", min: 0, max: 300, step: 0.5, value: defaultHeight, onChange: (e) => setDefaultHeight(+e.target.value) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Day limit dB(A)" }), _jsx("input", { type: "number", min: 20, max: 80, value: defaultLimitDay, onChange: (e) => setDefaultLimitDay(+e.target.value) })] })] }), _jsxs("div", { className: "grid-2", children: [_jsxs("label", { className: "fld", children: [_jsx("span", { children: "Evening limit dB(A)" }), _jsx("input", { type: "number", min: 20, max: 80, value: defaultLimitEvening, onChange: (e) => setDefaultLimitEvening(+e.target.value) })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Night limit dB(A)" }), _jsx("input", { type: "number", min: 20, max: 80, value: defaultLimitNight, onChange: (e) => setDefaultLimitNight(+e.target.value) })] })] })] })), kind === 'wtg' && (_jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Defaults" }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "Hub height (m, when not in file)" }), _jsx("input", { type: "number", min: 50, max: 250, value: defaultHubHeight, onChange: (e) => setDefaultHubHeight(+e.target.value) })] })] })), _jsxs("section", { className: "settings-section", children: [_jsx("h3", { children: "Preview (first 5 features)" }), _jsx("div", { style: { overflowX: 'auto' }, children: _jsxs("table", { className: "catalog-table", style: { fontFamily: 'var(--font-mono)', fontSize: 11 }, children: [_jsx("thead", { children: _jsxs("tr", { children: [_jsx("th", { children: "lat" }), _jsx("th", { children: "lng" }), parsed.attributeNames.map((h) => _jsx("th", { children: h }, h))] }) }), _jsx("tbody", { children: parsed.features.slice(0, 5).map((f, i) => (_jsxs("tr", { children: [_jsx("td", { children: Number.isFinite(f.latLng[0]) ? f.latLng[0].toFixed(5) : '—' }), _jsx("td", { children: Number.isFinite(f.latLng[1]) ? f.latLng[1].toFixed(5) : '—' }), parsed.attributeNames.map((h) => _jsx("td", { children: String(f.properties[h] ?? '') }, h))] }, i))) })] }) })] })] }))] }), _jsxs("div", { className: "modal-footer", children: [_jsx("button", { className: "btn", onClick: onClose, children: "Cancel" }), _jsxs("button", { className: "btn primary", disabled: !parsed || (parsed.format === 'csv' && (!mapping.x || !mapping.y)), onClick: applyImport, children: ["Import ", parsed ? `${parsed.features.length} ${KIND_LABEL[kind].toLowerCase()}` : ''] })] })] }) }));
}
