// In-app notifications — toasts and modal dialogs replacing the native
// `alert` / `confirm` / `prompt`.
//
// Why not the native ones: they block the whole tab (a `confirm` during a grid
// solve freezes the worker's callbacks), they can't be styled, they're
// suppressed by some browsers after repeated use, and they can't show more than
// a line of plain text. They also can't be triggered from non-React code.
//
// This module is the imperative API — a tiny store any module can call,
// including plain functions with no React context. `components/Notifications`
// subscribes and renders. Keep this file free of React so it stays importable
// from workers, libs and tests.

export type ToastKind = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /// Optional bold first line above the message.
  title?: string;
  /// Sticky toasts stay until dismissed. Errors are sticky by default —
  /// an error that auto-vanishes is an error nobody read.
  sticky: boolean;
}

export interface ConfirmOptions {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /// Renders the confirm button in the destructive style.
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  body?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
}

export type DialogRequest =
  | { id: number; kind: 'confirm'; opts: ConfirmOptions; resolve(v: boolean): void }
  | { id: number; kind: 'prompt'; opts: PromptOptions; resolve(v: string | null): void };

export interface NotifyState {
  toasts: Toast[];
  /// Dialogs queue rather than overwrite: two confirms fired together must both
  /// get an answer, not silently lose one.
  dialogs: DialogRequest[];
}

type Listener = (s: NotifyState) => void;

let state: NotifyState = { toasts: [], dialogs: [] };
const listeners = new Set<Listener>();
let nextId = 1;

const AUTO_DISMISS_MS = 5000;

function emit() {
  state = { toasts: [...state.toasts], dialogs: [...state.dialogs] };
  for (const l of listeners) l(state);
}

/// Subscribe to store changes. Fires immediately with the current state.
export function subscribe(l: Listener): () => void {
  listeners.add(l);
  l(state);
  return () => { listeners.delete(l); };
}

export function getState(): NotifyState {
  return state;
}

function pushToast(kind: ToastKind, message: string, opts?: { title?: string; sticky?: boolean }) {
  const id = nextId++;
  const sticky = opts?.sticky ?? kind === 'error';
  state.toasts.push({ id, kind, message, title: opts?.title, sticky });
  emit();
  if (!sticky) {
    setTimeout(() => dismissToast(id), AUTO_DISMISS_MS);
  }
  return id;
}

export function dismissToast(id: number) {
  const i = state.toasts.findIndex((t) => t.id === id);
  if (i >= 0) {
    state.toasts.splice(i, 1);
    emit();
  }
}

/// Resolve the head dialog and drop it from the queue.
export function resolveDialog(id: number, value: boolean | string | null) {
  const i = state.dialogs.findIndex((d) => d.id === id);
  if (i < 0) return;
  const [d] = state.dialogs.splice(i, 1);
  emit();
  if (d.kind === 'confirm') d.resolve(value === true);
  else d.resolve(typeof value === 'string' ? value : null);
}

/// A dialog raised with no provider mounted can never be answered, so rather
/// than hang the caller forever we resolve it negatively and say so. Negative
/// is the safe default: a destructive action asking "are you sure?" gets "no".
function noProvider(what: string): boolean {
  if (listeners.size > 0) return false;
  console.error(
    `notify.${what}() called with no <Notifications> provider mounted — ` +
    'answering negatively. Mount the provider in App.tsx.',
  );
  return true;
}

export const notify = {
  info: (message: string, opts?: { title?: string; sticky?: boolean }) =>
    pushToast('info', message, opts),
  success: (message: string, opts?: { title?: string; sticky?: boolean }) =>
    pushToast('success', message, opts),
  warning: (message: string, opts?: { title?: string; sticky?: boolean }) =>
    pushToast('warning', message, opts),
  /// Sticky by default — pass `{sticky: false}` for a transient error.
  error: (message: string, opts?: { title?: string; sticky?: boolean }) =>
    pushToast('error', message, opts),

  confirm(opts: ConfirmOptions): Promise<boolean> {
    if (noProvider('confirm')) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      state.dialogs.push({ id: nextId++, kind: 'confirm', opts, resolve });
      emit();
    });
  },

  /// Resolves with the entered string, or `null` if cancelled.
  prompt(opts: PromptOptions): Promise<string | null> {
    if (noProvider('prompt')) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      state.dialogs.push({ id: nextId++, kind: 'prompt', opts, resolve });
      emit();
    });
  },
};

/// Test seam — drops all state without notifying.
export function __resetNotifyForTests() {
  state = { toasts: [], dialogs: [] };
  nextId = 1;
}
