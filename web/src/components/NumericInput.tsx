// NaN-safe wrapper around `<input type="number">` with locally-buffered
// text so the user can clear and retype without the field snapping back.
//
// Why the local buffer: the previous implementation committed `fallback`
// to the parent on every empty intermediate keystroke (e.g. when you
// select-all-delete to retype "150" as "50", the moment the field went
// empty the parent re-rendered with `100` and the input snapped to that
// — making it impossible to clear-and-retype). Now the displayed text
// lives in component state. The parent is only notified when the buffer
// parses to a finite number, or on blur (with fallback).
//
// We still solve the original problem this component was created for —
// React's controlled-input invariants blow up when `value` is NaN. The
// initial sync from `props.value` filters NaN to '' before it ever
// reaches the DOM.

import { useEffect, useRef, useState } from 'react';

interface Props {
  /// Current value. `null`, `undefined`, NaN, or ±Infinity all render as
  /// the empty field. External updates (undo, parent state change) are
  /// detected and re-synced into the local buffer automatically.
  value: number | null | undefined;
  /// Called with the parsed number when the buffer parses cleanly.
  /// NEVER called with NaN. When the buffer is empty and `allowEmpty`
  /// is false, the fallback is committed on blur instead.
  onChange(v: number): void;
  /// Replacement value when the user empties the field and `allowEmpty`
  /// is false. Default 0 — most callers should override.
  fallback?: number;
  /// When true, an empty buffer is allowed: the parent is notified via
  /// `onChangeOptional(undefined)` on blur, and the field can stay blank.
  /// Use for buffered draft inputs (BulkEditPanel) where empty means
  /// "leave this field untouched on apply".
  allowEmpty?: boolean;
  onChangeOptional?(v: number | undefined): void;

  // Pass-throughs.
  min?: number;
  max?: number;
  step?: number;
  className?: string;
  title?: string;
  placeholder?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

function valueToText(v: number | null | undefined): string {
  return (v != null && Number.isFinite(v)) ? String(v) : '';
}

export function NumericInput(props: Props) {
  const {
    value, onChange, fallback = 0, allowEmpty, onChangeOptional,
    min, max, step, className, title, placeholder, style, disabled,
  } = props;

  // Local buffer for the displayed text. Decouples the field from the
  // parent prop so the user can mid-edit (clear, paste, type partial
  // numbers like "1." or "-") without React re-rendering the input from
  // under them.
  const [text, setText] = useState<string>(() => valueToText(value));

  // Track whether the most recent edit came from THIS input vs. an
  // external prop change. If the parent's `value` shifts due to something
  // unrelated (undo, recompute, another component), re-sync the buffer.
  // If it shifts because of our own onChange, the parsed buffer already
  // matches and we leave the text alone (so "5.0" stays as "5.0", not "5").
  const lastCommittedRef = useRef<number | null | undefined>(value);
  useEffect(() => {
    if (value === lastCommittedRef.current) return;
    // External change. Resync the displayed text to match the new value,
    // overwriting whatever the user was mid-typing.
    setText(valueToText(value));
    lastCommittedRef.current = value;
  }, [value]);

  function commitText(raw: string) {
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (allowEmpty) {
        onChangeOptional?.(undefined);
        lastCommittedRef.current = undefined;
      } else {
        onChange(fallback);
        onChangeOptional?.(fallback);
        setText(String(fallback));
        lastCommittedRef.current = fallback;
      }
      return;
    }
    const n = +trimmed;
    if (Number.isFinite(n)) {
      onChange(n);
      onChangeOptional?.(n);
      lastCommittedRef.current = n;
    } else {
      // Garbled (e.g. "1.2.3", "abc"). Restore the last good value if we
      // have one, else fall back. For `allowEmpty` fields, prefer
      // restoring to undefined (don't manufacture a fallback the user
      // didn't ask for).
      if (allowEmpty && (value == null || !Number.isFinite(value))) {
        onChangeOptional?.(undefined);
        setText('');
        lastCommittedRef.current = undefined;
        return;
      }
      const restore = (value != null && Number.isFinite(value)) ? value : fallback;
      onChange(restore);
      onChangeOptional?.(restore);
      setText(String(restore));
      lastCommittedRef.current = restore;
    }
  }

  return (
    <input
      type="number"
      value={text}
      onChange={(e) => {
        const raw = e.target.value;
        setText(raw);                    // always update the displayed text
        const trimmed = raw.trim();
        if (trimmed === '') return;      // empty mid-edit: don't commit yet
        const n = +trimmed;
        // Only commit live updates for unambiguously valid numbers — leave
        // partial input like "1." or "-" alone until blur.
        if (Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(trimmed)) {
          onChange(n);
          onChangeOptional?.(n);
          lastCommittedRef.current = n;
        }
      }}
      onBlur={(e) => commitText(e.target.value)}
      onKeyDown={(e) => {
        // Enter commits then leaves the field (matching <form> semantics).
        if (e.key === 'Enter') {
          commitText((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      min={min} max={max} step={step}
      className={className} title={title} placeholder={placeholder}
      style={style} disabled={disabled}
    />
  );
}
