// `useProjectDoc(projectId)` — the persistence layer for the project editor.
//
// Hides the difference between Firestore-backed projects (post-migration,
// real-time collab) and legacy localStorage projects (offline / pre-Firebase).
// ProjectScreen calls `setProject(p)` after every mutation; the hook
// debounces the actual write so the editor remains responsive.
//
// Real-time collab:
//   - Subscribes to the Firestore doc via onSnapshot.
//   - Echo-suppression: snapshots whose `updatedByUid` matches the local
//     user are ignored — they're the round-trip of our own write.
//   - When a remote write lands while we have unsaved local changes
//     (writeTimer pending OR a write is in flight), we don't clobber the
//     editor — instead we surface a `remoteUpdate` notice so the user
//     can choose to reload or keep their version (last-write-wins
//     either way, but they're informed).
//   - When no local changes are pending, we silently replace state with
//     the remote version. This is what makes "two windows open" feel live.
//
// Storage selection:
//   - On mount, subscribe to Firestore.
//   - First snapshot decides the source:
//       - Doc exists → 'firestore', use Firestore for all writes.
//       - Doc missing AND localStorage has this id → 'local', use the
//         old storage.ts path.
//       - Doc missing AND no local copy → 'none' (caller redirects).
//   - On error (permission denied, offline) → try local.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  saveProject as saveFirestoreProject,
  subscribeToProject,
} from './firestoreProjects';
import { loadProject as loadLocalProject, saveProject as saveLocalProject } from './storage';
import type { Project } from './types';

export type ProjectSource = 'firestore' | 'local' | 'none';

export interface RemoteUpdateNotice {
  byUid: string;
  byDisplayName?: string;
  at: Date;
}

export interface UseProjectDocResult {
  /// Current in-memory project. `null` while loading or when no project
  /// exists for the given id.
  project: Project | null;
  /// True until the first snapshot has been resolved.
  loading: boolean;
  /// Where this project is being persisted. 'none' = couldn't find it
  /// anywhere; the caller should navigate away.
  source: ProjectSource;
  /// Set when a remote collaborator's write lands while we have unsaved
  /// local changes. Cleared by `dismissRemoteUpdate` or `reloadFromRemote`.
  remoteUpdate: RemoteUpdateNotice | null;
  /// Update the project. Local in-memory state changes immediately; the
  /// write to Firestore (or localStorage) is debounced.
  setProject: (next: Project) => void;
  /// Flush any pending debounced write immediately (call before navigating
  /// away so the user doesn't lose the last keystroke).
  flushPendingSave: () => Promise<void>;
  /// Discard the in-memory changes and re-load from the remote (Firestore
  /// snapshot or localStorage). Used by the "Reload" button on the
  /// remote-update banner.
  dismissRemoteUpdate: () => void;
}

const DEBOUNCE_MS = 800;

export function useProjectDoc(
  projectId: string | undefined,
  currentUid: string | null,
): UseProjectDocResult {
  const [project, setProjectState] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<ProjectSource>('none');
  const [remoteUpdate, setRemoteUpdate] = useState<RemoteUpdateNotice | null>(null);

  // Refs for the debounce + echo-suppression machinery. Kept in refs (not
  // state) because writes shouldn't trigger re-renders.
  const pendingProjectRef = useRef<Project | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const writeInFlightRef = useRef(false);
  const sourceRef = useRef<ProjectSource>('none');
  const firstSnapshotResolvedRef = useRef(false);

  useEffect(() => {
    sourceRef.current = source;
  }, [source]);

  // Subscribe to the project doc. Effect re-runs if the id or current
  // user changes (e.g. on sign-out + sign-in as a different user).
  useEffect(() => {
    if (!projectId) {
      setSource('none'); setProjectState(null); setLoading(false);
      return;
    }
    firstSnapshotResolvedRef.current = false;
    setLoading(true);

    const unsub = subscribeToProject(
      projectId,
      (remoteProject) => {
        // First snapshot: decide where this project lives.
        if (!firstSnapshotResolvedRef.current) {
          firstSnapshotResolvedRef.current = true;
          if (remoteProject) {
            setSource('firestore');
            setProjectState(remoteProject);
          } else {
            // Doc doesn't exist in Firestore — try localStorage.
            const local = loadLocalProject(projectId);
            if (local) {
              setSource('local');
              setProjectState(local);
            } else {
              setSource('none');
              setProjectState(null);
            }
          }
          setLoading(false);
          return;
        }

        // Subsequent snapshots: only relevant if we're in Firestore mode.
        if (sourceRef.current !== 'firestore') return;

        if (!remoteProject) {
          // Doc was deleted out from under us.
          setProjectState(null);
          return;
        }

        // Echo-suppress: ignore snapshots we triggered ourselves.
        if (
          remoteProject.updatedByUid && currentUid &&
          remoteProject.updatedByUid === currentUid
        ) {
          return;
        }

        // Remote write from another user. If we have unsaved local edits,
        // surface a banner; otherwise apply silently.
        const hasUnsavedLocal =
          writeTimerRef.current !== null || writeInFlightRef.current;
        if (hasUnsavedLocal) {
          setRemoteUpdate({
            byUid: remoteProject.updatedByUid ?? '',
            byDisplayName: remoteProject.ownerDisplayName,
            at: new Date(remoteProject.updatedAt),
          });
          // Keep the editor's local copy; the next debounced save will
          // overwrite the remote.
        } else {
          setProjectState(remoteProject);
        }
      },
      (err) => {
        // Permission denied, offline, etc. Fall back to localStorage.
        // eslint-disable-next-line no-console
        console.warn('[BESSTY] Firestore subscribe failed; falling back to localStorage:', err);
        if (!firstSnapshotResolvedRef.current) {
          firstSnapshotResolvedRef.current = true;
          const local = projectId ? loadLocalProject(projectId) : null;
          if (local) {
            setSource('local');
            setProjectState(local);
          } else {
            setSource('none');
            setProjectState(null);
          }
          setLoading(false);
        }
      },
    );

    return () => {
      unsub();
      // Cancel any pending debounce-write — the next mount will start fresh.
      if (writeTimerRef.current !== null) {
        window.clearTimeout(writeTimerRef.current);
        writeTimerRef.current = null;
      }
      pendingProjectRef.current = null;
    };
  }, [projectId, currentUid]);

  // ===== Writes =====

  const performWrite = useCallback(async () => {
    const next = pendingProjectRef.current;
    if (!next || !projectId) return;
    pendingProjectRef.current = null;
    writeTimerRef.current = null;
    writeInFlightRef.current = true;
    try {
      if (sourceRef.current === 'firestore') {
        await saveFirestoreProject(projectId, next, currentUid ?? '');
      } else if (sourceRef.current === 'local') {
        saveLocalProject(projectId, next);
      } else {
        // source === 'none' — don't persist
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[BESSTY] save failed:', err);
    } finally {
      writeInFlightRef.current = false;
      // If a new write came in while we were saving, re-debounce it.
      if (pendingProjectRef.current && writeTimerRef.current === null) {
        writeTimerRef.current = window.setTimeout(performWrite, DEBOUNCE_MS);
      }
    }
  }, [projectId, currentUid]);

  const setProject = useCallback((next: Project) => {
    setProjectState(next);
    pendingProjectRef.current = next;
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
    }
    writeTimerRef.current = window.setTimeout(performWrite, DEBOUNCE_MS);
  }, [performWrite]);

  const flushPendingSave = useCallback(async () => {
    if (writeTimerRef.current !== null) {
      window.clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    if (pendingProjectRef.current) {
      await performWrite();
    }
  }, [performWrite]);

  // Flush on unmount/page-hide so navigating away doesn't lose the last
  // ~800ms of edits.
  useEffect(() => {
    const handler = () => { void flushPendingSave(); };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      void flushPendingSave();
    };
  }, [flushPendingSave]);

  const dismissRemoteUpdate = useCallback(() => {
    setRemoteUpdate(null);
  }, []);

  return {
    project,
    loading,
    source,
    remoteUpdate,
    setProject,
    flushPendingSave,
    dismissRemoteUpdate,
  };
}
