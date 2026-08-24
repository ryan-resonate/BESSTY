// The per-receiver limit grid: periods down, wind speeds across.
//
// Only reachable when `settings.compliance.windSpeedLimits` is on. With it off
// the scalar per-period fields are the whole story and this never renders —
// the setting gates the LOOKUP as well, so showing a grid nobody is judged
// against would be worse than showing nothing.
//
// Editing rules follow the parsers in `lib/limitTable.ts`: a cell is a number,
// a paste can be a whole grid, and nothing is ever inferred silently.

import { useState } from 'react';

import { notify } from '../lib/notify';
import type { LimitTable, Period, Project, Receiver } from '../lib/types';
import { PERIODS, PERIOD_LABEL } from '../lib/modes';
import {
  applyBulkLimits,
  isUsableTable,
  matchBulkRows,
  normaliseTable,
  parseBulkLimits,
  parseLimitGrid,
  tableFromScalars,
  windSpeedBin,
} from '../lib/limitTable';

/// Wind speeds a new table starts with when the user has given no other clue.
const DEFAULT_SPEEDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export function LimitTableEditor(props: {
  project: Project;
  receiver: Receiver;
  unit: string;
  onChange(table: LimitTable | undefined): void;
  /// Write this table to every receiver in the project.
  onApplyToAll(table: LimitTable): void;
}) {
  const { project, receiver, unit, onChange, onApplyToAll } = props;
  const [open, setOpen] = useState(false);
  const table = isUsableTable(receiver.limitTable) ? receiver.limitTable : undefined;

  function seed() {
    // Start from the scalar limits rather than from blanks: the project already
    // says what the limit is, and retyping it is both tedious and a chance to
    // get it wrong.
    onChange(tableFromScalars(receiver, DEFAULT_SPEEDS));
    setOpen(true);
  }

  function setCell(period: Period, i: number, v: number) {
    if (!table) return;
    const limits = { ...table.limits, [period]: table.limits[period].map((x, j) => (j === i ? v : x)) };
    onChange({ ...table, limits });
  }

  function setSpeeds(text: string) {
    const ws = text.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
    if (ws.length === 0) return;
    const wanted = [...new Set(ws.map(windSpeedBin))].sort((a, b) => a - b);
    const cur = table;
    // Keep the limit already entered at each surviving wind speed; a speed
    // being added inherits the receiver's scalar limit rather than a zero,
    // which would read as a limit of 0 dB.
    const read = (p: Period, w: number): number => {
      const i = cur?.windSpeeds.indexOf(w) ?? -1;
      if (cur && i >= 0) return cur.limits[p][i];
      return p === 'day' ? receiver.limitDayDbA
        : p === 'evening' ? receiver.limitEveningDbA : receiver.limitNightDbA;
    };
    onChange(normaliseTable({
      windSpeeds: wanted,
      limits: {
        day: wanted.map((w) => read('day', w)),
        evening: wanted.map((w) => read('evening', w)),
        night: wanted.map((w) => read('night', w)),
      },
    }));
  }

  async function pasteGrid() {
    const text = await readClipboard();
    if (text == null) return;
    const got = parseLimitGrid(text);
    if (!got.ok) { notify.warning(got.reason, { title: 'Could not read that grid' }); return; }
    onChange(got.table);
    if (got.note) notify.info(got.note);
    else notify.success(`${got.table.windSpeeds.length} wind speeds pasted.`);
  }

  if (!table) {
    return (
      <button className="btn small" onClick={seed} title="Set limits per wind speed for this receiver">
        + wind-speed limits
      </button>
    );
  }

  return (
    <div style={{ width: '100%' }}>
      <div className="add-row" style={{ marginTop: 4 }}>
        <button className="btn small" onClick={() => setOpen(!open)}>
          {open ? '▾' : '▸'} Limits by wind speed
          <span className="muted"> · {table.windSpeeds.length} speeds</span>
        </button>
        {!open && (
          <button className="btn small" style={{ color: 'var(--red)' }} onClick={() => onChange(undefined)}>
            Remove
          </button>
        )}
      </div>

      {open && (
        <div style={{ marginTop: 4 }}>
          <label className="fld" style={{ fontSize: 11 }}>
            <span>Wind speeds</span>
            <input
              defaultValue={table.windSpeeds.join(', ')}
              onBlur={(e) => setSpeeds(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              style={{ width: 180 }}
              title="Integer wind speeds, comma separated. 8 means the 7.5–8.5 m/s bin."
            />
          </label>

          <div style={{ overflowX: 'auto', marginTop: 4 }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 11 }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '2px 6px 2px 0' }}>{unit}</th>
                  {table.windSpeeds.map((w) => (
                    <th key={w} style={{ textAlign: 'right', padding: '2px 3px', fontWeight: 600 }}>{w}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {PERIODS.map((p) => (
                  <tr key={p}>
                    <td
                      style={{
                        padding: '2px 6px 2px 0',
                        fontWeight: project.scenario.period === p ? 700 : 400,
                      }}
                      title={project.scenario.period === p ? 'The period being assessed' : undefined}
                    >{PERIOD_LABEL[p]}</td>
                    {table.windSpeeds.map((w, i) => (
                      <td key={w} style={{ padding: 1 }}>
                        <input
                          type="number" step={0.5}
                          value={table.limits[p][i]}
                          onChange={(e) => setCell(p, i, +e.target.value)}
                          style={{ width: 46, fontSize: 11, padding: '1px 3px', textAlign: 'right' }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="add-row" style={{ marginTop: 4 }}>
            <button className="btn small" onClick={() => void pasteGrid()} title="Paste a grid copied from Excel">
              Paste grid
            </button>
            <button
              className="btn small"
              onClick={async () => {
                const ok = await notify.confirm({
                  title: `Apply this table to all ${project.receivers.length} receivers?`,
                  body: 'Every receiver gets these wind speeds and these limits, replacing any '
                    + 'table it already has.',
                  confirmLabel: 'Apply to all',
                });
                if (ok) onApplyToAll(table);
              }}
            >Apply to all</button>
            <button className="btn small" style={{ color: 'var(--red)' }} onClick={() => onChange(undefined)}>
              Remove
            </button>
          </div>
          <div className="hint" style={{ fontSize: 10 }}>
            A wind speed outside this table uses the nearest column — limits are never
            interpolated, because a limit is a set value rather than a measurement.
          </div>
        </div>
      )}
    </div>
  );
}

/// Read the clipboard, explaining rather than failing silently when the browser
/// refuses (Safari and Firefox both gate this behind a permission).
async function readClipboard(): Promise<string | null> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) { notify.warning('The clipboard is empty.'); return null; }
    return text;
  } catch {
    notify.warning(
      'This browser would not let the page read the clipboard. Copy the block, click '
      + 'a cell and press Ctrl+V instead.',
    );
    return null;
  }
}

// ------------------------------------------------------- bulk import dialog

/// Import a whole period's limits for every receiver at once: wind speeds
/// across the top, receiver names down the first column (decision B).
export function BulkLimitImport(props: {
  project: Project;
  onClose(): void;
  onApply(receivers: Receiver[]): void;
}) {
  const { project, onClose, onApply } = props;
  const [period, setPeriod] = useState<Period>(project.scenario.period);
  const [text, setText] = useState('');

  function apply() {
    const parsed = parseBulkLimits(text);
    if (!parsed.ok) { notify.warning(parsed.reason, { title: 'Could not read that block' }); return; }
    const match = matchBulkRows(parsed.block.rows, project.receivers);
    if (match.matched.size === 0) {
      notify.warning(
        `None of the ${parsed.block.rows.length} row names matched a receiver in this project.`,
        { title: 'Nothing to apply' },
      );
      return;
    }
    onApply(applyBulkLimits(project, period, parsed.block, match.matched));

    // Both halves of "what did that do?" get reported. A receiver the file said
    // nothing about looks identical afterwards to one deliberately left alone,
    // and only one of those is what the user meant.
    const notes: string[] = [`${match.matched.size} receiver${match.matched.size === 1 ? '' : 's'} updated for ${period}.`];
    if (match.unmatchedRows.length > 0) {
      notes.push(`No receiver matched: ${match.unmatchedRows.join(', ')}.`);
    }
    if (match.missingReceivers.length > 0) {
      notes.push(`Not in the file, left unchanged: ${match.missingReceivers.join(', ')}.`);
    }
    if (match.unmatchedRows.length > 0 || match.missingReceivers.length > 0) {
      notify.warning(notes.join('\n'), { title: 'Imported with gaps' });
    } else {
      notify.success(notes[0]);
    }
    onClose();
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="hint">
        Paste a block with <b>wind speeds across the top row</b> and <b>receiver names down
        the first column</b>. One period at a time.
      </div>
      <label className="fld">
        <span>Period</span>
        <select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
          {PERIODS.map((p) => <option key={p} value={p}>{PERIOD_LABEL[p]}</option>)}
        </select>
      </label>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder={'\t3\t4\t5\nHouse A\t35\t35\t36\nHouse B\t40\t40\t41'}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 11, width: '100%' }}
      />
      <div className="add-row">
        <button className="btn small primary" onClick={apply} disabled={!text.trim()}>Import</button>
        <button className="btn small" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
