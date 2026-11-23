// The lightweight renderer entry waits for main and reports setup or module-load failure without booting the app.
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import './support/app-misc-css.ts';
import { deferred } from './support/async-scenarios.ts';

const ready = deferred<void>();
let starts = 0;
const failures: unknown[][] = [];
mock.method(console, 'error', (...args: unknown[]) => void failures.push(args));
// the bridge as the preload leaves it: the entry's first import puts it behind the native port (src/lib/nativeInstall.ts)
(window as any).native = { app: { ready: () => ready.promise } };
mock.module('../src/main.tsx', { namedExports: { start: () => starts++ } });
const root = window.document.createElement('div');
root.id = 'root';
root.textContent = 'Opening MoPilot…';
window.document.body.append(root);
const { launch } = await import('../src/launch.ts');

test('the production renderer entry keeps its first frame while main is pending, then starts once', async () => {
  assert.equal(starts, 0, 'the full renderer has not booted against unregistered IPC');
  assert.equal(root.textContent, 'Opening MoPilot…');
  ready.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
});

test('a failed startup or application import ends the loading state with a visible error', async () => {
  for (const stage of ['ready', 'import'] as const) {
    root.removeAttribute('role');
    root.textContent = 'Opening MoPilot…';
    const error = new Error(`${stage} failed`);
    let loaded = false;
    await launch(
      async () => {
        if (stage === 'ready') throw error;
      },
      async () => {
        loaded = true;
        throw error;
      },
    );
    assert.equal(loaded, stage === 'import');
    assert.equal(root.getAttribute('role'), 'alert');
    assert.equal(root.textContent, 'MoPilot could not finish starting. Quit and reopen it to try again.');
    assert.deepEqual(failures.at(-1), ['[startup] could not open the app', error]);
    assert.equal(starts, 1, 'a failure never boots a second app');
  }
});

test('the language is in place before any app module loads', async () => {
  const order: string[] = [];
  (window as any).native.app.language = async () => (order.push('language'), { tag: 'ja', messages: {} });
  await launch(
    async () => void order.push('ready'),
    async () => void order.push('load'),
  );
  assert.deepEqual(order, ['ready', 'language', 'load']);
  assert.equal(window.document.documentElement.lang, 'ja');
});

test('a window that cannot read its language still opens, in English', async () => {
  const error = new Error('no language');
  (window as any).native.app.language = async () => {
    throw error;
  };
  let loaded = false;
  await launch(
    async () => {},
    async () => void (loaded = true),
  );
  assert.equal(loaded, true);
  assert.deepEqual(failures.at(-1), ['[startup] showing the interface in English', error]);
});
