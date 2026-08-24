// I14 — factorial configuration study.
//
// Two axes (battery candidates × inverter candidates), everything else held
// constant. Results are transient: re-run to refresh. Persisting them would
// mean invalidating on every source edit, and a stale matrix that looks current
// is worse than no matrix.
//
// The window is NON-MODAL (Ryan): a study of any size takes long enough that
// blocking the whole app behind it is unreasonable, so it docks as a draggable
// floating window and the project stays editable while it runs.
//
// Non-modality forces one rule: everything a result depends on — the project,
// both axis specs, the receiver set, the axis labels — is SNAPSHOTTED when Run
// is pressed, and the matrix is rendered and exported from that snapshot alone.
// Reading any of it live would let an edit made during (or after) a run
// silently re-label or re-shape a matrix that was computed from something else.

import { useEffect, useMemo, useRef, useState } from 'react';
import { FloatingWindow } from './FloatingWindow';
import { notify } from '../lib/notify';
import { listEntriesByKind } from '../lib/catalog';
import { evaluateProject } from '../lib/solver';
import type { Project, Receiver, SourceKind } from '../lib/types';
import { assessedLevel, exceedsLimit, limitComparisonFor, limitFor } from '../lib/limits';
import {
  axisOverlap, axisScopeOptions, candidateLabel, enumerateCombos, projectForCombo,
  scopeKey, worstOf,
  type AxisScopeOption, type AxisSpec, type Candidate, type ComboResult,
} from '../lib/factorial';
import { buildFactorialXlsx } from '../lib/factorialXlsx';
import type { DemRaster } from '../lib/dem';

interface Props {
  project: Project;
  dem: DemRaster | null;
  onClose(): void;
}

/// Everything a completed run was computed against. Held whole so the matrix
/// can never drift from the numbers in it.
interface RunSnapshot {
  project: Project;
  /// The DEM is a solve input too, so it belongs in the snapshot — otherwise
  /// uploading a GeoTIFF after a run leaves the matrix looking current when a
  /// re-run would now produce different numbers.
  dem: DemRaster | null;
  battery: AxisSpec;
  inverter: AxisSpec;
  receivers: Receiver[];
  axisLabels: { axis1: string; axis2: string };
  at: Date;
}

/// Model + mode pairs available for a kind. A model with several modes appears
/// once per mode, because "which mode" is as much a configuration choice as
/// "which model".
function candidatesFor(project: Project, kind: SourceKind): Candidate[] {
  const out: Candidate[] = [];
  for (const e of listEntriesByKind(project, kind)) {
    const modes = e.modes?.length ? e.modes.map((m) => m.name) : [null];
    for (const mode of modes) {
      out.push({
        catalogScope: e._scope, modelId: e.id, mode,
        label: candidateLabel(e.displayName, mode),
      });
    }
  }
  return out;
}

export function FactorialStudy({ project, dem, onClose }: Props) {

  // Axis scopes (Ryan): a BESS group holds BOTH batteries and inverters, so
  // "the inverters inside Row A" has to be selectable independently of "all
  // inverters" and of another group's.
  const scopes = useMemo(() => axisScopeOptions(project), [project]);
  const firstOf = (k: SourceKind) => scopes.find((o) => o.scope.sourceKind === k) ?? scopes[0];
  const [batScope, setBatScope] = useState<string>(() => {
    const o = scopes.find((x) => x.scope.sourceKind === 'bess');
    return o ? scopeKey(o.scope) : '';
  });
  const [invScope, setInvScope] = useState<string>(() => {
    const o = scopes.find((x) => x.scope.sourceKind === 'auxiliary');
    return o ? scopeKey(o.scope) : '';
  });
  const batOpt = scopes.find((o) => scopeKey(o.scope) === batScope) ?? firstOf('bess');
  const invOpt = scopes.find((o) => scopeKey(o.scope) === invScope) ?? firstOf('auxiliary');
  const bessIds = batOpt?.sourceIds ?? [];
  const auxIds = invOpt?.sourceIds ?? [];

  const batteryPool = useMemo(
    () => (batOpt ? candidatesFor(project, batOpt.scope.sourceKind) : []),
    [project, batOpt?.scope.sourceKind]);
  const inverterPool = useMemo(
    () => (invOpt ? candidatesFor(project, invOpt.scope.sourceKind) : []),
    [project, invOpt?.scope.sourceKind]);

  const [batSel, setBatSel] = useState<Set<number>>(new Set());
  const [invSel, setInvSel] = useState<Set<number>>(new Set());
  const [rxSel, setRxSel] = useState<Set<string>>(() => new Set(project.receivers.map((r) => r.id)));
  const [results, setResults] = useState<ComboResult[] | null>(null);
  const [ran, setRan] = useState<RunSnapshot | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useRef({ v: false });

  // Closing the window mid-run must stop the loop. Without this the solve
  // keeps burning the main thread for a result nobody will see.
  useEffect(() => () => { cancelRef.current.v = true; }, []);

  const battery: AxisSpec = {
    sourceIds: bessIds,
    candidates: [...batSel].sort((a, b) => a - b).map((i) => batteryPool[i]),
  };
  const inverter: AxisSpec = {
    sourceIds: auxIds,
    candidates: [...invSel].sort((a, b) => a - b).map((i) => inverterPool[i]),
  };
  const receivers: Receiver[] = project.receivers.filter((r) => rxSel.has(r.id));
  // Both axes can now point at overlapping sources (e.g. "All BESS" and
  // "Row A — BESS"). projectForCombo lets axis 1 win, so axis 2 would silently
  // do nothing for the shared units — a study that appears to have varied
  // something it did not. Refuse rather than produce a misleading matrix.
  const overlap = axisOverlap(battery, inverter);
  const combos = battery.candidates.length && inverter.candidates.length && overlap.length === 0
    ? enumerateCombos(battery, inverter) : [];

  async function run() {
    if (combos.length === 0 || receivers.length === 0) return;
    cancelRef.current.v = false;
    setResults(null);
    setRan(null);
    setProgress({ done: 0, total: combos.length });
    // Freeze the inputs. `project` is a prop and the user can edit the model
    // while this runs, so every combination has to be solved against the same
    // geometry or the matrix compares configurations AND edits at once.
    setViewRx('worst');   // the old pick may not be in this run's receiver set
    const snap: RunSnapshot = {
      project,
      dem,
      battery,
      inverter,
      receivers,
      axisLabels: { axis1: batOpt?.label ?? 'Axis 1', axis2: invOpt?.label ?? 'Axis 2' },
      at: new Date(),
    };
    const selectedRxIds = new Set(snap.receivers.map((r) => r.id));
    const out: ComboResult[] = [];
    try {
      for (let i = 0; i < combos.length; i++) {
        if (cancelRef.current.v) { setProgress(null); return; }
        // A CLONE per combination — the live project is never touched.
        const p = projectForCombo(snap.project, snap.battery, snap.inverter, combos[i]);
        // The 'study' channel has its own worker, queued rather than
        // superseding: editing the project while this runs fires the editor's
        // own live solves, and those must not cancel the sweep.
        const rs = await evaluateProject(p, snap.dem, undefined, 'study');
        const byReceiver = new Map<string, number>();
        for (const r of rs) if (selectedRxIds.has(r.receiverId)) byReceiver.set(r.receiverId, assessedLevel(r) ?? r.totalDbA);
        out.push({ combo: combos[i], byReceiver });
        setProgress({ done: i + 1, total: combos.length });
      }
      if (cancelRef.current.v) { setProgress(null); return; }
      setResults(out);
      setRan(snap);
    } catch (e) {
      notify.error((e as Error).message, { title: 'Study failed' });
    } finally {
      setProgress(null);
    }
  }

  async function exportXlsx() {
    if (!results || !ran) return;
    try {
      const blob = await buildFactorialXlsx(
        ran.project, ran.battery, ran.inverter, results, ran.receivers, ran.axisLabels,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(ran.project.name || 'bessty').replace(/[^\w.-]+/g, '_')}-study.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      notify.success('Study exported.');
    } catch (e) {
      notify.error((e as Error).message, { title: 'Export failed' });
    }
  }

  const toggle = (set: Set<number>, i: number, fn: (s: Set<number>) => void) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i); else next.add(i);
    fn(next);
  };

  const [viewRx, setViewRx] = useState<string>('worst');
  // Read from the snapshot: the limit-comparison mode and period are project
  // settings, and the matrix's colours must match the run, not later edits.
  // Limits are read from the SNAPSHOT project too, not just the comparison
  // rule: with wind-speed-dependent limits the limit depends on the scenario
  // wind speed, so reading it from the live project would judge the run's
  // numbers against a limit from a wind speed it was never solved at.
  const limitProject = ran?.project ?? project;
  const mode = limitComparisonFor(limitProject);
  const period = limitProject.scenario.period;
  /// The project has moved on since these numbers were computed.
  const stale = ran != null && (ran.project !== project || ran.dem !== dem);

  function cellValue(r: ComboResult): { v: number | null; fail: boolean } {
    const rxs = ran?.receivers ?? [];
    if (viewRx === 'worst') {
      const v = worstOf(r, rxs.map((x) => x.id));
      const fail = rxs.some((rx) =>
        exceedsLimit(r.byReceiver.get(rx.id), limitFor(limitProject, rx, period), mode));
      return { v, fail };
    }
    const rx = rxs.find((x) => x.id === viewRx);
    const v = r.byReceiver.get(viewRx) ?? null;
    return { v, fail: rx ? exceedsLimit(v, limitFor(limitProject, rx, period), mode) : false };
  }

  return (
    <FloatingWindow
      title="Compare configurations"
      onClose={onClose}
      persistKey="study"
      defaultRect={{ w: 880, h: Math.min(700, window.innerHeight - 120), x: 80, y: 70 }}
      minW={520}
      minH={320}
    >
      <div className="hint" style={{ marginBottom: 10 }}>
        Every battery candidate against every inverter candidate, with
        everything else held constant. Sources outside the two axes are
        untouched, and <b>your project is never modified</b> — each
        combination is solved against a copy. Keep working while it runs;
        results are computed against the project as it was when you pressed
        Run.
      </div>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Pool
          title="Axis 1"
          scopes={scopes} scopeValue={batScope}
          onScope={(v) => { setBatScope(v); setBatSel(new Set()); }}
          pool={batteryPool} sel={batSel}
          onToggle={(i) => toggle(batSel, i, setBatSel)} />
        <Pool
          title="Axis 2"
          scopes={scopes} scopeValue={invScope}
          onScope={(v) => { setInvScope(v); setInvSel(new Set()); }}
          pool={inverterPool} sel={invSel}
          onToggle={(i) => toggle(invSel, i, setInvSel)} />
        <div style={{ flex: '1 1 200px', minWidth: 180 }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>
            Receivers ({rxSel.size}/{project.receivers.length})
          </div>
          <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <button className="btn small"
              onClick={() => setRxSel(new Set(project.receivers.map((r) => r.id)))}>All</button>
            <button className="btn small" onClick={() => setRxSel(new Set())}>None</button>
          </div>
          <div style={{ maxHeight: 150, overflowY: 'auto' }}>
            {project.receivers.map((r) => (
              <label key={r.id} className="row-checkbox">
                <input type="checkbox" checked={rxSel.has(r.id)}
                  onChange={() => {
                    const n = new Set(rxSel);
                    if (n.has(r.id)) n.delete(r.id); else n.add(r.id);
                    setRxSel(n);
                  }} />
                <span>{r.name}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button className="btn primary" onClick={run}
          disabled={!!progress || combos.length === 0 || receivers.length === 0}>
          {progress ? `Solving ${progress.done}/${progress.total}…` : `Run ${combos.length || '—'} combinations`}
        </button>
        {progress && (
          <button className="btn" style={{ color: 'var(--red)' }}
            onClick={() => { cancelRef.current.v = true; }}>Cancel</button>
        )}
        {results && ran && (
          <>
            <select value={viewRx} onChange={(e) => setViewRx(e.target.value)}>
              <option value="worst">All receivers (worst case)</option>
              {ran.receivers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
            <button className="btn" onClick={exportXlsx}>⬇ Export XLSX</button>
          </>
        )}
      </div>

      {overlap.length > 0 && (
        <div className="hint" style={{ color: 'var(--red)', marginTop: 8 }}>
          The two axes both control {overlap.length} of the same
          unit{overlap.length === 1 ? '' : 's'}. Pick scopes that don't
          overlap — otherwise axis 2 would have no effect on those units and
          the matrix would imply a comparison that never happened.
        </div>
      )}

      {results && ran && (
        <div style={{ overflowX: 'auto', marginTop: 12 }}>
          <div className="hint" style={{
            marginBottom: 6,
            color: stale ? 'var(--red)' : undefined,
          }}>
            {stale
              ? `⚠ The project has changed since this ran (${ran.at.toLocaleTimeString()}). `
                + 'These numbers describe the earlier model — re-run to refresh.'
              : `Solved against the project at ${ran.at.toLocaleTimeString()}.`}
          </div>
          <table className="catalog-table" style={{ fontSize: 11 }}>
            <thead>
              <tr>
                <th>{ran.axisLabels.axis2} \ {ran.axisLabels.axis1}</th>
                {ran.battery.candidates.map((c) => <th key={c.label}>{c.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {ran.inverter.candidates.map((inv, i) => (
                <tr key={inv.label}>
                  <td style={{ fontWeight: 600 }}>{inv.label}</td>
                  {ran.battery.candidates.map((_, b) => {
                    const r = results.find((x) =>
                      x.combo.batteryIdx === b && x.combo.inverterIdx === i);
                    const { v, fail } = r ? cellValue(r) : { v: null, fail: false };
                    return (
                      <td key={b} style={{
                        textAlign: 'right',
                        background: v == null ? undefined : fail ? 'rgba(211,47,47,.16)' : 'rgba(46,125,50,.16)',
                        color: v == null ? 'var(--ink-soft)' : fail ? 'var(--red)' : 'var(--green)',
                        fontWeight: 600,
                      }}>{v == null ? '—' : v.toFixed(1)}</td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </FloatingWindow>
  );
}

function Pool({ title, scopes, scopeValue, onScope, pool, sel, onToggle }: {
  title: string;
  scopes: AxisScopeOption[];
  scopeValue: string;
  onScope(v: string): void;
  pool: Candidate[]; sel: Set<number>; onToggle(i: number): void;
}) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: 220 }}>
      <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 4 }}>{title}</div>
      <select
        value={scopeValue}
        onChange={(e) => onScope(e.target.value)}
        style={{ width: '100%', marginBottom: 6 }}
        title="Which sources this axis varies"
      >
        {scopes.map((o) => (
          <option key={scopeKey(o.scope)} value={scopeKey(o.scope)}>{o.label}</option>
        ))}
      </select>
      {pool.length === 0 && <div className="hint">No catalog entries of this kind.</div>}
      <div style={{ maxHeight: 150, overflowY: 'auto' }}>
        {pool.map((c, i) => (
          <label key={`${c.modelId}:${c.mode}`} className="row-checkbox">
            <input type="checkbox" checked={sel.has(i)} onChange={() => onToggle(i)} />
            <span>{c.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
