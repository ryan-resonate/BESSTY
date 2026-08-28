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
  modeOverridesForCell,
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
  /// Undo an applied schedule for one period.
  onClearSchedule(period: Period): void;
}) {
  const { project, dem, onClose, onApplySchedule, onClearSchedule } = props;
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
  const [warningsOpen, setWarningsOpen] = useState(false);
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
      // Point the view at a period this run actually covered. `viewPeriod`
      // starts at the scenario's period, and the period tabs live INSIDE the
      // results block — so a night-only study on a project whose scenario is
      // Day rendered no table and no tabs to reach one. The run had worked
      // perfectly; there was simply no way to see it.
      if (!out.cells.some((c) => c.period === viewPeriod)) {
        const first = PERIODS.find((p) => out.cells.some((c) => c.period === p));
        if (first) setViewPeriod(first);
      }
      // Counted separately. A cell the solver could not RUN — the HiGHS wasm
      // failing to load offline makes every cell one — is not a farm that can
      // never comply, and telling someone their site is unbuildable because a
      // download failed is the wrong error twice over.
      const infeasible = out.cells.filter((c) => c.status === 'infeasible').length;
      const errored = out.cells.filter((c) => c.status === 'error').length;
      if (infeasible > 0) {
        notify.warning(
          `${infeasible} of ${out.cells.length} cells could not be met even with every turbine off.`,
          { title: 'Some cells are infeasible' },
        );
      }
      if (errored > 0) {
        notify.error(
          `${errored} of ${out.cells.length} cells could not be solved. `
          + (out.cells.find((c) => c.status === 'error')?.detail ?? ''),
          { title: 'The solver failed on some cells' },
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
      `${PERIOD_LABEL[c.period]} modes at ${c.windSpeed} m/s applied. Edit them per turbine `
      + 'in the side panel, or use Revert here to clear them.',
    );
  }

  /// Put every turbine back to its catalog default for the shown period.
  async function revert() {
    const ok = await notify.confirm({
      title: `Clear the applied ${PERIOD_LABEL[viewPeriod].toLowerCase()} schedule?`,
      body: 'Every wind turbine goes back to inheriting its catalog mode for this period. '
        + 'Other periods, and anything that is not a turbine, are left alone.',
      confirmLabel: 'Revert',
    });
    if (!ok) return;
    onClearSchedule(viewPeriod);
    notify.success(`${PERIOD_LABEL[viewPeriod]} turbine modes reverted.`);
  }

  const turbineName = new Map(
    project.sources.filter((s: Source) => s.kind === 'wtg').map((s) => [s.id, s.name]),
  );
  const shown = (result?.cells ?? [])
    .filter((c) => c.period === viewPeriod && c.windDirectionDeg === viewDirection);
  const shownSpeeds = [...new Set(shown.map((c) => c.windSpeed))].sort((a, b) => a - b);
  // Computed over the WHOLE run, not the shown period, so a mode keeps its
  // colour when the period or direction tab changes.
  const modeOrder = modeOrderOf(result?.cells ?? []);
  const ranDirections = [...new Set((result?.cells ?? []).map((c) => c.windDirectionDeg))]
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);

  return (
    <FloatingWindow
      title="Curtailment"
      onClose={onClose}
      persistKey="curtailment"
      defaultRect={{ x: 90, y: 60, w: 1180, h: 660 }}
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
                  exportCurtailmentXlsx(project, result),
                )}
              >↓ XLSX</button>
            )}
            <button
              className="btn small"
              onClick={() => void revert()}
              title={'Clear any applied schedule for the period shown, putting every turbine '
                + 'back to its catalog mode'}
            >↺ Revert applied</button>
            {stale && (
              <span style={{ fontSize: 11, color: 'var(--amber, #b26a00)' }}>
                ⚠ the project has changed since this ran
              </span>
            )}
          </div>

          {result && result.warnings.length > 0 && (
            // Collapsed by default. These are notes about how the data was
            // read, not problems with the schedule — worth being able to reach,
            // not worth pushing the table off the screen every run.
            <div>
              <button
                className="btn small"
                style={{ color: 'var(--amber, #b26a00)' }}
                onClick={() => setWarningsOpen(!warningsOpen)}
              >
                {warningsOpen ? '▾' : '▸'} {result.warnings.length} note
                {result.warnings.length === 1 ? '' : 's'} about the input data
              </button>
              {warningsOpen && (
                <ul style={{
                  margin: '4px 0 0', paddingLeft: 18, fontSize: 11,
                  color: 'var(--amber, #b26a00)', maxHeight: 120, overflow: 'auto',
                }}>
                  {result.warnings.map((w) => <li key={w}>{w}</li>)}
                </ul>
              )}
            </div>
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
                        const forDir = result.cells
                          .filter((c) => c.period === viewPeriod && c.windDirectionDeg === d);
                        const cost = forDir
                          .reduce((a, c) => a + (c.status === 'optimal' ? c.lostKw : 0), 0);
                        // A direction whose expensive cells are INFEASIBLE sums
                        // to zero lost kW, and "no curtailment" is the last
                        // thing it should be labelled — blank reading as fine
                        // is the trap this whole window is built to avoid.
                        const unmet = forDir.filter((c) => c.status !== 'optimal').length;
                        const label = unmet > 0
                          ? ` — ${unmet} wind speed${unmet === 1 ? '' : 's'} unmet`
                          : cost > 0 ? ` — ${cost.toFixed(0)} kW` : ' — no curtailment';
                        return (
                          <option key={d} value={d}>{describeWindFrom(d)}{label}</option>
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
                                    // `nowrap` because a mode name broken across
                                    // two lines makes the row taller than its
                                    // neighbours and the grid stops scanning as
                                    // a grid.
                                    whiteSpace: 'nowrap',
                                    ...modeChipStyle(mode, modeOrder),
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
                      title={'How far the binding receiver sits below the CAP it was held to '
                        + '— the limit less any margin and tonality penalty, plus the rounding '
                        + 'grace. Positive is under; an over-limit cell reads "N over".'}
                      speeds={shownSpeeds}
                      cells={shown}
                      // Positive means headroom, the same sign the XLSX writes.
                      // This used to be negated for display, so a cell with
                      // 2.3 dB to spare read "-2.3" under a heading promising
                      // how far BELOW the limit it sat — and the spreadsheet
                      // exported from the same run said "2.30".
                      render={(c) => (c.marginAtBindingDb == null
                        ? '—'
                        : c.marginAtBindingDb >= 0
                          ? c.marginAtBindingDb.toFixed(1)
                          : `${(-c.marginAtBindingDb).toFixed(1)} over`)}
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
/// Built from `modeOverridesForCell` rather than reading `cell.modes` again.
/// Two places deciding which period a schedule touches is how they come to
/// disagree, and the one that would have been wrong is this one — the one that
/// writes to the project.
export function applyCellToProject(project: Project, cell: CellResult): Project {
  const edits = new Map(
    modeOverridesForCell(cell).map((e) => [e.sourceId, e]),
  );
  return {
    ...project,
    // Applying a schedule writes a mode for ONE period, which is by definition
    // a per-period project — so the feature that edits per-period modes is
    // switched on at the same time.
    //
    // Without this the schedule lands but becomes read-only: `ModePicker`
    // deliberately refuses to edit per-period values while the setting is off
    // (a stray click would flatten the other two periods), so the user was left
    // with modes they could see, could not change, and could not undo except
    // through Ctrl+Z. Applying a schedule and then being unable to touch it is
    // worse than the stray click the guard was protecting against.
    settings: {
      ...project.settings,
      periods: { ...project.settings?.periods, perPeriodModes: true },
    } as Project['settings'],
    sources: project.sources.map((s) => {
      const edit = edits.get(s.id);
      if (!edit) return s;
      return { ...s, modeOverride: withPeriodMode(s.modeOverride, edit.period, edit.mode) };
    }),
  };
}

/// Undo an applied schedule for one period: every turbine goes back to
/// inheriting its catalog default.
///
/// `undefined` rather than the default's NAME, so a turbine returns to
/// "whatever the model says" rather than being pinned to what the model says
/// today — the two differ the moment someone edits the catalog.
///
/// Only turbines, and only this period. A BESS with a night mode set by hand
/// was never part of the schedule and must not be swept up by undoing it.
export function clearScheduleFromProject(project: Project, period: Period): Project {
  return {
    ...project,
    sources: project.sources.map((s) => (
      s.kind === 'wtg'
        ? { ...s, modeOverride: withPeriodMode(s.modeOverride, period, undefined) }
        : s
    )),
  };
}

/// Mode names in the order they appear across a run, so a colour means the same
/// thing in every cell of the table.
///
/// Derived from the RESULT rather than the catalog: the table only ever shows
/// modes the optimiser actually chose, and colouring by catalog position would
/// waste the readable end of the ramp on modes nobody is using.
export function modeOrderOf(cells: readonly CellResult[]): string[] {
  const seen = new Set<string>();
  for (const c of cells) {
    for (const m of Object.values(c.modes)) if (m !== MODE_OFF) seen.add(m);
  }
  return [...seen].sort();
}

/// Colour for one mode chip.
///
/// A schedule is read by scanning for PATTERN — where curtailment starts, which
/// turbines carry it, whether it deepens with wind speed. All-grey chips make
/// that a reading exercise; a ramp makes it visible at a glance.
///
/// Green through amber to red, by position in the run's own mode list, so
/// "further along the list" reads as "more curtailed" — which is how the modes
/// are named (SO1…SO6) and ordered. Off is the red terminus, and always the
/// same colour whatever else is on screen.
function modeChipStyle(
  mode: string | undefined,
  order: readonly string[],
): { background: string; color: string; border?: string } {
  if (mode === MODE_OFF) return { background: 'var(--red, #c0392b)', color: '#fff' };
  if (!mode) return { background: 'var(--light, #eee)', color: 'inherit' };
  const i = order.indexOf(mode);
  // The first mode in the list is the un-curtailed one in every catalog we
  // have seen; give it a neutral chip so a schedule with no curtailment reads
  // as quiet rather than as a wall of green.
  if (i <= 0) return { background: 'var(--light, #eee)', color: 'inherit' };
  // Hue from green (120°) to red (0°) across the remaining modes.
  const t = order.length > 1 ? i / (order.length - 1) : 1;
  const hue = 110 - 110 * t;
  return {
    background: `hsl(${hue}, 70%, 88%)`,
    color: `hsl(${hue}, 70%, 25%)`,
    border: `1px solid hsl(${hue}, 60%, 72%)`,
  };
}
