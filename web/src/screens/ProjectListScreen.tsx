import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listProjects } from '../lib/projects';
import { isFirebaseConfigured } from '../lib/firebase';
import { createProject, deleteProject } from '../lib/storage';
import type { ProjectSummary } from '../lib/types';

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function ProjectListScreen() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  function refresh() {
    listProjects().then(setProjects).catch((e) => setError(String(e)));
  }

  useEffect(refresh, []);

  function handleNew() {
    const name = prompt('New project name', 'Untitled project');
    if (!name) return;
    const { id } = createProject(name.trim() || 'Untitled project');
    navigate(`/projects/${id}`);
  }

  function handleDelete(id: string, name: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!confirm(`Delete project "${name}"? This cannot be undone.`)) return;
    deleteProject(id);
    refresh();
  }

  return (
    <div className="project-list-screen">
      {!isFirebaseConfigured() && (
        <div className="banner">DEV MODE · MOCK DATA · CONFIGURE FIREBASE TO PERSIST</div>
      )}

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

      {error && (
        <div className="empty-state" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          Failed to load: {error}
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="empty-state">
          No projects yet. Create one to get started.
        </div>
      )}

      {projects && projects.length > 0 && (
        <div className="project-grid">
          {projects.map((p) => (
            <Link key={p.id} to={`/projects/${p.id}`} style={{ textDecoration: 'none' }}>
              <div className="project-card">
                <div className="name">{p.name}
                  <button
                    className="x-btn"
                    style={{ float: 'right' }}
                    title="Delete project"
                    onClick={(e) => handleDelete(p.id, p.name, e)}
                  >✕</button>
                </div>
                {p.description && <div className="description">{p.description}</div>}
                <div className="meta">
                  <span>{p.sourceCount ?? 0} sources</span>
                  <span>{p.receiverCount ?? 0} receivers</span>
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
