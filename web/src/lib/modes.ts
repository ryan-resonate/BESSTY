// Operating modes, resolved for the period being assessed.
//
// A source's mode used to be one value for the whole project. Day, evening and
// night limits differ, and plant is routinely run differently under each — a
// BESS dropped to a low-noise fan curve after 10pm, turbines curtailed
// overnight — so a single mode meant keeping three near-identical projects and
// remembering which was which.
//
// The override WIDENS rather than changes shape: a plain string still means
// "this mode, every period", so every document written before this parses
// unchanged and nothing needs migrating. Only when a user asks for per-period
// modes does the value become an object.
//
// One rule holds the whole feature together: nothing outside this module may
// read `modeOverride` directly. `spectrumFor` falls back to the catalog's FIRST
// mode when it doesn't recognise a name, so an unresolved override — or the
// reserved Off id — reaching it doesn't fail loudly, it silently runs the
// source at whatever mode happens to be listed first. That is the one failure
// this design has to make impossible, hence a single resolver and a wiring test
// that watches for direct reads.

import type {
  CatalogEntry, ModeOverride, Period, PeriodModes, Project, Source,
} from './types';

export type { ModeOverride, PeriodModes };

/// The three assessment periods, in the order they're shown everywhere.
export const PERIODS: readonly Period[] = ['day', 'evening', 'night'] as const;

export const PERIOD_LABEL: Record<Period, string> = {
  day: 'Day',
  evening: 'Evening',
  night: 'Night',
};

/// Reserved mode id meaning "this source is not running in this period".
///
/// Not a catalog mode — no lookup will ever find it — and prefixed so it cannot
/// collide with a name off a datasheet. A source resolving to Off is left out
/// of the scene entirely for that period, which is not the same as running it
/// at 0 dB: it contributes nothing, screens nothing, and reflects nothing.
export const MODE_OFF = '__off';

/// Shown wherever a mode name is shown.
export const MODE_OFF_LABEL = 'Off';

export function isPeriodModes(v: ModeOverride | undefined): v is PeriodModes {
  return typeof v === 'object' && v !== null;
}

/// The override that applies in one period, still un-resolved against the
/// catalog: `undefined`/`null` mean "inherit".
export function modeForPeriod(
  v: ModeOverride | undefined,
  period: Period,
): string | null | undefined {
  if (!isPeriodModes(v)) return v;
  return v[period];
}

/// The catalog mode a source actually runs in during `period`, or `null` when
/// it is Off and must be left out of the scene.
///
/// Every caller has to handle the null — dropping the source, not substituting
/// a default. See the note at the top of this file for why.
export function resolveModeName(
  v: ModeOverride | undefined,
  period: Period,
  defaultMode: string,
): string | null {
  const picked = modeForPeriod(v, period) ?? defaultMode;
  return picked === MODE_OFF ? null : picked;
}

/// `resolveModeName` for a source against its catalog entry — the form nearly
/// every caller wants.
export function sourceModeName(
  source: Pick<Source, 'modeOverride'>,
  entry: CatalogEntry,
  period: Period,
): string | null {
  return resolveModeName(source.modeOverride, period, entry.defaultMode);
}

/// Is this source switched off in `period`?
export function sourceIsOff(
  source: Pick<Source, 'modeOverride'>,
  period: Period,
): boolean {
  return modeForPeriod(source.modeOverride, period) === MODE_OFF;
}

/// Collapse an override chain — NEAREST FIRST (per-unit, then per-segment,
/// then per-source) — into the single override to store on the materialised
/// source.
///
/// Resolution is per period, not per whole override: a unit that only names a
/// night mode still inherits the segment's day mode. Doing it at whole-override
/// granularity would have made setting one period silently blank the other two,
/// which is the sort of data loss nobody notices until a report is wrong.
///
/// When no link in the chain is per-period this returns the first defined
/// value, which is exactly what the old `!== undefined` chain did.
export function mergeModeChain(
  ...chain: Array<ModeOverride | undefined>
): ModeOverride | undefined {
  const links = chain.filter((v) => v !== undefined);
  if (links.length === 0) return undefined;
  if (!links.some(isPeriodModes)) return links[0];

  const out: PeriodModes = {};
  for (const period of PERIODS) {
    for (const link of links) {
      const v = modeForPeriod(link, period);
      if (v !== undefined) { out[period] = v; break; }
    }
  }
  return out;
}

/// Fold a per-period object back to a plain string when all three periods agree,
/// so a project that was set per-period and then levelled out stores — and
/// fingerprints — identically to one that never used the feature.
export function normaliseModeOverride(v: ModeOverride | undefined): ModeOverride | undefined {
  if (!isPeriodModes(v)) return v;
  const [d, e, n] = [v.day, v.evening, v.night];
  if (d === e && e === n) return d ?? undefined;
  return v;
}

/// Set one period's mode, widening a plain string into a per-period object as
/// needed. The other periods keep the value they were already resolving to,
/// which is what "change just the night mode" has to mean — leaving them absent
/// would quietly hand them back to the catalog default.
/// Keys are DELETED rather than set to `undefined`: Firestore rejects undefined
/// field values, and although the writer prunes them, a shape that only survives
/// because something downstream cleans it up is a trap for the next caller.
export function withPeriodMode(
  current: ModeOverride | undefined,
  period: Period,
  value: string | null | undefined,
): ModeOverride | undefined {
  const base: PeriodModes = {};
  for (const p of PERIODS) {
    const v = modeForPeriod(current, p);
    if (v !== undefined) base[p] = v;
  }
  if (value === undefined) delete base[period];
  else base[period] = value;
  return normaliseModeOverride(base);
}

/// Apply an EDIT to an existing override, where the edit names only the periods
/// it means to change.
///
/// This is what a bulk "change mode" has to do: setting the night mode across a
/// selection must leave each source's own day and evening alone, and those can
/// differ from one source to the next. A plain string still means "every
/// period", so the blunt form of the bulk edit is unchanged.
export function applyModeEdit(
  current: ModeOverride | undefined,
  edit: ModeOverride | undefined,
): ModeOverride | undefined {
  if (edit === undefined) return current;
  if (!isPeriodModes(edit)) return edit;
  let out = current;
  for (const p of PERIODS) {
    const v = edit[p];
    if (v !== undefined) out = withPeriodMode(out, p, v);
  }
  return out;
}

/// Does this override resolve differently in different periods? Drives the
/// per-period badge on a source chip — a chip that says "D/E/N" when all three
/// are the same is noise.
export function variesByPeriod(v: ModeOverride | undefined): boolean {
  if (!isPeriodModes(v)) return false;
  return v.day !== v.evening || v.evening !== v.night;
}

/// Is any period of this override Off? A uniform Off doesn't "vary", so
/// `variesByPeriod` alone misses it — and an Off is exactly the value the UI
/// must never hide: a source contributing nothing with no visible control set
/// to Off looks like a solver bug, not a choice.
export function involvesOff(v: ModeOverride | undefined): boolean {
  if (!isPeriodModes(v)) return v === MODE_OFF;
  return PERIODS.some((p) => v[p] === MODE_OFF);
}

/// Is the whole per-period capability switched on for this project? Default
/// OFF — a project that has never heard of periods shows none of the UI.
///
/// Deliberately gates the UI only. Stored per-period values are honoured by the
/// solver whatever this says: a level that changes because a checkbox was
/// unticked in Settings, with no other visible cause, is far worse than an
/// override the picker can't currently edit.
export function perPeriodModesEnabled(project: Project): boolean {
  return project.settings?.periods?.perPeriodModes === true;
}

/// How a mode reads in the UI — Off included, and the catalog default named
/// rather than shown blank.
export function modeLabel(
  name: string | null | undefined,
  defaultMode?: string,
): string {
  if (name === MODE_OFF) return MODE_OFF_LABEL;
  if (name == null || name === '') return defaultMode ?? '—';
  return name;
}

/// "NRO0 / NRO2 / Off" for a chip or a tooltip; a single name when the mode
/// doesn't vary. `defaultMode` fills in the periods that inherit.
export function describeModes(
  v: ModeOverride | undefined,
  defaultMode: string,
): string {
  if (!isPeriodModes(v)) return modeLabel(v, defaultMode);
  return PERIODS.map((p) => modeLabel(modeForPeriod(v, p), defaultMode)).join(' / ');
}
