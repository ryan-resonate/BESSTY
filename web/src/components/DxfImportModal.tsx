// DXF import: pick the file, confirm the units, name the CRS, then say what
// each layer is.
//
// The units step is the one that earns its place. A DXF carries no coordinate
// system and often no honest unit either, and reading a millimetre drawing as
// metres puts the site 1000× too big while looking perfectly well drawn. So
// rather than asking "what units is this?", the dialog answers "here is how big
// your site would be under each" and lets the eye do the work.

import { useMemo, useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';
import { EpsgPicker } from './EpsgPicker';
import { notify } from '../lib/notify';
import { dxfLayers, insUnitsName, type DxfDocument } from '../lib/dxfParse';
import {
  applyDxfPlan, layerHasZ, parseDxfFile, suggestedUnit, unitCandidates,
  type DxfImportResult, type DxfLayerPlan, type DxfPlacement,
} from '../lib/dxfImport';

interface Props {
  onClose(): void;
  /// Receives the objects to merge, plus the extent so the map can fly there.
  onImport(result: DxfImportResult, place: DxfPlacement, doc: DxfDocument): void;
  /// First unused barrier number, so imported walls continue the project's
  /// numbering rather than colliding with it.
  nextBarrierIndex: number;
  /// Local ground level at a lat/lng, for converting an absolute Z in the
  /// drawing into the height-above-ground a barrier stores. Null when no
  /// terrain is loaded, in which case Z mode is not offered.
  groundAt: ((latLng: [number, number]) => number) | null;
}

function formatM(m: number): string {
  if (!Number.isFinite(m) || m <= 0) return '—';
  if (m >= 10_000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 1000) return `${(m / 1000).toFixed(2)} km`;
  if (m >= 10) return `${m.toFixed(0)} m`;
  return `${m.toFixed(2)} m`;
}

export function DxfImportModal({ onClose, onImport, nextBarrierIndex, groundAt }: Props) {
  const [doc, setDoc] = useState<DxfDocument | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unitScale, setUnitScale] = useState(1);
  const [epsg, setEpsg] = useState(28354);
  const [plans, setPlans] = useState<DxfLayerPlan[]>([]);

  const candidates = useMemo(
    () => (doc ? unitCandidates(doc.entities, doc.insUnits) : []),
    [doc],
  );
  const layers = useMemo(() => (doc ? dxfLayers(doc.entities) : []), [doc]);
  /// Which layers carry a usable Z. Computed once per document rather than
  /// per layer per render — it is a full scan of every entity, and a 40 000-
  /// entity drawing with 60 layers spent tens of milliseconds redoing it on
  /// every click.
  const layersWithZ = useMemo(() => {
    const s = new Set<string>();
    if (doc) for (const l of dxfLayers(doc.entities)) {
      if (layerHasZ(doc.entities, l.name)) s.add(l.name);
    }
    return s;
  }, [doc]);

  async function onFile(file: File | null) {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDoc(null);
    try {
      const parsed = await parseDxfFile(file);
      const cands = unitCandidates(parsed.entities, parsed.insUnits);
      setDoc(parsed);
      setUnitScale(suggestedUnit(cands).metresPerUnit);
      // Everything starts as reference geometry: importing a drawing should not
      // silently add screening objects that change computed levels.
      setPlans(dxfLayers(parsed.entities).map((l) => ({
        layer: l.name, target: 'reference' as const, heightM: 3, useZ: false,
      })));
    } catch (e) {
      setError((e as Error).message ?? String(e));
    } finally {
      setBusy(false);
    }
  }

  function patch(layer: string, p: Partial<DxfLayerPlan>) {
    setPlans((cur) => cur.map((x) => (x.layer === layer ? { ...x, ...p } : x)));
  }

  function doImport() {
    if (!doc) return;
    const place: DxfPlacement = { unitScale, epsg };
    let result;
    try {
      result = applyDxfPlan(doc.entities, plans, place, { nextBarrierIndex, groundAt });
    } catch (e) {
      // `toWgs84` throws for a CRS proj4 does not know. Without this the modal
      // just sat there having done nothing, with no message.
      setError(`Could not place the drawing in EPSG:${epsg} — ${(e as Error).message ?? String(e)}`);
      return;
    }
    const nothing = result.barriers.length === 0
      && result.referenceFeaturesByLayer.length === 0;
    if (nothing) {
      notify.info(
        'Nothing was imported. Either every layer is set to Skip, or the units '
        + 'and coordinate system place the drawing outside the world.',
        { title: 'Nothing imported' },
      );
      return;
    }
    onImport(result, place, doc);
    onClose();
  }

  const skippedTypes = doc ? Object.entries(doc.skipped) : [];

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" style={{ maxWidth: 660 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Import DXF</h3>

        {!doc && (
          <>
            <div className="hint" style={{ marginBottom: 10 }}>
              ASCII DXF up to 50 MB. Lines, polylines, arcs, circles, text and
              block references are read; anything else is listed and skipped.
            </div>
            <input
              type="file"
              accept=".dxf"
              disabled={busy}
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                // Cleared so picking the SAME file again still fires a change
                // event — otherwise retrying after an error is a dead button.
                e.target.value = '';
                void onFile(f);
              }}
            />
            {busy && <div className="meta-line" style={{ marginTop: 8 }}>Reading…</div>}
          </>
        )}

        {error && (
          <div className="hint" style={{ color: 'var(--red)', marginTop: 8 }}>{error}</div>
        )}

        {doc && (
          <>
            <div className="meta-line" style={{ marginBottom: 8 }}>
              {doc.entities.length} object{doc.entities.length === 1 ? '' : 's'} on{' '}
              {layers.length} layer{layers.length === 1 ? '' : 's'} · drawing says{' '}
              <b>{insUnitsName(doc.insUnits)}</b>
            </div>

            <div className="meta-line" style={{ marginTop: 10 }}><b>1 · Units</b></div>
            <div className="hint">
              A DXF often mis-states its units, so check the site size rather
              than the label — the right one should look like your site.
            </div>
            <div className="dxf-units">
              {candidates.map((c) => (
                <label
                  key={c.label}
                  className={`dxf-unit${unitScale === c.metresPerUnit ? ' on' : ''}${c.plausible ? '' : ' implausible'}`}
                >
                  <input
                    type="radio"
                    name="dxf-units"
                    checked={unitScale === c.metresPerUnit}
                    onChange={() => setUnitScale(c.metresPerUnit)}
                  />
                  <span className="dxf-unit-name">
                    {c.label}{c.fromHeader ? ' (as stated)' : ''}
                  </span>
                  <span className="dxf-unit-size">
                    {formatM(c.widthM)} × {formatM(c.heightM)}
                  </span>
                </label>
              ))}
            </div>

            <div className="meta-line" style={{ marginTop: 12 }}><b>2 · Coordinate system</b></div>
            <div className="hint">
              A DXF stores no coordinate system. Pick the one the drawing was
              set out in — the geometry lands on the map when you import, so a
              wrong choice is obvious immediately.
            </div>
            <EpsgPicker value={epsg} onChange={setEpsg} label="" />

            <div className="meta-line" style={{ marginTop: 12 }}><b>3 · Layers</b></div>
            <div className="hint">
              Reference geometry is drawn on the map but never affects levels.
              Walls do — they screen sound.
            </div>
            <div className="dxf-layers">
              {layers.map((l) => {
                const p = plans.find((x) => x.layer === l.name);
                if (!p) return null;
                // Z mode needs terrain to subtract: without a DEM there is
                // nothing to convert an absolute level against, so the option
                // is not offered rather than silently doing nothing.
                const hasZ = layersWithZ.has(l.name) && groundAt != null;
                return (
                  <div key={l.name} className="dxf-layer">
                    <div className="dxf-layer-head">
                      <b>{l.name}</b>
                      <span className="muted">
                        {[
                          l.lines ? `${l.lines} line` : '',
                          l.curves ? `${l.curves} curve` : '',
                          l.texts ? `${l.texts} text` : '',
                          l.points ? `${l.points} point` : '',
                        ].filter(Boolean).join(' · ') || 'empty'}
                      </span>
                    </div>
                    <div className="seg block">
                      {(['reference', 'barriers', 'skip'] as const).map((t) => (
                        <button
                          key={t}
                          className={p.target === t ? 'on' : ''}
                          onClick={() => patch(l.name, { target: t })}
                        >{t === 'reference' ? 'Reference' : t === 'barriers' ? 'Walls' : 'Skip'}</button>
                      ))}
                    </div>
                    {p.target === 'barriers' && (
                      <div className="dxf-layer-opts">
                        <label>
                          Height (m)
                          <input
                            type="number"
                            step={0.5}
                            value={p.heightM}
                            onChange={(e) => patch(l.name, { heightM: Math.max(0.1, +e.target.value || 0) })}
                          />
                        </label>
                        {hasZ && (
                          <label className="row-checkbox" title="Treat each vertex's Z as an absolute top level and subtract the terrain beneath it">
                            <input
                              type="checkbox"
                              checked={p.useZ}
                              onChange={(e) => patch(l.name, { useZ: e.target.checked })}
                            />
                            <span>Use Z as top level</span>
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {skippedTypes.length > 0 && (
              <div className="hint" style={{ marginTop: 10 }}>
                Skipped: {skippedTypes.map(([k, n]) => `${n}× ${k}`).join(', ')}.
              </div>
            )}
            {doc.warnings.map((w) => (
              <div key={w} className="hint" style={{ marginTop: 6, color: 'var(--red)' }}>{w}</div>
            ))}
          </>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={doImport} disabled={!doc || busy}>
            Import
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
