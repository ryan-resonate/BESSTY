import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { NavLink, useLocation } from 'react-router-dom';
export function Header({ projectBreadcrumb }) {
    // Carry the current project id through to /catalog so the Local tab is
    // immediately scoped to that project.
    const location = useLocation();
    const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
    const projectId = projectMatch?.[1];
    const catalogTo = projectId ? `/catalog?project=${projectId}` : '/catalog';
    return (_jsxs("header", { className: "app-header", children: [_jsxs("div", { className: "left", children: [_jsx("img", { className: "logo", src: "/ResonateLogo.svg", alt: "Resonate" }), _jsx("div", { className: "pipe" }), _jsxs("h1", { children: ["BEESTY ", _jsx("small", { children: "WTG + BESS Noise Modeller" })] }), projectBreadcrumb && (_jsx("span", { style: {
                            padding: '4px 10px',
                            borderRadius: 99,
                            border: '1.5px solid var(--ink)',
                            background: 'var(--paper)',
                            fontSize: 13,
                            marginLeft: 8,
                        }, children: projectBreadcrumb }))] }), _jsxs("nav", { children: [_jsx(NavLink, { to: "/projects", end: true, className: ({ isActive }) => (isActive ? 'active' : ''), children: "Projects" }), _jsx(NavLink, { to: catalogTo, className: ({ isActive }) => (isActive ? 'active' : ''), children: "Catalog" })] }), _jsxs("div", { className: "header-right", children: [_jsx("button", { className: "ic-btn", title: "Help", type: "button", children: "?" }), _jsx("div", { className: "ic-btn", title: "Account (auth not enabled)", style: { background: 'var(--paper-2)', cursor: 'default' }, children: "\u2014" })] })] }));
}
