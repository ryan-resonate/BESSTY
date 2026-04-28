import { NavLink, useLocation } from 'react-router-dom';
import { Logo } from './Logo';
import { logout } from '../lib/auth';

interface Props {
  projectBreadcrumb?: string;
}

export function Header({ projectBreadcrumb }: Props) {
  // Carry the current project id through to /catalog so the Local tab is
  // immediately scoped to that project.
  const location = useLocation();
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const projectId = projectMatch?.[1];
  const catalogTo = projectId ? `/catalog?project=${projectId}` : '/catalog';
  return (
    <header className="app-header">
      <div className="left">
        <Logo height={32} className="logo" title="Resonate Consultants" />
        <div className="pipe" />
        <h1>
          BESSTY <small>WTG + BESS Noise Modeller</small>
        </h1>
        {projectBreadcrumb && (
          <span
            style={{
              padding: '4px 10px',
              borderRadius: 99,
              border: '1.5px solid var(--ink)',
              background: 'var(--paper)',
              fontSize: 13,
              marginLeft: 8,
            }}
          >
            {projectBreadcrumb}
          </span>
        )}
      </div>

      <nav>
        <NavLink to="/projects" end className={({ isActive }) => (isActive ? 'active' : '')}>
          Projects
        </NavLink>
        <NavLink to={catalogTo} className={({ isActive }) => (isActive ? 'active' : '')}>
          Catalog
        </NavLink>
      </nav>

      <div className="header-right">
        <button className="ic-btn" title="Help" type="button">?</button>
        <button
          className="ic-btn"
          title="Sign out (Stage-1 placeholder auth)"
          type="button"
          onClick={() => { logout(); window.location.reload(); }}
        >
          ⎋
        </button>
      </div>
    </header>
  );
}
