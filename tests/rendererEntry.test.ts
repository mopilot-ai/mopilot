// The renderer entry (src/main.tsx): Quick Chat or the main window, inside an error boundary.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import './support/app-misc-css.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: string[] = [];
const rendered: any[] = [];
const App = () => null;
const Mini = () => null;
const ErrorBoundary = () => null;
const QuitDialog = () => null;
mock.module('react-dom/client', {
  namedExports: { createRoot: (el: Element) => (calls.push(`root:${el.id}`), { render: (node: any) => rendered.push(node) }) },
});
mock.module('../src/App.tsx', { namedExports: { App } });
mock.module('../src/components/mini/Mini.tsx', { namedExports: { Mini } });
mock.module('../src/components/ui/ErrorBoundary.tsx', { namedExports: { ErrorBoundary } });
mock.module('../src/components/dialogs/QuitDialog.tsx', { namedExports: { QuitDialog } });
let bootResult: () => Promise<void> = async () => {};
const toasts: unknown[][] = [];
const reported: unknown[][] = [];
const useStore = { getState: () => ({}) };
stubStore({ boot: () => (calls.push('boot'), bootResult()), toast: (...a: unknown[]) => void toasts.push(a), useStore });
const probes: unknown[][] = [];
const reactCommit = () => undefined;
mock.module('../src/session/perf.ts', { namedExports: { installPerfProbe: (...a: unknown[]) => void probes.push(a), reactCommit } });
mock.module('../src/lib/telemetry.ts', {
  namedExports: { installErrorHandlers: () => calls.push('errors'), reportError: (...a: unknown[]) => void reported.push(a) },
});
mock.module('../src/lib/platform.ts', { namedExports: { platform: 'win32' } });
const native = { win: { rendererReady: () => calls.push('ready') } };
installNativeStub(native);

let readyMarks = 0;
mock.module('../src/lib/windowReady.ts', { namedExports: { markWindowReady: () => void readyMarks++ } });

// the harness runtime main installs for the store: a stand-in, so no harness module loads
const harnessRuntimeStub = { stand: 'in' };
mock.module('../src/session/harness/runtime.ts', {
  namedExports: { harnessRuntime: () => (calls.push('runtime'), harnessRuntimeStub) },
});
// the dev-only window hooks (src/store/devHooks.ts) load the whole store: not this test's subject
mock.module('../src/store/devHooks.ts', { namedExports: {} });
mock.module('../src/session/harness/adapters/handlers.ts', {
  namedExports: { registerSemanticHandlers: () => void calls.push('handlers') },
});
const { runtime } = await import('../src/store/runtime.ts');

const root = document.createElement('div');
root.id = 'root';
document.body.append(root);
const { start } = await import('../src/main.tsx');
start();

test('the main window boots the store and renders the app and the quit dialog, each in an error boundary', () => {
  // the store's harness runtime and the harnesses' built-in handlers are installed before it boots
  assert.deepEqual(calls, ['runtime', 'handlers', 'errors', 'boot', 'root:root']);
  assert.equal(runtime(), harnessRuntimeStub);
  assert.equal(document.documentElement.dataset.platform, 'win32');
  const [app, quit] = rendered[0].props.children;
  assert.equal(app.type === ErrorBoundary, true);
  // the app's commits are timed for the performance probe (development builds report them)
  const profiler = app.props.children;
  assert.equal(profiler.props.id, 'app');
  assert.equal(profiler.props.onRender, reactCommit);
  assert.equal(profiler.props.children.type === App, true);
  // the probe follows its switch in every window
  assert.equal(probes.length, 1);
  // it is handed the native port, which reads the bridge installed here
  assert.equal((probes[0][0] as typeof native).win, native.win);
  assert.equal(probes[0][1], useStore);
  // an app on its error screen still answers Quit: the dialog is not inside it
  assert.equal(quit.type === ErrorBoundary, true);
  assert.equal(quit.props.label, 'the quit dialog');
  assert.equal(quit.props.children.type === QuitDialog, true);
});

test('Quick Chat renders without booting the main window', () => {
  calls.length = 0;
  window.location.hash = '#mini';
  try {
    start();
  } finally {
    window.location.hash = '';
  }
  // Quick Chat's store reaches the harnesses the same way
  assert.deepEqual(calls, ['runtime', 'handlers', 'errors', 'root:root']);
  assert.equal(rendered[1].type === ErrorBoundary, true);
  assert.equal(rendered[1].props.children.type === Mini, true);
});

test('a boot that fails partway is reported and the window says so', async () => {
  const error = new Error("Error invoking remote method 'chats:snapshot': Error: disk full");
  bootResult = async () => {
    throw error;
  };
  start();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(reported, [[error, { kind: 'boot' }]]);
  assert.deepEqual(toasts, [["MoPilot didn't finish starting: disk full. Restart it to try again.", 'error']]);
  assert.equal(calls.at(-1), 'ready');
  // reads that wait for the window to be known go now and show main's refusal, instead of waiting forever
  assert.equal(readyMarks, 1);
});

test('dropping a file outside a drop target does not navigate', () => {
  for (const type of ['dragover', 'drop']) {
    const e = new window.Event(type, { cancelable: true });
    window.dispatchEvent(e);
    assert.equal(e.defaultPrevented, true, type);
  }
});
