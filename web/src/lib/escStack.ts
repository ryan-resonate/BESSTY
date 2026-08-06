// One Escape key, many overlays — a layering protocol so exactly ONE of them
// responds.
//
// Every overlay used to attach its own `window` keydown listener. Those are
// siblings on the same EventTarget, so `stopPropagation` does nothing between
// them and one keypress fired all of them at once. The failures were real and
// destructive: pressing Esc to dismiss the "discard manual edits?" confirm also
// closed the BESS wizard behind it, throwing away every edit; and Esc pressed
// to leave barrier-draw mode also closed a running factorial study, cancelling
// the sweep and destroying its results.
//
// The rule here is a stack: the most recently mounted overlay is the only one
// that sees Escape. Everything else — including the map's own
// "deselect / exit add-mode" — sits underneath and only runs when nothing is
// above it.
//
// Handlers are registered in mount order, so a modal opened ON TOP of a window
// is on top of the stack, which is exactly the ordering the user perceives.

type EscHandler = () => void;

const stack: EscHandler[] = [];
let installed = false;

/// Text fields own their Escape (revert / blur), so the stack never sees it.
/// `select` is included: Escape closes an open dropdown, and stealing that
/// would close the whole panel instead.
function inTextField(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return el.tagName === 'INPUT'
    || el.tagName === 'TEXTAREA'
    || el.tagName === 'SELECT'
    || el.isContentEditable === true;
}

function onKeyDown(ev: KeyboardEvent) {
  if (ev.key !== 'Escape') return;
  if (inTextField(ev.target)) return;
  const top = stack[stack.length - 1];
  if (!top) return;
  ev.preventDefault();
  ev.stopPropagation();
  top();
}

/// Register `handler` as the current top of the Escape stack. Returns an
/// unregister function; call it on unmount.
///
/// Capture phase, so this runs before any stray listener still attached
/// elsewhere and can stop the event reaching it.
export function pushEscHandler(handler: EscHandler): () => void {
  stack.push(handler);
  if (!installed) {
    window.addEventListener('keydown', onKeyDown, true);
    installed = true;
  }
  return () => {
    // `lastIndexOf`, not `indexOf`: the same function identity could in
    // principle be registered twice, and the newest registration is the one
    // being torn down.
    const i = stack.lastIndexOf(handler);
    if (i >= 0) stack.splice(i, 1);
  };
}

/// Test seam.
export function __escStackDepthForTests(): number {
  return stack.length;
}
