// Draggable, resizable, NON-MODAL window. Shared by Settings (I10) and Help
// (I11).
//
// Non-modal is the point: settings changes are only judgeable against the map,
// so the map has to stay interactive while the window is open. That rules out
// ModalBackdrop — no backdrop, no focus trap, no scroll lock.
//
// Position and size persist per `persistKey`, so reopening puts the window back
// where the user left it rather than recentring every time.

import {
  useCallback, useEffect, useRef, useState, type ReactNode,
} from 'react';

interface Rect { x: number; y: number; w: number; h: number }

interface Props {
  title: string;
  onClose(): void;
  children: ReactNode;
  /// localStorage key suffix for the remembered geometry.
  persistKey: string;
  defaultRect?: Partial<Rect>;
  minW?: number;
  minH?: number;
}

const MARGIN = 8;

function loadRect(key: string, fallback: Rect): Rect {
  try {
    const raw = localStorage.getItem(`bessty.win.${key}`);
    if (!raw) return fallback;
    const r = JSON.parse(raw) as Partial<Rect>;
    if (![r.x, r.y, r.w, r.h].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return fallback;
    }
    return r as Rect;
  } catch {
    return fallback;
  }
}

/// Keep the window reachable: a saved position from a bigger monitor must not
/// park it off-screen where it can't be dragged back.
function clampToViewport(r: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.min(r.w, Math.max(240, vw - MARGIN * 2));
  const h = Math.min(r.h, Math.max(160, vh - MARGIN * 2));
  return {
    w,
    h,
    x: Math.min(Math.max(MARGIN, r.x), Math.max(MARGIN, vw - w - MARGIN)),
    y: Math.min(Math.max(MARGIN, r.y), Math.max(MARGIN, vh - h - MARGIN)),
  };
}

export function FloatingWindow({
  title, onClose, children, persistKey, defaultRect, minW = 320, minH = 200,
}: Props) {
  const [rect, setRect] = useState<Rect>(() => clampToViewport(loadRect(persistKey, {
    x: defaultRect?.x ?? Math.max(MARGIN, window.innerWidth - (defaultRect?.w ?? 460) - 40),
    y: defaultRect?.y ?? 80,
    w: defaultRect?.w ?? 460,
    h: defaultRect?.h ?? Math.min(620, window.innerHeight - 160),
  })));

  const dragRef = useRef<{ mode: 'move' | 'resize'; dx: number; dy: number } | null>(null);

  // Persist on settle, not on every pointer move.
  useEffect(() => {
    const id = window.setTimeout(() => {
      try { localStorage.setItem(`bessty.win.${persistKey}`, JSON.stringify(rect)); } catch { /* quota */ }
    }, 300);
    return () => window.clearTimeout(id);
  }, [rect, persistKey]);

  useEffect(() => {
    const onResize = () => setRect((r) => clampToViewport(r));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Esc closes — but only when focus isn't inside a field, where Esc means
  // "abandon this edit" (same rule the map uses).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setRect((r) => clampToViewport(
      d.mode === 'move'
        ? { ...r, x: e.clientX - d.dx, y: e.clientY - d.dy }
        : { ...r, w: Math.max(minW, e.clientX - r.x), h: Math.max(minH, e.clientY - r.y) },
    ));
  }, [minW, minH]);

  const endDrag = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  function startDrag(mode: 'move' | 'resize', e: React.PointerEvent) {
    e.preventDefault();
    dragRef.current = mode === 'move'
      ? { mode, dx: e.clientX - rect.x, dy: e.clientY - rect.y }
      : { mode, dx: 0, dy: 0 };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', endDrag);
  }

  useEffect(() => endDrag, [endDrag]);

  return (
    <div
      role="dialog"
      aria-label={title}
      style={{
        position: 'fixed', left: rect.x, top: rect.y, width: rect.w, height: rect.h,
        zIndex: 9000,
        display: 'flex', flexDirection: 'column',
        background: 'var(--panel, #fff)',
        border: '1px solid rgba(0,0,0,.2)',
        borderRadius: 8,
        boxShadow: '0 10px 40px rgba(0,0,0,.3)',
        overflow: 'hidden',
      }}
    >
      <header
        onPointerDown={(e) => startDrag('move', e)}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 8px 6px 12px',
          background: 'var(--panel-2, #f3f4f6)',
          borderBottom: '1px solid rgba(0,0,0,.12)',
          cursor: 'move', userSelect: 'none', flex: '0 0 auto',
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 13, flex: 1 }}>{title}</span>
        <button className="x-btn" onClick={onClose} aria-label="Close">✕</button>
      </header>

      <div style={{ flex: 1, overflow: 'auto', padding: 12 }}>{children}</div>

      {/* Resize grip. */}
      <div
        onPointerDown={(e) => startDrag('resize', e)}
        title="Resize"
        style={{
          position: 'absolute', right: 0, bottom: 0, width: 16, height: 16,
          cursor: 'nwse-resize',
          background: 'linear-gradient(135deg, transparent 50%, rgba(0,0,0,.25) 50%)',
        }}
      />
    </div>
  );
}
