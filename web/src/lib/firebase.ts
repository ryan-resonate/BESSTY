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

function maybeLoadAnalytics() {
  if (analyticsLoaded) return;
  if (typeof window === 'undefined') return;
  if (!firebaseConfig.measurementId) return;
  analyticsLoaded = true;
  void import('firebase/analytics').then(async ({ getAnalytics, isSupported }) => {
    if (await isSupported()) {
      try { getAnalytics(getApp()); } catch { /* analytics is optional */ }
    }
  });
}
