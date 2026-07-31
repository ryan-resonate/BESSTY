// I5 — copy/paste for map objects, across projects and tabs.
//
// The clipboard carries a JSON envelope rather than an in-memory reference, so
// a copy in one project pastes into another (and into another tab) for free.
// Anything that isn't our envelope is ignored — pasting a spreadsheet cell into
// the map must do nothing, not throw.
//
// Pasting preserves the copied set's RELATIVE layout: the centroid moves to the
// paste anchor and every object keeps its offset from it. Pasting a row of
// eight units must not stack them on one point.
//
// Ids are regenerated throughout. A pasted BESS group becomes a genuinely new
// group — new `groupId`, new `slotKey`s, and `unitOverrides` remapped onto them
// — otherwise the copy and the original would share override state and editing
// one would silently edit the other.

import type { Barrier, BessGroup, Project, Receiver, Source } from './types';

export const CLIPBOARD_MAGIC = 'beesty';
export const CLIPBOARD_VERSION = 1;

export interface ClipboardEnvelope {
  beesty: typeof CLIPBOARD_VERSION;
  /// App version that wrote it, for future migrations. Not validated.
  version: string;
  /// Centroid of the copied objects (lat, lng) — paste translates from here.
  origin: [number, number];
  objects: {
    sources: Source[];
    receivers: Receiver[];
    barriers: Barrier[];
    /// Groups whose members are ALL in `sources`; pasted as new groups.
    bessGroups: BessGroup[];
  };
}

export interface CopySelection {
  sourceIds: ReadonlySet<string>;
  receiverIds: ReadonlySet<string>;
  barrierIds: ReadonlySet<string>;
}

/// Every lat/lng an object occupies — used for the centroid.
function pointsOf(env: ClipboardEnvelope['objects']): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (const s of env.sources) pts.push(s.latLng);
  for (const r of env.receivers) pts.push(r.latLng);
  for (const b of env.barriers) for (const p of b.polylineLatLng ?? []) pts.push(p);
  return pts.filter((p) => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]));
}

function centroid(pts: Array<[number, number]>): [number, number] {
  if (pts.length === 0) return [0, 0];
  let lat = 0; let lng = 0;
  for (const p of pts) { lat += p[0]; lng += p[1]; }
  return [lat / pts.length, lng / pts.length];
}

/// Build the envelope for the current selection.
///
/// A BESS group comes along only when EVERY one of its members is selected —
/// a partial group copy would produce a group whose sequence doesn't match its
/// units, so those units are copied as plain standalone sources instead.
export function buildEnvelope(
  project: Project,
  sel: CopySelection,
  appVersion = '0',
): ClipboardEnvelope | null {
  const sources = project.sources.filter((s) => sel.sourceIds.has(s.id));
  const receivers = project.receivers.filter((r) => sel.receiverIds.has(r.id));
  const barriers = (project.barriers ?? []).filter((b) => sel.barrierIds.has(b.id));
  if (sources.length === 0 && receivers.length === 0 && barriers.length === 0) return null;

  const selectedIds = new Set(sources.map((s) => s.id));
  const wholeGroups = (project.bessGroups ?? []).filter((g) => {
    const members = project.sources.filter((s) => s.groupId === g.id);
    return members.length > 0 && members.every((m) => selectedIds.has(m.id));
  });
  const wholeGroupIds = new Set(wholeGroups.map((g) => g.id));

  // Members of a partially-selected group lose their group linkage so they
  // paste as ordinary sources rather than referencing a group that isn't here.
  const outSources = sources.map((s) => {
    if (s.groupId && !wholeGroupIds.has(s.groupId)) {
      const copy = { ...s };
      delete copy.groupId;
      delete copy.slotKey;
      return copy;
    }
    return s;
  });

  const objects = { sources: outSources, receivers, barriers, bessGroups: wholeGroups };
  return {
    beesty: CLIPBOARD_VERSION,
    version: appVersion,
    origin: centroid(pointsOf(objects)),
    objects,
  };
}

/// Parse clipboard text. Returns null for anything that isn't our envelope —
/// pasting arbitrary text must be a no-op, not an error.
export function parseEnvelope(text: string): ClipboardEnvelope | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<ClipboardEnvelope>;
  if (e.beesty !== CLIPBOARD_VERSION) return null;
  const o = e.objects;
  if (!o || typeof o !== 'object') return null;
  if (!Array.isArray(o.sources) || !Array.isArray(o.receivers)
      || !Array.isArray(o.barriers) || !Array.isArray(o.bessGroups)) {
    return null;
  }
  if (!Array.isArray(e.origin) || e.origin.length !== 2
      || !Number.isFinite(e.origin[0]) || !Number.isFinite(e.origin[1])) {
    return null;
  }
  return e as ClipboardEnvelope;
}

export interface PasteResult {
  sources: Source[];
  receivers: Receiver[];
  barriers: Barrier[];
  bessGroups: BessGroup[];
  /// New ids of everything pasted, so the caller can select it.
  newIds: string[];
}

/// Materialise an envelope at `anchor`, with fresh ids throughout.
///
/// `newId(prefix)` is injected so the caller controls id generation (and tests
/// can make it deterministic).
export function materialisePaste(
  env: ClipboardEnvelope,
  anchor: [number, number],
  newId: (prefix: string) => string,
): PasteResult {
  const dLat = anchor[0] - env.origin[0];
  const dLng = anchor[1] - env.origin[1];
  const move = (p: [number, number]): [number, number] => [p[0] + dLat, p[1] + dLng];

  const groupIdMap = new Map<string, string>();
  for (const g of env.objects.bessGroups) groupIdMap.set(g.id, newId('GRP'));

  // Old slotKey → new slotKey, per group, so unitOverrides can be remapped.
  const slotMap = new Map<string, string>();
  const newIds: string[] = [];

  const sources: Source[] = env.objects.sources.map((s) => {
    const id = newId(s.kind === 'wtg' ? 'WTG' : s.kind.toUpperCase());
    newIds.push(id);
    const next: Source = { ...s, id, latLng: move(s.latLng) };
    if (s.groupId) {
      const g = groupIdMap.get(s.groupId);
      if (g) {
        next.groupId = g;
        if (s.slotKey) {
          const newSlot = s.slotKey;         // slot identity is positional
          slotMap.set(`${s.groupId}::${s.slotKey}`, newSlot);
          next.slotKey = newSlot;
        }
      } else {
        delete next.groupId;
        delete next.slotKey;
      }
    }
    return next;
  });

  const receivers: Receiver[] = env.objects.receivers.map((r) => {
    const id = newId('RX');
    newIds.push(id);
    return { ...r, id, latLng: move(r.latLng) };
  });

  const barriers: Barrier[] = env.objects.barriers.map((b) => {
    const id = newId('BAR');
    newIds.push(id);
    return { ...b, id, polylineLatLng: (b.polylineLatLng ?? []).map(move) };
  });

  const bessGroups: BessGroup[] = env.objects.bessGroups.map((g) => {
    const id = groupIdMap.get(g.id)!;
    newIds.push(id);
    // Overrides are keyed by slotKey, which is positional and therefore stable
    // across the copy — but they must be a fresh object, or the pasted group
    // would share override state with the original.
    const unitOverrides = g.unitOverrides
      ? Object.fromEntries(Object.entries(g.unitOverrides).map(([k, v]) => [k, { ...v }]))
      : undefined;
    return {
      ...g,
      id,
      name: `${g.name} (copy)`,
      centerLatLng: move(g.centerLatLng),
      unitOverrides,
    };
  });

  return { sources, receivers, barriers, bessGroups, newIds };
}

/// Human summary for the paste toast.
export function describePaste(r: PasteResult): string {
  const bits: string[] = [];
  if (r.sources.length) bits.push(`${r.sources.length} source${r.sources.length === 1 ? '' : 's'}`);
  if (r.receivers.length) bits.push(`${r.receivers.length} receiver${r.receivers.length === 1 ? '' : 's'}`);
  if (r.barriers.length) bits.push(`${r.barriers.length} barrier${r.barriers.length === 1 ? '' : 's'}`);
  if (r.bessGroups.length) bits.push(`${r.bessGroups.length} group${r.bessGroups.length === 1 ? '' : 's'}`);
  return bits.length ? `Pasted ${bits.join(', ')}.` : 'Nothing to paste.';
}
