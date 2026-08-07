// I15 — the "Export PDF…" dialog.
//
// A snapshot, so the extent is whatever is on screen right now. Everything the
// dialog offers is report furniture; the map content mirrors the current layer
// toggles, because the figure should look like what you were just looking at.

import { useState } from 'react';
import { ModalBackdrop } from './ModalBackdrop';
import { notify } from '../lib/notify';
import { buildPdf, DEFAULT_PDF_OPTIONS, type PdfInput, type PdfOptions } from '../lib/pdfReport';

type Props = Omit<PdfInput, 'options'> & { onClose(): void };

export function PdfExportDialog(props: Props) {
  const [opts, setOpts] = useState<PdfOptions>(DEFAULT_PDF_OPTIONS);
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<PdfOptions>) => setOpts((o) => ({ ...o, ...p }));

  async function run() {
    setBusy(true);
    try {
      const doc = await buildPdf({ ...props, options: opts });
      const name = (props.project.name || 'bessty').replace(/[^\w.-]+/g, '_');
      doc.save(`${name}-noise-map.pdf`);
      notify.success('PDF exported.');
      props.onClose();
    } catch (e) {
      notify.error((e as Error).message, { title: 'PDF export failed' });
    } finally {
      setBusy(false);
    }
  }

  const check = (k: keyof PdfOptions, label: string) => (
    <label className="row-checkbox">
      <input
        type="checkbox"
        checked={opts[k] as boolean}
        onChange={(e) => set({ [k]: e.target.checked } as Partial<PdfOptions>)}
      />
      <span>{label}</span>
    </label>
  );

  return (
    <ModalBackdrop onClose={props.onClose}>
      <div className="modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>Export PDF</h3>
        <div className="hint" style={{ marginBottom: 10 }}>
          A snapshot of the current map view. The basemap goes in as an image;
          contours, receivers, sources and barriers are drawn as vectors, so
          they stay sharp and the level text stays selectable. Text is set in
          Arimo, metrically identical to Arial.
        </div>

        <label className="fld" style={{ display: 'block', marginBottom: 8 }}>
          <span>Page</span>
          <select
            value={opts.pageId}
            onChange={(e) => set({ pageId: e.target.value as PdfOptions['pageId'] })}
            style={{ width: '100%' }}
          >
            <option value="a4-landscape">A4 landscape</option>
            <option value="a4-portrait">A4 portrait</option>
            <option value="a3-landscape">A3 landscape</option>
            <option value="a3-portrait">A3 portrait</option>
          </select>
        </label>

        {check('titleBlock', 'Title block (project, scenario, date)')}
        {check('legend', 'Contour legend')}
        {check('scaleBar', 'Scale bar')}
        {check('northArrow', 'North arrow')}
        {check('showReceiverNames', 'Receiver names')}
        {check('showReceiverLimits', 'Show limits under receiver levels')}
        {check('annotations', 'Notes and dimensions')}

        {!props.grid && (
          <div className="hint" style={{ marginTop: 8 }}>
            No grid computed — the figure will show receivers and sources over
            the basemap, without contours.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button className="btn" onClick={props.onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? 'Rendering…' : 'Export PDF'}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}
