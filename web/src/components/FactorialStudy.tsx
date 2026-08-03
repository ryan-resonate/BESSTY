// I14 — factorial configuration study.
//
// Two axes (battery candidates × inverter candidates), everything else held
// constant. Results are transient: re-run to refresh. Persisting them would
// mean invalidating on every source edit, and a stale matrix that looks current
// is worse than no matrix.

import { useMemo, useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';
import { notify } from '../lib/notify';
import { listEntriesByKind } from '../lib/catalog';
import { evaluateProject } from '../lib/solver';
import { limitForPeriod, type Project, type Receiver, type SourceKind } from '../lib/types';
import { exceedsLimit, limitComparisonFor } from '../lib/limits';
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
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const cancelRef = useState<{ v: boolean }>({ v: false })[0];

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
    cancelRef.v = false;
    setResults(null);
    setProgress({ done: 0, total: combos.length });
    const out: ComboResult[] = [];
    try {
      for (let i = 0; i < combos.length; i++) {
        if (cancelRef.v) { setProgress(null); return; }
        // A CLONE per combination — the live project is never touched.
        const p = projectForCombo(project, battery, inverter, combos[i]);
        const rs = await evaluateProject(p, dem);
        const byReceiver = new Map<string, number>();
        for (const r of rs) if (rxSel.has(r.receiverId)) byReceiver.set(r.receiverId, r.totalDbA);
        out.push({ combo: combos[i], byReceiver });
        setProgress({ done: i + 1, total: combos.length });
      }
      setResults(out);
    } catch (e) {
      notify.error((e as Error).message, { title: 'Study failed' });
    } finally {
      setProgress(null);
    }
  }

  async function exportXlsx() {
    if (!results) return;
    try {
      const blob = await buildFactorialXlsx(
        project, battery, inverter, results, receivers,
        { axis1: batOpt?.label ?? 'Axis 1', axis2: invOpt?.label ?? 'Axis 2' },
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${(project.name || 'bessty').replace(/[^\w.-]+/g, '_')}-study.xlsx`;
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
  const mode = limitComparisonFor(project);
  const period = project.scenario.period;

  function cellValue(r: ComboResult): { v: number | null; fail: boolean } {
    if (viewRx === 'worst') {
      const v = worstOf(r, receivers.map((x) => x.id));
      const fail = receivers.some((rx) =>
        exceedsLimit(r.byReceiver.get(rx.id), limitForPeriod(rx, period), mode));
      return { v, fail };
    }
    const rx = receivers.find((x) => x.id === viewRx);
    const v = r.byReceiver.get(viewRx) ?? null;
    return { v, fail: rx ? exceedsLimit(v, limitForPeriod(rx, period), mode) : false };
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" style={{ maxWidth: 900, width: '92vw' }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Compare configurations</h3>
        <div className="hint" style={{ marginBottom: 10 }}>
          Every battery candidate against every inverter candidate, with
          everything else held constant. Sources outside the two axes are
          untouched, and <b>your project is never modified</b> — each
          combination is solved against a copy.
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

        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12 }}>
          <button className="btn primary" onClick={run}
            disabled={!!progress || combos.length === 0 || receivers.length === 0}>
            {progress ? `Solving ${progress.done}/${progress.total}…` : `Run ${combos.length || '—'} combinations`}
          </button>
          {progress && (
            <button className="btn" style={{ color: 'var(--red)' }}
              onClick={() => { cancelRef.v = true; }}>Cancel</button>
          )}
          {results && (
            <>
              <select value={viewRx} onChange={(e) => setViewRx(e.target.value)}>
                <option value="worst">All receivers (worst case)</option>
                {receivers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
              <button className="btn" onClick={exportXlsx}>⬇ Export XLSX</button>
            </>
          )}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={onClose}>Close</button>
        </div>

        {overlap.length > 0 && (
          <div className="hint" style={{ color: 'var(--red)', marginTop: 8 }}>
            The two axes both control {overlap.length} of the same
            unit{overlap.length === 1 ? '' : 's'}. Pick scopes that don't
            overlap — otherwise axis 2 would have no effect on those units and
            the matrix would imply a comparison that never happened.
          </div>
        )}

        {results && (
          <div style={{ overflowX: 'auto', marginTop: 12 }}>
            <table className="catalog-table" style={{ fontSize: 11 }}>
              <thead>
                <tr>
                  <th>{invOpt?.label ?? 'Axis 2'} \ {batOpt?.label ?? 'Axis 1'}</th>
                  {battery.candidates.map((c) => <th key={c.label}>{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {inverter.candidates.map((inv, i) => (
                  <tr key={inv.label}>
                    <td style={{ fontWeight: 600 }}>{inv.label}</td>
                    {battery.candidates.map((_, b) => {
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
      </div>
    </ModalBackdrop>
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
