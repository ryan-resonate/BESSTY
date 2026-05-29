// Firebase Auth wrapper + reactive user-profile state.
//
// Single source of truth for "who's signed in" across the app. Exposes a
// React hook (`useAuthState`) and a handful of imperative actions
// (signup / signin / signout / verify / password reset).
//
// Access policy (enforced both client-side here and, eventually, server-side
// via a Cloud Function `onUserCreate` trigger):
//   1. Anyone with an `@resonate-consultants.com` email may sign up.
//   2. Anyone else must be on the `authAllowlist` Firestore collection
//      (only admins can add entries). Until the Cloud Function ships,
//      we enforce (1) client-side only — non-Resonate signups are
//      rejected at the form, but a determined user with the SDK could
//      still create an account. That's OK as a stage; the Cloud
//      Function adds the server-side gate.
//
// Profile docs live at `users/{uid}` and are created the first time a
// verified user signs in. The `allowed` field decides whether they're
// admitted to the app; `flags.admin` (set manually in the Firebase
// Console for the bootstrap admin) gates the future admin UI.

import { useEffect, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  updateProfile,
  type User as FirebaseUser,
} from 'firebase/auth';
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth as fbAuth, db as fbDb } from './firebase';

export const RESONATE_DOMAIN = '@resonate-consultants.com';

export function isResonateEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(RESONATE_DOMAIN);
}

export interface UserFlags {
  admin?: boolean;
}

export interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  createdAt: string;       // ISO 8601 (server-set on creation)
  emailVerified: boolean;
  allowed: boolean;
  flags: UserFlags;
}

export type AuthStatus =
  | 'loading'      // initial — waiting for the first onAuthStateChanged tick
  | 'unauthed'    // no signed-in firebase user
  | 'unverified'  // signed in, but emailVerified === false
  | 'allowed'     // signed in, verified, profile.allowed === true
  | 'blocked';    // signed in, verified, but profile.allowed === false

export interface AuthState {
  status: AuthStatus;
  user: FirebaseUser | null;
  profile: UserProfile | null;
}

// --- Hook -----------------------------------------------------------------

/// Subscribe to the auth + profile state. Always returns immediately; the
/// initial render is in `loading` state until Firebase fires the first
/// `onAuthStateChanged` event (single round-trip on app load).
export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({
    status: 'loading', user: null, profile: null,
  });

  useEffect(() => {
    let profileUnsub: (() => void) | null = null;

    const authUnsub = onAuthStateChanged(fbAuth(), async (user) => {
      // Tear down any previous profile listener — a sign-out, a sign-in as
      // a different user, or a token refresh all land here.
      if (profileUnsub) { profileUnsub(); profileUnsub = null; }

      if (!user) {
        setState({ status: 'unauthed', user: null, profile: null });
        return;
      }

      // Refresh the user record from the server in case `emailVerified` was
      // flipped in another tab (verification clicked in a different window).
      try { await user.reload(); } catch { /* offline — fall through */ }

      if (!user.emailVerified) {
        setState({ status: 'unverified', user, profile: null });
        return;
      }

      // First-verified-signin path: ensure the profile doc exists.
      await ensureProfileDoc(user);

      // Subscribe to live updates on the profile (admin promotion, allowlist
      // flips by Cloud Function, etc.).
      profileUnsub = onSnapshot(doc(fbDb(), 'users', user.uid), (snap) => {
        const profile = snap.exists() ? snapToProfile(user, snap.data()) : null;
        if (!profile) {
          setState({ status: 'unverified', user, profile: null });
          return;
        }
        setState({
          status: profile.allowed ? 'allowed' : 'blocked',
          user, profile,
        });
      });
    });

    return () => {
      authUnsub();
      if (profileUnsub) profileUnsub();
    };
  }, []);

  return state;
}

function snapToProfile(user: FirebaseUser, d: any): UserProfile {
  return {
    uid: user.uid,
    email: user.email ?? d.email ?? '',
    displayName: user.displayName ?? d.displayName ?? '',
    createdAt: d.createdAt?.toDate?.().toISOString?.() ?? d.createdAt ?? '',
    emailVerified: user.emailVerified,
    allowed: d.allowed === true,
    flags: d.flags ?? {},
  };
}

async function ensureProfileDoc(user: FirebaseUser): Promise<void> {
  const ref = doc(fbDb(), 'users', user.uid);
  const snap = await getDoc(ref);
  if (snap.exists()) return;
  // First-verified-signin: write the profile. `allowed` is set based on
  // the email-domain check. Cloud Function (when present) will overwrite
  // this with the allowlist-aware value.
  //
  // `flags.admin` is written explicitly as `false` (rather than an empty
  // `flags: {}`) so the field is visible in the Firebase Console — that
  // makes the manual bootstrap-admin step (flip the field to `true`)
  // a one-click change instead of "add new field, type map, add child
  // field admin, type bool, value true".
  const email = (user.email ?? '').trim();
  await setDoc(ref, {
    email: email.toLowerCase(),  // canonical-case so "Add by email" lookups match
    displayName: user.displayName ?? email.split('@')[0],
    createdAt: serverTimestamp(),
    allowed: isResonateEmail(email),
    flags: { admin: false },
  });
}

// --- Imperative actions ---------------------------------------------------

/// Create a new Firebase user and send the verification email. The display
/// name is written to the Firebase Auth profile and mirrored into the
/// Firestore user doc on first verified sign-in.
export async function signUp(
  email: string, password: string, displayName: string,
): Promise<void> {
  const trimmed = email.trim();
  if (!isResonateEmail(trimmed)) {
    // Stage-1 gate: until the Cloud Function lands, only Resonate emails
    // can self-serve. External users get a clear "contact us" message.
    throw new Error(
      `Self-signup is currently limited to ${RESONATE_DOMAIN} accounts. ` +
      `Contact innovation@resonate-consultants.com to request access.`
    );
  }
  const cred = await createUserWithEmailAndPassword(fbAuth(), trimmed, password);
  if (displayName.trim()) {
    await updateProfile(cred.user, { displayName: displayName.trim() });
  }
  await sendEmailVerification(cred.user);
}

export async function signIn(email: string, password: string): Promise<void> {
  await signInWithEmailAndPassword(fbAuth(), email.trim(), password);
}

export async function signOut(): Promise<void> {
  await fbSignOut(fbAuth());
}

export async function resendVerification(): Promise<void> {
  const u = fbAuth().currentUser;
  if (!u) throw new Error('Not signed in');
  await sendEmailVerification(u);
}

export async function sendPasswordReset(email: string): Promise<void> {
  await sendPasswordResetEmail(fbAuth(), email.trim());
}

// --- Synchronous accessors (for non-React paths) --------------------------

export function getCurrentUid(): string | null {
  return fbAuth().currentUser?.uid ?? null;
}

// --- Legacy shims ---------------------------------------------------------
// The old placeholder `lib/auth.ts` exported `isAuthenticated`, `tryLogin`,
// and `logout`. Keep `logout` as a no-arg shim so existing Header code
// doesn't break during the migration window. `isAuthenticated` / `tryLogin`
// are gone — use `useAuthState` / `signIn` instead.
export function logout(): void {
  void signOut();
}
