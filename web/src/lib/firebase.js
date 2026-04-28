import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
// Fill these in once the Firebase project is created.
// In the meantime, the app falls back to mock data when `apiKey` is empty.
const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ?? '',
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN ?? '',
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ?? '',
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET ?? '',
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID ?? '',
    appId: import.meta.env.VITE_FIREBASE_APP_ID ?? '',
};
let app = null;
let _db = null;
let _storage = null;
export function isFirebaseConfigured() {
    return Boolean(firebaseConfig.apiKey);
}
export function getApp() {
    if (!app) {
        if (!isFirebaseConfigured()) {
            throw new Error('Firebase is not configured. Set VITE_FIREBASE_* env vars to connect.');
        }
        app = initializeApp(firebaseConfig);
    }
    return app;
}
export function db() {
    if (!_db)
        _db = getFirestore(getApp());
    return _db;
}
export function storage() {
    if (!_storage)
        _storage = getStorage(getApp());
    return _storage;
}
