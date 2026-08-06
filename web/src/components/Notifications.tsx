// Renderer for the notification store (`lib/notify.ts`).
//
// Mounted once in App.tsx. Everything else calls the imperative `notify.*` API,
// so no component needs to thread callbacks or context to raise a message.

import { useEffect, useRef, useState } from 'react';
import {
  dismissToast, resolveDialog, subscribe,
  type NotifyState, type ToastKind,
} from '../lib/notify';
import { ModalBackdrop } from './ModalBackdrop';
import { pushEscHandler } from '../lib/escStack';

const KIND_STYLE: Record<ToastKind, { bar: string; icon: string }> = {
  info:    { bar: 'var(--blue, #1565c0)',  icon: 'ℹ' },
  success: { bar: 'var(--green, #2e7d32)', icon: '✓' },
  warning: { bar: 'var(--amber, #b26a00)', icon: '⚠' },
  error:   { bar: 'var(--red, #d32f2f)',   icon: '✕' },
};

export function Notifications() {
  const [state, setState] = useState<NotifyState>({ toasts: [], dialogs: [] });
  useEffect(() => subscribe(setState), []);

  // Only the head of the queue is shown; answering it reveals the next.
  const dialog = state.dialogs[0];

  return (
    <>
      <div
        style={{
          position: 'fixed', top: 12, right: 12, zIndex: 10000,
          display: 'flex', flexDirection: 'column', gap: 8,
          maxWidth: 380, pointerEvents: 'none',
        }}
      >
        {state.toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{
              pointerEvents: 'auto',
              display: 'flex', gap: 8, alignItems: 'flex-start',
              background: 'var(--panel, #fff)',
              color: 'var(--ink, #1f2937)',
              border: '1px solid rgba(0,0,0,.15)',
              borderLeft: `4px solid ${KIND_STYLE[t.kind].bar}`,
              borderRadius: 6,
              boxShadow: '0 4px 14px rgba(0,0,0,.22)',
              padding: '8px 10px',
              fontSize: 12.5, lineHeight: 1.35,
            }}
          >
            <span style={{ color: KIND_STYLE[t.kind].bar, fontWeight: 700 }}>
              {KIND_STYLE[t.kind].icon}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              {t.title && <div style={{ fontWeight: 600, marginBottom: 2 }}>{t.title}</div>}
              <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.message}</div>
            </div>
            <button
              className="x-btn"
              title="Dismiss"
              style={{ flex: '0 0 auto' }}
              onClick={() => dismissToast(t.id)}
            >✕</button>
          </div>
        ))}
      </div>

      {dialog && (
        dialog.kind === 'confirm'
          ? <ConfirmDialog key={dialog.id} req={dialog} />
          : <PromptDialog key={dialog.id} req={dialog} />
      )}
    </>
  );
}

type ConfirmReq = Extract<NotifyState['dialogs'][number], { kind: 'confirm' }>;
type PromptReq = Extract<NotifyState['dialogs'][number], { kind: 'prompt' }>;

function ConfirmDialog({ req }: { req: ConfirmReq }) {
  const { opts } = req;
  // Esc cancels, matching the native dialog these replace.
  //
  // Enter confirms ONLY for non-destructive dialogs. A stray Enter — left over
  // from submitting the form that opened this, or from keyboard navigation —
  // must not delete a project. Destructive actions require an explicit click or
  // a deliberate Tab-to-the-button.
  // Escape goes through the shared stack so dismissing THIS dialog cannot also
  // close whatever it was opened on top of.
  useEffect(() => pushEscHandler(() => resolveDialog(req.id, false)), [req.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !opts.danger) resolveDialog(req.id, true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.id, opts.danger]);

  return (
    <ModalBackdrop onClose={() => resolveDialog(req.id, false)}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{opts.title}</h3>
        {opts.body && <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{opts.body}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
          <button
            className="btn"
            autoFocus={opts.danger}
            onClick={() => resolveDialog(req.id, false)}
          >
            {opts.cancelLabel ?? 'Cancel'}
          </button>
          <button
            className={opts.danger ? 'btn danger' : 'btn primary'}
            style={opts.danger ? { background: 'var(--red, #d32f2f)', color: '#fff' } : undefined}
            // Destructive dialogs don't autofocus their confirm button either —
            // focus lands on Cancel, so Space/Enter is a safe no-op.
            autoFocus={!opts.danger}
            onClick={() => resolveDialog(req.id, true)}
          >
            {opts.confirmLabel ?? 'OK'}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

function PromptDialog({ req }: { req: PromptReq }) {
  const { opts } = req;
  const [value, setValue] = useState(opts.defaultValue ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') resolveDialog(req.id, null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [req.id]);

  return (
    <ModalBackdrop onClose={() => resolveDialog(req.id, null)}>
      <div className="modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <h3 style={{ marginTop: 0 }}>{opts.title}</h3>
        {opts.body && <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>{opts.body}</div>}
        <form
          onSubmit={(e) => { e.preventDefault(); resolveDialog(req.id, value); }}
        >
          <label className="fld" style={{ display: 'block', marginTop: 10 }}>
            {opts.label && <span>{opts.label}</span>}
            <input
              ref={inputRef}
              value={value}
              placeholder={opts.placeholder}
              style={{ width: '100%' }}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14 }}>
            <button type="button" className="btn" onClick={() => resolveDialog(req.id, null)}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              {opts.confirmLabel ?? 'OK'}
            </button>
          </div>
        </form>
      </div>
    </ModalBackdrop>
  );
}
