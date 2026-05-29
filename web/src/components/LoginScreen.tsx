// Firebase auth gate. Renders three modes inside a single card:
//   - 'signin' (default): existing user signs in
//   - 'signup'          : new Resonate user creates an account
//   - 'forgot'          : send password-reset email
//
// The "waiting for email verification" and "blocked" follow-up states are
// rendered separately by App.tsx (see VerifyEmailScreen / BlockedScreen)
// because they're post-login screens, not part of the login form.

import { useState } from 'react';
import {
  RESONATE_DOMAIN,
  isResonateEmail,
  resendVerification,
  sendPasswordReset,
  signIn,
  signOut,
  signUp,
  type AuthState,
} from '../lib/auth';
import { Logo } from './Logo';

type Mode = 'signin' | 'signup' | 'forgot';

export function LoginScreen() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setInfo(null); setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email, password);
        // Successful sign-in: App's useAuthState picks it up automatically.
      } else if (mode === 'signup') {
        await signUp(email, password, displayName);
        setInfo(
          `Account created. We've sent a verification email to ${email.trim()}. ` +
          `Click the link, then sign in.`
        );
        setMode('signin');
      } else {
        await sendPasswordReset(email);
        setInfo(`If an account exists for ${email.trim()}, a reset link has been sent.`);
      }
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  const showName = mode === 'signup';
  const showPassword = mode !== 'forgot';
  const buttonLabel = mode === 'signin' ? 'Sign in'
    : mode === 'signup' ? 'Create account'
    : 'Send reset link';

  return (
    <Shell>
      <form onSubmit={submit} style={formStyle}>
        <HeaderBar />

        <div style={{ fontSize: 13, color: 'var(--ink-soft, #475569)', lineHeight: 1.45 }}>
          {mode === 'signin' && 'Sign in with your Resonate Consultants account.'}
          {mode === 'signup' && (
            <>Sign up with your <code>{RESONATE_DOMAIN}</code> email. We'll send you a verification link.</>
          )}
          {mode === 'forgot' && "Enter your email and we'll send a password-reset link."}
        </div>

        {showName && (
          <Field label="Your name">
            <input
              type="text" autoComplete="name" autoFocus
              value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              style={inputStyle}
            />
          </Field>
        )}

        <Field label="Email">
          <input
            type="email" autoComplete="email"
            autoFocus={!showName}
            value={email} onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
          />
          {mode === 'signup' && email && !isResonateEmail(email) && (
            <div style={hintStyle}>
              Must end in <code>{RESONATE_DOMAIN}</code>. External users must be
              invited — contact innovation@resonate-consultants.com.
            </div>
          )}
        </Field>

        {showPassword && (
          <Field label="Password">
            <input
              type="password"
              autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)}
              style={inputStyle}
              minLength={mode === 'signup' ? 8 : undefined}
            />
            {mode === 'signup' && (
              <div style={hintStyle}>Minimum 8 characters.</div>
            )}
          </Field>
        )}

        {error && <Banner kind="error">{error}</Banner>}
        {info && <Banner kind="info">{info}</Banner>}

        <button type="submit" style={primaryBtn} disabled={busy}>
          {busy ? 'Working…' : buttonLabel}
        </button>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 4 }}>
          {mode === 'signin' && (
            <>
              <LinkBtn onClick={() => { setMode('forgot'); setError(null); setInfo(null); }}>
                Forgot password?
              </LinkBtn>
              <LinkBtn onClick={() => { setMode('signup'); setError(null); setInfo(null); }}>
                Create account →
              </LinkBtn>
            </>
          )}
          {mode === 'signup' && (
            <LinkBtn onClick={() => { setMode('signin'); setError(null); setInfo(null); }}>
              ← Already have an account? Sign in
            </LinkBtn>
          )}
          {mode === 'forgot' && (
            <LinkBtn onClick={() => { setMode('signin'); setError(null); setInfo(null); }}>
              ← Back to sign in
            </LinkBtn>
          )}
        </div>
      </form>
    </Shell>
  );
}

// ===== Post-login screens =====

export function VerifyEmailScreen({ state }: { state: AuthState }) {
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const email = state.user?.email ?? '';

  async function resend() {
    setError(null); setInfo(null); setBusy(true);
    try {
      await resendVerification();
      setInfo(`Verification email re-sent to ${email}.`);
    } catch (err) {
      setError(prettyAuthError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <div style={formStyle}>
        <HeaderBar />
        <h2 style={{ margin: 0, fontSize: 18 }}>Verify your email</h2>
        <div style={{ fontSize: 13, color: 'var(--ink-soft, #475569)', lineHeight: 1.5 }}>
          We've sent a verification link to <strong>{email}</strong>.
          Click the link in that email, then refresh this page to continue.
        </div>
        {info && <Banner kind="info">{info}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        <button type="button" style={primaryBtn} onClick={() => window.location.reload()}>
          I've verified — refresh
        </button>
        <button type="button" style={secondaryBtn} onClick={resend} disabled={busy}>
          {busy ? 'Sending…' : 'Resend verification email'}
        </button>
        <LinkBtn onClick={() => void signOut()}>Sign out</LinkBtn>
      </div>
    </Shell>
  );
}

export function BlockedScreen({ state }: { state: AuthState }) {
  return (
    <Shell>
      <div style={formStyle}>
        <HeaderBar />
        <h2 style={{ margin: 0, fontSize: 18 }}>Awaiting approval</h2>
        <div style={{ fontSize: 13, color: 'var(--ink-soft, #475569)', lineHeight: 1.5 }}>
          Your account <strong>{state.user?.email}</strong> is verified but not
          yet on the BESSTY access list. Contact{' '}
          <a href="mailto:innovation@resonate-consultants.com" style={{ color: 'inherit' }}>
            innovation@resonate-consultants.com
          </a>{' '}
          to request access.
        </div>
        <LinkBtn onClick={() => void signOut()}>Sign out</LinkBtn>
      </div>
    </Shell>
  );
}

export function LoadingScreen() {
  return (
    <Shell>
      <div style={{ ...formStyle, alignItems: 'center' }}>
        <HeaderBar />
        <div style={{ fontSize: 13, color: 'var(--ink-soft, #475569)' }}>Loading…</div>
      </div>
    </Shell>
  );
}

// ===== Layout helpers =====

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--paper-2, #f8fafc)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, fontFamily: 'var(--font-sans, Inter, sans-serif)',
    }}>
      {children}
    </div>
  );
}

function HeaderBar() {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--ink, #1f2937)' }}>
        <Logo height={28} />
        <span style={{
          fontSize: 18, fontWeight: 700, letterSpacing: '-0.01em',
          color: 'var(--ink, #1f2937)',
        }}>BESSTY</span>
      </div>
      <div style={{
        height: 3, background: 'var(--yellow, #F2CB00)',
        borderRadius: 2, marginTop: -4,
      }} />
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink, #1f2937)' }}>
      <span style={{ fontWeight: 600 }}>{label}</span>
      {children}
    </label>
  );
}

function Banner({ kind, children }: { kind: 'error' | 'info'; children: React.ReactNode }) {
  const colors = kind === 'error'
    ? { bg: 'rgba(239, 68, 68, 0.08)', fg: 'var(--red, #dc2626)' }
    : { bg: 'rgba(16, 185, 129, 0.10)', fg: '#047857' };
  return (
    <div style={{
      background: colors.bg, color: colors.fg,
      padding: '8px 10px', borderRadius: 6, fontSize: 12, lineHeight: 1.4,
    }}>
      {children}
    </div>
  );
}

function LinkBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: 'none', border: 'none', padding: 0, margin: 0,
        color: 'var(--ink, #1f2937)', textDecoration: 'underline',
        cursor: 'pointer', fontSize: 12, fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

const formStyle: React.CSSProperties = {
  width: '100%', maxWidth: 380, background: '#fff',
  border: '1px solid var(--light, #e5e7eb)',
  borderRadius: 10, padding: '28px 28px 22px',
  boxShadow: '0 12px 40px rgba(0,0,0,0.08)',
  display: 'flex', flexDirection: 'column', gap: 14,
};

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--light, #e5e7eb)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};

const hintStyle: React.CSSProperties = {
  fontSize: 11, color: 'var(--ink-soft, #475569)', marginTop: 4, lineHeight: 1.4,
};

const primaryBtn: React.CSSProperties = {
  background: 'var(--ink, #1f2937)', color: '#fff', border: 'none',
  padding: '10px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600,
  cursor: 'pointer', marginTop: 4,
};

const secondaryBtn: React.CSSProperties = {
  background: '#fff', color: 'var(--ink, #1f2937)',
  border: '1px solid var(--light, #e5e7eb)',
  padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 500,
  cursor: 'pointer',
};

// ===== Error pretty-printing =====

function prettyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code;
  switch (code) {
    case 'auth/email-already-in-use':
      return 'An account with that email already exists. Try signing in instead.';
    case 'auth/invalid-email':
      return 'That doesn’t look like a valid email address.';
    case 'auth/weak-password':
      return 'Password is too weak. Use at least 8 characters.';
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
      return 'Incorrect email or password.';
    case 'auth/user-not-found':
      return 'No account found with that email.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact innovation@resonate-consultants.com.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a few minutes and try again.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return (err as Error)?.message ?? String(err);
  }
}
