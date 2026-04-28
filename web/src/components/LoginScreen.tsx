// Stage-1 login gate. Renders a centred card with username + password
// fields when the user hasn't passed `lib/auth.tryLogin`. Wraps the rest
// of the app via `<App>`'s auth check.
//
// Visual style matches the rest of the workspace (Resonate logo top, dark
// ink on yellow accent strip). Doesn't pretend to be a real auth flow —
// the placeholder copy "Stage-1 access · public preview" tells the user
// (and any code-reviewer) what they're looking at.

import { useState } from 'react';
import { tryLogin } from '../lib/auth';
import { Logo } from './Logo';

interface Props {
  /// Called after a successful login so the parent can re-render.
  onLogin(): void;
}

export function LoginScreen({ onLogin }: Props) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (tryLogin(username, password)) {
      setError(null);
      onLogin();
    } else {
      setError('Incorrect username or password.');
    }
  }

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--paper-2, #f8fafc)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 24, fontFamily: 'var(--font-sans, Inter, sans-serif)',
    }}>
      <form
        onSubmit={submit}
        style={{
          width: '100%', maxWidth: 360, background: '#fff',
          border: '1px solid var(--light, #e5e7eb)',
          borderRadius: 10, padding: '28px 28px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,0.08)',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}
      >
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
        <div style={{ fontSize: 13, color: 'var(--ink-soft, #475569)', lineHeight: 1.45 }}>
          Stage-1 access · public preview. Enter the shared credentials to continue.
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink, #1f2937)' }}>
          <span style={{ fontWeight: 600 }}>Username</span>
          <input
            type="text" autoComplete="username" autoFocus
            value={username} onChange={(e) => setUsername(e.target.value)}
            style={inputStyle}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--ink, #1f2937)' }}>
          <span style={{ fontWeight: 600 }}>Password</span>
          <input
            type="password" autoComplete="current-password"
            value={password} onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
          />
        </label>

        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.08)', color: 'var(--red, #dc2626)',
            padding: '8px 10px', borderRadius: 6, fontSize: 12,
          }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          style={{
            background: 'var(--ink, #1f2937)', color: '#fff', border: 'none',
            padding: '10px 14px', borderRadius: 6, fontSize: 14, fontWeight: 600,
            cursor: 'pointer', marginTop: 4,
          }}
        >Sign in</button>

        <div style={{ fontSize: 11, color: 'var(--ink-soft, #475569)', textAlign: 'center', marginTop: 6 }}>
          Need access? Contact <a href="mailto:innovation@resonate-consultants.com" style={{ color: 'inherit' }}>
            innovation@resonate-consultants.com
          </a>
        </div>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  border: '1px solid var(--light, #e5e7eb)',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 14,
  fontFamily: 'inherit',
  outline: 'none',
};
