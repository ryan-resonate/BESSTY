// "Project" tab — project-level metadata: owner, visibility, version
// history. Distinct from the per-object tabs (Sources / Receivers /
// Barriers) because these settings apply to the whole document, not to
// any one element on the map.
//
// Privacy:
//   - 'public' (default): any signed-in user can read the project.
//     Owner + allowedUserIds can write.
//   - 'private': only owner + allowedUserIds can read AND write.
//   - "Add by email" looks up the user's uid via a Firestore query on
//     users.email. Targets are added to allowedUserIds; the security
//     rules (task #10) honour the same field.
//
// Versions:
//   - Manual save points. User types a label, hits Save; the current
//     project doc is snapshotted into `projects/{id}/versions/{vid}`.
//   - Each row in the list has a Revert button — clones the snapshot
//     back into the live doc (which the ProjectScreen useProjectDoc
//     hook then surfaces as a normal state update).
//   - Snapshots are immutable; reverting never destroys history.

import { useEffect, useMemo, useState } from 'react';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { db } from '../lib/firebase';
import {
  revertToVersion,
  saveVersion,
  setProjectVisibility,
  subscribeToVersions,
  type VersionListItem,
} from '../lib/firestoreProjects';
import type { Project } from '../lib/types';

interface Props {
  projectId: string;
  project: Project;
  currentUid: string;
  currentDisplayName: string;
  /// 'firestore' = features below are usable. 'local' = legacy
  /// localStorage project; privacy/versions don't apply yet.
  source: 'firestore' | 'local' | 'none';
}

export function ProjectMetaPanel({
  projectId, project, currentUid, currentDisplayName, source,
}: Props) {
  if (source !== 'firestore') {
    return (
      <div style={{ padding: 12, color: 'var(--ink-soft, #475569)', fontSize: 13 }}>
        Privacy &amp; version history are only available for cloud-saved
        projects. This project is currently a local copy — open or create a
        new project to access these features.
      </div>
    );
  }
  const isOwner = project.ownerUid === currentUid;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18, padding: 12 }}>
      <OwnerBlock project={project} />
      <PrivacyBlock
        projectId={projectId}
        project={project}
        currentUid={currentUid}
        canEdit={isOwner}
      />
      <VersionsBlock
        projectId={projectId}
        currentUid={currentUid}
        currentDisplayName={currentDisplayName}
      />
    </div>
  );
}

// ===== Owner =====

function OwnerBlock({ project }: { project: Project }) {
  return (
    <section>
      <SectionTitle>Project info</SectionTitle>
      <KvRow k="Owner" v={project.ownerDisplayName ?? '(unknown)'} />
      <KvRow k="Created" v={project.createdAt ? new Date(project.createdAt).toLocaleString() : '—'} />
      <KvRow k="Last edit" v={project.updatedAt ? new Date(project.updatedAt).toLocaleString() : '—'} />
    </section>
  );
}

// ===== Privacy =====

function PrivacyBlock({ projectId, project, currentUid, canEdit }: {
  projectId: string; project: Project; currentUid: string; canEdit: boolean;
}) {
  const [vis, setVis] = useState<'public' | 'private'>(project.visibility ?? 'public');
  const [allow, setAllow] = useState<string[]>(project.allowedUserIds ?? []);
  const [emailInput, setEmailInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-sync local state if the project doc changes from under us
  // (e.g. owner edited visibility in another tab).
  useEffect(() => {
    setVis(project.visibility ?? 'public');
    setAllow(project.allowedUserIds ?? []);
  }, [project.visibility, project.allowedUserIds]);

  async function commit(nextVis: 'public' | 'private', nextAllow: string[]) {
    setBusy(true); setError(null);
    try {
      await setProjectVisibility(projectId, nextVis, nextAllow, currentUid);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    if (!emailInput.trim()) return;
    setBusy(true); setError(null);
    try {
      const uid = await uidForEmail(emailInput.trim());
      if (!uid) {
        setError(`No BESSTY account found for ${emailInput.trim()}. They need to sign up first.`);
        return;
      }
      if (uid === project.ownerUid) {
        setError('Owner is already implicitly granted access.');
        return;
      }
      if (allow.includes(uid)) {
        setError('That user is already on the list.');
        return;
      }
      const next = [...allow, uid];
      setAllow(next);
      setEmailInput('');
      await commit(vis, next);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function handleRemove(uid: string) {
    const next = allow.filter((x) => x !== uid);
    setAllow(next);
    void commit(vis, next);
  }

  function handleToggleVis() {
    const next = vis === 'public' ? 'private' : 'public';
    setVis(next);
    void commit(next, allow);
  }

  return (
    <section>
      <SectionTitle>Privacy</SectionTitle>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          <input
            type="checkbox"
            checked={vis === 'private'}
            disabled={!canEdit || busy}
            onChange={handleToggleVis}
          />
          Private (only owner &amp; invited users can see this project)
        </label>
      </div>
      <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)', marginBottom: 8 }}>
        {vis === 'public'
          ? 'Public — any signed-in BESSTY user can view this project. Editing is still limited to the owner and invited users.'
          : 'Private — only the owner and users listed below can view or edit.'}
      </div>

      <SectionSubtitle>Invited users</SectionSubtitle>
      {allow.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)', marginBottom: 6 }}>
          No additional users invited.
        </div>
      )}
      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
        {allow.map((uid) => (
          <li key={uid} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <UserBadge uid={uid} />
            {canEdit && (
              <button
                type="button"
                onClick={() => handleRemove(uid)}
                disabled={busy}
                style={btnTinyStyle}
                title="Remove"
              >×</button>
            )}
          </li>
        ))}
      </ul>

      {canEdit && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type="email"
            placeholder="user@example.com"
            value={emailInput}
            onChange={(e) => setEmailInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleAdd(); } }}
            style={{ ...inputStyle, flex: 1 }}
            disabled={busy}
          />
          <button
            type="button"
            onClick={handleAdd}
            disabled={busy || !emailInput.trim()}
            style={btnStyle}
          >Add</button>
        </div>
      )}
      {error && <Banner kind="error">{error}</Banner>}
    </section>
  );
}

// ===== Versions =====

function VersionsBlock({ projectId, currentUid, currentDisplayName }: {
  projectId: string; currentUid: string; currentDisplayName: string;
}) {
  const [versions, setVersions] = useState<VersionListItem[] | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribeToVersions(
      projectId,
      setVersions,
      (err) => setError(err.message),
    );
    return () => unsub();
  }, [projectId]);

  async function handleSave() {
    if (!label.trim()) return;
    setBusy(true); setError(null);
    try {
      await saveVersion(projectId, label.trim(), {
        uid: currentUid, displayName: currentDisplayName,
      });
      setLabel('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevert(v: VersionListItem) {
    if (!confirm(
      `Revert the live project to version "${v.label}" (saved ${v.createdAt.toLocaleString()})?\n\n` +
      'Your current state will be overwritten. (You can always Save a new version first to keep it.)'
    )) return;
    setBusy(true); setError(null);
    try {
      await revertToVersion(projectId, v.id, currentUid);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section>
      <SectionTitle>Versions</SectionTitle>
      <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)', marginBottom: 8 }}>
        Save a snapshot of the current state to come back to later.
        Reverting restores the snapshot — your current state is overwritten,
        but the snapshot itself stays in the history.
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input
          type="text"
          placeholder="Label (e.g. 'Pre-rezoning revision')"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void handleSave(); } }}
          style={{ ...inputStyle, flex: 1 }}
          disabled={busy}
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={busy || !label.trim()}
          style={btnStyle}
        >Save version</button>
      </div>

      {error && <Banner kind="error">{error}</Banner>}

      {versions === null && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)' }}>Loading…</div>
      )}
      {versions && versions.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)' }}>
          No saved versions yet.
        </div>
      )}
      {versions && versions.length > 0 && (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {versions.map((v) => (
            <li key={v.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', border: '1px solid var(--light, #e5e7eb)',
              borderRadius: 4,
            }}>
              <div style={{ flex: 1, fontSize: 12 }}>
                <div style={{ fontWeight: 600 }}>{v.label}</div>
                <div style={{ color: 'var(--ink-soft, #475569)' }}>
                  {v.createdByDisplayName} · {v.createdAt.toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRevert(v)}
                disabled={busy}
                style={btnTinyStyle}
                title="Revert the live project to this snapshot"
              >Revert</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ===== Helpers =====

/// Look up a user's uid by email. Used by the privacy "Add by email" flow.
/// Returns null if no account exists. Requires the user to have signed up
/// (and verified) at least once — there's no "invite a pending account"
/// path yet.
async function uidForEmail(email: string): Promise<string | null> {
  const lower = email.trim().toLowerCase();
  const snap = await getDocs(query(
    collection(db(), 'users'),
    where('email', '==', lower),
  ));
  if (snap.empty) return null;
  return snap.docs[0].id;
}

function UserBadge({ uid }: { uid: string }) {
  // Cheap inline cache — we only need the display name + email.
  // Avoids one Firestore read per render.
  const [info, setInfo] = useState<{ name: string; email: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { getDoc, doc } = await import('firebase/firestore');
        const snap = await getDoc(doc(db(), 'users', uid));
        if (!cancelled && snap.exists()) {
          const d = snap.data();
          setInfo({ name: d.displayName ?? d.email ?? uid, email: d.email ?? '' });
        }
      } catch {
        if (!cancelled) setInfo({ name: uid, email: '' });
      }
    })();
    return () => { cancelled = true; };
  }, [uid]);
  return (
    <span title={info?.email ?? uid}>
      {info?.name ?? <span style={{ opacity: 0.5 }}>{uid.slice(0, 6)}…</span>}
    </span>
  );
}

// ===== Tiny inline styles =====

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--light, #e5e7eb)',
  borderRadius: 4, padding: '6px 8px', fontSize: 13,
  fontFamily: 'inherit', outline: 'none',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--ink, #1f2937)', color: '#fff', border: 'none',
  padding: '6px 12px', borderRadius: 4, fontSize: 12, fontWeight: 600,
  cursor: 'pointer',
};

const btnTinyStyle: React.CSSProperties = {
  background: '#fff', color: 'var(--ink, #1f2937)',
  border: '1px solid var(--light, #e5e7eb)',
  padding: '2px 8px', borderRadius: 4, fontSize: 11,
  cursor: 'pointer',
};

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{
      fontSize: 12, fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.06em', margin: '0 0 8px',
      color: 'var(--ink, #1f2937)',
    }}>{children}</h3>
  );
}

function SectionSubtitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 style={{
      fontSize: 11, fontWeight: 600, margin: '8px 0 4px',
      color: 'var(--ink-soft, #475569)',
    }}>{children}</h4>
  );
}

function KvRow({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', fontSize: 12, gap: 8, marginBottom: 2 }}>
      <span style={{ width: 80, color: 'var(--ink-soft, #475569)' }}>{k}</span>
      <span style={{ color: 'var(--ink, #1f2937)' }}>{v}</span>
    </div>
  );
}

function Banner({ kind, children }: { kind: 'error' | 'info'; children: React.ReactNode }) {
  const colors = kind === 'error'
    ? { bg: 'rgba(239, 68, 68, 0.08)', fg: 'var(--red, #dc2626)' }
    : { bg: 'rgba(16, 185, 129, 0.10)', fg: '#047857' };
  return (
    <div style={{
      background: colors.bg, color: colors.fg,
      padding: '6px 10px', borderRadius: 4, fontSize: 12,
      marginTop: 6,
    }}>
      {children}
    </div>
  );
}

// Suppress unused-import warnings for helpers we may reach for in
// follow-up commits (e.g. version preview / diff).
void useMemo;
