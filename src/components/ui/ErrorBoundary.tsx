// A React error boundary that reports the error and shows it with a retry button.

import { reportError } from '../../lib/telemetry';
import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    console.error(error);
    reportError(error, { kind: 'react', component: this.props.label ?? (info.componentStack ?? '').trim().split('\n')[0] });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="center-fill">
        <div className="conn-error">
          <div className="conn-error-title">Something went wrong{this.props.label ? ` in ${this.props.label}` : ''}</div>
          <pre>{String(this.state.error?.stack ?? this.state.error)}</pre>
          <button className="btn primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      </div>
    );
  }
}
