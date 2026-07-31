// Project list — top-level landing screen after sign-in.
//
// Two live tabs:
//   - "All projects"  : everything I can read (public + mine + shared-to-me),
//                       merged from three Firestore queries.
//   - "My projects"   : just the ones I own.
//
// Reads are live (`onSnapshot`), so a project edited or created by a
// collaborator shows up here without a refresh.
//
// Empty-list affordances:
//   - First-time users see "No projects yet — Create one to get started".
//   - Admin users additionally see a "Seed example projects" hint that
//     points at the future seeding flow (task #12).

import { useEffect, useState } from 'react';
import { notify } from '../lib/notify';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthState } from '../lib/auth';
import {
  createProject,
  deleteProject,
  getProject,
  subscribeToAllAccessibleProjects,
  subscribeToMyProjects,
  type ProjectListItem,
} from '../lib/firestoreProjects';
import { deleteProjectDem } from '../lib/firestoreStorage';
import { seedExampleProjects } from '../lib/firestoreSeed';

type Tab = 'all' | 'mine';

function formatRelative(d: Date): string {
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return 'just now';
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export function ProjectListScreen() {
  const auth = useAuthState();
  const myUid = auth.user?.uid;
  const navigate = useNavigate();

  const [tab, setTab] = useState<Tab>('all');
  const [projects, setProjects] = useState<ProjectListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seeding, setSeeding] = useState(false);

  const isAdmin = auth.profile?.flags?.admin === true;

  // Live subscription. Re-runs when the tab or signed-in user changes.
  useEffect(() => {
    if (!myUid) return;
    setProjects(null);
    setError(null);
    const onItems = (items: ProjectListItem[]) => setProjects(items);
    const onError = (err: Error) => setError(err.message);
    const unsub = tab === 'mine'
      ? subscribeToMyProjects(myUid, onItems, onError)
      : subscribeToAllAccessibleProjects(myUid, onItems, onError);
    return () => unsub();
  }, [tab, myUid]);

  async function handleNew() {
    if (!auth.user || !auth.profile) return;
    const name = await notify.prompt({
      title: 'New project',
      label: 'Project name',
      defaultValue: 'Untitled project',
      confirmLabel: 'Create',
    });
    if (!name) return;
    try {
      const id = await createProject(name.trim() || 'Untitled project', {}, {
        uid: auth.user.uid,
        displayName: auth.profile.displayName || auth.user.email || 'Unknown',
        email: auth.user.email ?? '',
      });
      navigate(`/projects/${id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleDelete(item: ProjectListItem, e: React.MouseEvent) {
    e.preventDefault(); e.stopPropagation();
    const ok = await notify.confirm({
      title: `Delete project "${item.name}"?`,
      body: 'This cannot be undone.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      // Best-effort: clean up the project's Firebase Storage objects
      // BEFORE deleting the Firestore doc. The Storage rules gate this
      // on having edit access to the project, so once the doc is gone
      // the storage delete would be denied. A Blaze Cloud Function
      // (functions/src/index.ts onProjectDelete -- TODO when on Blaze)
      // would handle this server-side independently of the rule check.
      try {
        const full = await getProject(item.id);
        if (full?.dem?.storagePath) {
          await deleteProjectDem(full.dem.storagePath);
        }
      } catch (cleanupErr) {
        // Storage cleanup failed (offline, permission issue, race) -- log
        // and continue with the project delete. Orphan storage objects
        // are a leak we can clean up out-of-band; not worth blocking
        // the user's primary intent.
        // eslint-disable-next-line no-console
        console.warn('[BESSTY] failed to clean up project Storage objects:', cleanupErr);
      }
      await deleteProject(item.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function handleSeed() {
    if (!auth.user || !auth.profile) return;
    const ok = await notify.confirm({
      title: 'Add the example projects to the cloud?',
      body: 'GP BESS + Tarong WF will be created as public projects owned by '
        + 'you, visible to every signed-in BESSTY user.',
      confirmLabel: 'Add examples',
    });
    if (!ok) return;
    setSeeding(true); setError(null);
    try {
      await seedExampleProjects({
        uid: auth.user.uid,
        displayName: auth.profile.displayName || auth.user.email || 'Unknown',
        email: auth.user.email ?? '',
      });
      // Live subscription will pick up the new docs automatically.
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSeeding(false);
    }
  }

  return (
    <div className="project-list-screen">
      <div className="page-header">
        <div>
          <h2>Projects</h2>
          <div className="subtitle">
            {projects ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : 'Loading…'}
          </div>
        </div>
        <button className="btn primary" type="button" onClick={handleNew}>
          + New project
        </button>
      </div>

      <div role="tablist" style={{
        display: 'flex', gap: 4, borderBottom: '1px solid var(--light, #e5e7eb)',
        marginBottom: 16,
      }}>
        <TabBtn active={tab === 'all'}  onClick={() => setTab('all')}>All projects</TabBtn>
        <TabBtn active={tab === 'mine'} onClick={() => setTab('mine')}>My projects</TabBtn>
      </div>

      {error && (
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Failed to load: {error}
        </div>
      )}

      {projects && projects.length === 0 && !error && (
        <div className="empty-state">
          <div>
            {tab === 'mine'
              ? "You haven't created any projects yet."
              : 'No projects you can see yet — create one to get started.'}
          </div>
          {isAdmin && tab === 'all' && (
            <div style={{ marginTop: 12 }}>
              <button
                className="btn"
                type="button"
                onClick={handleSeed}
                disabled={seeding}
              >
                {seeding ? 'Seeding…' : 'Seed example projects (admin)'}
              </button>
              <div style={{ fontSize: 12, color: 'var(--ink-soft, #475569)', marginTop: 6 }}>
                Adds GP BESS + Tarong WF as public projects owned by you.
                One-time setup; every user will see them in "All projects".
              </div>
            </div>
          )}
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} style={{ textDecoration: 'none' }}>
              <div className="project-card">
                <div className="name">
                  {p.visibility === 'private' && (
                    <span title="Private — only the owner and invited users can see this"
                      style={{ marginRight: 6, color: 'var(--ink-soft, #475569)' }}>🔒</span>
                  )}
                  {p.name}
                  {p.ownerUid === myUid && (
                    <button
                      className="x-btn"
                      style={{ float: 'right' }}
                      title="Delete project"
                      onClick={(e) => handleDelete(p, e)}
                    >✕</button>
                  )}
                </div>
                {p.description && <div className="description">{p.description}</div>}
                <div className="meta">
                  <span title={`Owner: ${p.ownerDisplayName}`}>
                    {p.ownerUid === myUid ? 'You' : p.ownerDisplayName}
                  </span>
                  <span>{p.sourceCount} source{p.sourceCount === 1 ? '' : 's'}</span>
                  <span>{p.receiverCount} receiver{p.receiverCount === 1 ? '' : 's'}</span>
                  <span>updated {formatRelative(p.updatedAt)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: {
  active: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      style={{
        background: 'none', border: 'none', padding: '8px 14px',
        fontSize: 13, fontWeight: 600, cursor: 'pointer',
        color: active ? 'var(--ink, #1f2937)' : 'var(--ink-soft, #475569)',
        borderBottom: active
          ? '2px solid var(--yellow, #F2CB00)'
          : '2px solid transparent',
        marginBottom: -1,
      }}
    >
      {children}
    </button>
  );
}
