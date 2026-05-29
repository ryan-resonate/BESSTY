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
import { Link, useNavigate } from 'react-router-dom';
import { useAuthState } from '../lib/auth';
import {
  createProject,
  deleteProject,
  subscribeToAllAccessibleProjects,
  subscribeToMyProjects,
  type ProjectListItem,
} from '../lib/firestoreProjects';

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
    const name = prompt('New project name', 'Untitled project');
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
    if (!confirm(`Delete project "${item.name}"? This cannot be undone.`)) return;
    try {
      await deleteProject(item.id);
    } catch (err) {
      setError((err as Error).message);
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
          {tab === 'mine'
            ? "You haven't created any projects yet."
            : 'No projects you can see yet — create one to get started.'}
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
