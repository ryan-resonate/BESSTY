// Firebase SDK initialisation. Single source of truth for the `app`, `db`,
// `auth`, and (optional) `storage` / `analytics` clients.
//
// Lazy: clients are created on first use, so importing this module is free.
// `isFirebaseConfigured()` reports whether the VITE_FIREBASE_* env vars are
// set — currently used by the project-list screen to show a "DEV MODE"
// banner and fall back to localStorage. Once the full Firestore migration
// lands the fallback paths get removed and this becomes a hard error.
//
// `measurementId` is optional. When present, Google Analytics is loaded
// dynamically (so the analytics bundle doesn't bloat the main chunk) and
// only on browsers that actually support it.

import { initializeApp, type FirebaseOptions, type FirebaseApp } from 'firebase/app';
import { getAuth, type Auth } from 'firebase/auth';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
  measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

let app: FirebaseApp | null = null;
let _auth: Auth | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;
let analyticsLoaded = false;

export function isFirebaseConfigured(): boolean {
  return Boolean(firebaseConfig.apiKey);
}

export function getApp(): FirebaseApp {
  if (!app) {
    if (!isFirebaseConfigured()) {
      throw new Error(
        'Firebase is not configured. Set VITE_FIREBASE_* env vars to connect.'
      );
    }
    app = initializeApp(firebaseConfig);
    // Kick off Analytics on first app access — non-blocking, never throws.
    maybeLoadAnalytics();
  }
  return app;
}

export function auth(): Auth {
  if (!_auth) _auth = getAuth(getApp());
  return _auth;
}

export function db(): Firestore {
  if (!_db) _db = getFirestore(getApp());
  return _db;
}

export function storage(): FirebaseStorage {
  if (!_storage) _storage = getStorage(getApp());
  return _storage;
}

/// Is the page currently showing a public share link?
///
/// Read from `location.hash` rather than from the router, because this is
/// called during Firebase initialisation — before React has mounted — and it
/// must be right the first time.
function onShareRoute(): boolean {
  return typeof window !== 'undefined'
    && /^#\/share\//.test(window.location.hash);
}

function maybeLoadAnalytics() {
  if (analyticsLoaded) return;
  if (typeof window === 'undefined') return;
  if (!firebaseConfig.measurementId) return;
  // NEVER on a share route. The app uses a HashRouter, so a share URL carries
  // its token in the fragment — and GA4's automatic `page_view` reports
  // `page_location`, which is the FULL url including that fragment. Loading
  // analytics here would hand every live share token to Google, where it would
  // sit in an analytics property long after the share was withdrawn.
  //
  // The share viewer reaches Firebase (it reads one document), so this cannot
  // be solved by not initialising Firebase there.
  //
  // Residual, accepted: someone already inside the signed-in app who edits the
  // address bar into a share link has analytics loaded from the previous page.
  // The case this protects is the one that matters — a client opening a link
  // they were sent, in a fresh tab.
  if (onShareRoute()) return;
  analyticsLoaded = true;
  void import('firebase/analytics').then(async ({ getAnalytics, isSupported }) => {
    if (await isSupported()) {
      try { getAnalytics(getApp()); } catch { /* analytics is optional */ }
    }
  });
}
