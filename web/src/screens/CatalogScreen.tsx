// Global catalog screen — manage source models that any project can pull from.
//
// Two databases are visible side-by-side: the global catalog (this screen
// edits) and a per-project local catalog (visible / editable in each
// project's workspace). Entries can be transferred via the per-row actions.

import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deleteGlobalEntry,
  loadGlobalCatalog,
  upsertGlobalEntry,
} from '../lib/catalog';
import { parseCatalogXlsx } from '../lib/xlsxImport';
import type { CatalogEntry, CatalogModeData, SourceKind } from '../lib/types';

const KIND_ORDER: SourceKind[] = ['wtg', 'bess', 'auxiliary'];
const KIND_LABEL: Record<SourceKind, string> = {
  wtg: 'Wind turbines',
  bess: 'BESS',
  auxiliary: 'Auxiliary',
};

export function CatalogScreen() {
  const [entries, setEntries] = useState<CatalogEntry[]>(() => loadGlobalCatalog());
  const [editing, setEditing] = useState<CatalogEntry | null>(null);

  function refresh() {
    setEntries(loadGlobalCatalog());
  }
  useEffect(refresh, []);

  function handleDelete(e: CatalogEntry) {
    if (!confirm(`Delete catalog entry "${e.displayName}"? Any project sources still referencing it will fail to evaluate until reassigned.`)) return;
    deleteGlobalEntry(e.id);
    refresh();
  }

  function handleSave(updated: CatalogEntry) {
    upsertGlobalEntry(updated);
    setEditing(null);
    refresh();
  }

  return (
    <div className="catalog-screen">
      <div className="catalog-header">
        <div>
          <h2>Catalog</h2>
          <div className="subtitle">
            Global database of source models. Available to every project on
            this device. Per-project local catalogs live inside each project's
            workspace (Sources tab → Local catalog).
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to="/projects" className="btn">← Projects</Link>
          <UploadButton onLoaded={(es) => { es.forEach(upsertGlobalEntry); refresh(); }} />
          <button className="btn primary" onClick={() => setEditing(blankEntry('wtg'))}>
            + Add entry
          </button>
        </div>
      </div>

      {KIND_ORDER.map((kind) => {
        const ofKind = entries.filter((e) => e.kind === kind);
        return (
          <section key={kind} className="catalog-section">
            <h3>{KIND_LABEL[kind]} <span className="muted">· {ofKind.length}</span></h3>
            {ofKind.length === 0 && (
              <div className="empty-state" style={{ padding: 20, marginBottom: 12 }}>
                No {KIND_LABEL[kind].toLowerCase()} entries yet.
              </div>
            )}
            {ofKind.length > 0 && (
              <table className="catalog-table">
                <thead>
                  <tr>
                    <th>Display name</th>
                    <th>Modes</th>
                    <th>Bands</th>
                    <th>Source</th>
                    <th>Origin</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ofKind.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{e.displayName}</div>
                        <div className="muted" style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                          {e.id}
                          {e.kind === 'auxiliary' && e.auxiliaryType ? ` · ${e.auxiliaryType}` : ''}
                          {e.kind === 'wtg' && e.rotorDiameterM ? ` · rotor ${e.rotorDiameterM} m` : ''}
                        </div>
                      </td>
                      <td>{e.modes.length}</td>
                      <td>
                        {e.modes[0]?.bandSystem === 'oneThirdOctave' ? '1/3-oct' : 'oct'}
                        <span className="muted"> · {e.modes[0]?.frequencies.length}</span>
                      </td>
                      <td className="muted" style={{ fontSize: 11 }}>{e.source ?? '—'}</td>
                      <td>
                        <span className={`origin-pill ${e.origin}`}>{e.origin}</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn small" onClick={() => setEditing(e)}>Edit</button>
                        <button className="btn small" style={{ color: 'var(--red)' }} onClick={() => handleDelete(e)}>✕</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}

      {editing && (
        <CatalogEntryEditor
          entry={editing}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      )}
    </div>
  );
}

const OCT_DEFAULT = [63, 125, 250, 500, 1000, 2000, 4000, 8000];

function blankEntry(kind: SourceKind): CatalogEntry {
  return {
    id: `new-${Date.now().toString(36)}`,
    kind,
    displayName: 'New entry',
    defaultMode: 'default',
    modes: [{
      name: 'default',
      bandSystem: 'octave',
      frequencies: OCT_DEFAULT.slice(),
      spectra: kind === 'wtg'
        ? { '8': new Array(8).fill(80) }
        : { broadband: new Array(8).fill(80) },
      windSpeeds: kind === 'wtg' ? [8] : undefined,
    }],
    origin: 'user',
  };
}

function UploadButton(props: { onLoaded(entries: CatalogEntry[]): void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn" disabled={busy} onClick={() => inputRef.current?.click()}>
        {busy ? 'Parsing…' : '↑ Upload xlsx'}
      </button>
      <input
        ref={inputRef}
        type="file" accept=".xlsx,.xlsm,.xlsb"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            const entries = await parseCatalogXlsx(file);
            if (entries.length === 0) {
              alert('No catalog entries found in that file.');
            } else {
              props.onLoaded(entries);
            }
          } catch (err) {
            alert(`Import failed: ${err}`);
          }
          setBusy(false);
          e.target.value = '';
        }}
      />
    </>
  );
}

/// Edit (or create) a single catalog entry. Supports adding/removing modes,
/// editing the spectrum cell-by-cell, and tweaking metadata.
export function CatalogEntryEditor(props: {
  entry: CatalogEntry;
  onClose(): void;
  onSave(e: CatalogEntry): void;
}) {
  const [draft, setDraft] = useState<CatalogEntry>(structuredClone(props.entry));
  const [activeModeIdx, setActiveModeIdx] = useState(0);

  function update<K extends keyof CatalogEntry>(k: K, v: CatalogEntry[K]) {
    setDraft((d) => ({ ...d, [k]: v }));
  }
  function updateMode(idx: number, patch: Partial<CatalogModeData>) {
    setDraft((d) => ({
      ...d,
      modes: d.modes.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    }));
  }
  function addMode() {
    const base = draft.modes[0] ?? blankEntry(draft.kind).modes[0];
    setDraft((d) => ({
      ...d,
      modes: [...d.modes, { ...base, name: `mode ${d.modes.length + 1}`, spectra: { ...base.spectra } }],
    }));
    setActiveModeIdx(draft.modes.length);
  }
  function removeMode(idx: number) {
    if (draft.modes.length <= 1) return;
    setDraft((d) => ({ ...d, modes: d.modes.filter((_, i) => i !== idx) }));
    setActiveModeIdx(0);
  }

  const m = draft.modes[activeModeIdx];
  const wsKeys = m && m.windSpeeds && m.windSpeeds.length > 0
    ? m.windSpeeds.map((w) => String(w))
    : ['broadband'];

  return (
    <div className="modal-backdrop" onClick={props.onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 800 }}>
        <div className="modal-header">
          <h2>{draft.id ? `Edit · ${draft.displayName}` : 'New catalog entry'}</h2>
          <button className="x-btn" onClick={props.onClose}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <div className="grid-2">
              <label className="fld">
                <span>Display name</span>
                <input value={draft.displayName} onChange={(e) => update('displayName', e.target.value)} />
              </label>
              <label className="fld">
                <span>Kind</span>
                <select value={draft.kind} onChange={(e) => update('kind', e.target.value as SourceKind)}>
                  <option value="wtg">WTG</option>
                  <option value="bess">BESS</option>
                  <option value="auxiliary">Auxiliary</option>
                </select>
              </label>
            </div>
            {draft.kind === 'wtg' && (
              <label className="fld">
                <span>Rotor diameter (m)</span>
                <input type="number" min={20} max={300}
                  value={draft.rotorDiameterM ?? ''}
                  onChange={(e) => update('rotorDiameterM', +e.target.value || undefined)} />
              </label>
            )}
            {draft.kind === 'auxiliary' && (
              <label className="fld">
                <span>Sub-type (free text)</span>
                <input value={draft.auxiliaryType ?? ''}
                  onChange={(e) => update('auxiliaryType', e.target.value)} />
              </label>
            )}
          </section>

          <section className="settings-section">
            <h3>Modes</h3>
            <div className="seg block" style={{ flexWrap: 'wrap' }}>
              {draft.modes.map((md, i) => (
                <button key={i} className={i === activeModeIdx ? 'on' : ''} onClick={() => setActiveModeIdx(i)}>
                  {md.name}
                </button>
              ))}
              <button onClick={addMode}>+ mode</button>
            </div>

            {m && (
              <>
                <div className="grid-2" style={{ marginTop: 6 }}>
                  <label className="fld">
                    <span>Mode name</span>
                    <input value={m.name} onChange={(e) => updateMode(activeModeIdx, { name: e.target.value })} />
                  </label>
                  <label className="fld">
                    <span>Band system</span>
                    <select value={m.bandSystem}
                      onChange={(e) => updateMode(activeModeIdx, { bandSystem: e.target.value as CatalogModeData['bandSystem'] })}>
                      <option value="octave">Octave</option>
                      <option value="oneThirdOctave">One-third octave</option>
                    </select>
                  </label>
                </div>

                <label className="fld">
                  <span>Frequencies (Hz, comma-separated)</span>
                  <input
                    value={m.frequencies.join(', ')}
                    onChange={(e) => {
                      const fs = e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
                      const newSpectra: Record<string, number[]> = {};
                      for (const k of Object.keys(m.spectra)) {
                        const old = m.spectra[k];
                        newSpectra[k] = fs.map((_, i) => old[i] ?? 0);
                      }
                      updateMode(activeModeIdx, { frequencies: fs, spectra: newSpectra });
                    }}
                  />
                </label>

                {draft.kind === 'wtg' && (
                  <label className="fld">
                    <span>Wind speeds (m/s @ 10 m, comma-separated; blank = single broadband entry)</span>
                    <input
                      value={(m.windSpeeds ?? []).join(', ')}
                      onChange={(e) => {
                        const ws = e.target.value.split(/[,\s]+/).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
                        const newSpectra: Record<string, number[]> = {};
                        if (ws.length === 0) {
                          newSpectra['broadband'] = m.frequencies.map(() => 80);
                          updateMode(activeModeIdx, { windSpeeds: undefined, spectra: newSpectra });
                          return;
                        }
                        for (const w of ws) {
                          const k = String(w);
                          newSpectra[k] = m.spectra[k] ?? m.frequencies.map(() => 80);
                        }
                        updateMode(activeModeIdx, { windSpeeds: ws, spectra: newSpectra });
                      }}
                    />
                  </label>
                )}

                <div style={{ overflowX: 'auto' }}>
                  <table className="catalog-table" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th>Hz</th>
                        {wsKeys.map((k) => (
                          <th key={k} style={{ textAlign: 'right' }}>
                            {k === 'broadband' ? 'Lw' : `${k} m/s`}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {m.frequencies.map((f, i) => (
                        <tr key={`${f}-${i}`}>
                          <td>{f}</td>
                          {wsKeys.map((k) => (
                            <td key={k} style={{ textAlign: 'right', padding: 2 }}>
                              <input
                                type="number" step={0.1}
                                value={m.spectra[k]?.[i] ?? 0}
                                onChange={(e) => {
                                  const next = (m.spectra[k] ?? []).slice();
                                  next[i] = +e.target.value;
                                  updateMode(activeModeIdx, {
                                    spectra: { ...m.spectra, [k]: next },
                                  });
                                }}
                                style={{ width: 60, fontFamily: 'inherit', fontSize: 11, padding: '2px 4px', textAlign: 'right' }}
                              />
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {draft.modes.length > 1 && (
                  <div className="add-row" style={{ marginTop: 6 }}>
                    <button className="btn small" style={{ color: 'var(--red)' }} onClick={() => removeMode(activeModeIdx)}>
                      Delete this mode
                    </button>
                  </div>
                )}
              </>
            )}
          </section>

          <section className="settings-section">
            <label className="fld">
              <span>Default mode</span>
              <select value={draft.defaultMode}
                onChange={(e) => update('defaultMode', e.target.value)}>
                {draft.modes.map((md) => <option key={md.name} value={md.name}>{md.name}</option>)}
              </select>
            </label>
          </section>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={props.onClose}>Cancel</button>
          <button className="btn primary" onClick={() => props.onSave(draft)}>Save</button>
        </div>
      </div>
    </div>
  );
}

