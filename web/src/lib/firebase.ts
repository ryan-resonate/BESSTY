import { initializeApp, type FirebaseOptions, type FirebaseApp } from 'firebase/app';
import { getFirestore, type Firestore } from 'firebase/firestore';
import { getStorage, type FirebaseStorage } from 'firebase/storage';

// Fill these in once the Firebase project is created.
// In the meantime, the app falls back to mock data when `apiKey` is empty.
const firebaseConfig: FirebaseOptions = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
  appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};

let app: FirebaseApp | null = null;
let _db: Firestore | null = null;
let _storage: FirebaseStorage | null = null;

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
  }
  return app;
}

export function db(): Firestore {
  if (!_db) _db = getFirestore(getApp());
  return _db;
}

export function storage(): FirebaseStorage {
  if (!_storage) _storage = getStorage(getApp());
  return _storage;
}
