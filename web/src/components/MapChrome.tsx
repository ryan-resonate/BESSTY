// Floating "glass" chrome that sits on top of the map. Layer / palette /
// DEM controls have moved to the side panel's Layers tab; what stays on the
// map is the legend, results dock, and status bar.

import { useState } from 'react';
import type { Project } from '../lib/types';
import { summariseDiagnostics, type Diagnostic } from '../lib/diagnostics';
import { limitForPeriod } from '../lib/types';
import { exceedsLimit, limitComparisonFor } from '../lib/limits';
import type { GridResult, ReceiverResult } from '../lib/solver';
import type { Palette } from '../lib/colormap';
import { paletteCss, makeBandsForRange } from '../lib/colormap';

interface LegendProps {
  palette: Palette;
  domain: { min: number; max: number };
  stepDb?: number;
  receiverDb: number[];
}

export function Legend({ palette, domain, stepDb, receiverDb }: LegendProps) {
  const bands = makeBandsForRange(domain.min, domain.max, stepDb);
  const count = (lo: number, hi: number) =>
    receiverDb.filter((v) => isFinite(v) && v >= lo && v < hi).length;
  return (
    <div className="map-chrome legend">
      <div className="chrome-title">Lp <span className="muted">dB(A)</span></div>
      {bands.slice().reverse().map((b) => {
        const tCentre = (b.lo + b.hi) / 2;
        const t = Math.max(0, Math.min(1, (tCentre - domain.min) / (domain.max - domain.min || 1)));
        const col = paletteCss(palette, t);
        const c = count(b.lo, b.hi);
        return (
          <div key={b.label} className="legend-row">
            <span className="legend-swatch" style={{ background: col }} />
            <span className="legend-label">{b.label}</span>
            <span className="legend-count">{c > 0 ? c : ''}</span>
          </div>
        );
      })}
      <div className="legend-foot muted">
        domain: {domain.min.toFixed(0)} – {domain.max.toFixed(0)}
      </div>
    </div>
  );
}

interface ResultsDockProps {
  project: Project;
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  computing: boolean;
  lastSolveMs: number | null;
  gridStatus: 'idle' | 'computing' | 'ready';
  onRunGrid(): void;
  /// I12: live tile progress while a grid is solving, or null.
  gridProgress?: { done: number; total: number } | null;
  /// I12: kill the running solve. Absent = no cancel affordance.
  onCancelGrid?(): void;
  /// I20: approximations the last solve applied.
  diagnostics?: Diagnostic[];
}

/// I20 — the count is always visible when non-zero; the detail is one click
/// away. Deliberately not a toast: these are a property of the result, not an
/// event, so they belong next to the result and must not be dismissable.
function DiagnosticsRow({ items }: { items: Diagnostic[] }) {
  const [open, setOpen] = useState(false);
  const summary = summariseDiagnostics(items);
  const hasMaterial = items.some((d) => d.severity === 'material');
  return (
    <div className="dock-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
      <button
        className="btn small"
        onClick={() => setOpen(!open)}
        title="Approximations applied to this solve"
        style={{
          textAlign: 'left',
          color: hasMaterial ? 'var(--amber, #b26a00)' : 'var(--ink-soft, #475569)',
        }}
      >
        {open ? '▾' : '▸'} {hasMaterial ? '⚠' : 'ℹ'} {summary}
      </button>
      {open && (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: 11, lineHeight: 1.4 }}>
          {items.map((d) => (
            <li key={d.code} style={{ marginBottom: 4 }}>
              {d.message}
              {d.count > 1 && (
                <span style={{ color: 'var(--ink-soft, #475569)' }}> (×{d.count})</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ResultsDock(props: ResultsDockProps) {
  const {
    project, results, grid, computing, lastSolveMs, gridStatus, onRunGrid,
    gridProgress, onCancelGrid, diagnostics,
  } = props;
  // null until the first tile reports, so the bar can be indeterminate.
  const pct = gridProgress && gridProgress.total > 0
    ? Math.min(100, Math.round((gridProgress.done / gridProgress.total) * 100))
    : null;
  const mode = limitComparisonFor(project);
  const exceedances = (results ?? []).filter((r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    return rx && exceedsLimit(r.totalDbA, limitForPeriod(rx, project.scenario.period), mode);
  });
  // `over` stays the TRUE margin (it tells you how close you are), but the
  // colour must come from the same rule as everything else — otherwise a
  // receiver at 40.4 against a 40 limit reads green on the map and red here.
  const worst = (results ?? []).reduce<{ id: string; over: number; fail: boolean } | null>((acc, r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    if (!rx || !isFinite(r.totalDbA)) return acc;
    const limit = limitForPeriod(rx, project.scenario.period);
    const over = r.totalDbA - limit;
    if (!acc || over > acc.over) {
      return { id: r.receiverId, over, fail: exceedsLimit(r.totalDbA, limit, mode) };
    }
    return acc;
  }, null);
  const total = project.receivers.length;
  const pass = total - exceedances.length;

  return (
    <div className="map-chrome dock">
      <div className="dock-row">
        <div className="dock-label">Receivers</div>
        <div className="dock-bar">
          <span style={{ width: total > 0 ? `${(pass / total) * 100}%` : 0 }} className="dock-bar-pass" />
        </div>
        <div className="dock-counts">
          <span className="ok">{pass} ok</span>
          {exceedances.length > 0 && <span className="fail">· {exceedances.length} over</span>}
          <span className="muted"> / {total}</span>
        </div>
      </div>
      {worst && worst.over > -50 && (
        <div className="dock-row dock-detail">
          <span className="muted">Worst:</span>
          <span style={{ color: worst.fail ? 'var(--red)' : 'var(--green)' }}>
            {project.receivers.find((r) => r.id === worst.id)?.name ?? worst.id}
            {' '}{worst.over > 0 ? '+' : ''}{worst.over.toFixed(1)} dB
          </span>
        </div>
      )}
      {diagnostics && diagnostics.length > 0 && (
        <DiagnosticsRow items={diagnostics} />
      )}
      <div className="dock-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
        {gridStatus === 'computing' ? (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn block" disabled style={{ flex: 1 }}>
                {pct == null ? 'Computing grid…' : `Computing ${pct}%…`}
              </button>
              {onCancelGrid && (
                <button
                  className="btn"
                  onClick={onCancelGrid}
                  title="Stop the grid solve"
                  style={{ color: 'var(--red)' }}
                >Cancel</button>
              )}
            </div>
            {/* Indeterminate until the first tile lands — a bar sitting at 0%
                reads as "stuck", which is the impression we're fixing. */}
            <div className="dock-bar">
              <span
                className="dock-bar-pass"
                style={{
                  width: pct == null ? '100%' : `${pct}%`,
                  opacity: pct == null ? 0.35 : 1,
                }}
              />
            </div>
          </>
        ) : (
          <button className="btn primary block" disabled={computing} onClick={onRunGrid}>
            {grid ? '↻ Recompute grid' : '▶ Run grid'}
          </button>
        )}
      </div>
      <div className="dock-row dock-meta">
        {lastSolveMs != null && <span>solve: {lastSolveMs.toFixed(0)} ms</span>}
        {grid && <span>grid: {grid.cols}×{grid.rows} · {grid.computedMs.toFixed(0)} ms</span>}
      </div>
    </div>
  );
}

interface StatusBarProps {
  project: Project;
  selectedIds: Set<string>;
  cursorLatLng: [number, number] | null;
}

export function StatusBar({ project, selectedIds, cursorLatLng }: StatusBarProps) {
  // For the status bar we just highlight the first selected item by name
  // (or the count when multi-selected).
  const ids = Array.from(selectedIds);
  const sel = ids.length === 1
    ? (project.sources.find((s) => s.id === ids[0]) ??
       project.receivers.find((r) => r.id === ids[0]))
    : null;
  return (
    <div className="map-chrome status-bar">
      <span><b>{project.name}</b></span>
      <span className="muted">·</span>
      <span>{project.scenario.windSpeed} m/s</span>
      <span className="muted">·</span>
      <span>{project.scenario.period}</span>
      <span className="muted">·</span>
      <span>{project.sources.length} src · {project.receivers.length} rcv</span>
      {sel && (
        <>
          <span className="muted">·</span>
          <span style={{ color: 'var(--ink)' }}>selected: <b>{(sel as { name: string }).name}</b></span>
        </>
      )}
      {ids.length > 1 && (
        <>
          <span className="muted">·</span>
          <span style={{ color: 'var(--ink)' }}><b>{ids.length}</b> selected</span>
        </>
      )}
      {cursorLatLng && (
        <span className="cursor-pos">
          {cursorLatLng[0].toFixed(5)}, {cursorLatLng[1].toFixed(5)}
        </span>
      )}
    </div>
  );
}
