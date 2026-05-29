import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Logo } from './Logo';
import { logout } from '../lib/auth';

interface Props {
  projectBreadcrumb?: string;
}

export function Header({ projectBreadcrumb }: Props) {
  // Carry the current project id through to /catalog so the Local tab is
  // immediately scoped to that project.
  const location = useLocation();
  const navigate = useNavigate();
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
        {/* Tiny build identifier. Stamped at build time from the git short
            SHA + UTC build date (see vite.config.ts `define`). Renders as
            subtle gray monospace text so it's findable but never demands
            attention. Tooltip carries the full string for support / bug
            reporting purposes. */}
        <span
          title={`Build ${__APP_VERSION_SHA__} · ${__APP_VERSION_DATE__}`}
          style={{
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
            color: 'var(--mid)',
            opacity: 0.55,
            marginRight: 8,
            userSelect: 'text',
            cursor: 'default',
            whiteSpace: 'nowrap',
          }}
        >
          {__APP_VERSION_SHA__} · {__APP_VERSION_DATE__}
        </span>
        <button
          className="ic-btn"
          title="Help / user guide"
          type="button"
          onClick={() => navigate('/help')}
        >?</button>
        <button
          className="ic-btn"
          title="Sign out"
          type="button"
          onClick={() => { logout(); }}
        >
          ⎋
        </button>
      </div>
    </header>
  );
}
