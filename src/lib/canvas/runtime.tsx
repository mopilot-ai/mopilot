// This entrypoint is bundled as text and executes only inside the opaque canvas iframe, never with the app preload.
import * as React from 'react';
import * as jsxRuntime from 'react/jsx-runtime';
import { createRoot } from 'react-dom/client';
import * as components from './components';
import * as controls from './controls';
import * as charts from './charts';
import * as theme from './theme';
import { CanvasContext, canvasEnvironment, useCanvasAction, useCanvasState, useHostTheme, type CanvasMessage } from './context';

const sdk = Object.freeze({ ...components, ...controls, ...charts, ...theme, useCanvasAction, useCanvasState, useHostTheme });
export function canvasRequire(name: string) {
  if (name === 'react') return React;
  if (name === 'react/jsx-runtime') return jsxRuntime;
  if (name === 'cursor/canvas')
    return new Proxy(sdk, {
      get(target, key) {
        if (key === '__esModule') return true;
        if (typeof key === 'string' && Object.hasOwn(target, key)) return target[key as keyof typeof sdk];
        throw Error(`This canvas uses an unsupported component: ${String(key)}.`);
      },
    });
  throw Error(`This canvas imports an unavailable module: ${name}. Use a self-contained HTML artifact for additional libraries.`);
}
export function canvasRuntime(host: Window, root: HTMLElement, input: { id: string; dark: boolean; state: Record<string, unknown> }) {
  const publish = (message: CanvasMessage) => host.parent.postMessage({ ...message, channel: 'mopilot-canvas', id: input.id }, '*');
  const environment = canvasEnvironment(input.dark, input.state, publish);
  let failed = false;
  const failure = () => {
    failed = true;
    publish({ type: 'error' });
  };
  const notice = (event: ErrorEvent | PromiseRejectionEvent) => {
    event.preventDefault();
    failure();
  };
  host.addEventListener('error', notice);
  host.addEventListener('unhandledrejection', notice);
  const restore = (event: MessageEvent) => {
    const data = event.data;
    if (event.source !== host.parent || !data || data.channel !== 'mopilot-canvas' || data.id !== input.id || data.type !== 'restore')
      return;
    if (
      !data.state ||
      typeof data.state !== 'object' ||
      Array.isArray(data.state) ||
      !Number.isSafeInteger(data.revision) ||
      data.revision < 0 ||
      !Number.isSafeInteger(data.acknowledged) ||
      data.acknowledged < 0
    )
      return;
    environment.restore(data.state, data.revision, data.acknowledged);
  };
  host.addEventListener('message', restore);
  class Boundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() {
      return { failed: true };
    }
    componentDidCatch() {
      failure();
    }
    render() {
      return this.state.failed ? (
        <p role="alert">This canvas could not be rendered. View the source to inspect it or ask the agent to repair it.</p>
      ) : (
        this.props.children
      );
    }
  }
  function Ready({ component: Component }: { component: React.ElementType }) {
    const revision = React.useSyncExternalStore(environment.subscribe, environment.revision);
    React.useEffect(() => {
      if (!failed) publish(revision < 0 ? { type: 'booted' } : { type: 'ready', revision });
    }, [revision]);
    return <Component />;
  }
  const reactRoot = createRoot(root);
  return {
    React,
    require: canvasRequire,
    mount(component: React.ElementType) {
      if (!component || !['function', 'object'].includes(typeof component)) throw Error('A canvas must default-export a React component.');
      reactRoot.render(
        <Boundary>
          <CanvasContext.Provider value={environment}>
            <Ready component={component} />
          </CanvasContext.Provider>
        </Boundary>,
      );
    },
    failure(error: unknown) {
      reactRoot.render(
        <div role="alert">
          <p>This canvas could not be rendered. View the source to inspect it or ask the agent to repair it.</p>
          <pre>{error instanceof Error ? error.message.slice(0, 600) : String(error).slice(0, 600)}</pre>
        </div>,
      );
      failure();
    },
    dispose() {
      reactRoot.unmount();
      host.removeEventListener('error', notice);
      host.removeEventListener('unhandledrejection', notice);
      host.removeEventListener('message', restore);
    },
  };
}
