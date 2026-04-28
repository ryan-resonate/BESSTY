import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { listProjects } from '../lib/projects';
import { isFirebaseConfigured } from '../lib/firebase';
import { createProject, deleteProject } from '../lib/storage';
function formatRelative(iso) {
    const then = new Date(iso).getTime();
    const now = Date.now();
    const diffMs = now - then;
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
export function ProjectListScreen() {
    const [projects, setProjects] = useState(null);
    const [error, setError] = useState(null);
    const navigate = useNavigate();
    function refresh() {
        listProjects().then(setProjects).catch((e) => setError(String(e)));
    }
    useEffect(refresh, []);
    function handleNew() {
        const name = prompt('New project name', 'Untitled project');
        if (!name)
            return;
        const { id } = createProject(name.trim() || 'Untitled project');
        navigate(`/projects/${id}`);
    }
    function handleDelete(id, name, e) {
        e.preventDefault();
        e.stopPropagation();
        if (!confirm(`Delete project "${name}"? This cannot be undone.`))
            return;
        deleteProject(id);
        refresh();
    }
    return (_jsxs("div", { className: "project-list-screen", children: [!isFirebaseConfigured() && (_jsx("div", { className: "banner", children: "DEV MODE \u00B7 MOCK DATA \u00B7 CONFIGURE FIREBASE TO PERSIST" })), _jsxs("div", { className: "page-header", children: [_jsxs("div", { children: [_jsx("h2", { children: "Projects" }), _jsx("div", { className: "subtitle", children: projects ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : 'Loading…' })] }), _jsx("button", { className: "btn primary", type: "button", onClick: handleNew, children: "+ New project" })] }), error && (_jsxs("div", { className: "empty-state", style: { borderColor: 'var(--red)', color: 'var(--red)' }, children: ["Failed to load: ", error] })), projects && projects.length === 0 && (_jsx("div", { className: "empty-state", children: "No projects yet. Create one to get started." })), projects && projects.length > 0 && (_jsx("div", { className: "project-grid", children: projects.map((p) => (_jsx(Link, { to: `/projects/${p.id}`, style: { textDecoration: 'none' }, children: _jsxs("div", { className: "project-card", children: [_jsxs("div", { className: "name", children: [p.name, _jsx("button", { className: "x-btn", style: { float: 'right' }, title: "Delete project", onClick: (e) => handleDelete(p.id, p.name, e), children: "\u2715" })] }), p.description && _jsx("div", { className: "description", children: p.description }), _jsxs("div", { className: "meta", children: [_jsxs("span", { children: [p.sourceCount ?? 0, " sources"] }), _jsxs("span", { children: [p.receiverCount ?? 0, " receivers"] }), _jsxs("span", { children: ["updated ", formatRelative(p.updatedAt)] })] })] }) }, p.id))) }))] }));
}
