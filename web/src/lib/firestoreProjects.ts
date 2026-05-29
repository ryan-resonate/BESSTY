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
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type Query,
  type QuerySnapshot,
  type Unsubscribe,
} from 'firebase/firestore';
import { db } from './firebase';
import type { Project } from './types';

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
  const ref = await addDoc(collection(db(), 'projects'), docData as DocumentData);
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
  // Strip undefineds — Firestore rejects them at write time.
  const payload: DocumentData = pruneUndefined({
    ...project,
    updatedAt: serverTimestamp(),
    updatedByUid,
  });
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
/// Returns the new version id.
export async function saveVersion(
  projectId: string,
  label: string,
  by: { uid: string; displayName: string },
): Promise<string> {
  // Read the live doc as it exists right now, server-side, so the snapshot
  // reflects committed state — not whatever the client has in memory.
  const snap = await getDoc(doc(db(), 'projects', projectId));
  if (!snap.exists()) throw new Error(`Project ${projectId} not found`);
  const ref = await addDoc(
    collection(db(), 'projects', projectId, 'versions'),
    {
      label,
      createdAt: serverTimestamp(),
      createdByUid: by.uid,
      createdByDisplayName: by.displayName,
      snapshot: snap.data(),
    },
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
        createdAt: tsToDate(x.createdAt),
        createdByUid: x.createdByUid ?? '',
        createdByDisplayName: x.createdByDisplayName ?? 'Unknown',
      };
    })),
    (err) => onError?.(err as Error),
  );
}

/// Read the embedded project payload from a saved snapshot.
export async function loadVersionSnapshot(
  projectId: string,
  versionId: string,
): Promise<Project | null> {
  const snap = await getDoc(doc(db(), 'projects', projectId, 'versions', versionId));
  if (!snap.exists()) return null;
  const data = snap.data();
  return data.snapshot as Project;
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
  const d = snap.data() ?? {};
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

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out as T;
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

// Suppress unused-import warning for writeBatch — kept ready for the
// transactional moves we'll need when we add "transfer ownership" later.
void writeBatch;
