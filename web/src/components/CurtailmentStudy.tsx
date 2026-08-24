// The curtailment optimiser's window: turbine × wind speed, per period.
//
// Every cell is a proven optimum for that (period, wind speed) — the least
// generation that has to be given up for every receiver to comply. See
// `lib/curtailment.ts` for why one solve is enough to evaluate them all, and
// `lib/milp.ts` for the solver.
//
// The table is the deliverable, so it says what it is standing on: which
// receiver is binding in each cell, how much headroom is left, and where a cell
// could not be met at all. A schedule presented without those is a number
// nobody can check.

import { useMemo, useRef, useState } from 'react';

import { FloatingWindow } from './FloatingWindow';
import { notify } from '../lib/notify';
import type { DemRaster } from '../lib/dem';
import type { Period, Project, Source } from '../lib/types';
import { MODE_OFF, MODE_OFF_LABEL, PERIODS, PERIOD_LABEL, withPeriodMode } from '../lib/modes';
import { DEFAULT_DIRECTIVITY, describeWindFrom, sweepDirections } from '../lib/directivity';
import {
  optimiseCurtailment,
  precheckCurtailment,
  type CellResult,
  type CurtailmentResult,
} from '../lib/curtailment';
import { exportCurtailmentXlsx, triggerDownload, defaultFilenameStem } from '../lib/exporters';

export function CurtailmentStudy(props: {
  project: Project;
  dem: DemRaster | null;
  onClose(): void;
  /// Write a cell's schedule into the project's per-period mode overrides.
  onApplySchedule(cell: CellResult): void;
}) {
  const { project, dem, onClose, onApplySchedule } = props;
  const pre = useMemo(() => precheckCurtailment(project), [project]);

  const [periods, setPeriods] = useState<Period[]>([...PERIODS]);
  const [speeds, setSpeeds] = useState<number[]>(pre.windSpeeds);
  const [marginDb, setMarginDb] = useState(0);
  // Off by default: with no direction assumed, every receiver is treated as
  // downwind, which is what ISO 9613-2 does and what the rest of BESSTY
  // reports. Switching it on is opting into a less conservative model.
  const [directional, setDirectional] = useState(false);
  const [stepDeg, setStepDeg] = useState(10);
  const [viewDirection, setViewDirection] = useState<number | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<CurtailmentResult | null>(null);
  const [ranAgainst, setRanAgainst] = useState<Project | null>(null);
  const [viewPeriod, setViewPeriod] = useState<Period>(project.scenario.period);
  const runId = useRef(0);

  const stale = ranAgainst != null && ranAgainst !== project;

  async function run() {
    if (running) return;
    const id = ++runId.current;
    setRunning(true);
    const dirs = directional ? sweepDirections(stepDeg) : [];
    setProgress({ done: 0, total: periods.length * speeds.length * Math.max(1, dirs.length) });
    try {
      const out = await optimiseCurtailment(
        project, dem,
        {
          windSpeeds: speeds, periods, marginDb,
          windDirectionsDeg: dirs,
          directivity: DEFAULT_DIRECTIVITY,
        },
        (done, total) => { if (id === runId.current) setProgress({ done, total }); },
      );
      if (id !== runId.current) return;        // superseded by a later run
      setResult(out);
      setViewDirection(dirs[0]);
      setRanAgainst(project);
      const failed = out.cells.filter((c) => c.status !== 'optimal').length;
      if (failed > 0) {
        notify.warning(
          `${failed} of ${out.cells.length} cells could not be met even with every turbine off.`,
          { title: 'Some cells are infeasible' },
        );
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e), { title: 'Curtailment failed' });
    } finally {
      if (id === runId.current) { setRunning(false); setProgress(null); }
    }
  }

  /// Write a cell's modes into the project.
  ///
  /// A DIRECTIONAL cell needs a word first. Its schedule was chosen having
  /// credited receivers that are not downwind, and BESSTY deliberately reports
  /// no such credit — so the levels on the map will sit above what this cell
  /// assumed, and a receiver can read over its limit while the schedule is
  /// correct for that wind direction. Better said out loud than discovered.
  async function applyCell(c: CellResult) {
    if (c.status !== 'optimal') return;
    if (c.windDirectionDeg !== undefined) {
      const ok = await notify.confirm({
        title: `Apply the schedule for wind from ${describeWindFrom(c.windDirectionDeg)}?`,
        body: 'This schedule credits receivers that are not downwind. Reported levels do '
          + 'not — every level, contour and export BESSTY produces treats every receiver '
          + 'as downwind — so expect them to read HIGHER than this cell assumed, and '
          + 'possibly over the limit.\n\nThe modes applied are still the right ones for '
          + 'this wind direction.',
        confirmLabel: 'Apply',
      });
      if (!ok) return;
    }
    onApplySchedule(c);
    notify.success(
      `${PERIOD_LABEL[c.period]} modes at ${c.windSpeed} m/s applied to the project.`,
    );
  }

  const turbineName = new Map(
    project.sources.filter((s: Source) => s.kind === 'wtg').map((s) => [s.id, s.name]),
  );
  const shown = (result?.cells ?? [])
    .filter((c) => c.period === viewPeriod && c.windDirectionDeg === viewDirection);
  const shownSpeeds = [...new Set(shown.map((c) => c.windSpeed))].sort((a, b) => a - b);
  const ranDirections = [...new Set((result?.cells ?? []).map((c) => c.windDirectionDeg))]
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  return (
    <FloatingWindow
      title="Curtailment"
      onClose={onClose}
      persistKey="curtailment"
      defaultRect={{ x: 120, y: 70, w: 880, h: 620 }}
      minW={560}
    >
      {!pre.ok ? (
        <div style={{ padding: 12 }}>
          <div className="meta-line"><b>This project cannot be optimised yet.</b></div>
          <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, lineHeight: 1.5 }}>
            {pre.reasons.map((r) => <li key={r}>{r}</li>)}
          </ul>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 }}>
          {/* ---- controls ---- */}
          <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ fontSize: 11 }}>Periods:</span>
            {PERIODS.map((p) => (
              <label key={p} className="row-checkbox" style={{ fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={periods.includes(p)}
                  onChange={(e) => setPeriods(
                    e.target.checked ? [...PERIODS].filter((x) => x === p || periods.includes(x))
                      : periods.filter((x) => x !== p),
                  )}
                />
                <span>{PERIOD_LABEL[p]}</span>
              </label>
            ))}
            <span style={{ fontSize: 11, marginLeft: 8 }} title="Comply this far BELOW the limit">
              Margin
            </span>
            <input
              type="number" step={0.5} min={0} max={20} value={marginDb}
              onChange={(e) => setMarginDb(Math.max(0, +e.target.value))}
              style={{ width: 56 }}
            />
            <span style={{ fontSize: 11 }}>dB</span>
          </div>

          <label className="fld" style={{ fontSize: 11 }}>
            <span>Wind speeds</span>
            <input
              defaultValue={speeds.join(', ')}
              onBlur={(e) => {
                const ws = e.target.value.split(/[,\s]+/).map(Number)
                  .filter((n) => Number.isFinite(n)).map(Math.round);
                setSpeeds([...new Set(ws)].sort((a, b) => a - b));
              }}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              style={{ flex: 1 }}
              title="Integer wind speeds. Defaults to what every turbine's catalog covers."
            />
          </label>

          <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <label className="row-checkbox" style={{ fontSize: 11 }}>
              <input
                type="checkbox"
                checked={directional}
                onChange={(e) => setDirectional(e.target.checked)}
              />
              <span title={'Credit receivers that are not downwind with the reduction they '
                + 'actually get, instead of treating every receiver as downwind'}
              >Account for wind direction</span>
            </label>
            {directional && (
              <>
                <span style={{ fontSize: 11 }}>every</span>
                <select value={stepDeg} onChange={(e) => setStepDeg(+e.target.value)}>
                  <option value={10}>10° (36 directions)</option>
                  <option value={22.5}>22.5° (16 directions)</option>
                  <option value={30}>30° (12 directions)</option>
                  <option value={45}>45° (8 directions)</option>
                </select>
              </>
            )}
          </div>
          {directional && (
            <div className="hint" style={{ fontSize: 10 }}>
              Approximate, and for scheduling turbines only: no adjustment within ±60° of
              downwind, −2 dB elsewhere, applied to <b>turbine</b> contributions on top of
              the same solve. A BESS or substation is never adjusted. It changes nothing
              BESSTY reports — levels, contours and exports stay on the
              downwind-to-every-receiver reading, which is what ISO 9613-2 does and is the
              conservative case. Each direction gets its own schedule.
            </div>
          )}

          <div className="add-row">
            <button
              className="btn small primary"
              disabled={running || speeds.length === 0 || periods.length === 0}
              onClick={() => void run()}
            >
              {running
                ? `Optimising… ${progress ? `${progress.done}/${progress.total}` : ''}`
                : '▶ Optimise'}
            </button>
            {result && (
              <button
                className="btn small"
                onClick={() => triggerDownload(
                  `${defaultFilenameStem(project, 'curtailment')}.xlsx`,
                  exportCurtailmentXlsx(project, result, { marginDb }),
                )}
              >↓ XLSX</button>
            )}
            {stale && (
              <span style={{ fontSize: 11, color: 'var(--amber, #b26a00)' }}>
                ⚠ the project has changed since this ran
              </span>
            )}
          </div>

          {result && result.warnings.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--amber, #b26a00)' }}>
              {result.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          {/* ---- results ---- */}
          {result && shown.length > 0 && (
            <>
              <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                {PERIODS.filter((p) => result.cells.some((c) => c.period === p)).map((p) => (
                  <button
                    key={p}
                    className={`btn small${viewPeriod === p ? ' active' : ''}`}
                    onClick={() => setViewPeriod(p)}
                  >{PERIOD_LABEL[p]}</button>
                ))}
                {ranDirections.length > 0 && (
                  <>
                    <span style={{ fontSize: 11, marginLeft: 8 }} title="Direction the wind blows FROM">
                      Wind from
                    </span>
                    <select
                      value={viewDirection ?? ''}
                      onChange={(e) => setViewDirection(+e.target.value)}
                    >
                      {ranDirections.map((d) => {
                        // Worst first is the wrong default, but knowing which
                        // directions actually cost generation is the point of
                        // the sweep, so each option carries its own cost.
                        const cost = result.cells
                          .filter((c) => c.period === viewPeriod && c.windDirectionDeg === d)
                          .reduce((a, c) => a + (c.status === 'optimal' ? c.lostKw : 0), 0);
                        return (
                          <option key={d} value={d}>
                            {describeWindFrom(d)}{cost > 0 ? ` — ${cost.toFixed(0)} kW` : ' — no curtailment'}
                          </option>
                        );
                      })}
                    </select>
                  </>
                )}
              </div>

              <div style={{ overflow: 'auto', minHeight: 0, flex: 1 }}>
                <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: 'left', padding: '3px 6px', position: 'sticky', left: 0, background: 'var(--panel, #fff)' }}>
                        Turbine
                      </th>
                      {shownSpeeds.map((w) => (
                        <th key={w} style={{ textAlign: 'center', padding: '3px 6px' }}>{w} m/s</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {result.turbines.map((t) => (
                      <tr key={t.id}>
                        <td style={{ padding: '2px 6px', position: 'sticky', left: 0, background: 'var(--panel, #fff)' }}>
                          {turbineName.get(t.id) ?? t.name}
                        </td>
                        {shownSpeeds.map((w) => {
                          const cell = shown.find((c) => c.windSpeed === w);
                          const mode = cell?.modes[t.id];
                          const off = mode === MODE_OFF;
                          return (
                            <td key={w} style={{ textAlign: 'center', padding: '2px 4px' }}>
                              {cell?.status !== 'optimal' ? (
                                <span className="muted">—</span>
                              ) : (
                                <span
                                  style={{
                                    padding: '1px 5px', borderRadius: 3, fontSize: 10,
                                    background: off ? 'var(--red)' : 'var(--light)',
                                    color: off ? '#fff' : 'inherit',
                                  }}
                                >{off ? MODE_OFF_LABEL : mode}</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <SummaryRow
                      label="Lost kW"
                      title="Generation given up at this wind speed, summed over the farm"
                      speeds={shownSpeeds}
                      cells={shown}
                      render={(c) => (c.status === 'optimal' ? c.lostKw.toFixed(0) : '—')}
                    />
                    <SummaryRow
                      label="Binding"
                      title="The receiver with the least headroom under this schedule"
                      speeds={shownSpeeds}
                      cells={shown}
                      render={(c) => c.bindingReceiverName ?? '—'}
                    />
                    <SummaryRow
                      label="Headroom"
                      title="How far the binding receiver sits below its limit"
                      speeds={shownSpeeds}
                      cells={shown}
                      render={(c) => (c.marginAtBindingDb == null
                        ? '—'
                        : `${c.marginAtBindingDb >= 0 ? '' : '+'}${(-c.marginAtBindingDb).toFixed(1)}`)}
                    />
                    <SummaryRow
                      label=""
                      title="Apply this wind speed's modes to the project"
                      speeds={shownSpeeds}
                      cells={shown}
                      render={(c) => c.status === 'optimal' ? 'apply' : ''}
                      onCell={(c) => { void applyCell(c); }}
                    />
                  </tfoot>
                </table>
              </div>

              {shown.some((c) => c.status !== 'optimal') && (
                <div style={{ fontSize: 11, color: 'var(--red)' }}>
                  {shown.filter((c) => c.status !== 'optimal').map((c) => (
                    <div key={c.windSpeed}>
                      <b>{c.windSpeed} m/s:</b> {c.detail ?? 'no schedule complies.'}
                      {c.marginAtBindingDb != null && ` (${(-c.marginAtBindingDb).toFixed(1)} dB over)`}
                    </div>
                  ))}
                </div>
              )}

              <div className="hint" style={{ fontSize: 10 }}>
                Each cell is a proven optimum — the least generation given up for every
                receiver to comply, at that wind speed and period. Headroom is measured at
                the binding receiver.
              </div>
            </>
          )}
        </div>
      )}
    </FloatingWindow>
  );
}

function SummaryRow(props: {
  label: string;
  title: string;
  speeds: number[];
  cells: CellResult[];
  render(c: CellResult): string;
  onCell?(c: CellResult): void;
}) {
  const { label, title, speeds, cells, render, onCell } = props;
  return (
    <tr style={{ borderTop: '1px solid var(--light)' }}>
      <td
        title={title}
        style={{
          padding: '2px 6px', fontWeight: 600, position: 'sticky', left: 0,
          background: 'var(--panel, #fff)',
        }}
      >{label}</td>
      {speeds.map((w) => {
        const c = cells.find((x) => x.windSpeed === w);
        const text = c ? render(c) : '';
        return (
          <td key={w} style={{ textAlign: 'center', padding: '2px 4px' }}>
            {onCell && c && text ? (
              <button className="btn small" style={{ fontSize: 10 }} onClick={() => onCell(c)}>
                {text}
              </button>
            ) : text}
          </td>
        );
      })}
    </tr>
  );
}

/// Fold a cell's schedule into the project's per-period mode overrides.
///
/// Only the cell's own period is written: applying a night schedule must leave
/// what the turbines do during the day exactly as it was.
export function applyCellToProject(project: Project, cell: CellResult): Project {
  return {
    ...project,
    sources: project.sources.map((s) => {
      const mode = cell.modes[s.id];
      if (mode === undefined) return s;
      return { ...s, modeOverride: withPeriodMode(s.modeOverride, cell.period, mode) };
    }),
  };
}
