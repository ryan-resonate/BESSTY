// Catalog screen — manages source models in two databases:
//
//   - **Global** — shared across every project on this device.
//   - **Local**  — lives on a single project; only visible when the screen
//                  is reached from within a project (URL `?project=<id>`).
//
// Tabs at the top switch between the two. Add / edit / delete buttons hit
// whichever scope is active.

import { useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  deleteGlobalEntry,
  loadGlobalCatalog,
  localCatalogOf,
  upsertGlobalEntry,
  withLocalEntry,
  withoutLocalEntry,
} from '../lib/catalog';
import { loadProject, saveProject } from '../lib/storage';
import { parseCatalogXlsx } from '../lib/xlsxImport';
import { ModalBackdrop } from '../components/ModalBackdrop';
import type {
  CatalogBandSystem,
  CatalogEntry,
  CatalogModeData,
  Project,
  SourceKind,
} from '../lib/types';

const KIND_ORDER: SourceKind[] = ['wtg', 'bess', 'auxiliary'];
const KIND_LABEL: Record<SourceKind, string> = {
  wtg: 'Wind turbines',
  bess: 'BESS',
  auxiliary: 'Auxiliary',
};

type Scope = 'global' | 'local';

export function CatalogScreen() {
  // Optional `?project=<id>` query selects a project for the Local tab.
  const location = useLocation();
  const projectId = useMemo(
    () => new URLSearchParams(location.search).get('project'),
    [location.search],
  );

  const [project, setProject] = useState<Project | null>(() =>
    projectId ? loadProject(projectId) : null,
  );
  const [scope, setScope] = useState<Scope>(projectId ? 'local' : 'global');

  const [globalEntries, setGlobalEntries] = useState<CatalogEntry[]>(() => loadGlobalCatalog());
  const [editing, setEditing] = useState<{ entry: CatalogEntry; targetScope: Scope } | null>(null);

  function refreshGlobal() {
    setGlobalEntries(loadGlobalCatalog());
  }

  function persistProject(p: Project) {
    setProject(p);
    if (projectId) saveProject(projectId, p);
  }

  function activeEntries(): CatalogEntry[] {
    if (scope === 'local') return project ? localCatalogOf(project) : [];
    return globalEntries;
  }

  function handleDelete(e: CatalogEntry) {
    if (!confirm(`Delete catalog entry "${e.displayName}"?`)) return;
    if (scope === 'global') {
      deleteGlobalEntry(e.id);
      refreshGlobal();
    } else if (project) {
      persistProject(withoutLocalEntry(project, e.id));
    }
  }
  function handleSave(updated: CatalogEntry, targetScope: Scope) {
    if (targetScope === 'global') {
      upsertGlobalEntry(updated);
      refreshGlobal();
    } else if (project) {
      persistProject(withLocalEntry(project, updated));
    }
    setEditing(null);
  }
  function copyToOtherScope(e: CatalogEntry) {
    if (scope === 'global' && project) {
      persistProject(withLocalEntry(project, { ...e, origin: 'user' }));
    } else if (scope === 'local') {
      upsertGlobalEntry({ ...e, origin: 'user' });
      refreshGlobal();
    }
  }

  const entries = activeEntries();

  return (
    <div className="catalog-screen">
      <div className="catalog-header">
        <div>
          <h2>Catalog</h2>
          <div className="subtitle">
            Source-model database. <b>Global</b> is shared across every project
            on this device; <b>Local</b> belongs to one project. The two are
            independent — copy entries between them as needed.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link to={projectId ? `/projects/${projectId}` : '/projects'} className="btn">
            ← {projectId ? 'Project' : 'Projects'}
          </Link>
          <UploadButton onLoaded={(es) => {
            if (scope === 'global') { es.forEach(upsertGlobalEntry); refreshGlobal(); }
            else if (project) {
              let next = project;
              for (const e of es) next = withLocalEntry(next, e);
              persistProject(next);
            }
          }} />
          <button className="btn primary" onClick={() => setEditing({ entry: blankEntry('wtg'), targetScope: scope })}>
            + Add entry
          </button>
        </div>
      </div>

      <div className="seg" style={{ display: 'inline-flex', marginBottom: 16 }}>
        <button className={scope === 'global' ? 'on' : ''} onClick={() => setScope('global')}>
          Global ({globalEntries.length})
        </button>
        {project && (
          <button className={scope === 'local' ? 'on' : ''} onClick={() => setScope('local')}>
            {project.name} · Local ({localCatalogOf(project).length})
          </button>
        )}
        {!project && (
          <button disabled title="Open this screen from inside a project to edit its local catalog">
            Local catalog (open from a project)
          </button>
        )}
      </div>

      {KIND_ORDER.map((kind) => {
        const ofKind = entries.filter((e) => e.kind === kind);
        return (
          <section key={kind} className="catalog-section">
            <h3>{KIND_LABEL[kind]} <span className="muted">· {ofKind.length}</span></h3>
            {ofKind.length === 0 && (
              <div className="empty-state" style={{ padding: 20, marginBottom: 12 }}>
                No {KIND_LABEL[kind].toLowerCase()} entries in this {scope} catalog.
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
                        <button className="btn small" onClick={() => setEditing({ entry: e, targetScope: scope })}>Edit</button>
                        {(scope === 'global' ? !!project : true) && (
                          <button className="btn small" onClick={() => copyToOtherScope(e)} title={scope === 'global' ? 'Copy to project local' : 'Push to global'}>
                            {scope === 'global' ? '→ Local' : '→ Global'}
                          </button>
                        )}
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
          entry={editing.entry}
          onClose={() => setEditing(null)}
          onSave={(e) => handleSave(e, editing.targetScope)}
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
      // Default to Z (un-weighted) — matches the ISO 9613-2 convention.
      // Switch to 'A' if pasting LwA-per-band datasheet values.
      weighting: 'Z',
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
          // Ask up front whether the file's per-band Lw values are A-weighted
          // (LwA per band — common for IEC 61400-11 and ISO 3744 datasheets)
          // or Z-weighted (un-weighted — the ISO 9613-2 convention). Wrong
          // answer here drives a 3–5 dB systematic error in propagated levels.
          const isAWeighted = window.confirm(
            'Are the per-band Lw values in this file A-weighted (LwA per band)?\n\n' +
            'OK   → A-weighted   (typical for IEC 61400-11 turbine reports and many BESS datasheets)\n' +
            'Cancel → Z-weighted / un-weighted   (raw Lw per band, ISO 9613-2 convention)\n\n' +
            'BESSTY converts to Z internally. Pick wrong and propagated levels are off by ~3-5 dB.',
          );
          setBusy(true);
          try {
            const entries = await parseCatalogXlsx(file);
            if (entries.length === 0) {
              alert('No catalog entries found in that file.');
            } else {
              // Tag every imported mode with the chosen weighting so the
              // converter in `spectrumFor` knows whether to un-weight.
              const weighting: 'A' | 'Z' = isAWeighted ? 'A' : 'Z';
              for (const entry of entries) {
                for (const mode of entry.modes) {
                  mode.weighting = weighting;
                }
              }
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

// ============== Frequency picker (start / end dropdowns) ==============

const OCTAVE_BANDS_HZ = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
const ONE_THIRD_OCTAVE_BANDS_HZ = [
  10, 12.5, 16, 20, 25, 31.5, 40,
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000,
];

function bandList(bandSystem: CatalogBandSystem): number[] {
  return bandSystem === 'oneThirdOctave' ? ONE_THIRD_OCTAVE_BANDS_HZ : OCTAVE_BANDS_HZ;
}

function formatHz(f: number): string {
  if (f >= 1000) {
    const k = f / 1000;
    // 1k, 1.25k, 1.6k, 2k, 2.5k etc
    return Number.isInteger(k) ? `${k}k` : `${k}k`;
  }
  return Number.isInteger(f) ? String(f) : String(f);
}

function FrequencyRangePicker(props: {
  bandSystem: CatalogBandSystem;
  frequencies: number[];
  onChange(frequencies: number[]): void;
}) {
  const all = bandList(props.bandSystem);
  // Snap the entry's first/last frequency to whichever standard band is
  // closest, so the dropdowns always have a valid selection even after a
  // manual edit elsewhere.
  function nearestIdx(target: number) {
    let bestI = 0; let bestD = Infinity;
    for (let i = 0; i < all.length; i++) {
      const d = Math.abs(Math.log(all[i]) - Math.log(target));
      if (d < bestD) { bestD = d; bestI = i; }
    }
    return bestI;
  }
  const startIdx = props.frequencies.length > 0 ? nearestIdx(props.frequencies[0]) : 0;
  const endIdx = props.frequencies.length > 0 ? nearestIdx(props.frequencies[props.frequencies.length - 1]) : all.length - 1;

  function setRange(s: number, e: number) {
    if (s > e) [s, e] = [e, s];
    props.onChange(all.slice(s, e + 1));
  }

  return (
    <div className="grid-2">
      <label className="fld">
        <span>From (lowest band)</span>
        <select value={startIdx} onChange={(ev) => setRange(+ev.target.value, endIdx)}>
          {all.map((f, i) => <option key={f} value={i}>{formatHz(f)} Hz</option>)}
        </select>
      </label>
      <label className="fld">
        <span>To (highest band)</span>
        <select value={endIdx} onChange={(ev) => setRange(startIdx, +ev.target.value)}>
          {all.map((f, i) => <option key={f} value={i}>{formatHz(f)} Hz</option>)}
        </select>
      </label>
    </div>
  );
}

/// Edit (or create) a single catalog entry.
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
    <ModalBackdrop onClose={props.onClose}>
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
                    <select
                      value={m.bandSystem}
                      onChange={(e) => {
                        const next = e.target.value as CatalogBandSystem;
                        // Re-snap frequency range when band system flips.
                        const all = bandList(next);
                        updateMode(activeModeIdx, {
                          bandSystem: next,
                          frequencies: all.slice(),
                          spectra: Object.fromEntries(
                            Object.keys(m.spectra).map((k) => [k, all.map(() => 80)]),
                          ),
                        });
                      }}>
                      <option value="octave">Octave (16 Hz – 8 kHz)</option>
                      <option value="oneThirdOctave">One-third octave (10 Hz – 10 kHz)</option>
                    </select>
                  </label>
                </div>
                <label className="fld">
                  <span>Frequency weighting of the per-band Lw values</span>
                  <select
                    value={m.weighting ?? 'Z'}
                    onChange={(e) => updateMode(activeModeIdx, { weighting: e.target.value as 'A' | 'Z' })}
                  >
                    <option value="Z">Z (un-weighted) — ISO 9613-2 convention</option>
                    <option value="A">A-weighted (LwA per band) — IEC 61400-11 / ISO 3744 datasheets</option>
                  </select>
                  <div className="hint">
                    Wind-turbine sound-power data per IEC 61400-11 is usually
                    A-weighted per band. Many BESS / inverter / transformer
                    datasheets are also A-weighted. Pick this so BESSTY can
                    convert to un-weighted before propagation; otherwise
                    levels come out ~3–5 dB low (the size of the A-weighting
                    offset across the dominant bands).
                  </div>
                </label>

                <FrequencyRangePicker
                  bandSystem={m.bandSystem}
                  frequencies={m.frequencies}
                  onChange={(fs) => {
                    const newSpectra: Record<string, number[]> = {};
                    for (const k of Object.keys(m.spectra)) {
                      const old = m.spectra[k];
                      const oldFs = m.frequencies;
                      newSpectra[k] = fs.map((f) => {
                        const oldIdx = oldFs.indexOf(f);
                        return oldIdx >= 0 ? old[oldIdx] : 0;
                      });
                    }
                    updateMode(activeModeIdx, { frequencies: fs, spectra: newSpectra });
                  }}
                />

                {draft.kind === 'wtg' && (
                  <label className="fld">
                    <span>Wind speeds (m/s @ 10 m, comma-separated; blank = broadband)</span>
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
                          <td>{formatHz(f)}</td>
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
    </ModalBackdrop>
  );
}

