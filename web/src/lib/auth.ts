// **Stage-1 placeholder authentication.**
//
// Hardcoded shared credentials gated behind a localStorage flag. This is
// NOT real security — the credentials are visible to anyone who opens the
// dev tools, and the localStorage flag is trivially set by anyone with
// console access. The intent is purely to keep casual visitors out of the
// public GitHub Pages preview while we wire up the real auth layer
// (Firebase / Auth0 / Cloudflare Access — TBD).
//
// Replace this entire module before exposing real client data. The
// LoginScreen consumer just imports `isAuthenticated` / `tryLogin` /
// `logout`, so the swap-in is mechanical.

const STORAGE_KEY = 'bessty.auth.session';
const SHARED_USERNAME = 'Resonate';
const SHARED_PASSWORD = 'Resonate';

/// Has the user passed the login gate this session?
export function isAuthenticated(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'ok';
  } catch {
    return false;
  }
}

/// Validate credentials and persist the session marker on success. Returns
/// true on success, false on bad credentials. Case-insensitive on both
/// fields — the user types "resonate" and we accept it.
export function tryLogin(username: string, password: string): boolean {
  const u = username.trim().toLowerCase();
  const p = password;     // password match is case-sensitive intentionally
  if (u === SHARED_USERNAME.toLowerCase() && p === SHARED_PASSWORD) {
    try { localStorage.setItem(STORAGE_KEY, 'ok'); } catch { /* fail-open */ }
    return true;
  }
  return false;
}

/// Clear the session marker. UI can call this from a "Sign out" button.
export function logout() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
}
