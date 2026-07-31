// Catalog data layer.
//
// Two databases of source models live alongside each other:
//
//   - **Global catalog** — stored in Firestore (`catalogsGlobal/{id}`),
//     shared across every signed-in user. Cached in module memory and
//     kept fresh by a live Firestore subscription so the existing
//     sync API (`loadGlobalCatalog`, `lookupEntry`, source pickers)
//     can stay synchronous.
//
//   - **Local catalog** — stored on the project document itself
//     (`project.localCatalog`). Per-project, isolated from anything else.
//
// The two are deliberately independent: an entry can live in either, both,
// or just one, with no automatic syncing. UI affordances let users copy
// global → local (and the catalog screen lets them edit either or both).
// Sources reference an entry by `{ catalogScope, modelId }`.
//
// First-time seeding: when the Firestore collection is empty (first ever
// load), `loadGlobalCatalog` writes the bundled SEED_CATALOG to Firestore.
// Any signed-in user can do this since the security rule on
// `catalogsGlobal` allows writes by any authenticated user. Idempotent
// per doc id, so races between concurrent users are benign.

import type { CatalogEntry, Project, Source, SourceKind } from './types';

// Physical dimension resolution (emission height, footprint, container box)
// lives in the dependency-free `catalogDims` leaf so it can be unit-tested and
// imported by `MapView` without dragging the Firebase SDK along. Re-exported
// here so `from './catalog'` keeps working for every existing call site.
export {
  sourceHeightFor,
  footprintFor,
  containerHeightFor,
  resolveContainer,
  type ContainerBox,
} from './catalogDims';

import { SEED_CATALOG } from './seedCatalog';
import {
  deleteGlobalEntryFs,
  deletePersonalEntryFs,
  seedGlobalCatalog,
  subscribeGlobalCatalog,
  subscribePersonalCatalog,
  upsertGlobalEntryFs,
  upsertPersonalEntryFs,
} from './firestoreCatalog';
import { auth as firebaseAuth } from './firebase';

// ---------- Global catalog: cache + subscription ----------

let cachedGlobal: CatalogEntry[] = [];
let cacheHasData = false;
let subscriptionStarted = false;
let seedAttempted = false;

/// External listeners (e.g. CatalogScreen) get notified whenever the
/// cache changes. Plain Set-of-callbacks; cheap and synchronous.
const listeners = new Set<(entries: CatalogEntry[]) => void>();

function emit() {
  for (const cb of listeners) cb(cachedGlobal);
}

function startSubscription() {
  if (subscriptionStarted) return;
  subscriptionStarted = true;
  subscribeGlobalCatalog(
    (entries) => {
      cachedGlobal = entries;
      cacheHasData = true;
      emit();
      // First snapshot is in. If empty, try seeding once (any signed-in
      // user is allowed to). Per-doc-id writes are idempotent so races
      // between users are harmless.
      if (entries.length === 0 && !seedAttempted) {
        seedAttempted = true;
        const uid = firebaseAuth().currentUser?.uid;
        if (uid) {
          void seedGlobalCatalog(SEED_CATALOG, uid).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[BESSTY] auto-seed global catalog failed:', err);
          });
        }
      }
    },
    (err) => {
      // eslint-disable-next-line no-console
      console.warn('[BESSTY] global catalog subscription failed:', err);
    },
  );
}

/// Read the cached global catalog (synchronous). On first call, kicks off
/// the Firestore subscription that keeps the cache fresh. Returns the
/// bundled SEED_CATALOG until the first server snapshot lands -- avoids
/// a "no entries available" flash on the first render after sign-in.
export function loadGlobalCatalog(): CatalogEntry[] {
  startSubscription();
  return cacheHasData ? cachedGlobal : SEED_CATALOG;
}

/// Subscribe to cache changes. Returns an unsubscribe. Used by
/// CatalogScreen to re-render when other users' writes land or our
/// own writes round-trip back.
export function subscribeToCachedGlobalCatalog(
  cb: (entries: CatalogEntry[]) => void,
): () => void {
  startSubscription();
  listeners.add(cb);
  // Fire once immediately with current cache contents.
  cb(loadGlobalCatalog());
  return () => { listeners.delete(cb); };
}

/// Insert / overwrite an entry. Writes to Firestore (async) and
/// optimistically updates the local cache so the UI doesn't flicker.
export function upsertGlobalEntry(entry: CatalogEntry) {
  // Optimistic local update.
  const idx = cachedGlobal.findIndex((e) => e.id === entry.id);
  cachedGlobal = idx >= 0
    ? cachedGlobal.map((e, i) => (i === idx ? entry : e))
    : [...cachedGlobal, entry];
  cacheHasData = true;
  emit();
  // Async write -- onSnapshot will reconcile once the server confirms.
  const uid = firebaseAuth().currentUser?.uid ?? 'unknown';
  void upsertGlobalEntryFs(entry, uid).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BESSTY] upsertGlobalEntry failed:', err);
  });
}

export function deleteGlobalEntry(id: string) {
  cachedGlobal = cachedGlobal.filter((e) => e.id !== id);
  emit();
  void deleteGlobalEntryFs(id).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BESSTY] deleteGlobalEntry failed:', err);
  });
}

/// Bulk replace the entire global catalog (legacy CatalogScreen import
/// flow). Done as individual upserts so the per-doc-id idempotency
/// covers re-imports cleanly.
export function saveGlobalCatalog(entries: CatalogEntry[]) {
  cachedGlobal = entries.slice();
  cacheHasData = true;
  emit();
  const uid = firebaseAuth().currentUser?.uid ?? 'unknown';
  void seedGlobalCatalog(entries, uid).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BESSTY] saveGlobalCatalog failed:', err);
  });
}

// ---------- Personal catalog: cache + subscription ----------
//
// Per-user library at `users/{uid}/catalogs/{id}`. Same cache + listener
// pattern as the global catalog. The cache is scoped to the currently
// signed-in user; on sign-out / sign-in-as-different-user we tear down
// the old subscription and start fresh.

let cachedPersonal: CatalogEntry[] = [];
let personalCacheUid: string | null = null;
let personalUnsub: (() => void) | null = null;
const personalListeners = new Set<(entries: CatalogEntry[]) => void>();

function emitPersonal() {
  for (const cb of personalListeners) cb(cachedPersonal);
}

function ensurePersonalSubscription() {
  const uid = firebaseAuth().currentUser?.uid ?? null;
  if (uid === personalCacheUid) return;       // already subscribed for this user
  // User changed (or signed out). Reset and re-subscribe if signed in.
  if (personalUnsub) { personalUnsub(); personalUnsub = null; }
  cachedPersonal = [];
  personalCacheUid = uid;
  emitPersonal();
  if (!uid) return;
  personalUnsub = subscribePersonalCatalog(
    uid,
    (entries) => { cachedPersonal = entries; emitPersonal(); },
    (err) => {
      // eslint-disable-next-line no-console
      console.warn('[BESSTY] personal catalog subscription failed:', err);
    },
  );
}

/// Read the cached personal catalog (synchronous). On first call, or
/// after a user change, kicks off the Firestore subscription that
/// keeps the cache fresh.
export function loadPersonalCatalog(): CatalogEntry[] {
  ensurePersonalSubscription();
  return cachedPersonal;
}

export function subscribeToCachedPersonalCatalog(
  cb: (entries: CatalogEntry[]) => void,
): () => void {
  ensurePersonalSubscription();
  personalListeners.add(cb);
  cb(loadPersonalCatalog());
  return () => { personalListeners.delete(cb); };
}

/// Optimistic upsert (cache first, async write to Firestore).
export function upsertPersonalEntry(entry: CatalogEntry) {
  const uid = firebaseAuth().currentUser?.uid;
  if (!uid) {
    // eslint-disable-next-line no-console
    console.warn('[BESSTY] upsertPersonalEntry called while signed out');
    return;
  }
  const idx = cachedPersonal.findIndex((e) => e.id === entry.id);
  cachedPersonal = idx >= 0
    ? cachedPersonal.map((e, i) => (i === idx ? entry : e))
    : [...cachedPersonal, entry];
  emitPersonal();
  void upsertPersonalEntryFs(uid, entry).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BESSTY] upsertPersonalEntry failed:', err);
  });
}

export function deletePersonalEntry(id: string) {
  const uid = firebaseAuth().currentUser?.uid;
  if (!uid) return;
  cachedPersonal = cachedPersonal.filter((e) => e.id !== id);
  emitPersonal();
  void deletePersonalEntryFs(uid, id).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[BESSTY] deletePersonalEntry failed:', err);
  });
}

// ---------- Local catalog (lives on a project) ----------

export function localCatalogOf(project: Project): CatalogEntry[] {
  return project.localCatalog ?? [];
}

export function withLocalEntry(project: Project, entry: CatalogEntry): Project {
  const existing = localCatalogOf(project);
  const idx = existing.findIndex((e) => e.id === entry.id);
  const next = idx >= 0
    ? existing.map((e, i) => (i === idx ? entry : e))
    : [...existing, entry];
  return { ...project, localCatalog: next };
}

export function withoutLocalEntry(project: Project, id: string): Project {
  return { ...project, localCatalog: localCatalogOf(project).filter((e) => e.id !== id) };
}

// ---------- Cross-scope lookup ----------

/// Resolve a source's catalog entry by scope + id. Returns null if the
/// referenced entry has been deleted -- OR for a `personal`-scoped source
/// referenced by a user other than its owner (personal libraries are
/// per-user; cross-user reads are blocked by security rules).
export function lookupEntry(project: Project, source: Source): CatalogEntry | null {
  if (source.catalogScope === 'local') {
    return localCatalogOf(project).find((e) => e.id === source.modelId) ?? null;
  }
  if (source.catalogScope === 'personal') {
    return loadPersonalCatalog().find((e) => e.id === source.modelId) ?? null;
  }
  return loadGlobalCatalog().find((e) => e.id === source.modelId) ?? null;
}

/// All catalog entries available to a project. Order is local → personal
/// → global, dedup'd by id with earlier scopes winning. (A `local`
/// override of a `global` entry e.g. "tweaked V163 for this site" still
/// shows as local; a `personal` entry of the same id wins over the
/// matching global.)
export function allEntriesFor(
  project: Project,
): Array<CatalogEntry & { _scope: 'local' | 'global' | 'personal' }> {
  const local = localCatalogOf(project).map((e) => ({ ...e, _scope: 'local' as const }));
  const localIds = new Set(local.map((e) => e.id));
  const personal = loadPersonalCatalog()
    .filter((e) => !localIds.has(e.id))
    .map((e) => ({ ...e, _scope: 'personal' as const }));
  const personalIds = new Set(personal.map((e) => e.id));
  const global = loadGlobalCatalog()
    .filter((e) => !localIds.has(e.id) && !personalIds.has(e.id))
    .map((e) => ({ ...e, _scope: 'global' as const }));
  return [...local, ...personal, ...global];
}

export function listEntriesByKind(
  project: Project,
  kind: SourceKind,
): Array<CatalogEntry & { _scope: 'local' | 'global' | 'personal' }> {
  return allEntriesFor(project).filter((e) => e.kind === kind);
}

// ---------- Helpers used by Source pickers ----------

/// Derive a per-band Lw spectrum from a catalog entry + mode + project wind
/// speed, projecting onto the solver's chosen band system.
///
///   - octave + octave source             → energy-snap to standard octave centres
///   - octave + third-octave source       → sum each octave's 3 child thirds
///   - third-octave + third-octave source → energy-snap to standard 1/3-oct centres
///   - third-octave + octave source       → distribute each octave's energy
///                                          equally across its 3 children
///                                          (lp_third = lp_oct − 10 log10(3))
export function spectrumFor(
  entry: CatalogEntry,
  modeName: string,
  windSpeed: number,
  bandSystem: 'octave' | 'oneThirdOctave',
): Float64Array {
  const mode = entry.modes.find((m) => m.name === modeName) ?? entry.modes[0];
  if (!mode) return new Float64Array(bandSystem === 'octave' ? OCTAVE_CENTRES.length : THIRD_OCT_CENTRES.length);

  // Pull the raw per-band Lw values for the requested wind speed, then
  // un-weight if the catalog mode is stored in A-weighted form. The WASM
  // solver always works in Z (un-weighted) per-band space — see the
  // A-weighting note in `lib/solver.ts`.
  const rawLevels = pickWindSpeed(mode, windSpeed);
  const sourceLevels = (mode.weighting === 'A')
    ? unweightFromA(mode.frequencies, rawLevels)
    : rawLevels;

  if (bandSystem === 'octave') {
    if (mode.bandSystem === 'octave') {
      return snapToCentres(mode.frequencies, sourceLevels, OCTAVE_CENTRES, octaveBand);
    }
    return foldThirdsToOctave(mode.frequencies, sourceLevels);
  }

  if (mode.bandSystem === 'oneThirdOctave') {
    return snapToCentres(mode.frequencies, sourceLevels, THIRD_OCT_CENTRES, thirdOctaveBand);
  }
  return distributeOctavesToThirds(mode.frequencies, sourceLevels);
}

/// Convert per-band LwA values to Lw (un-weighted) by subtracting the
/// IEC 61672-1 A-weighting offset for each band's centre frequency. The
/// inverse of "apply A-weighting" — at 1 kHz nothing changes (offset 0);
/// at 16 Hz a value of 49.2 dBA becomes 49.2 - (-56.4) = 105.6 dB
/// un-weighted (much higher because A-weighting heavily suppresses LF).
function unweightFromA(frequencies: number[], lwA: number[]): number[] {
  const out: number[] = new Array(lwA.length);
  for (let i = 0; i < lwA.length; i++) {
    const f = frequencies[i];
    const aw = aWeightingAt(f);
    out[i] = lwA[i] - aw;
  }
  return out;
}

/// IEC 61672-1 A-weighting curve evaluated at any frequency. Used to
/// convert A-weighted catalog spectra back to Z-weighted before the
/// solver call. Closed-form per IEC 61672-1 §A.4 — exact, not a table
/// lookup, so it works for arbitrary band centres (not just the standard
/// octave / third-octave grids).
function aWeightingAt(f: number): number {
  // RA(f) per IEC 61672-1 + +2.0 normalisation so RA(1000 Hz) = 0.
  const f2 = f * f;
  const num = 12194.217 * 12194.217 * f2 * f2;
  const denom =
    (f2 + 20.598997 * 20.598997)
    * Math.sqrt((f2 + 107.65265 * 107.65265) * (f2 + 737.86223 * 737.86223))
    * (f2 + 12194.217 * 12194.217);
  const ra = num / denom;
  return 20 * Math.log10(ra) + 2.0;
}

/// Overall (single-figure) sound power from a per-band spectrum, returned as
/// both A-weighted dB(A) and un-weighted dB. `weighting` says whether the
/// stored per-band values are ALREADY A-weighted ('A') or un-weighted ('Z'):
///   - 'Z': band A-level = Lw_band + A(f); overall dB(A) is the energy sum of
///          those; overall Z is the energy sum of the raw bands.
///   - 'A': the stored bands ARE the A-levels (energy-sum them directly for
///          dB(A)); subtract A(f) to recover the Z bands for the overall Z.
/// Bands that are non-finite or <= 0 are treated as "unset" and skipped (the
/// same convention the solver uses for catalog spectra), so an empty 0-cell
/// doesn't drag the total down to a 0 dB floor.
export function overallLwFromBands(
  frequencies: number[],
  levels: number[],
  weighting: 'A' | 'Z',
): { dbA: number; dbZ: number } {
  let energyA = 0;
  let energyZ = 0;
  const n = Math.min(frequencies.length, levels.length);
  for (let i = 0; i < n; i++) {
    const lv = levels[i];
    if (lv == null || !Number.isFinite(lv) || lv <= 0) continue;
    const aw = aWeightingAt(frequencies[i]);
    const lz = weighting === 'A' ? lv - aw : lv;   // un-weighted band level
    const la = weighting === 'A' ? lv : lv + aw;   // A-weighted band level
    energyZ += Math.pow(10, lz / 10);
    energyA += Math.pow(10, la / 10);
  }
  return {
    dbA: energyA > 0 ? 10 * Math.log10(energyA) : 0,
    dbZ: energyZ > 0 ? 10 * Math.log10(energyZ) : 0,
  };
}

/// Backwards-compatible alias for the original octave-only API.
export function octaveSpectrumFor(
  entry: CatalogEntry,
  modeName: string,
  windSpeed: number,
): Float64Array {
  return spectrumFor(entry, modeName, windSpeed, 'octave');
}

/// Linear-interpolate (in dB) the spectrum at the requested wind speed.
function pickWindSpeed(mode: { spectra: Record<string, number[]>; windSpeeds?: number[] }, ws: number): number[] {
  if (!mode.windSpeeds || mode.windSpeeds.length === 0) {
    // Wind-independent (BESS / Aux): single 'broadband' key.
    const k = Object.keys(mode.spectra)[0];
    return mode.spectra[k] ?? [];
  }
  const sorted = mode.windSpeeds.slice().sort((a, b) => a - b);
  if (ws <= sorted[0]) return mode.spectra[String(sorted[0])] ?? [];
  if (ws >= sorted[sorted.length - 1]) return mode.spectra[String(sorted[sorted.length - 1])] ?? [];
  for (let i = 1; i < sorted.length; i++) {
    if (ws <= sorted[i]) {
      const lo = sorted[i - 1];
      const hi = sorted[i];
      const t = (ws - lo) / (hi - lo);
      const a = mode.spectra[String(lo)] ?? [];
      const b = mode.spectra[String(hi)] ?? [];
      const out: number[] = [];
      for (let j = 0; j < a.length; j++) out.push(a[j] + (b[j] - a[j]) * t);
      return out;
    }
  }
  return [];
}

/// 10 octave-band centres matching the solver (16 Hz – 8 kHz).
const OCTAVE_CENTRES = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
/// 31 one-third octave centres (10 Hz – 10 kHz).
const THIRD_OCT_CENTRES = [
  10, 12.5, 16, 20, 25, 31.5, 40,
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000,
];

function octaveBand(f: number, centre: number): boolean {
  const lo = centre / Math.SQRT2;
  const hi = centre * Math.SQRT2;
  return f >= lo && f < hi;
}
function thirdOctaveBand(f: number, centre: number): boolean {
  // ratio is 10^(1/20) ≈ 1.122 each side of centre.
  const lo = centre / Math.pow(10, 1 / 20);
  const hi = centre * Math.pow(10, 1 / 20);
  return f >= lo && f < hi;
}

function snapToCentres(
  frequencies: number[],
  levels: number[],
  centres: number[],
  inBand: (f: number, c: number) => boolean,
): Float64Array {
  const out = new Float64Array(centres.length);
  for (let i = 0; i < centres.length; i++) {
    let energy = 0;
    for (let j = 0; j < frequencies.length; j++) {
      if (!inBand(frequencies[j], centres[i])) continue;
      const lp = levels[j];
      if (lp == null || !isFinite(lp) || lp <= 0) continue;
      energy += Math.pow(10, lp / 10);
    }
    out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
  }
  return out;
}

function foldThirdsToOctave(frequencies: number[], levels: number[]): Float64Array {
  return snapToCentres(frequencies, levels, OCTAVE_CENTRES, octaveBand);
}

/// Octave-band Lw distributed equally (in linear energy) across each octave's
/// three child third-octaves: each child receives `lw - 10·log10(3)` ≈ lw − 4.77 dB.
function distributeOctavesToThirds(frequencies: number[], levels: number[]): Float64Array {
  const out = new Float64Array(THIRD_OCT_CENTRES.length);
  const split = -10 * Math.log10(3);
  for (let i = 0; i < THIRD_OCT_CENTRES.length; i++) {
    const t = THIRD_OCT_CENTRES[i];
    // Find the source octave that contains this third-octave.
    let energy = 0;
    for (let j = 0; j < frequencies.length; j++) {
      if (!octaveBand(t, frequencies[j])) continue;
      const lp = levels[j];
      if (lp == null || !isFinite(lp) || lp <= 0) continue;
      energy += Math.pow(10, (lp + split) / 10);
    }
    out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
  }
  return out;
}
