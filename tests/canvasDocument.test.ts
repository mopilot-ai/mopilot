// Canvas compilation, bundling and persistence honor the offline sandbox and preserve independent or unreadable saved state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { Window } from 'happy-dom';
import { canvasDocument, CANVAS_CSP } from '../src/lib/visualization.ts';
import { compileCanvas } from '../src/lib/canvas/compile.ts';
import {
  readCanvasState,
  saveCanvasValue,
  canvasStorageKey,
  canvasStoragePrefix,
  MAX_CANVAS_STATE,
} from '../src/lib/canvas/persistence.ts';
import { canvasRuntimePlugin, bundleCanvasRuntime, CANVAS_RUNTIME } from '../scripts/canvas-runtime.mjs';

test('the document escapes its payload and script terminators, keeps the theme, and needs neither network nor eval', () => {
  const code = compileCanvas('export default () => <h1>{"</script><script>injected()</script>"}</h1>;');
  const source = canvasDocument(code, 'window.runtimeMarker = true;', { id: 'test', dark: true, state: { note: '</script><img src=x>' } });
  const window = new Window();
  try {
    window.document.write(source);
    assert.equal(window.document.querySelectorAll('script').length, 3);
    assert.deepEqual(JSON.parse(window.document.querySelector('#canvas-input')!.textContent!), {
      id: 'test',
      dark: true,
      state: { note: '</script><img src=x>' },
    });
    assert.equal(window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content'), CANVAS_CSP);
    assert.match(source, /color-scheme: dark/);
    assert.match(source, /connect-src 'none'/);
    assert.doesNotMatch(source, /unsafe-eval|https:\/\/cdn/);
    assert.match(source, /window.MoPilotCanvas.mount/);
    assert.match(canvasDocument('', '', { id: 'light', dark: false, state: {} }), /color-scheme: light/);
  } finally {
    window.happyDOM.abort();
  }
});

test('the production plugin bundles React and the runtime offline and watches every source input', async () => {
  const plugin = canvasRuntimePlugin();
  assert.equal(plugin.resolveId('ordinary-module'), null);
  assert.equal(plugin.resolveId(CANVAS_RUNTIME), `\0${CANVAS_RUNTIME}`);
  assert.equal(await plugin.load.call({ addWatchFile() {} }, 'ordinary-module'), null);
  const watched: string[] = [];
  const module = await plugin.load.call({ addWatchFile: (path: string) => watched.push(path) }, `\0${CANVAS_RUNTIME}`);
  const code = JSON.parse(module!.replace(/^export default /, '').replace(/;$/, ''));
  assert.match(code, /MoPilotCanvas/);
  assert.doesNotMatch(code, /\brequire\(["'](?:react|cursor\/canvas)["']\)/);
  assert.ok(watched.some((path) => path.endsWith('/canvas/entry.ts')));
  assert.ok(watched.some((path) => path.endsWith('/canvas/charts.tsx')));
  assert.ok(code.length < 350_000, 'the offline runtime remains a small lazy preview dependency');
  const bundle = await bundleCanvasRuntime();
  assert.equal(bundle.code, code);
});

test('the lazy loader supplies a real parser without asking the app to execute authored code', async () => {
  const hook = registerHooks({
    resolve(specifier, context, next) {
      return specifier === CANVAS_RUNTIME
        ? { url: 'data:text/javascript,export default "offline-runtime"', shortCircuit: true }
        : next(specifier, context);
    },
  });
  try {
    const { loadCanvasPreview } = await import('../src/lib/canvas/loader.ts');
    const loaded = await loadCanvasPreview();
    assert.equal(loaded.runtime, 'offline-runtime');
    assert.match(loaded.compile('export default () => <h1>Plan</h1>;'), /React.createElement/);
  } finally {
    hook.deregister();
  }
});

test('saved controls merge independent keys, isolate paths and preserve failed-write and malformed-state evidence', () => {
  const window = new Window({ url: 'http://localhost' });
  const storage = window.localStorage;
  try {
    assert.deepEqual(readCanvasState(storage, '/one/plan.canvas.tsx'), {});
    saveCanvasValue(storage, '/one/plan.canvas.tsx', 'tab', 'Roadmap');
    saveCanvasValue(storage, '/one/plan.canvas.tsx', 'filter', 'open');
    saveCanvasValue(storage, '/two/plan.canvas.tsx', 'tab', 'Evidence');
    assert.deepEqual(readCanvasState(storage, '/one/plan.canvas.tsx'), { tab: 'Roadmap', filter: 'open' });
    assert.deepEqual(readCanvasState(storage, '/two/plan.canvas.tsx'), { tab: 'Evidence' });
    saveCanvasValue(storage, '/one/plan.canvas.tsx', '__proto__', { safe: true });
    assert.equal(Object.getPrototypeOf(readCanvasState(storage, '/one/plan.canvas.tsx')), Object.prototype);
    assert.equal(({} as any).safe, undefined);
    assert.throws(() => saveCanvasValue(storage, '/one/plan.canvas.tsx', 'x'.repeat(257), 1), /key is too large/);
    assert.throws(() => saveCanvasValue(storage, '/one/plan.canvas.tsx', 'oversize', 'x'.repeat(MAX_CANVAS_STATE)), /too large/);
    assert.equal(readCanvasState(storage, '/one/plan.canvas.tsx').tab, 'Roadmap');
    for (const raw of ['{', ' '.repeat(MAX_CANVAS_STATE + 1)]) {
      const broken = canvasStorageKey('/broken', 'bad');
      storage.setItem(broken, raw);
      assert.throws(() => readCanvasState(storage, '/broken'));
      saveCanvasValue(storage, '/broken', 'tab', 'changed');
      assert.equal(storage.getItem(broken), raw);
      let invalid = 0;
      assert.deepEqual(
        readCanvasState(storage, '/broken', () => invalid++),
        { tab: 'changed' },
      );
      assert.equal(invalid, 1);
    }
    for (const value of [null, [], 42, 'value']) {
      saveCanvasValue(storage, '/values', 'value', value);
      assert.deepEqual(readCanvasState(storage, '/values').value, value);
    }
    assert.throws(() => saveCanvasValue(storage, '/values', 'undefined', undefined), /JSON data/);
    for (const tail of ['42]', '"key","extra"]']) {
      const name = canvasStoragePrefix('/invalid') + tail;
      storage.setItem(name, '0');
      assert.throws(() => readCanvasState(storage, '/invalid'), /Invalid canvas state key/);
      storage.removeItem(name);
    }
    assert.deepEqual(readCanvasState({ length: 1, key: () => null } as unknown as Storage, '/gone'), {});
    assert.deepEqual(
      readCanvasState({ length: 1, key: () => canvasStorageKey('/gone', 'key'), getItem: () => null } as unknown as Storage, '/gone'),
      {},
    );
    const blocked = {
      getItem: storage.getItem.bind(storage),
      setItem: () => {
        throw Error('quota');
      },
    } as unknown as Storage;
    assert.throws(() => saveCanvasValue(blocked, '/one/plan.canvas.tsx', 'tab', 'New'), /quota/);
    assert.equal(readCanvasState(storage, '/one/plan.canvas.tsx').tab, 'Roadmap');
  } finally {
    window.happyDOM.abort();
  }
});
