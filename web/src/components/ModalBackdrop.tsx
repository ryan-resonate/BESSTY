// Modal backdrop with drag-select safety.
//
// The naive pattern `<div onClick={onClose}>` is broken for any modal that
// contains text inputs: when the user clicks inside an input, drags the
// selection past the modal edge, and releases outside, the click event
// fires on the backdrop (since that's where mouse-up landed) and the
// modal closes mid-edit. Bug then cascades into "I can't clear the field
// because the window vanishes the moment I release the mouse."
//
// Standard fix: track `mousedown` and only treat it as a close-intent
// click if BOTH mouse-down AND mouse-up happened on the backdrop element
// itself (not bubbled up from an input child). Same idea used by
// react-modal, MUI Dialog, headless-ui, etc.

import { useRef, type ReactNode, type MouseEvent } from 'react';

interface Props {
  onClose(): void;
  children: ReactNode;
  /// Forwarded to the backdrop div. Defaults to the modal-backdrop class.
  className?: string;
  style?: React.CSSProperties;
}

export function ModalBackdrop({ onClose, children, className = 'modal-backdrop', style }: Props) {
  const downOnBackdropRef = useRef(false);

  function onMouseDown(e: MouseEvent<HTMLDivElement>) {
    downOnBackdropRef.current = e.target === e.currentTarget;
  }
  function onClick(e: MouseEvent<HTMLDivElement>) {
    // Only close if mouse-down AND the click landed on the backdrop itself.
    // A click that arrived via an input drag-select-release will fail the
    // mouse-down check; a stray child click bubbling up will fail the
    // target check.
    if (downOnBackdropRef.current && e.target === e.currentTarget) {
      onClose();
    }
    downOnBackdropRef.current = false;
  }

  return (
    <div className={className} style={style} onMouseDown={onMouseDown} onClick={onClick}>
      {children}
    </div>
  );
}
