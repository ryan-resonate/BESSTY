// Firestore CRUD + live-subscription layer for projects and versions.
// Mirrors the schema in docs/firestore-schema.md.
//
// Design notes:
//   - The project doc IS the project. We store the whole `Project` payload
//     inline. The Firestore-specific fields (ownerUid, visibility, etc.)
//     live alongside it on the same doc.
//   - Real-time collab uses `onSnapshot`. Local edits in `ProjectScreen`
//     are debounced (~1s) into `saveProject`; the snapshot listener then
//     echoes the write back. Local code suppresses the echo by checking
//     `updatedByUid === me`.
//   - Versions are stored at `projects/{id}/versions/{vid}`. Snapshots are
//     immutable — `revertToVersion` clones a snapshot back into the live
//     doc rather than mutating the snapshot.
//   - `subscribeToAllAccessibleProjects` runs three queries in parallel
//     (public OR mine OR allowlisted), merges client-side. Firestore's
//     `or()` would let us do this in one query, but the three-stream
//     approach keeps the security-rule story simple and avoids a forced
//     composite index for every combination.

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Barrier, Project } from './types';

// ===== Public-facing types =====

export interface ProjectListItem {
  id: string;
  name: string;
  description: string;
  ownerUid: string;
  ownerDisplayName: string;
  updatedAt: Date;
  updatedByUid: string;
  visibility: 'public' | 'private';
  allowedUserIds: string[];
  sourceCount: number;
  receiverCount: number;
}

export interface VersionListItem {
  id: string;
  label: string;
  /// Free-text note. Useful when the label alone doesn't capture *why*
  /// the snapshot exists ("after Q1 client review — they wanted the
  /// north turbine moved 200 m south"). Optional.
  note?: string;
  createdAt: Date;
  createdByUid: string;
  createdByDisplayName: string;
}

// ===== Project CRUD =====

/// Create a new project, return its Firestore-assigned id.
export async function createProject(
  name: string,
  initial: Partial<Project>,
  owner: { uid: string; displayName: string; email: string },
): Promise<string> {
  const now = new Date().toISOString();
  const docData: Project & { createdAt: any; updatedAt: any } = {
    schemaVersion: 1,
    name,
    description: initial.description ?? '',
    createdAt: now,
    updatedAt: now,
    owner: owner.email,
    ownerUid: owner.uid,
    ownerDisplayName: owner.displayName,
    visibility: 'public',
    allowedUserIds: [],
    updatedByUid: owner.uid,
    scenario: initial.scenario ?? defaultScenario(),
    sources: initial.sources ?? [],
    barriers: initial.barriers ?? [],
    receivers: initial.receivers ?? [],
    groups: initial.groups ?? [],
    calculationArea: initial.calculationArea,
    settings: initial.settings,
    localCatalog: initial.localCatalog,
  };
  // Use server timestamps for the indexed fields so list-by-updatedAt
  // queries don't suffer from client clock skew.
  docData.createdAt = serverTimestamp();
  docData.updatedAt = serverTimestamp();
  // Firestore rejects `undefined` values at write time, so strip them out.
  // Common offenders for a brand-new project: calculationArea, settings,
  // localCatalog (all optional fields on the Project interface). Also encode
  // wall polylines (nested arrays Firestore can't store).
  const payload = pruneUndefined(encodeBarriersIn(docData as DocumentData));
  const ref = await addDoc(collection(db(), 'projects'), payload);
  return ref.id;
}

/// One-shot read. Prefer `subscribeToProject` for the editor screen — that
/// gives you live updates too.
export async function getProject(id: string): Promise<Project | null> {
  const snap = await getDoc(doc(db(), 'projects', id));
  return snap.exists() ? hydrateProject(snap) : null;
}

/// Subscribe to live updates on a single project. Returns an `unsubscribe`
/// function — call it in your useEffect cleanup.
export function subscribeToProject(
  id: string,
  onChange: (project: Project | null) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  return onSnapshot(
    doc(db(), 'projects', id),
    (snap) => onChange(snap.exists() ? hydrateProject(snap) : null),
    (err) => onError?.(err as Error),
  );
}

/// Overwrite the live project doc. Server bumps `updatedAt` to the server
/// timestamp; client provides `updatedByUid` so other clients can suppress
/// echo notifications for the same user's writes.
export async function saveProject(
  id: string,
  project: Project,
  updatedByUid: string,
): Promise<void> {
  // Strip undefineds — Firestore rejects them at write time — and encode
  // wall polylines (nested arrays Firestore can't store).
  const payload: DocumentData = pruneUndefined(encodeBarriersIn({
    ...project,
    updatedAt: serverTimestamp(),
    updatedByUid,
  }));
  await setDoc(doc(db(), 'projects', id), payload, { merge: false });
}

export async function deleteProject(id: string): Promise<void> {
  await deleteDoc(doc(db(), 'projects', id));
  // Versions in the subcollection are NOT auto-deleted by Firestore.
  // They'll be cleaned up by a Cloud Function on the project's onDelete
  // trigger (added with the rest of the functions in task #11).
}

export async function setProjectVisibility(
  id: string,
  visibility: 'public' | 'private',
  allowedUserIds: string[],
  byUid: string,
): Promise<void> {
  await updateDoc(doc(db(), 'projects', id), {
    visibility,
    allowedUserIds,
    updatedAt: serverTimestamp(),
    updatedByUid: byUid,
  });
}

// ===== Project listing =====

/// All projects owned by this user. Live.
export function subscribeToMyProjects(
  uid: string,
  onChange: (items: ProjectListItem[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'projects'),
    where('ownerUid', '==', uid),
    orderBy('updatedAt', 'desc'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map(toListItem)),
    (err) => onError?.(err as Error),
  );
}

/// Everything I can see: public projects + my projects + private projects
/// I'm explicitly invited to. Merged client-side from three live queries.
///
/// Returns an unsubscribe that tears down all three subscriptions.
export function subscribeToAllAccessibleProjects(
  uid: string,
  onChange: (items: ProjectListItem[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  // Cache the latest snapshot from each stream so we can merge on any
  // change. Using Maps keyed by id de-duplicates docs that satisfy more
  // than one query (e.g. my own private project: hits both "mine" and
  // "allowlisted").
  const buckets = {
    public:    new Map<string, ProjectListItem>(),
    mine:      new Map<string, ProjectListItem>(),
    sharedToMe: new Map<string, ProjectListItem>(),
  };

  function emit() {
    const merged = new Map<string, ProjectListItem>();
    for (const bucket of Object.values(buckets)) {
      for (const [id, item] of bucket) merged.set(id, item);
    }
    const items = Array.from(merged.values())
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    onChange(items);
  }

  const make = (q: Query, bucket: Map<string, ProjectListItem>): Unsubscribe =>
    onSnapshot(
      q,
      (snap: QuerySnapshot) => {
        bucket.clear();
        for (const d of snap.docs) bucket.set(d.id, toListItem(d));
        emit();
      },
      (err) => onError?.(err as Error),
    );

  const projectsCol = collection(db(), 'projects');

  const unsubs = [
    make(query(projectsCol,
      where('visibility', '==', 'public'),
      orderBy('updatedAt', 'desc')
    ), buckets.public),
    make(query(projectsCol,
      where('ownerUid', '==', uid),
      orderBy('updatedAt', 'desc')
    ), buckets.mine),
    make(query(projectsCol,
      where('allowedUserIds', 'array-contains', uid),
      orderBy('updatedAt', 'desc')
    ), buckets.sharedToMe),
  ];

  return () => { for (const u of unsubs) u(); };
}

// ===== Versions =====

/// Snapshot the current live project doc into a new immutable version.
/// Returns the new version id. Label is required; note is optional and
/// can be edited later via `updateVersionMeta` (the *snapshot* itself
/// remains immutable -- you can only change the human-readable
/// label / note around it).
export async function saveVersion(
  projectId: string,
  label: string,
  by: { uid: string; displayName: string },
  note?: string,
): Promise<string> {
  // Read the live doc as it exists right now, server-side, so the snapshot
  // reflects committed state — not whatever the client has in memory.
  const snap = await getDoc(doc(db(), 'projects', projectId));
  if (!snap.exists()) throw new Error(`Project ${projectId} not found`);
  const payload: DocumentData = pruneUndefined({
    label,
    note: note?.trim() || undefined,
    createdAt: serverTimestamp(),
    createdByUid: by.uid,
    createdByDisplayName: by.displayName,
    snapshot: snap.data(),
  });
  const ref = await addDoc(
    collection(db(), 'projects', projectId, 'versions'),
    payload,
  );
  return ref.id;
}

export function subscribeToVersions(
  projectId: string,
  onChange: (versions: VersionListItem[]) => void,
  onError?: (err: Error) => void,
): Unsubscribe {
  const q = query(
    collection(db(), 'projects', projectId, 'versions'),
    orderBy('createdAt', 'desc'),
  );
  return onSnapshot(
    q,
    (snap) => onChange(snap.docs.map((d) => {
      const x = d.data();
      return {
        id: d.id,
        label: x.label ?? '(unnamed)',
        note: typeof x.note === 'string' && x.note.length > 0 ? x.note : undefined,
        createdAt: tsToDate(x.createdAt),
        createdByUid: x.createdByUid ?? '',
        createdByDisplayName: x.createdByDisplayName ?? 'Unknown',
      };
    })),
    (err) => onError?.(err as Error),
  );
}

/// Update a version's label and/or note. The snapshot itself is
/// immutable -- callers cannot rewrite the captured project state.
export async function updateVersionMeta(
  projectId: string,
  versionId: string,
  patch: { label?: string; note?: string },
): Promise<void> {
  // Strip undefined fields so we don't accidentally wipe values the
  // caller didn't pass. An empty-string note is a valid "clear it" signal
  // and gets turned into a delete by writing null via FieldValue.delete...
  // ...actually, for simplicity we just store empty string and surface
  // it as undefined in VersionListItem.
  const update: DocumentData = pruneUndefined({
    label: patch.label?.trim() || undefined,
    note: patch.note !== undefined ? patch.note.trim() : undefined,
  });
  if (Object.keys(update).length === 0) return;
  await updateDoc(doc(db(), 'projects', projectId, 'versions', versionId), update);
}

/// Permanently delete a version. The snapshot is gone -- callers can't
/// undo this. UI should confirm before invoking.
export async function deleteVersion(
  projectId: string,
  versionId: string,
): Promise<void> {
  await deleteDoc(doc(db(), 'projects', projectId, 'versions', versionId));
}

/// Read the embedded project payload from a saved snapshot.
export async function loadVersionSnapshot(
  projectId: string,
  versionId: string,
): Promise<Project | null> {
  const snap = await getDoc(doc(db(), 'projects', projectId, 'versions', versionId));
  if (!snap.exists()) return null;
  const data = snap.data();
  if (!data.snapshot) return null;
  // The snapshot was stored as the (already-encoded) live doc, so decode the
  // wall polylines back to [lat, lng] tuples before handing it to the app.
  return decodeBarriersIn(data.snapshot as DocumentData) as unknown as Project;
}

/// Clone a saved snapshot back into the live project doc. The snapshot
/// itself stays put — reverting doesn't destroy history.
export async function revertToVersion(
  projectId: string,
  versionId: string,
  byUid: string,
): Promise<void> {
  const snap = await loadVersionSnapshot(projectId, versionId);
  if (!snap) throw new Error(`Version ${versionId} not found`);
  await saveProject(projectId, snap, byUid);
}

// ===== Helpers =====

function hydrateProject(snap: DocumentSnapshot): Project {
  const d = decodeBarriersIn(snap.data() ?? {});
  return {
    ...(d as Project),
    // Ensure id-correlated fields are populated even when the doc was
    // written by a slightly older client that didn't set them.
    createdAt: tsToDate(d.createdAt).toISOString(),
    updatedAt: tsToDate(d.updatedAt).toISOString(),
  };
}

function toListItem(d: DocumentSnapshot): ProjectListItem {
  const x = d.data() ?? {};
  return {
    id: d.id,
    name: x.name ?? 'Untitled project',
    description: x.description ?? '',
    ownerUid: x.ownerUid ?? '',
    ownerDisplayName: x.ownerDisplayName ?? '(unknown)',
    updatedAt: tsToDate(x.updatedAt),
    updatedByUid: x.updatedByUid ?? '',
    visibility: x.visibility === 'private' ? 'private' : 'public',
    allowedUserIds: Array.isArray(x.allowedUserIds) ? x.allowedUserIds : [],
    sourceCount: Array.isArray(x.sources) ? x.sources.length : 0,
    receiverCount: Array.isArray(x.receivers) ? x.receivers.length : 0,
  };
}

function tsToDate(v: unknown): Date {
  if (v instanceof Timestamp) return v.toDate();
  if (typeof v === 'string') return new Date(v);
  if (typeof v === 'number') return new Date(v);
  return new Date(0);
}

/// DEEP-prune undefined values from an object before sending to
/// Firestore. Firestore rejects `undefined` field values anywhere in
/// the document tree -- not just at the top level. Optional fields
/// on nested types (e.g. BessSegment.modeOverride, BessRow.
/// segmentSequenceRepeat) are commonly undefined at construction time
/// and would otherwise blow up the save with
///   "Function setDoc() called with invalid data. Unsupported field
///    value: undefined (found in field bessGroups.0.rows.0.segments.0
///    .modeOverride ...)"
///
/// Behaviour:
///   - Arrays: recurse into each element, keep nulls/sparse holes
///     (Firestore accepts arrays with null entries; absent entries
///     become null).
///   - Plain objects: recurse, drop keys whose value is undefined OR
///     whose recursed value becomes undefined.
///   - Firestore sentinels (serverTimestamp, FieldValue): instances
///     of FieldValue from the SDK -- pass through unchanged via the
///     `_methodName` heuristic check. Same for Timestamp.
///   - Date / number / string / boolean / null: pass through.
///
/// Returns the pruned value, typed loosely as it may have lost keys.
function deepPruneUndefined<T>(value: T): T {
  if (value === undefined) return value;     // caller decides what to do
  if (value === null) return value;
  if (typeof value !== 'object') return value;
  // Firestore sentinel objects (FieldValue instances such as
  // serverTimestamp()) carry a `_methodName` field; passing them
  // through a `for...in` loop strips the FieldValue prototype and
  // produces an invalid plain-object impostor. Detect and bypass.
  if (typeof (value as { _methodName?: unknown })._methodName === 'string') {
    return value;
  }
  // Firestore Timestamp / GeoPoint / etc: instanceof check via the
  // constructor's name to avoid importing the whole SDK type set.
  const ctorName = (value as object).constructor?.name;
  if (ctorName === 'Timestamp' || ctorName === 'GeoPoint' || ctorName === 'DocumentReference') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => v === undefined ? null : deepPruneUndefined(v)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = deepPruneUndefined(v);
    if (cleaned === undefined) continue;
    out[k] = cleaned;
  }
  return out as T;
}

/// Back-compat alias for the older shallow helper. All call sites have
/// been switched to the deep version; this just keeps the existing
/// usages compiling and behaviourally equivalent (deep is a superset).
function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  return deepPruneUndefined(obj);
}

/// Firestore CANNOT store a nested array — an array whose elements are
/// themselves arrays. `Barrier.polylineLatLng` is `Array<[number, number]>`
/// (a list of [lat, lng] tuples) — the ONLY field of that shape in the whole
/// project model. Writing it raw makes every save throw
///   "Function setDoc() called with invalid data. Nested arrays are not
///    supported (found in field barriers.0.polylineLatLng)"
/// which fails the entire write, so the wall never persists and version
/// snapshots come back wall-less. Encode each vertex to a {lat,lng} object
/// on write; restore the tuple on read. (Sources / receivers / calc-area use
/// single tuples wrapped in an object, so Firestore accepts them as-is —
/// that's why only walls were affected.)
///
/// No data migration is needed: before this fix a wall could never be saved,
/// so no stored doc or version contains an encoded — or raw — wall vertex.
function encodeBarriersIn<T extends DocumentData>(data: T): T {
  const barriers = (data as { barriers?: unknown }).barriers;
  if (!Array.isArray(barriers) || barriers.length === 0) return data;
  return {
    ...data,
    barriers: barriers.map((b) => {
      const poly = (b as Barrier)?.polylineLatLng;
      if (!Array.isArray(poly)) return b;
      return { ...(b as Barrier), polylineLatLng: poly.map(([lat, lng]) => ({ lat, lng })) };
    }),
  };
}

/// Inverse of `encodeBarriersIn`. Defensive: a vertex already in tuple form
/// (legacy / hand-edited data) passes through unchanged.
function decodeBarriersIn<T extends DocumentData>(data: T): T {
  const barriers = (data as { barriers?: unknown }).barriers;
  if (!Array.isArray(barriers) || barriers.length === 0) return data;
  return {
    ...data,
    barriers: barriers.map((b) => {
      const poly = (b as { polylineLatLng?: unknown })?.polylineLatLng;
      if (!Array.isArray(poly)) return b;
      return {
        ...(b as object),
        polylineLatLng: poly.map((p) =>
          Array.isArray(p)
            ? p
            : [(p as { lat: number }).lat, (p as { lng: number }).lng],
        ),
      };
    }),
  };
}

// Default scenario when creating a brand-new project. Kept here rather
// than imported from `storage.makeEmptyProject` to keep this module
// dependency-free of the local-storage stack.
function defaultScenario() {
  return {
    windSpeed: 10,
    windSpeedReferenceHeight: 10,
    period: 'night' as const,
    bandSystem: 'octave' as const,
  };
}

