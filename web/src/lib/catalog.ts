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
import { seedEntriesToUpsert } from './catalogMigration';
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
      // First snapshot is in. Top the global catalog up with any bundled seed
      // entry it doesn't already have (I2). Previously this only fired when
      // the collection was completely EMPTY, so a seed product added to the
      // bundle after first launch never reached Firestore and existed only for
      // users whose cache hadn't loaded yet.
      //
      // Matched by id, so an entry someone has since edited globally is never
      // reverted to the bundled version. Per-doc-id writes are idempotent, so
      // races between users are harmless.
      if (!seedAttempted) {
        seedAttempted = true;
        const missing = seedEntriesToUpsert(SEED_CATALOG, entries);
        const uid = firebaseAuth().currentUser?.uid;
        if (missing.length > 0 && uid) {
          void seedGlobalCatalog(missing, uid).catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[BESSTY] global catalog top-up failed:', err);
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
    // I2: local catalogs are gone, but stored sources still carry
    // `catalogScope: 'local'` until they're migrated. Resolve from whatever
    // localCatalog the document still has, then fall through to global — an
    // un-migrated project must keep solving, not lose its models.
    return localCatalogOf(project).find((e) => e.id === source.modelId)
      ?? loadGlobalCatalog().find((e) => e.id === source.modelId)
      ?? null;
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


// ---------- Spectra ----------
//
// The projection maths lives in the dependency-free `spectra` leaf so the
// curtailment model — and its tests — can use it without pulling Firebase in
// through this module. Re-exported here so every existing call site keeps
// importing from './catalog'.
export {
  spectrumFor,
  spectrumForMode,
  overallLwFromBands,
  octaveSpectrumFor,
} from './spectra';
