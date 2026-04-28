// "Local catalog" card shown in the Sources tab. Mirrors the global catalog
// screen's affordances but writes to `project.localCatalog`.

import { useRef, useState } from 'react';
import { localCatalogOf, withLocalEntry, withoutLocalEntry, loadGlobalCatalog } from '../lib/catalog';
import { parseCatalogXlsx } from '../lib/xlsxImport';
import type { CatalogEntry, Project } from '../lib/types';

interface Props {
  project: Project;
  setProject(p: Project): void;
  onEditEntry(e: CatalogEntry): void;
}

export function LocalCatalogCard({ project, setProject, onEditEntry }: Props) {
  const local = localCatalogOf(project);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [busy, setBusy] = useState(false);

  function copyFromGlobal(e: CatalogEntry) {
    setProject(withLocalEntry(project, { ...e, origin: 'user', source: e.source ?? 'copied from global' }));
    setBrowsing(false);
  }
  function deleteLocal(id: string) {
    if (!confirm('Remove from this project\'s local catalog?')) return;
    setProject(withoutLocalEntry(project, id));
  }
  async function handleUpload(file: File) {
    setBusy(true);
    try {
      const entries = await parseCatalogXlsx(file);
      let next = project;
      for (const e of entries) next = withLocalEntry(next, e);
      setProject(next);
    } catch (err) {
      alert(`Import failed: ${err}`);
    }
    setBusy(false);
  }

  return (
    <section className="sp-section">
      <h3>
        <span>Local catalog</span>
        <span className="badge">{local.length}</span>
      </h3>
      <div className="hint">
        Models that live with this project only. Independent of the global catalog;
        copy entries between the two as needed.
      </div>
      <div className="add-row">
        <button className="btn small" onClick={() => onEditEntry({
          id: `local-${Date.now().toString(36)}`,
          kind: 'wtg',
          displayName: 'New local entry',
          defaultMode: 'default',
          modes: [{
            name: 'default', bandSystem: 'octave',
            frequencies: [63, 125, 250, 500, 1000, 2000, 4000, 8000],
            spectra: { '8': new Array(8).fill(80) },
            windSpeeds: [8],
          }],
          origin: 'user',
        })}>+ New</button>
        <button className="btn small" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Parsing…' : '↑ Upload xlsx'}
        </button>
        <button className="btn small" onClick={() => setBrowsing(true)}>Copy from global…</button>
        <input
          ref={fileRef} type="file" accept=".xlsx,.xlsm,.xlsb"
          style={{ display: 'none' }}
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) await handleUpload(f);
            e.target.value = '';
          }}
        />
      </div>

      {local.length === 0 && <div className="hint">Nothing here yet.</div>}
      {local.map((e) => (
        <div key={e.id} className="item">
          <div className="item-name">{e.displayName}</div>
          <div className="item-meta">
            {e.kind} · {e.modes.length} mode{e.modes.length === 1 ? '' : 's'}
            {e.modes[0] && <> · {e.modes[0].bandSystem === 'oneThirdOctave' ? '1/3 oct' : 'oct'}</>}
          </div>
          <div className="item-controls" onClick={(ev) => ev.stopPropagation()}>
            <button className="btn small" onClick={() => onEditEntry(e)}>Edit</button>
            <button className="x-btn" onClick={() => deleteLocal(e.id)}>✕</button>
          </div>
        </div>
      ))}

      {browsing && (
        <GlobalBrowser onPick={copyFromGlobal} onClose={() => setBrowsing(false)} />
      )}
    </section>
  );
}

function GlobalBrowser({ onPick, onClose }: { onPick(e: CatalogEntry): void; onClose(): void }) {
  const entries = loadGlobalCatalog();
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560 }}>
        <div className="modal-header">
          <h2>Copy from global catalog</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <table className="catalog-table">
            <thead>
              <tr><th>Display name</th><th>Kind</th><th>Modes</th><th></th></tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.displayName}</td>
                  <td>{e.kind}</td>
                  <td>{e.modes.length}</td>
                  <td><button className="btn small" onClick={() => onPick(e)}>Copy</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
