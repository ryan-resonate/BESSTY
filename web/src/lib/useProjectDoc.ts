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
import { notify } from './notify';
import type { Project } from './types';

/// Where the open project lives. `'local'` (localStorage) was removed in I2 —
/// the union keeps the name out so any lingering comparison fails to compile
/// rather than silently never matching.
export type ProjectSource = 'firestore' | 'none';

export type SaveStatus =
  | 'idle'      // no recent save, no pending edit
  | 'pending'   // edit made; debounced write not yet fired
  | 'saving'    // write in flight to Firestore / localStorage
  | 'saved'     // last write succeeded (auto-fades back to 'idle')
  | 'error';    // last write failed (sticky until the next success)

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
  /// Current state of the save pipeline -- drives the UI's "Saving…" /
  /// "Saved" badge.
  saveStatus: SaveStatus;
  /// Human-readable error from the last failed save, if any.
  saveError: string | null;
  /// Set when a remote collaborator's write lands while we have unsaved
  /// local changes. Cleared by `dismissRemoteUpdate` or `reloadFromRemote`.
  remoteUpdate: RemoteUpdateNotice | null;
  /// Bumped ONLY when a project from the SERVER is applied to `project` —
  /// the initial load and silent remote-collaborator applies. `project`
  /// itself changes identity on every local `setProject` too (the editor
  /// reads its own writes back), so consumers that must react to *loads*
  /// (e.g. resetting undo history) key on this, not on `project` identity —
  /// keying on identity fires on every keystroke.
  remoteRevision: number;
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
const SAVED_FADE_MS = 2000;

export function useProjectDoc(
  projectId: string | undefined,
  currentUid: string | null,
): UseProjectDocResult {
  const [project, setProjectState] = useState<Project | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<ProjectSource>('none');
  const [remoteUpdate, setRemoteUpdate] = useState<RemoteUpdateNotice | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [remoteRevision, setRemoteRevision] = useState(0);

  // Refs for the debounce + echo-suppression machinery. Kept in refs (not
  // state) because writes shouldn't trigger re-renders.
  const pendingProjectRef = useRef<Project | null>(null);
  const writeTimerRef = useRef<number | null>(null);
  const writeInFlightRef = useRef(false);
  const sourceRef = useRef<ProjectSource>('none');
  const firstSnapshotResolvedRef = useRef(false);
  const savedFadeTimerRef = useRef<number | null>(null);

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
            setRemoteRevision((r) => r + 1);
          } else {
            // I2: projects live in Firestore only. The localStorage fallback
            // that used to catch this case is gone.
            setSource('none');
            setProjectState(null);
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
          setRemoteRevision((r) => r + 1);
        }
      },
      (err) => {
        // Permission denied, offline, etc. There is no local fallback any more
        // (I2), so surface it instead of silently showing an empty project —
        // "your project didn't load" must not look like "your project is
        // empty", which is what a silent failure would read as.
        // eslint-disable-next-line no-console
        console.error('[BESSTY] Firestore subscribe failed:', err);
        if (!firstSnapshotResolvedRef.current) {
          firstSnapshotResolvedRef.current = true;
          setSource('none');
          setProjectState(null);
          setLoading(false);
          notify.error(
            `Couldn't load this project: ${err.message}. Check your connection and reload.`,
            { title: 'Project failed to load' },
          );
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
    setSaveStatus('saving');
    try {
      if (sourceRef.current === 'firestore') {
        await saveFirestoreProject(projectId, next, currentUid ?? '');
      } else {
        // source === 'none' — nothing to persist to
      }
      setSaveError(null);
      // Show "Saved" briefly, then fade back to idle if no new edits.
      setSaveStatus('saved');
      if (savedFadeTimerRef.current !== null) {
        window.clearTimeout(savedFadeTimerRef.current);
      }
      savedFadeTimerRef.current = window.setTimeout(() => {
        // Only fade to idle if nothing has changed in the meantime --
        // otherwise the user typed and we're already back in pending.
        setSaveStatus((cur) => (cur === 'saved' ? 'idle' : cur));
      }, SAVED_FADE_MS);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      // eslint-disable-next-line no-console
      console.error('[BESSTY] save failed:', err);
      setSaveError(msg);
      setSaveStatus('error');
    } finally {
      writeInFlightRef.current = false;
      // If a new write came in while we were saving, re-debounce it.
      if (pendingProjectRef.current && writeTimerRef.current === null) {
        setSaveStatus('pending');
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
    // Only show 'pending' for Firestore-backed saves -- localStorage writes
    // are synchronous and there's nothing in-flight to indicate.
    if (sourceRef.current === 'firestore') {
      setSaveStatus('pending');
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

  // Flush on every page-lifecycle exit point we can hook:
  //   - beforeunload: full page navigation / tab close (best-effort, no
  //     guarantees because browsers may cut us off mid-write).
  //   - visibilitychange (hidden): the user switched tabs or minimised.
  //     Earlier than beforeunload on mobile / Safari, so flushes land
  //     reliably even when the OS suspends the tab.
  //   - effect cleanup (component unmount): in-app route changes.
  useEffect(() => {
    const handler = () => { void flushPendingSave(); };
    const visibilityHandler = () => {
      if (document.visibilityState === 'hidden') handler();
    };
    window.addEventListener('beforeunload', handler);
    document.addEventListener('visibilitychange', visibilityHandler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      document.removeEventListener('visibilitychange', visibilityHandler);
      void flushPendingSave();
      // Cancel the "Saved" fade timer if the component unmounts while
      // it's pending (otherwise it tries to setState on a dead component).
      if (savedFadeTimerRef.current !== null) {
        window.clearTimeout(savedFadeTimerRef.current);
        savedFadeTimerRef.current = null;
      }
    };
  }, [flushPendingSave]);

  const dismissRemoteUpdate = useCallback(() => {
    setRemoteUpdate(null);
  }, []);

  return {
    project,
    loading,
    source,
    saveStatus,
    saveError,
    remoteUpdate,
    remoteRevision,
    setProject,
    flushPendingSave,
    dismissRemoteUpdate,
  };
}
