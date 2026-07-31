import { useState } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Header } from './components/Header';
import {
  BlockedScreen,
  LoadingScreen,
  LoginScreen,
  VerifyEmailScreen,
} from './components/LoginScreen';
import { Notifications } from './components/Notifications';
import { HelpWindow } from './components/HelpWindow';
import { CatalogScreen } from './screens/CatalogScreen';
import { HelpScreen } from './screens/HelpScreen';
import { ProjectListScreen } from './screens/ProjectListScreen';
import { ProjectScreen } from './screens/ProjectScreen';
import { useAuthState } from './lib/auth';

export default function App() {
  // I11: help opens as a floating window over whatever you're doing.
  const [helpOpen, setHelpOpen] = useState(false);
  // Reactive Firebase auth + profile state. Re-renders the tree any time
  // the user signs in/out, verifies their email, or has their profile
  // doc updated (e.g. an admin flips `allowed = true`).
  const authState = useAuthState();

  const location = useLocation();
  // Crumb shows on per-project routes only.
  const projectMatch = location.pathname.match(/^\/projects\/([^/]+)/);
  const breadcrumb = projectMatch ? `Project · ${projectMatch[1]}` : undefined;

  function screen() {
    switch (authState.status) {
      case 'loading':    return <LoadingScreen />;
      case 'unauthed':   return <LoginScreen />;
      case 'unverified': return <VerifyEmailScreen state={authState} />;
      case 'blocked':    return <BlockedScreen state={authState} />;
      case 'allowed':    break;
    }
    return (
      <>
        <Header projectBreadcrumb={breadcrumb} onOpenHelp={() => setHelpOpen(true)} />
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectListScreen />} />
          <Route path="/projects/:projectId" element={<ProjectScreen />} />
          <Route path="/catalog" element={<CatalogScreen />} />
          <Route path="/help" element={<HelpScreen />} />
        </Routes>
      </>
    );
  }

  // Mounted OUTSIDE the auth switch: a sign-in or Firestore failure needs to be
  // able to raise a toast just as much as an in-app action does, and the
  // imperative `notify.*` API silently no-ops if no provider is listening.
  return (
    <>
      {screen()}
      {helpOpen && <HelpWindow onClose={() => setHelpOpen(false)} />}
      <Notifications />
    </>
  );
}
