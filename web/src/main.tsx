import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import App from './App';
import './styles.css';

// HashRouter (URLs look like `/#/projects/foo`) instead of BrowserRouter
// because GitHub Pages only serves static files — a deep BrowserRouter URL
// like `/repo/projects/foo` would 404 on a hard refresh since the server
// doesn't know to fall back to `index.html`. HashRouter keeps the path in
// the URL fragment (`#/...`) which the server never sees, so reloads,
// shareable links, and the back button all just work.
//
// If/when this app moves off GH Pages onto a host that supports SPA
// fallback (Cloudflare Pages, Netlify, S3 + CloudFront), swap back to
// `BrowserRouter` for cleaner URLs.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </React.StrictMode>
);
