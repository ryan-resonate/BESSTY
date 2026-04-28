// Floating "glass" chrome that sits on top of the map. Layer / palette /
// DEM controls have moved to the side panel's Layers tab; what stays on the
// map is the legend, results dock, and status bar.

import type { Project } from '../lib/types';
import { limitForPeriod } from '../lib/types';
import type { GridResult, ReceiverResult } from '../lib/solver';
import type { Palette } from '../lib/colormap';
import { paletteCss, makeBandsForRange } from '../lib/colormap';

interface LegendProps {
  palette: Palette;
  domain: { min: number; max: number };
  receiverDb: number[];
}

export function Legend({ palette, domain, receiverDb }: LegendProps) {
  const bands = makeBandsForRange(domain.min, domain.max);
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
  /// True when an extrapolation breached the cap and a background re-snapshot
  /// is in flight — the displayed values are clamped to ±cap from the last
  /// snapshot until the new one lands.
  snapshotStale: boolean;
  onRunGrid(): void;
}

export function ResultsDock(props: ResultsDockProps) {
  const { project, results, grid, computing, lastSolveMs, gridStatus, snapshotStale, onRunGrid } = props;
  const exceedances = (results ?? []).filter((r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    return rx && r.totalDbA > limitForPeriod(rx, project.scenario.period);
  });
  const worst = (results ?? []).reduce<{ id: string; over: number } | null>((acc, r) => {
    const rx = project.receivers.find((x) => x.id === r.receiverId);
    if (!rx || !isFinite(r.totalDbA)) return acc;
    const over = r.totalDbA - limitForPeriod(rx, project.scenario.period);
    if (!acc || over > acc.over) return { id: r.receiverId, over };
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
          <span style={{ color: worst.over > 0 ? 'var(--red)' : 'var(--green)' }}>
            {project.receivers.find((r) => r.id === worst.id)?.name ?? worst.id}
            {' '}{worst.over > 0 ? '+' : ''}{worst.over.toFixed(1)} dB
          </span>
        </div>
      )}
      <div className="dock-row">
        <button className="btn primary block" disabled={computing || gridStatus === 'computing'} onClick={onRunGrid}>
          {gridStatus === 'computing' ? 'Computing grid…' : grid ? '↻ Recompute grid' : '▶ Run grid'}
        </button>
      </div>
      {snapshotStale && (
        <div className="dock-row" style={{ background: 'rgba(245, 158, 11, 0.15)', padding: '4px 8px', borderRadius: 4, fontSize: 11 }}>
          <span style={{ color: 'var(--amber)', fontWeight: 600 }}>● Refining…</span>
          <span className="muted">drag exceeded cap, re-snapshotting</span>
        </div>
      )}
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
