import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { limitForPeriod } from '../lib/types';
import { paletteCss, makeBandsForRange } from '../lib/colormap';
export function Legend({ palette, domain, stepDb, receiverDb }) {
    const bands = makeBandsForRange(domain.min, domain.max, stepDb);
    const count = (lo, hi) => receiverDb.filter((v) => isFinite(v) && v >= lo && v < hi).length;
    return (_jsxs("div", { className: "map-chrome legend", children: [_jsxs("div", { className: "chrome-title", children: ["Lp ", _jsx("span", { className: "muted", children: "dB(A)" })] }), bands.slice().reverse().map((b) => {
                const tCentre = (b.lo + b.hi) / 2;
                const t = Math.max(0, Math.min(1, (tCentre - domain.min) / (domain.max - domain.min || 1)));
                const col = paletteCss(palette, t);
                const c = count(b.lo, b.hi);
                return (_jsxs("div", { className: "legend-row", children: [_jsx("span", { className: "legend-swatch", style: { background: col } }), _jsx("span", { className: "legend-label", children: b.label }), _jsx("span", { className: "legend-count", children: c > 0 ? c : '' })] }, b.label));
            }), _jsxs("div", { className: "legend-foot muted", children: ["domain: ", domain.min.toFixed(0), " \u2013 ", domain.max.toFixed(0)] })] }));
}
export function ResultsDock(props) {
    const { project, results, grid, computing, lastSolveMs, gridStatus, snapshotStale, onRunGrid } = props;
    const exceedances = (results ?? []).filter((r) => {
        const rx = project.receivers.find((x) => x.id === r.receiverId);
        return rx && r.totalDbA > limitForPeriod(rx, project.scenario.period);
    });
    const worst = (results ?? []).reduce((acc, r) => {
        const rx = project.receivers.find((x) => x.id === r.receiverId);
        if (!rx || !isFinite(r.totalDbA))
            return acc;
        const over = r.totalDbA - limitForPeriod(rx, project.scenario.period);
        if (!acc || over > acc.over)
            return { id: r.receiverId, over };
        return acc;
    }, null);
    const total = project.receivers.length;
    const pass = total - exceedances.length;
    return (_jsxs("div", { className: "map-chrome dock", children: [_jsxs("div", { className: "dock-row", children: [_jsx("div", { className: "dock-label", children: "Receivers" }), _jsx("div", { className: "dock-bar", children: _jsx("span", { style: { width: total > 0 ? `${(pass / total) * 100}%` : 0 }, className: "dock-bar-pass" }) }), _jsxs("div", { className: "dock-counts", children: [_jsxs("span", { className: "ok", children: [pass, " ok"] }), exceedances.length > 0 && _jsxs("span", { className: "fail", children: ["\u00B7 ", exceedances.length, " over"] }), _jsxs("span", { className: "muted", children: [" / ", total] })] })] }), worst && worst.over > -50 && (_jsxs("div", { className: "dock-row dock-detail", children: [_jsx("span", { className: "muted", children: "Worst:" }), _jsxs("span", { style: { color: worst.over > 0 ? 'var(--red)' : 'var(--green)' }, children: [project.receivers.find((r) => r.id === worst.id)?.name ?? worst.id, ' ', worst.over > 0 ? '+' : '', worst.over.toFixed(1), " dB"] })] })), _jsx("div", { className: "dock-row", children: _jsx("button", { className: "btn primary block", disabled: computing || gridStatus === 'computing', onClick: onRunGrid, children: gridStatus === 'computing' ? 'Computing grid…' : grid ? '↻ Recompute grid' : '▶ Run grid' }) }), snapshotStale && (_jsxs("div", { className: "dock-row", style: { background: 'rgba(245, 158, 11, 0.15)', padding: '4px 8px', borderRadius: 4, fontSize: 11 }, children: [_jsx("span", { style: { color: 'var(--amber)', fontWeight: 600 }, children: "\u25CF Refining\u2026" }), _jsx("span", { className: "muted", children: "drag exceeded cap, re-snapshotting" })] })), _jsxs("div", { className: "dock-row dock-meta", children: [lastSolveMs != null && _jsxs("span", { children: ["solve: ", lastSolveMs.toFixed(0), " ms"] }), grid && _jsxs("span", { children: ["grid: ", grid.cols, "\u00D7", grid.rows, " \u00B7 ", grid.computedMs.toFixed(0), " ms"] })] })] }));
}
export function StatusBar({ project, selectedIds, cursorLatLng }) {
    // For the status bar we just highlight the first selected item by name
    // (or the count when multi-selected).
    const ids = Array.from(selectedIds);
    const sel = ids.length === 1
        ? (project.sources.find((s) => s.id === ids[0]) ??
            project.receivers.find((r) => r.id === ids[0]))
        : null;
    return (_jsxs("div", { className: "map-chrome status-bar", children: [_jsx("span", { children: _jsx("b", { children: project.name }) }), _jsx("span", { className: "muted", children: "\u00B7" }), _jsxs("span", { children: [project.scenario.windSpeed, " m/s"] }), _jsx("span", { className: "muted", children: "\u00B7" }), _jsx("span", { children: project.scenario.period }), _jsx("span", { className: "muted", children: "\u00B7" }), _jsxs("span", { children: [project.sources.length, " src \u00B7 ", project.receivers.length, " rcv"] }), sel && (_jsxs(_Fragment, { children: [_jsx("span", { className: "muted", children: "\u00B7" }), _jsxs("span", { style: { color: 'var(--ink)' }, children: ["selected: ", _jsx("b", { children: sel.name })] })] })), ids.length > 1 && (_jsxs(_Fragment, { children: [_jsx("span", { className: "muted", children: "\u00B7" }), _jsxs("span", { style: { color: 'var(--ink)' }, children: [_jsx("b", { children: ids.length }), " selected"] })] })), cursorLatLng && (_jsxs("span", { className: "cursor-pos", children: [cursorLatLng[0].toFixed(5), ", ", cursorLatLng[1].toFixed(5)] }))] }));
}
