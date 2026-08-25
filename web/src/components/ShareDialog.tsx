// Publishing a read-only share link, and withdrawing one.
//
// The dialog's job is to make the publisher's choice an informed one, because
// a share is not undoable in the usual sense: once the URL is sent, the only
// remedy is revocation, and revocation cannot un-see anything already read.
// So the two things it insists on saying are WHAT will be visible and FOR HOW
// LONG — and it prices every state, since the difference between a share that
// fits and one that does not is which boxes are ticked.

import { useEffect, useMemo, useState } from 'react';

import { ModalBackdrop } from './ModalBackdrop';
import { notify } from '../lib/notify';
import { traceForExport } from '../lib/contourLines';
import { listMyShares, publishShare, revokeShare, type ShareSummary } from '../lib/firestoreShares';
import {
  DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES, PAYLOAD_INLINE_LIMIT,
  describeBytes, describePublishError, shareContoursOf, shareUrl,
} from '../lib/share';
import {
  collectShareStates, estimateBytes, shareStatesFor, type AvailableState,
} from '../lib/shareStates';
import type { ShareState } from '../lib/share';
import type { GridResult, ReceiverResult } from '../lib/solver';
import type { CustomContourLine, Project } from '../lib/types';
import type { SweepResult } from '../lib/windSweep';

export function ShareDialog(props: {
  project: Project;
  projectId: string;
  results: ReceiverResult[] | null;
  grid: GridResult | null;
  sweep: SweepResult | null;
  contourLevels: number[];
  customContours?: CustomContourLine[];
  onClose(): void;
}) {
  const {
    project, projectId, results, grid, sweep, contourLevels, customContours, onClose,
  } = props;

  const states = useMemo(
    () => collectShareStates({ project, results, grid, sweep }),
    [project, results, grid, sweep],
  );

  const [selected, setSelected] = useState<Set<string>>(
    // The state on screen is ticked to begin with: it is the one the publisher
    // is looking at, and a dialog that opens with nothing selected makes the
    // common case (share what I can see) into three clicks.
    () => new Set(states.length > 0 ? [states[0].key] : []),
  );
  const [includeGrid, setIncludeGrid] = useState(true);
  const [includeContours, setIncludeContours] = useState(true);
  const [label, setLabel] = useState('');
  const [expiryDays, setExpiryDays] = useState<number>(DEFAULT_EXPIRY_DAYS);
  const [draftOrFinal, setDraftOrFinal] = useState<'draft' | 'final'>('draft');
  const [busy, setBusy] = useState(false);
  const [published, setPublished] = useState<{ token: string; expiresAt: string } | null>(null);
  const [links, setLinks] = useState<ShareSummary[]>([]);

  useEffect(() => {
    // Best-effort: the index only exists once something has been published
    // through the function, so an empty or failed read is the normal state
    // today and is not worth a toast.
    listMyShares().then(setLinks).catch(() => setLinks([]));
  }, [published]);

  const estimate = estimateBytes(states, selected, includeGrid);
  const overSize = estimate > PAYLOAD_INLINE_LIMIT;

  function toggle(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function publish() {
    if (busy || selected.size === 0) return;
    setBusy(true);
    try {
      // Contours are traced now rather than held from the map, so the share
      // carries lines at the levels currently on screen — the same rule every
      // other export in the app follows.
      const contoursByKey = new Map<string, ShareState['contours']>();
      if (includeContours) {
        for (const s of states) {
          if (!selected.has(s.key) || !s.grid) continue;
          const sets = await traceForExport(s.grid, contourLevels, customContours);
          contoursByKey.set(s.key, shareContoursOf(sets));
        }
      }
      const out = await publishShare({
        projectId,
        label,
        expiryDays,
        draftOrFinal,
        states: shareStatesFor(states, selected, includeGrid, contoursByKey),
      });
      setPublished(out);
      notify.success('Share link published.');
    } catch (e) {
      notify.error(describePublishError(e), { title: 'Could not publish' });
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(token: string) {
    const ok = await notify.confirm({
      title: 'Withdraw this link?',
      body: 'Anyone holding it will stop being able to open it. This cannot be undone — '
        + 'publishing again creates a new link with a new address.',
      confirmLabel: 'Withdraw',
    });
    if (!ok) return;
    try {
      await revokeShare(token);
      setLinks((prev) => prev.map((l) => (l.token === token ? { ...l, revoked: true } : l)));
      notify.success('Link withdrawn.');
    } catch (e) {
      notify.error(e instanceof Error ? e.message : String(e), { title: 'Could not withdraw' });
    }
  }

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" style={{ width: 620, maxHeight: '86vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-header"><b>Share a read-only link</b></div>

        <div className="modal-body" style={{ overflow: 'auto', minHeight: 0 }}>
          {published ? (
            <PublishedLink
              token={published.token}
              expiresAt={published.expiresAt}
              onAnother={() => setPublished(null)}
            />
          ) : (
            <>
              <div className="hint" style={{ fontSize: 11 }}>
                Anyone with the link can open it, without an account. They see contours,
                receivers and their limits, source positions and noise walls — never
                contributions, terrain data, or anything about who worked on the project.
                The link is a frozen snapshot: republish to update it.
              </div>

              {states.length === 0 ? (
                <div style={{ padding: 12, fontSize: 12 }}>
                  Nothing has been computed yet. Run the grid, or a wind sweep, and the
                  states you solve will be offered here.
                </div>
              ) : (
                <>
                  <div className="meta-line" style={{ marginTop: 10 }}>
                    <b>What the viewer can switch between</b>
                  </div>
                  <div style={{ maxHeight: 190, overflow: 'auto', border: '1px solid var(--line, #ddd)', borderRadius: 4 }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <tbody>
                        {states.map((s) => (
                          <StateRow
                            key={s.key}
                            state={s}
                            checked={selected.has(s.key)}
                            includeGrid={includeGrid}
                            onToggle={() => toggle(s.key)}
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="add-row" style={{ marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <label className="row-checkbox" style={{ fontSize: 11 }}>
                      <input type="checkbox" checked={includeContours}
                        onChange={(e) => setIncludeContours(e.target.checked)} />
                      <span>Contour lines</span>
                    </label>
                    <label className="row-checkbox" style={{ fontSize: 11 }}>
                      <input type="checkbox" checked={includeGrid}
                        onChange={(e) => setIncludeGrid(e.target.checked)} />
                      <span title="The filled colour wash. This is what makes a share large.">
                        Filled grid
                      </span>
                    </label>
                    <span style={{ fontSize: 11, marginLeft: 'auto', color: overSize ? 'var(--red)' : undefined }}>
                      about {describeBytes(estimate)}
                      {overSize && ` — over the ${describeBytes(PAYLOAD_INLINE_LIMIT)} limit`}
                    </span>
                  </div>
                  {overSize && (
                    <div className="hint" style={{ fontSize: 10, color: 'var(--red)' }}>
                      Untick the filled grid, or include fewer states. Contour lines alone
                      are a fraction of the size and stay sharp at any zoom.
                    </div>
                  )}
                  <div className="hint" style={{ fontSize: 10 }}>
                    Contour lines are not counted above until they are traced, so the real
                    size is a little higher. Publishing checks the true size and refuses
                    rather than truncating.
                  </div>

                  <div className="grid-2" style={{ marginTop: 10 }}>
                    <label className="fld">
                      <span>Label</span>
                      <input
                        value={label}
                        maxLength={120}
                        placeholder="e.g. Planning submission"
                        onChange={(e) => setLabel(e.target.value)}
                      />
                    </label>
                    <label className="fld">
                      <span>Expires after</span>
                      <select value={expiryDays} onChange={(e) => setExpiryDays(Number(e.target.value))}>
                        {EXPIRY_CHOICES.map((d) => (
                          <option key={d} value={d}>{d} days</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="add-row" style={{ alignItems: 'center' }}>
                    <span style={{ fontSize: 11 }}>Mark as</span>
                    {(['draft', 'final'] as const).map((v) => (
                      <button
                        key={v}
                        className={`btn small${draftOrFinal === v ? ' active' : ''}`}
                        onClick={() => setDraftOrFinal(v)}
                      >{v === 'draft' ? 'Draft' : 'Final'}</button>
                    ))}
                    <span className="hint" style={{ fontSize: 10, marginLeft: 8 }}>
                      shown in the viewer’s header
                    </span>
                  </div>
                </>
              )}

              {links.length > 0 && <LinkList links={links} onWithdraw={withdraw} />}
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Close</button>
          {!published && (
            <button
              className="btn primary"
              disabled={busy || selected.size === 0 || states.length === 0}
              onClick={() => void publish()}
            >
              {busy ? 'Publishing…' : 'Publish link'}
            </button>
          )}
        </div>
      </div>
    </ModalBackdrop>
  );
}

function StateRow({
  state, checked, includeGrid, onToggle,
}: {
  state: AvailableState; checked: boolean; includeGrid: boolean; onToggle(): void;
}) {
  const bytes = state.receiverBytes + (includeGrid ? state.gridBytes : 0);
  return (
    <tr>
      <td style={{ padding: '3px 6px', width: 22 }}>
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </td>
      <td style={{ padding: '3px 6px' }}>{state.label}</td>
      <td style={{ padding: '3px 6px', opacity: 0.7 }}>
        {state.grid ? 'contours + grid' : 'receivers only'}
      </td>
      <td style={{ padding: '3px 6px', textAlign: 'right', opacity: 0.7 }}>
        {describeBytes(bytes)}
      </td>
    </tr>
  );
}

function PublishedLink({
  token, expiresAt, onAnother,
}: { token: string; expiresAt: string; onAnother(): void }) {
  const url = shareUrl(token);
  return (
    <div style={{ padding: '6px 0' }}>
      <div className="meta-line"><b>Link published</b></div>
      <div className="add-row" style={{ marginTop: 6 }}>
        <input readOnly value={url} style={{ flex: 1, fontSize: 11 }} onFocus={(e) => e.currentTarget.select()} />
        <button
          className="btn small"
          onClick={() => {
            void navigator.clipboard.writeText(url)
              .then(() => notify.success('Link copied.'))
              .catch(() => notify.warning('Could not copy — select the text and copy manually.'));
          }}
        >Copy</button>
      </div>
      <div className="hint" style={{ fontSize: 11, marginTop: 6 }}>
        Expires {new Date(expiresAt).toLocaleDateString()}. Anyone with this address can
        open it — treat it like the document itself. It can be withdrawn at any time.
      </div>
      <button className="btn small" style={{ marginTop: 8 }} onClick={onAnother}>
        Publish another
      </button>
    </div>
  );
}

function LinkList({
  links, onWithdraw,
}: { links: ShareSummary[]; onWithdraw(token: string): void }) {
  return (
    <>
      <div className="meta-line" style={{ marginTop: 12 }}><b>Your links</b></div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
        <tbody>
          {links.map((l) => {
            const expired = Date.parse(l.expiresAt) <= Date.now();
            const dead = l.revoked || expired;
            return (
              <tr key={l.token} style={{ opacity: dead ? 0.55 : 1 }}>
                <td style={{ padding: '3px 6px' }}>
                  {l.label || '(no label)'}
                  {l.draftOrFinal === 'draft' && (
                    <span style={{ marginLeft: 6, fontSize: 9, opacity: 0.7 }}>DRAFT</span>
                  )}
                </td>
                <td style={{ padding: '3px 6px', opacity: 0.75 }}>
                  {l.revoked ? 'withdrawn' : expired ? 'expired'
                    : `expires ${new Date(l.expiresAt).toLocaleDateString()}`}
                </td>
                <td style={{ padding: '3px 6px', textAlign: 'right' }}>
                  {!dead && (
                    <>
                      <button
                        className="btn small"
                        onClick={() => {
                          void navigator.clipboard.writeText(shareUrl(l.token))
                            .then(() => notify.success('Link copied.'))
                            .catch(() => notify.warning('Could not copy.'));
                        }}
                      >Copy</button>
                      <button
                        className="btn small"
                        style={{ color: 'var(--red)', marginLeft: 4 }}
                        onClick={() => onWithdraw(l.token)}
                      >Withdraw</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}
