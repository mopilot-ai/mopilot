// Code-split pages and panels: a named export loaded on first render, an empty fallback (the chunk is a local file, so a spinner would only flash), and a retry card when the chunk fails to load.
import { Component, createElement, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
import { reportError } from './telemetry';

/** Catches a failed chunk load: the card's button remounts the page with a fresh import (React caches a rejected lazy for good). */
class LoadBoundary extends Component<{ label: string; onRetry: () => void; children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    reportError(error, { kind: 'chunk-load', component: this.props.label });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-fill">
        <div className="conn-error">
          <div className="conn-error-title">Couldn't load {this.props.label}</div>
          <button
            className="btn primary"
            onClick={() => {
              this.props.onRetry();
              this.setState({ failed: false });
            }}
          >
            Try again
          </button>
        </div>
      </div>
    );
  }
}

/**
 * A component loaded on first use. `load` imports its module, `pick` takes the component from it. A failed import shows a
 * retry card in the component's place and imports again when pressed.
 */
export function lazyPage<M, P extends object>(label: string, load: () => Promise<M>, pick: (m: M) => ComponentType<P>): ComponentType<P> {
  const make = (): LazyExoticComponent<ComponentType<P>> => lazy(() => load().then((m) => ({ default: pick(m) })));
  let Inner = make();
  return function LazyPage(props: P) {
    // a retry swaps in a fresh lazy and renders this page again so its children use it
    const [, setAttempt] = useState(0);
    return createElement(
      LoadBoundary,
      {
        label,
        onRetry: () => {
          Inner = make();
          setAttempt((n) => n + 1);
        },
      },
      createElement(Suspense, { fallback: null }, createElement(Inner as ComponentType<P>, props)),
    );
  };
}
