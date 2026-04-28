import { useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import { LoginScreen } from './components/LoginScreen';
import { CatalogScreen } from './screens/CatalogScreen';
import { ProjectListScreen } from './screens/ProjectListScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { isAuthenticated } from './lib/auth';

export default function App() {
  // Stage-1 auth gate. Re-evaluated when the login screen calls
  // `setAuthed(true)`, so a successful login swaps to the app without a
  // page reload. localStorage persists the marker between refreshes.
  // Replace with real auth before exposing client data — see lib/auth.ts.
  const [authed, setAuthed] = useState(() => isAuthenticated());

  const location = useLocation();
  // Crumb shows on per-project routes only.
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const breadcrumb = projectMatch ? `Project · ${projectMatch[1]}` : undefined;

  if (!authed) {
    return <LoginScreen onLogin={() => setAuthed(true)} />;
  }

  return (
    <>
      <Header projectBreadcrumb={breadcrumb} />
      <Routes>
        <Route path="/" element={<Navigate to="/projects" replace />} />
        <Route path="/projects" element={<ProjectListScreen />} />
        <Route path="/projects/:projectId" element={<ProjectScreen />} />
        <Route path="/catalog" element={<CatalogScreen />} />
      </Routes>
    </>
  );
}
