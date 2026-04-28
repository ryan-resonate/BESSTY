import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { CatalogScreen } from './screens/CatalogScreen';
import { ProjectListScreen } from './screens/ProjectListScreen';
import { ProjectScreen } from './screens/ProjectScreen';
export default function App() {
    const location = useLocation();
    // Crumb shows on per-project routes only.
    const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
    const breadcrumb = projectMatch ? `Project · ${projectMatch[1]}` : undefined;
    return (_jsxs(_Fragment, { children: [_jsx(Header, { projectBreadcrumb: breadcrumb }), _jsxs(Routes, { children: [_jsx(Route, { path: "/", element: _jsx(Navigate, { to: "/projects", replace: true }) }), _jsx(Route, { path: "/projects", element: _jsx(ProjectListScreen, {}) }), _jsx(Route, { path: "/projects/:projectId", element: _jsx(ProjectScreen, {}) }), _jsx(Route, { path: "/catalog", element: _jsx(CatalogScreen, {}) })] })] }));
}
