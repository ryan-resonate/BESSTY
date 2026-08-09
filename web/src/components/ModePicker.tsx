// The operating-mode dropdown, in its one-value and its per-period forms.
//
// Three places pick a mode — the per-source row, the bulk "change mode to"
// editor, and a BESS wizard segment — and all three have to agree about what an
// unset value means, what Off looks like, and when the per-period expander is
// available. When they were three separate `<select>`s they didn't, so this is
// the one component they share.
//
// Per-period modes are gated by a project setting that defaults OFF: with it
// off this renders exactly the single dropdown it always was, and the D/E/N
// control does not exist.

import { useState } from 'react';

import type { ModeOverride, Period, Project } from '../lib/types';
import {
  MODE_OFF,
  MODE_OFF_LABEL,
  PERIODS,
  PERIOD_LABEL,
  describeModes,
  modeForPeriod,
  perPeriodModesEnabled,
  variesByPeriod,
  withPeriodMode,
} from '../lib/modes';

export function ModePicker(props: {
  project: Project;
  /// Mode names offered, in catalog order.
  modes: string[];
  value: ModeOverride | undefined;
  onChange(next: ModeOverride | undefined): void;
  /// Label for the leading "no explicit value" option. Omit and the picker
  /// always holds a concrete mode (the per-source rows), which is how the mode
  /// dropdown has always behaved there.
  inheritLabel?: string;
  /// Shown in place of an inherited mode in the D/E/N summary.
  inheritName?: string;
  /// Offer the reserved Off mode. Off is a scene-level decision — the source is
  /// removed for that period — so it isn't offered where the value is a
  /// template rather than a source (the bulk editor still offers it: turning a
  /// selection off is the point of having it).
  allowOff?: boolean;
  title?: string;
  /// Render inside a `<Field>` label (the stacked forms) rather than as a bare
  /// inline control (the per-source row).
  fieldLabel?: string;
}) {
  const {
    project, modes, value, onChange, inheritLabel, inheritName = '(default)',
    allowOff = true, title,
  } = props;
  const perPeriod = perPeriodModesEnabled(project);
  const varies = variesByPeriod(value);
  const [open, setOpen] = useState(false);

  /// The value a single dropdown shows: whatever applies in the period being
  /// assessed, so the control agrees with the levels on screen.
  const single = modeForPeriod(value, project.scenario.period);

  /// Options for one select, given the value it currently shows.
  ///
  /// Two rules that both exist because a `<select>` whose value matches no
  /// option renders BLANK while something real is in force:
  ///  - an inherit option appears whenever the caller asked for one, or the
  ///    current value is "inherit" itself (a sparse per-period object, or a
  ///    model whose catalog entry is missing) — otherwise the blank control
  ///    sits beside a project solving at the catalog default;
  ///  - Off is offered only while per-period modes are ON — it is part of that
  ///    capability — EXCEPT when the value already is Off, where hiding the
  ///    option would strand the source: visible as Off, recoverable to a mode.
  const inheritOptionLabel = inheritLabel
    ?? (inheritName.startsWith('(') ? inheritName : `(default — ${inheritName})`);
  /// `alwaysInherit` — the expander's selects always offer inheritance, so a
  /// period that was pinned can be handed back to the default, not only set to
  /// a name that happens to equal it.
  const optionsFor = (current: string | null | undefined, alwaysInherit = false) => (
    <>
      {(inheritLabel !== undefined || alwaysInherit || current == null) && (
        <option value="">{inheritOptionLabel}</option>
      )}
      {modes.map((m) => <option key={m} value={m}>{m}</option>)}
      {allowOff && (perPeriod || current === MODE_OFF) && (
        <option value={MODE_OFF}>{MODE_OFF_LABEL}</option>
      )}
    </>
  );

  function setAllPeriods(v: string) {
    onChange(v === '' ? undefined : v);
  }
  function setOne(period: Period, v: string) {
    onChange(withPeriodMode(value, period, v === '' ? undefined : v));
  }

  const summary = describeModes(value, inheritName);

  // Per-period modes are switched off but this value has them anyway — the
  // setting was turned back off, or a colleague set them. Showing one of the
  // three in an editable dropdown would let a stray click silently flatten the
  // other two, so it reads as text until the setting is back on.
  if (!perPeriod && varies) {
    return (
      <span
        className="muted"
        style={{ fontSize: 11 }}
        title={'This source has a different mode per period. Turn on '
          + '"Modes per day / evening / night" in Settings to edit them.'}
      >{summary}</span>
    );
  }

  const control = (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      {varies
        ? <span className="muted" style={{ fontSize: 11 }} title={summary}>{summary}</span>
        : (
          <select
            value={single ?? ''}
            title={title}
            onChange={(e) => setAllPeriods(e.target.value)}
          >{optionsFor(single)}</select>
        )}
      {perPeriod && (
        <button
          className={`btn small${open || varies ? ' active' : ''}`}
          title={varies
            ? `Modes per period — ${summary}`
            : 'Set a different mode for day, evening and night'}
          onClick={() => setOpen(!open)}
        >D/E/N{open ? ' ▾' : ' ▸'}</button>
      )}
    </span>
  );

  const expander = open && perPeriod && (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 4,
        margin: '4px 0 2px', paddingLeft: 8,
        borderLeft: '2px solid var(--light)',
      }}
    >
      {PERIODS.map((p) => (
        <label key={p} className="fld" style={{ fontSize: 11 }}>
          <span>{PERIOD_LABEL[p]}</span>
          <select value={modeForPeriod(value, p) ?? ''} onChange={(e) => setOne(p, e.target.value)}>
            {optionsFor(modeForPeriod(value, p), true)}
          </select>
        </label>
      ))}
      {varies && (
        <button
          className="btn small"
          title="Set evening and night to the day mode, and stop varying by period"
          // "Same all day" read as "unchanged throughout the day" rather than
          // "make them all the day one" — the opposite of what it does.
          onClick={() => onChange(modeForPeriod(value, 'day') ?? undefined)}
        >Use day mode for all</button>
      )}
    </div>
  );

  if (props.fieldLabel !== undefined) {
    return (
      <>
        <label className="fld"><span>{props.fieldLabel}</span>{control}</label>
        {expander}
      </>
    );
  }
  return <>{control}{expander}</>;
}
