// The renderer entry point: mounts the main window, or Quick Chat in the #mini window.

import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Mini } from './components/mini/Mini';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { QuitDialog } from './components/dialogs/QuitDialog';
// the dev-only window hooks (automation's window.__codex, reload on a hot update), before anything reads the store
import './store/devHooks';
import { boot } from './store/boot';
import { toast, useStore } from './store/core';
import { installPerfProbe, reactCommit } from './session/perf';
import { installRendererRecord } from './session/rendererRecord';
import { installErrorHandlers, reportError } from './lib/telemetry';
import { errorText } from './lib/ignored';
import { native } from './lib/native';
import './styles/tokens.css';
import './styles/app.css';
import './styles/agents.css';
import './styles/tasks.css';
import { platform } from './lib/platform';
import { markWindowReady } from './lib/windowReady';
import { installRuntime, type HarnessRuntime } from './store/runtime';
import { harnessRuntime } from './session/harness/runtime';
import { registerSemanticHandlers } from './session/harness/adapters/handlers';

/** The renderer entry: the main window, or Quick Chat (#mini). Exported so a unit test can run it. */
export function start() {
  // before anything boots: the store reaches each harness through it (typed here, where both sides meet)
  const runtime: HarnessRuntime = harnessRuntime();
  installRuntime(runtime);
  registerSemanticHandlers();
  // Platform-specific chrome (Windows caption buttons on the right, macOS traffic lights on the left).
  document.documentElement.dataset.platform = platform;

  // A file dropped anywhere but a drop target (the composer, the sidebar) would navigate the window to it.
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  // the streaming performance probe, while its switch is on (docs/performance/measurement.md)
  installPerfProbe(native, useStore);
  installRendererRecord(native, useStore);

  if (location.hash === '#mini') {
    // Quick Chat shares session state, but never writes the main window’s UI state.
    installErrorHandlers();
    createRoot(document.getElementById('root')!).render(
      <ErrorBoundary>
        <Mini />
      </ErrorBoundary>,
    );
  } else {
    installErrorHandlers();
    // a boot that failed partway leaves a window that may be missing chats or settings: report it, and say so
    boot().catch((error) => {
      reportError(error, { kind: 'boot' });
      toast(`MoPilot didn't finish starting: ${errorText(error)}. Restart it to try again.`, 'error');
      // the window is up all the same: main routes commands to it instead of waiting for a ready that never comes
      native.win.rendererReady();
      // reads waiting for the window to be known go now, so each shows main's refusal instead of waiting forever
      markWindowReady();
    });
    // the quit dialog answers main's exit gate, so it is beside the app, not in it: an app showing its error
    // screen must still let Quit and Restart to update go on
    createRoot(document.getElementById('root')!).render(
      <>
        <ErrorBoundary>
          {/* React reports commit times to the probe in development builds only */}
          <Profiler id="app" onRender={reactCommit}>
            <App />
          </Profiler>
        </ErrorBoundary>
        <ErrorBoundary label="the quit dialog">
          <QuitDialog />
        </ErrorBoundary>
      </>,
    );
  }
}
