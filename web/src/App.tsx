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
import { ShareViewerScreen } from './screens/ShareViewerScreen';
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

  // The share viewer is the ONE route that must render without an account, so
  // it is matched before the auth switch below — not inside it. Putting it in
  // the `allowed` branch would gate a public link behind sign-in, which is the
  // whole feature; putting it after the switch would still run the auth
  // machinery (and its Firestore profile read) for an anonymous reader.
  //
  // It is deliberately NOT wrapped in `<Header>` either: the header offers
  // navigation into the app, and a share reader has nowhere to go.
  //
  // `location.pathname` here is the HASH path — the app mounts a HashRouter so
  // GitHub Pages can serve deep links without an SPA fallback. A share URL is
  // therefore `…/#/share/<token>`, which has a useful side effect: a fragment
  // is never sent to a server, so the token stays out of access logs and out
  // of the Referer header entirely.
  //
  // Matched loosely — ANY /share/… path, not just a well-formed token — so a
  // truncated or mistyped link is answered by the viewer ("that link is not
  // valid") instead of falling through to a sign-in form. A client who was sent
  // a share has no account, and asking them to log in is the least useful
  // possible response to a copy-paste error. Validation still happens in the
  // viewer, before anything is looked up.
  const shareMatch = location.pathname.match(/^\/share\/(.*)$/);
  if (shareMatch) {
    return (
      <>
        <ShareViewerScreen token={shareMatch[1]} />
        <Notifications />
      </>
    );
  }

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
