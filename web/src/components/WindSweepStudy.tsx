// The wind-speed sweep's window: configure a run, watch it, export it.
//
// A sweep is minutes of solving, so the dialog's first job is to say what it is
// about to cost BEFORE it is started — the solve count is on the Run button —
// and its second is to stay honest while it runs: which state is solving, how
// far through, and a cancel that actually stops the workers rather than just
// hiding the progress bar.
//
// The on-screen table and the XLSX are built from the same `sweepReceiverRows`,
// so what the user checks here is what the spreadsheet says.

import { useMemo, useRef, useState } from 'react';

import { FloatingWindow } from './FloatingWindow';
import { notify } from '../lib/notify';
import { lookupEntry } from '../lib/catalog';
import { cancelGridRun } from '../lib/solver';
import { PERIODS, PERIOD_LABEL } from '../lib/modes';
import type { DemRaster } from '../lib/dem';
import type { CustomContourLine, Period, Project } from '../lib/types';
import {
  SWEEP_CANCELLED,
  defaultSweepSpeeds,
  liveSweepDeps,
  normaliseSpeeds,
  runWindSweep,
  sweepPeriods,
  sweepReceiverRows,
  sweepSolveCount,
  sweepSpeeds,
  traceSweepContours,
  type SweepConfig,
  type SweepProgress,
  type SweepResult,
} from '../lib/windSweep';
import {
  defaultFilenameStem,
  exportWindSweepContoursKml,
  exportWindSweepContoursShp,
  exportWindSweepGeoTiffZip,
  exportWindSweepXlsx,
  triggerDownload,
} from '../lib/exporters';

export function WindSweepStudy(props: {
  project: Project;
  dem: DemRaster | null;
  /// Grid resolution the map is using. The sweep solves at the same spacing so
  /// an exported contour and an on-screen one are the same computation.
  gridSpacingM: number;
  /// The display contour levels — what the user is looking at (Q25).
  contourLevels: number[];
  customContours?: CustomContourLine[];
  /// Told while a sweep is in flight so the screen can hold off its own
  /// automatic regrid: the grid pool is newest-wins, and a background regrid
  /// landing mid-sweep would kill it.
  onRunningChange(running: boolean): void;
  onClose(): void;
}) {
  const {
    project, dem, gridSpacingM, contourLevels, customContours, onRunningChange, onClose,
  } = props;

  const catalogSpeeds = useMemo(
    () => defaultSweepSpeeds(project, (s) => {
      const entry = lookupEntry(project, s);
      if (!entry) return null;
      const ws = new Set<number>();
      for (const m of entry.modes) for (const w of m.windSpeeds ?? []) ws.add(Math.round(w));
      return [...ws];
    }),
    // Deliberately keyed on the project object: the catalog is read through it,
    // and a sweep dialog left open across a model swap should re-offer the new
    // model's speeds rather than the old one's.
    [project],
  );

  const [speeds, setSpeeds] = useState<number[]>(catalogSpeeds);
  const [periods, setPeriods] = useState<Period[]>([project.scenario.period]);
  const [doReceivers, setDoReceivers] = useState(true);
  const [doGrids, setDoGrids] = useState(false);

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<SweepProgress | null>(null);
  const [result, setResult] = useState<SweepResult | null>(null);
  const [ranAgainst, setRanAgainst] = useState<Project | null>(null);
  const [viewPeriod, setViewPeriod] = useState<Period>(project.scenario.period);
  const [exporting, setExporting] = useState<string | null>(null);
  const cancelRef = useRef(false);

  const config: SweepConfig = {
    windSpeeds: speeds, periods, receivers: doReceivers, grids: doGrids,
  };
  const solves = sweepSolveCount(project, config);
  const stale = ranAgainst != null && ranAgainst !== project;
  const receiverHeightM = project.settings?.general.defaultReceiverHeight ?? 1.5;

  function setRun(on: boolean) {
    setRunning(on);
    onRunningChange(on);
  }

  async function run() {
    if (running) return;
    cancelRef.current = false;
    // Drop the previous run BEFORE starting: a half-replaced result on screen,
    // with the old wind speeds' columns still showing, is worse than an empty
    // table while this one solves.
    setResult(null);
    setRanAgainst(null);
    setRun(true);
    setProgress({ done: 0, total: solves, label: 'starting…' });
    try {
      const out = await runWindSweep(
        project, dem, config,
        liveSweepDeps(gridSpacingM, receiverHeightM),
        (p) => setProgress(p),
        () => cancelRef.current,
      );
      out.gridSpacingM = doGrids ? gridSpacingM : undefined;
      out.receiverHeightM = doGrids ? receiverHeightM : undefined;
      setResult(out);
      setRanAgainst(project);
      if (!periods.includes(viewPeriod)) setViewPeriod(periods[0]);
      notify.success(
        `Swept ${sweepSpeeds(out, doReceivers ? 'receivers' : 'grid').length} wind speeds `
        + `in ${(out.elapsedMs / 1000).toFixed(0)} s.`,
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // A cancel is a decision, not a failure. Everything else gets named.
      if (msg !== SWEEP_CANCELLED) {
        notify.error(msg, { title: 'Wind sweep failed' });
      }
    } finally {
      setRun(false);
      setProgress(null);
    }
  }

  function cancel() {
    cancelRef.current = true;
    // The grid's tile loop has no yield point, so the flag alone would not be
    // read until the current grid finished — which on a big site is the entire
    // wait the user just asked to stop.
    cancelGridRun();
  }

  /// Closing the window while a sweep is running stops the sweep.
  ///
  /// The alternative is a run nobody can see, cancel or collect: the results
  /// are held in this component's state, so they die with it regardless — but
  /// without this the workers would keep grinding through every remaining wind
  /// speed first, and the map's automatic regrid would stay suspended until
  /// they finished.
  function close() {
    if (running) cancel();
    onClose();
  }

  async function exportGrids(kind: 'shp' | 'kml' | 'tif') {
    if (!result) return;
    setExporting(kind);
    try {
      const stem = defaultFilenameStem(project, 'wind_sweep');
      if (kind === 'tif') {
        triggerDownload(`${stem}_grids.zip`, exportWindSweepGeoTiffZip(result));
        return;
      }
      const layers = await traceSweepContours(result, contourLevels, customContours);
      if (kind === 'shp') {
        triggerDownload(`${stem}_contours.zip`, exportWindSweepContoursShp(project, layers));
      } else {
        triggerDownload(`${stem}_contours.kml`, exportWindSweepContoursKml(project, layers));
      }
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e), { title: 'Contour export failed' });
    } finally {
      setExporting(null);
    }
  }

  const rows = useMemo(
    () => (result && result.config.receivers ? sweepReceiverRows(project, result, viewPeriod) : []),
    [project, result, viewPeriod],
  );
  const shownSpeeds = result ? sweepSpeeds(result, 'receivers') : [];
  const donePeriods = result ? sweepPeriods(result, 'receivers') : [];

  return (
    <FloatingWindow
      title="Wind-speed sweep"
      onClose={close}
      persistKey="windsweep"
      defaultRect={{ x: 140, y: 80, w: 900, h: 600 }}
      minW={560}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 10, minHeight: 0 }}>
        <div className="hint" style={{ fontSize: 10 }}>
          Solves the project again at each wind speed — turbine sound power and, with
          wind-speed limits on, the limit itself both move — so the worst case can be found
          rather than assumed. Every number below came out of the engine.
        </div>

        {/* ---- controls ---- */}
        <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 11 }}>Periods:</span>
          {PERIODS.map((p) => (
            <label key={p} className="row-checkbox" style={{ fontSize: 11 }}>
              <input
                type="checkbox"
                disabled={running}
                checked={periods.includes(p)}
                onChange={(e) => setPeriods(
                  e.target.checked
                    ? [...PERIODS].filter((x) => x === p || periods.includes(x))
                    : periods.filter((x) => x !== p),
                )}
              />
              <span>{PERIOD_LABEL[p]}</span>
            </label>
          ))}
        </div>

        <label className="fld" style={{ fontSize: 11 }}>
          <span>Wind speeds</span>
          <input
            defaultValue={speeds.join(', ')}
            disabled={running}
            onBlur={(e) => setSpeeds(normaliseSpeeds(e.target.value.split(/[,\s]+/).map(Number)))}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            style={{ flex: 1 }}
            title="Whole m/s. Defaults to the speeds every turbine's catalog covers."
          />
        </label>

        <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row-checkbox" style={{ fontSize: 11 }}>
            <input
              type="checkbox" disabled={running}
              checked={doReceivers} onChange={(e) => setDoReceivers(e.target.checked)}
            />
            <span>Receivers</span>
          </label>
          <label className="row-checkbox" style={{ fontSize: 11 }}>
            <input
              type="checkbox" disabled={running}
              checked={doGrids} onChange={(e) => setDoGrids(e.target.checked)}
            />
            <span title="A full contour grid per wind speed and period">Contour grids</span>
          </label>
        </div>

        {doGrids && (
          <div className="hint" style={{ fontSize: 10, color: 'var(--amber, #b26a00)' }}>
            ⚠ Each contour grid is a full solve at {gridSpacingM} m spacing — the same one the
            map runs, once per wind speed and period. Expect this to take roughly as long as
            running the grid {sweepSolveCount(project, { ...config, receivers: false })} times.
          </div>
        )}

        <div className="add-row" style={{ alignItems: 'center' }}>
          <button
            className="btn small primary"
            disabled={running || solves === 0}
            onClick={() => void run()}
          >
            {running ? 'Sweeping…' : `▶ Run sweep (${solves} solve${solves === 1 ? '' : 's'})`}
          </button>
          {running && <button className="btn small" onClick={cancel}>Cancel</button>}
          {stale && !running && (
            <span style={{ fontSize: 11, color: 'var(--amber, #b26a00)' }}>
              ⚠ the project has changed since this ran
            </span>
          )}
        </div>

        {progress && (
          <div style={{ fontSize: 11 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>{progress.label}</span>
              <span>
                {progress.done}/{progress.total}
                {progress.tiles && ` · tile ${progress.tiles.done}/${progress.tiles.total}`}
              </span>
            </div>
            <div style={{ height: 4, background: 'var(--line, #ddd)', borderRadius: 2, marginTop: 3 }}>
              <div
                style={{
                  height: '100%',
                  width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%`,
                  background: 'var(--accent, #3b82f6)',
                  borderRadius: 2,
                }}
              />
            </div>
          </div>
        )}

        {result && result.warnings.length > 0 && (
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: 'var(--amber, #b26a00)' }}>
            {result.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        )}

        {/* ---- exports ---- */}
        {result && !running && (
          <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            {result.config.receivers && (
              <button
                className="btn small"
                onClick={() => triggerDownload(
                  `${defaultFilenameStem(project, 'wind_sweep')}.xlsx`,
                  exportWindSweepXlsx(project, result),
                )}
              >↓ Receivers XLSX</button>
            )}
            {result.config.grids && (
              <>
                <button className="btn small" disabled={exporting != null} onClick={() => void exportGrids('shp')}>
                  {exporting === 'shp' ? 'Tracing…' : '↓ Contours SHP'}
                </button>
                <button className="btn small" disabled={exporting != null} onClick={() => void exportGrids('kml')}>
                  {exporting === 'kml' ? 'Tracing…' : '↓ Contours KML'}
                </button>
                <button className="btn small" disabled={exporting != null} onClick={() => void exportGrids('tif')}>
                  ↓ GeoTIFF zip
                </button>
              </>
            )}
          </div>
        )}

        {/* ---- results ---- */}
        {rows.length > 0 && shownSpeeds.length > 0 && (
          <>
            <div className="add-row" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
              {donePeriods.map((p) => (
                <button
                  key={p}
                  className={`btn small${viewPeriod === p ? ' active' : ''}`}
                  onClick={() => setViewPeriod(p)}
                >{PERIOD_LABEL[p]}</button>
              ))}
              <span className="hint" style={{ fontSize: 10, marginLeft: 8 }}>
                margin to limit, dB — negative is over
              </span>
            </div>

            <div style={{ overflow: 'auto', minHeight: 0, flex: 1 }}>
              <table style={{ borderCollapse: 'collapse', fontSize: 11, width: '100%' }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: 'left', padding: '3px 6px', position: 'sticky', left: 0, background: 'var(--panel, #fff)' }}>
                      Receiver
                    </th>
                    {shownSpeeds.map((w) => (
                      <th key={w} style={{ textAlign: 'center', padding: '3px 6px' }}>{w}</th>
                    ))}
                    <th style={{ textAlign: 'center', padding: '3px 6px' }}>Worst</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ padding: '3px 6px', position: 'sticky', left: 0, background: 'var(--panel, #fff)' }}>
                        {r.name}
                      </td>
                      {r.cells.map((c) => (
                        <td
                          key={c.windSpeed}
                          title={c.levelDb == null ? 'no result'
                            : `${c.levelDb.toFixed(1)} dB against a ${c.limitDb} dB limit`
                              + (c.limitSource === 'clamped' ? ' (nearest table column)' : '')}
                          style={{
                            textAlign: 'center',
                            padding: '3px 6px',
                            color: c.exceeds ? 'var(--red, #c0392b)' : undefined,
                            fontWeight: c.exceeds ? 600 : undefined,
                          }}
                        >
                          {c.marginDb == null ? '—' : c.marginDb.toFixed(1)}
                        </td>
                      ))}
                      <td style={{ textAlign: 'center', padding: '3px 6px' }}>
                        {r.worst ? `${r.worst.windSpeed} m/s` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {result && result.config.grids && !result.config.receivers && (
          <div className="hint" style={{ fontSize: 10 }}>
            Contour grids only — there is no receiver table to show. The exports above hold
            {' '}{result.states.filter((s) => s.grid).length} grids.
          </div>
        )}
      </div>
    </FloatingWindow>
  );
}
