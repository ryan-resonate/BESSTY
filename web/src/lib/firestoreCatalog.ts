// Firestore primitives for the catalog (global + personal libraries).
//
// `catalogsGlobal/{entryId}` is the shared library — readable by any
// signed-in user, writable by any signed-in user per the agreed access
// model. Document id = CatalogEntry.id.
//
// `users/{uid}/catalogs/{entryId}` is the personal library — only the
// owning user can read or write.
//
// `catalog.ts` consumes these primitives behind a synchronous cache so
// existing call sites (source pickers, ProjectScreen) don't have to
// become async. Writes go through this module directly.

import {
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { CatalogEntry } from './types';

// ===== Global library =====

/// Live subscription on the shared global catalog. Fires once with the
/// initial set then re-fires on every server-side change. Use the
/// returned unsubscribe in your useEffect cleanup.
export function subscribeGlobalCatalog(
  onChange: (entries: CatalogEntry[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db(), 'catalogsGlobal'),
    (snap) => {
      const entries = snap.docs.map((d) => stripMeta(d.data()) as unknown as CatalogEntry);
      onChange(entries);
    },
    (err) => onError?.(err as Error),
  );
}

/// Insert / overwrite a single global entry. Stamped with the caller's
/// uid for traceability (rules require `createdByUid === request.auth.uid`
/// on create).
export async function upsertGlobalEntryFs(
  entry: CatalogEntry,
  byUid: string,
): Promise<void> {
  await setDoc(
    doc(db(), 'catalogsGlobal', entry.id),
    {
      ...entry,
      createdByUid: byUid,
      updatedAt: serverTimestamp(),
    },
    { merge: true },
  );
}

export async function deleteGlobalEntryFs(id: string): Promise<void> {
  await deleteDoc(doc(db(), 'catalogsGlobal', id));
}

/// Bulk-seed the global library. Used once to migrate the bundled
/// SEED_CATALOG to Firestore -- subsequent runs are no-ops because we
/// only call this when the collection is empty. Done in a single batch
/// so it lands atomically (no half-seeded intermediate state).
export async function seedGlobalCatalog(
  entries: CatalogEntry[],
  byUid: string,
): Promise<void> {
  const batch = writeBatch(db());
  for (const entry of entries) {
    batch.set(
      doc(db(), 'catalogsGlobal', entry.id),
      {
        ...entry,
        createdByUid: byUid,
        updatedAt: serverTimestamp(),
      },
    );
  }
  await batch.commit();
}

// ===== Personal library =====

/// Live subscription on the signed-in user's personal library.
export function subscribePersonalCatalog(
  uid: string,
  onChange: (entries: CatalogEntry[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    collection(db(), 'users', uid, 'catalogs'),
    (snap) => onChange(snap.docs.map((d) => stripMeta(d.data()) as unknown as CatalogEntry)),
    (err) => onError?.(err as Error),
  );
}

export async function upsertPersonalEntryFs(
  uid: string,
  entry: CatalogEntry,
): Promise<void> {
  await setDoc(
    doc(db(), 'users', uid, 'catalogs', entry.id),
    { ...entry, updatedAt: serverTimestamp() },
    { merge: true },
  );
}

export async function deletePersonalEntryFs(uid: string, id: string): Promise<void> {
  await deleteDoc(doc(db(), 'users', uid, 'catalogs', id));
}

// ===== Helpers =====

/// Strip the Firestore-specific bookkeeping fields back off the entry so
/// the cached value is a clean CatalogEntry. Stops `createdByUid` /
/// `updatedAt` leaking into the source-picker UI.
function stripMeta(data: Record<string, unknown>): Record<string, unknown> {
  const { createdByUid: _c, updatedAt: _u, ...rest } = data as {
    createdByUid?: unknown; updatedAt?: unknown;
  } & Record<string, unknown>;
  return rest;
}
