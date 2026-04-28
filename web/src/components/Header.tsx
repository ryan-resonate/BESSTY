import { NavLink } from 'react-router-dom';

interface Props {
  projectBreadcrumb?: string;
}

export function Header({ projectBreadcrumb }: Props) {
  return (
    <header className="app-header">
      <div className="left">
        <img className="logo" src="/ResonateLogo.svg" alt="Resonate" />
        <div className="pipe" />
        <h1>
          BEESTY <small>WTG + BESS Noise Modeller</small>
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
        <NavLink to="/catalog" className={({ isActive }) => (isActive ? 'active' : '')}>
          Catalog
        </NavLink>
      </nav>

      <div className="header-right">
        <button className="ic-btn" title="Help" type="button">?</button>
        <div
          className="ic-btn"
          title="Account (auth not enabled)"
          style={{ background: 'var(--paper-2)', cursor: 'default' }}
        >
          —
        </div>
      </div>
    </header>
  );
}
