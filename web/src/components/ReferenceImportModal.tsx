import { useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';
import {
  parseReferenceShapefile,
  finaliseFeatures,
  featuresBounds,
  type ParsedReference,
} from '../lib/referenceImport';
import { DEFAULT_REFERENCE_STYLE, type ReferenceLayer } from '../lib/types';

interface Props {
  onClose(): void;
  onImport(layer: ReferenceLayer, bounds: { sw: [number, number]; ne: [number, number] } | null): void;
}

function newId(): string {
  try { return `rl-${crypto.randomUUID()}`; } catch { return `rl-${Math.random().toString(36).slice(2)}`; }
}

export function ReferenceImportModal({ onClose, onImport }: Props) {
  const [parsed, setParsed] = useState<ParsedReference | null>(null);
  const [name, setName] = useState('Reference layer');
  const [labelAttr, setLabelAttr] = useState<string>('');
  const [stroke, setStroke] = useState(DEFAULT_REFERENCE_STYLE.stroke);
  const [fill, setFill] = useState(DEFAULT_REFERENCE_STYLE.fill);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onFile(file: File | null) {
    if (!file) return;
    setParsing(true); setError(null); setParsed(null);
    try {
      const r = await parseReferenceShapefile(file);
      setParsed(r);
      setName(file.name.replace(/\.(zip|shp)$/i, '') || 'Reference layer');
      // Guess a sensible label field.
      setLabelAttr(r.attributeNames.find((a) => /name|label|lot|id|title|zone/i.test(a)) ?? '');
    } catch (e) {
      setError(String(e));
    } finally {
      setParsing(false);
    }
  }

  function doImport() {
    if (!parsed || parsed.features.length === 0) return;
    const features = finaliseFeatures(parsed.features, labelAttr || null);
    const layer: ReferenceLayer = {
      id: newId(),
      name: name.trim() || 'Reference layer',
      visible: true,
      kind: 'vector',
      style: { ...DEFAULT_REFERENCE_STYLE, stroke, fill, showLabels: !!labelAttr },
      features,
    };
    onImport(layer, featuresBounds(features));
    onClose();
  }

  const c = parsed?.counts;
  const empty = !parsed || parsed.features.length === 0;

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-header">
          <h2>Import reference geometry</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <label className="fld">
              <span>Shapefile — a <code>.zip</code> with <code>.shp/.dbf/.prj</code>, or a single <code>.shp</code></span>
              <input type="file" accept=".zip,.shp" onChange={(e) => onFile(e.target.files?.[0] ?? null)} />
            </label>
            {parsing && <div className="hint">Parsing…</div>}
            {error && <div className="hint" style={{ color: 'var(--red)' }}>{error}</div>}
            {c && (
              <div className="hint" style={{ display: 'flex', gap: 12 }}>
                <span><b>{c.polygon}</b> polygons</span>
                <span><b>{c.line}</b> lines</span>
                <span><b>{c.point}</b> points</span>
              </div>
            )}
            {parsed?.warnings.map((w, i) => (
              <div key={i} className="hint" style={{ color: 'var(--red)' }}>⚠ {w}</div>
            ))}
          </section>

          {parsed && parsed.features.length > 0 && (
            <section className="settings-section">
              <label className="fld">
                <span>Layer name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label className="fld">
                <span>Label features from attribute (.dbf field → feature name)</span>
                <select value={labelAttr} onChange={(e) => setLabelAttr(e.target.value)}>
                  <option value="">— none (no labels) —</option>
                  {parsed.attributeNames.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
              </label>
              <div className="grid-2">
                <label className="fld">
                  <span>Stroke colour</span>
                  <input type="color" value={stroke} onChange={(e) => setStroke(e.target.value)} />
                </label>
                <label className="fld">
                  <span>Fill colour (polygons)</span>
                  <input type="color" value={fill} onChange={(e) => setFill(e.target.value)} />
                </label>
              </div>
              <div className="hint">
                Reference layers are purely visual — they never affect the acoustic calculation.
              </div>
            </section>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={empty} onClick={doImport}>Import as layer</button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
