import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
// Reusable CRS picker for import dialogs. Renders a single <select> with
// optgroups for Geographic / Web / MGA94 / MGA2020 / NZTM / UK / UTM, plus
// a "Custom proj4 string…" entry that pops a small inline prompt.
//
// All EPSGs in the dropdown are pre-registered with proj4 on module load
// (see lib/projections.ts) — the parent component just reads `value` and
// passes it to `toWgs84` / `fromWgs84`.
import { useMemo, useState } from 'react';
import { groupedEpsgPresets, registerCustomEpsg } from '../lib/projections';
export function EpsgPicker({ value, onChange, label = 'Coordinate system', hint }) {
    const groups = useMemo(() => groupedEpsgPresets(), []);
    const [showCustom, setShowCustom] = useState(false);
    const [customCode, setCustomCode] = useState('');
    const [customDef, setCustomDef] = useState('');
    function handleSelectChange(v) {
        if (v === '__custom__') {
            setShowCustom(true);
            return;
        }
        const epsg = parseInt(v, 10);
        if (Number.isFinite(epsg))
            onChange(epsg);
    }
    function commitCustom() {
        const code = parseInt(customCode, 10);
        if (!Number.isFinite(code) || !customDef.trim()) {
            alert('Enter a numeric EPSG code and a proj4 definition string.');
            return;
        }
        registerCustomEpsg(code, customDef.trim());
        onChange(code);
        setShowCustom(false);
        setCustomCode('');
        setCustomDef('');
    }
    return (_jsxs("label", { className: "fld", children: [_jsx("span", { children: label }), _jsxs("select", { value: String(value), onChange: (e) => handleSelectChange(e.target.value), children: [groups.map((g) => (_jsx("optgroup", { label: g.group, children: g.presets.map((p) => (_jsx("option", { value: String(p.code), children: p.label }, p.code))) }, g.group))), _jsx("optgroup", { label: "Other", children: _jsx("option", { value: "__custom__", children: "Custom proj4 string\u2026" }) })] }), hint && _jsx("div", { className: "hint", children: hint }), showCustom && (_jsxs("div", { className: "settings-section", style: { marginTop: 6 }, children: [_jsxs("div", { className: "hint", children: ["Paste a proj4 definition (e.g. from ", _jsx("a", { href: "https://epsg.io", target: "_blank", rel: "noreferrer", children: "epsg.io" }), "). BEESTY will register it for the rest of this session."] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "EPSG code" }), _jsx("input", { type: "number", value: customCode, onChange: (e) => setCustomCode(e.target.value), placeholder: "e.g. 32633" })] }), _jsxs("label", { className: "fld", children: [_jsx("span", { children: "proj4 definition" }), _jsx("input", { type: "text", value: customDef, onChange: (e) => setCustomDef(e.target.value), placeholder: "+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs" })] }), _jsxs("div", { className: "add-row", children: [_jsx("button", { className: "btn small primary", onClick: commitCustom, children: "Use" }), _jsx("button", { className: "btn small", onClick: () => setShowCustom(false), children: "Cancel" })] })] }))] }));
}
