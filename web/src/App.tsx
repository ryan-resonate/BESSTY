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
