// A preview owns its loader, sandbox messages and persisted controls across replacement, failure, retry and disposal.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { render } from './support/shell-panels-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { readCanvasState, canvasStorageKey } from '../src/lib/canvas/persistence.ts';
import { retainCanvasState } from '../src/lib/canvas/stateOwner.ts';
let load: () => Promise<{ runtime: string; compile: (source: string) => string }> = async () => ({
  runtime: '',
  compile: (source) => source,
});
const opened: unknown[][] = [];
const sequences = new WeakMap<HTMLIFrameElement, number>();
mock.module('../src/lib/canvas/loader.ts', { namedExports: { loadCanvasPreview: () => load() } });
mock.module('../src/session/open.ts', { namedExports: { openMessageLink: (...args: unknown[]) => opened.push(args) } });
const { act, createElement: h, StrictMode } = await import('react');
const { FileCanvasPreview } = await import('../src/components/panels/FileCanvasPreview.tsx');
const { PreviewSwap } = await import('../src/components/panels/PreviewSwap.tsx');
const view = (source = 'export default () => null;', extra: Record<string, unknown> = {}) =>
  h(FileCanvasPreview, { source, path: '/repo/plan.canvas.tsx', cwd: '/repo', dark: false, ...extra });
function frame(host: HTMLElement) {
  const el = host.querySelector('iframe')!;
  assert.ok(el);
  return el;
}
function payload(el: HTMLIFrameElement) {
  return JSON.parse(/id="canvas-input">([^<]*)<\/script>/.exec(el.getAttribute('srcdoc')!)![1]);
}
async function message(el: HTMLIFrameElement, data: unknown, source: unknown = el.contentWindow) {
  await act(() => window.dispatchEvent(new window.MessageEvent('message', { data, source: source as any })));
}
const send = (el: HTMLIFrameElement, data: Record<string, unknown>) => {
  if (data.type === 'state' && !Object.hasOwn(data, 'sequence')) {
    const sequence = (sequences.get(el) ?? 0) + 1;
    sequences.set(el, sequence);
    data = { ...data, sequence };
  }
  if (data.type === 'ready' && !Object.hasOwn(data, 'revision')) {
    const owner = retainCanvasState('/repo/plan.canvas.tsx', localStorage);
    data = { ...data, revision: owner.read().revision };
    owner.release();
  }
  return message(el, { channel: 'mopilot-canvas', id: payload(el).id, ...data });
};

test('canvas state is scoped to its path, source toggles are isolated, and foreign frame messages cannot act', async () => {
  opened.length = 0;
  localStorage.clear();
  let ready = 0,
    failed = 0;
  const r = await render(view(undefined, { onReady: () => ready++, onFailure: () => failed++ }));
  try {
    const el = frame(r.host);
    assert.equal(el.getAttribute('sandbox'), 'allow-scripts');
    assert.equal(el.getAttribute('referrerpolicy'), 'no-referrer');
    assert.match(el.getAttribute('srcdoc')!, /connect-src 'none'/);
    await message(el, null);
    await message(el, {});
    await message(el, []);
    await message(el, 1);
    await message(el, { channel: 'other', id: payload(el).id, type: 'ready' });
    await message(el, { channel: 'mopilot-canvas', id: 'other', type: 'ready' });
    await message(el, { channel: 'mopilot-canvas', id: payload(el).id, type: 'ready' }, window);
    await send(el, { type: 'state', key: 42, value: 'bad' });
    assert.equal(ready, 0);
    assert.equal(failed, 0);
    await send(el, { type: 'ready' });
    assert.equal(ready, 1);
    await send(el, { type: 'state', key: 'view', value: 'Evidence' });
    assert.equal(readCanvasState(localStorage, '/repo/plan.canvas.tsx').view, 'Evidence');
    for (const sequence of [0, 2, 0.5, null]) await send(el, { type: 'state', key: 'view', value: 'Roadmap', sequence });
    assert.equal(
      readCanvasState(localStorage, '/repo/plan.canvas.tsx').view,
      'Evidence',
      'stale or malformed write sequences cannot replay',
    );
    await send(el, { type: 'link', href: 'https://example.com' });
    assert.equal(opened.length, 0);
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: { isActive: true } });
    await send(el, { type: 'link', href: 'https://example.com' });
    await send(el, { type: 'action', action: { type: 'openFile', path: '/repo/source.ts' } });
    assert.deepEqual(opened, [
      ['https://example.com', '/repo'],
      ['/repo/source.ts', '/repo'],
    ]);
    await send(el, { type: 'action', action: { type: 'openFile', path: 'src/source.ts', selection: { startLineNumber: 12 } } });
    assert.deepEqual(opened.at(-1), ['src/source.ts#L12', '/repo']);
    await send(el, { type: 'action', action: { type: 'openAgent', agentId: 'cursor-native-id' } });
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /unavailable in MoPilot/);
    await send(el, { type: 'link', href: 'javascript:alert(1)' });
    assert.equal(opened.length, 3);
    for (const href of ['', '  ', '/repo/\0bad.ts', null]) await send(el, { type: 'link', href });
    assert.equal(opened.length, 3);
    await r.rerender(view('export default () => "updated";'));
    assert.equal(payload(frame(r.host)).state.view, 'Evidence');
    await r.rerender(view(undefined, { path: '/elsewhere/plan.canvas.tsx' }));
    assert.deepEqual(payload(frame(r.host)).state, {});
  } finally {
    Object.defineProperty(navigator, 'userActivation', { configurable: true, value: undefined });
    await r.unmount();
  }
});

test('failed saved edits survive theme changes and sandbox retry while the preview stays open', async () => {
  localStorage.clear();
  const r = await render(view());
  const blocked = mock.method(localStorage, 'setItem', () => {
    throw Error('quota');
  });
  try {
    await send(frame(r.host), { type: 'state', key: 'view', value: 'Evidence' });
    await r.rerender(view(undefined, { dark: true }));
    assert.equal(payload(frame(r.host)).state.view, 'Evidence', 'theme invalidates the sandbox but retains the live state owner');
    await send(frame(r.host), { type: 'error' });
    await act(() => r.host.querySelector<HTMLButtonElement>('button')!.click());
    assert.equal(payload(frame(r.host)).state.view, 'Evidence', 'retry preserves the failed saved edit');
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /could not be saved/);
  } finally {
    blocked.mock.restore();
    await r.unmount();
  }
});

test('late loader successes and rejections cannot replace a newer file or report failure after disposal', async () => {
  for (const reject of [false, true]) {
    const old = deferred<{ runtime: string; compile: (source: string) => string }>();
    let failed = 0;
    load = () => old.promise;
    const r = await render(view('old', { onFailure: () => failed++ }));
    try {
      assert.ok(r.host.querySelector('[aria-label="Loading preview"]'));
      load = async () => ({ runtime: '', compile: (source) => `/* ${source} */` });
      await r.rerender(view('new', { path: '/repo/new.canvas.tsx', onFailure: () => failed++ }));
      const el = frame(r.host);
      await act(() => {
        if (reject) old.reject(Error('retired loader'));
        else old.resolve({ runtime: '', compile: (source) => `/* ${source} */` });
      });
      assert.equal(frame(r.host), el);
      assert.match(el.getAttribute('srcdoc')!, /\/\* new \*\//);
      assert.equal(failed, 0);
    } finally {
      await r.unmount();
    }
  }
  const pending = deferred<any>();
  load = () => pending.promise;
  let failed = 0;
  const r = await render(view('unmounted', { onFailure: () => failed++ }));
  await r.unmount();
  await act(() => pending.reject(Error('closed')));
  assert.equal(failed, 0);
  load = async () => ({ runtime: '', compile: (source) => source });
});

test('failed compilation and runtime errors remain retryable and never count as rendered', async () => {
  let failed = 0,
    ready = 0;
  load = async () => ({
    runtime: '',
    compile: () => {
      throw Error('incomplete TSX');
    },
  });
  const r = await render(view(undefined, { onFailure: () => failed++, onReady: () => ready++ }));
  try {
    assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /Could not render this canvas/);
    assert.equal(failed, 1);
    load = async () => ({ runtime: '', compile: (source) => source });
    await act(() => r.host.querySelector<HTMLButtonElement>('button')!.click());
    let el = frame(r.host);
    await act(() => {
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: el.contentWindow,
          data: { channel: 'mopilot-canvas', id: payload(el).id, type: 'error' },
        }),
      );
      window.dispatchEvent(
        new window.MessageEvent('message', {
          source: el.contentWindow,
          data: { channel: 'mopilot-canvas', id: payload(el).id, type: 'ready' },
        }),
      );
    });
    assert.equal(ready, 0);
    assert.equal(failed, 2);
    await act(() => r.host.querySelector<HTMLButtonElement>('button')!.click());
    await send(frame(r.host), { type: 'ready' });
    assert.equal(ready, 1);
  } finally {
    await r.unmount();
  }
});

test('unreadable saved state and refused persistence preserve the source and the currently edited value', async () => {
  localStorage.clear();
  const broken = canvasStorageKey('/repo/plan.canvas.tsx', 'bad');
  localStorage.setItem(broken, '{broken');
  const r = await render(h(StrictMode, null, view()));
  try {
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /could not be read/);
    const el = frame(r.host);
    assert.deepEqual(payload(el).state, {});
    const blocked = mock.method(localStorage, 'setItem', () => {
      throw Error('quota');
    });
    await send(el, { type: 'state', key: 'view', value: 'Evidence' });
    assert.match(r.host.querySelector('[role="status"]')!.textContent!, /could not be saved/);
    assert.equal(localStorage.getItem(broken), '{broken');
    blocked.mock.restore();
    localStorage.removeItem(broken);
    await send(el, { type: 'state', key: 'view', value: 'Evidence' });
    assert.equal(r.host.querySelector('[role="status"]'), null);
  } finally {
    await r.unmount();
  }
});

test('a silent runtime exits loading with a retry instead of waiting forever', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = await render(view());
  try {
    await act(() => t.mock.timers.tick(15_000));
    assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /Could not render/);
  } finally {
    await r.unmount();
    t.mock.timers.reset();
  }
});

test('unserializable or unbounded canvas controls fail visibly without damaging saved state', async () => {
  localStorage.clear();
  const r = await render(view());
  try {
    const el = frame(r.host);
    await send(el, { type: 'state', key: 'view', value: 'Evidence' });
    const cycle: any = {};
    cycle.self = cycle;
    for (const data of [
      { key: 'bad', value: undefined },
      { key: 'bad', value: cycle },
      { key: 'x'.repeat(257), value: 1 },
    ]) {
      await send(el, { type: 'state', ...data });
      assert.match(r.host.querySelector('[role="status"]')!.textContent!, /bounded JSON/);
      assert.deepEqual(readCanvasState(localStorage, '/repo/plan.canvas.tsx'), { view: 'Evidence' });
    }
  } finally {
    await r.unmount();
  }
});

test('a timed-out loader cannot publish late, and stale frame messages cannot cross theme or source generations', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = deferred<{ runtime: string; compile: (source: string) => string }>();
  load = () => pending.promise;
  let ready = 0;
  const r = await render(view(undefined, { onReady: () => ready++ }));
  try {
    await act(() => t.mock.timers.tick(15_000));
    await act(() => pending.resolve({ runtime: '', compile: (source) => source }));
    assert.equal(r.host.querySelector('iframe'), null);
    load = async () => ({ runtime: '', compile: (source) => source });
    await act(() => r.host.querySelector<HTMLButtonElement>('button')!.click());
    const old = frame(r.host),
      oldId = payload(old).id;
    await r.rerender(view(undefined, { dark: true, onReady: () => ready++ }));
    const current = frame(r.host);
    assert.notEqual(payload(current).id, oldId);
    await message(current, { channel: 'mopilot-canvas', id: oldId, type: 'ready' });
    assert.equal(ready, 0);
    await send(current, { type: 'ready' });
    assert.equal(ready, 1);
  } finally {
    await r.unmount();
    t.mock.timers.reset();
    load = async () => ({ runtime: '', compile: (source) => source });
  }
});

test('an accepted edit survives a visible-to-candidate preview handoff', async () => {
  localStorage.clear();
  load = async () => ({ runtime: '', compile: (source) => source });
  const { saveCanvasValue } = await import('../src/lib/canvas/persistence.ts');
  saveCanvasValue(localStorage, '/repo/plan.canvas.tsx', 'view', 'Roadmap');
  const swap = (source: string) => h(PreviewSwap, { value: source, children: ({ value, ...ready }: any) => view(value, ready) });
  const r = await render(swap('first source'));
  const restores: any[] = [];
  try {
    const old = frame(r.host);
    const first = mock.method(old.contentWindow!, 'postMessage', (message: unknown) => restores.push(message));
    await send(old, { type: 'ready' });
    if (restores.length) await send(old, { type: 'ready', revision: restores.at(-1).revision });
    await r.rerender(swap('updated source'));
    const candidate = [...r.host.querySelectorAll('iframe')].at(-1)!;
    assert.notEqual(candidate, old);
    assert.equal(payload(candidate).state.view, 'Roadmap');
    const updates: any[] = [];
    const second = mock.method(candidate.contentWindow!, 'postMessage', (message: unknown) => updates.push(message));
    await send(candidate, { type: 'booted' });
    const priorRevision = updates.at(-1).revision;
    await send(old, { type: 'state', key: 'view', value: 'Evidence' });
    await send(candidate, { type: 'ready', revision: priorRevision });
    assert.equal(
      candidate.closest<HTMLElement>('.preview-generation')!.hidden,
      true,
      'stale ready cannot publish before current controls are committed',
    );
    const effective = updates.at(-1)?.state ?? payload(candidate).state;
    assert.equal(effective.view, 'Evidence', 'candidate must include the edit accepted while the old preview remained interactive');
    await send(candidate, { type: 'ready', revision: updates.at(-1).revision });
    assert.equal(candidate.closest<HTMLElement>('.preview-generation')!.hidden, false);
    first.mock.restore();
    second.mock.restore();
  } finally {
    await r.unmount();
  }
});
