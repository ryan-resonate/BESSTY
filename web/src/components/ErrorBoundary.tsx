// React error boundary — catches render-time exceptions in a subtree and
// shows the message + stack inline instead of letting the whole app blank
// out. Wrap the SidePanel, MapView, etc. so a single bad receiver / bad
// catalog entry can't take down the entire workspace.

import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /// Short label shown above the error message ("Side panel", "Map", …).
  /// Helps the user (and us) identify which subtree failed.
  region: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Log to the console with full stack — useful when the user has
    // devtools open and reports the issue.
    // eslint-disable-next-line no-console
    console.error(`[BESSTY ErrorBoundary · ${this.props.region}]`, error, info);
    this.setState({ info });
  }

  reset = () => this.setState({ error: null, info: null });

  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 12, margin: 8, border: '1px solid var(--red)',
          borderRadius: 4, background: 'rgba(239, 68, 68, 0.08)',
          fontFamily: 'var(--font-mono, monospace)', fontSize: 12,
          color: 'var(--ink)',
        }}>
          <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--red)' }}>
            ⚠ {this.props.region} crashed
          </div>
          <div style={{ marginBottom: 6 }}>
            {this.state.error.message || String(this.state.error)}
          </div>
          {this.state.error.stack && (
            <details>
              <summary style={{ cursor: 'pointer', color: 'var(--ink-soft)' }}>Stack trace</summary>
              <pre style={{ whiteSpace: 'pre-wrap', fontSize: 10, marginTop: 6 }}>
                {this.state.error.stack}
              </pre>
            </details>
          )}
          <button
            className="btn small" style={{ marginTop: 8 }}
            onClick={this.reset}
          >Try again</button>
        </div>
      );
    }
    return this.props.children;
  }
}
