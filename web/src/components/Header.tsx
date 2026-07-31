import { NavLink, useLocation } from 'react-router-dom';
import { Logo } from './Logo';
import { logout } from '../lib/auth';

interface Props {
  projectBreadcrumb?: string;
  /// I11: open the floating help window instead of navigating to /help.
  /// Absent on screens with nothing to stay on, where navigation is correct.
  onOpenHelp?(): void;
}

export function Header({ projectBreadcrumb, onOpenHelp }: Props) {
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
        {/* I11: a REAL anchor, so ctrl/middle-click opens the standalone
            /help route in a new tab natively. Plain left-click is intercepted
            to open the floating window instead, which keeps the project on
            screen. */}
        <a
          className="ic-btn"
          title="Help / user guide (ctrl-click for a new tab)"
          href="#/help"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
            if (!onOpenHelp) return;      // no handler here → let it navigate
            e.preventDefault();
            onOpenHelp();
          }}
        >?</a>
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
