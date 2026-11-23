// Scheduled action completions preserve newer navigation while task writes still finish.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import { importsToStub } from './support/source-modules.ts';
import { fakeStore, render, click, byText, flush } from './support/pages-kit.ts';
import { createElement as h, act, StrictMode } from 'react';
import { installNativeStub } from './support/ports/native.ts';
const owner = new URL('../src/session/useActionView.ts', import.meta.url);
const card = new URL('../src/components/thread/ScheduledTaskCard.tsx', import.meta.url);
const base = new URL('../', import.meta.url);
const at = (p: string) => new URL(p, base).href;
const store = fakeStore<any>({ threads: {}, basicHarnesses: [], prefs: {}, route: { name: 'scheduled' } });
const calls: any[] = [];
let run: () => Promise<string>;
let list: () => Promise<any>;
let update: (id: string, patch: any) => Promise<any>;
const a: any = { id: 'a', name: 'Task A', status: 'PAUSED', prompt: 'p', runsIn: ['mopilot'] };
const storeStubs = {
  useStore: store.useStore,
  navigate: (route: any) => {
    calls.push(['navigate', route]);
    store.set({ route });
  },
  toast: (...args: any[]) => calls.push(['toast', ...args]),
};
const overrides: Record<string, any> = {
  // the page and the scheduled components import the slices that own these names
  [at('src/store/core.ts')]: { useStore: storeStubs.useStore, toast: storeStubs.toast },
  [at('src/store/panes.ts')]: { navigate: storeStubs.navigate },
  [at('src/lib/ignored.ts')]: { errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)) },
  [at('src/lib/scheduleTask.ts')]: { whereItRuns: () => [], runWithLabel: () => 'Codex', runsInLabel: () => 'MoPilot' },
};
// the bridge, installed in the port the modules read (src/lib/native.ts, real here)
installNativeStub({
  automation: {
    runs: async () => [],
    onChanged: () => () => {},
    run: (task: any) => {
      calls.push(['run', task.id]);
      return run();
    },
    list: () => list(),
    update: async (id: string, patch: any) => {
      calls.push(['update', id, patch]);
      return update(id, patch);
    },
  },
});
for (const [file, names] of importsToStub(
  [card, owner],
  (m) => m.href === at('src/lib/native.ts') || m.href === at('src/lib/latestLoader.ts') || m.href === at('shared/scheduleTask.mjs'),
))
  mock.module(file, { namedExports: Object.fromEntries([...names].map((n) => [n, overrides[file]?.[n] ?? (() => null)])) });
const { ScheduledTaskCard } = await import(card.href);
const reset = () => {
  calls.length = 0;
  list = async () => ({ tasks: [a] });
  store.set({ route: { name: 'scheduled' }, paneActive: null });
  (globalThis as any).confirm = () => true;
};

test('card status: a retired task status response must not update replacement card', async () => {
  reset();
  const gate = deferred<any>();
  update = () => gate.promise;
  const v = await render(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
  try {
    await click(byText(v.host, 'Resume'));
    await v.rerender(h(ScheduledTaskCard, { call: { action: 'created', task: { ...a, id: 'b' } } }));
    gate.resolve({ ...a, status: 'ACTIVE' });
    await flush();
    assert.ok(byText(v.host, 'Resume'), 'Task B stays paused after Task A response');
  } finally {
    await v.unmount();
  }
});
test('card status: late earlier status response must not overwrite latest status response', async () => {
  reset();
  const older = deferred<any>();
  let count = 0;
  update = async (id, patch) => (++count === 1 ? older.promise : { ...a, ...patch });
  const v = await render(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
  try {
    await click(byText(v.host, 'Resume'));
    await click(byText(v.host, 'Resume'));
    await click(byText(v.host, 'Pause'));
    assert.ok(byText(v.host, 'Resume'));
    older.resolve({ ...a, status: 'ACTIVE' });
    await flush();
    assert.ok(byText(v.host, 'Resume'), 'Most recent paused status survives earlier response');
  } finally {
    await v.unmount();
  }
});

test('card status: completed status belongs to its task identity, including same-ID return', async () => {
  reset();
  update = async (_id, patch) => ({ ...a, ...patch });
  const v = await render(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
  try {
    await click(byText(v.host, 'Resume'));
    assert.ok(byText(v.host, 'Pause'));
    await v.rerender(h(ScheduledTaskCard, { call: { action: 'created', task: { ...a, id: 'b' } } }));
    assert.ok(byText(v.host, 'Resume'));
    await v.rerender(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
    assert.ok(byText(v.host, 'Resume'));
  } finally {
    await v.unmount();
  }
});

for (const retired of ['identity-return', 'unmount', 'route-away-back']) {
  test(`card status: ${retired} retires publication while accepted update finishes`, async () => {
    reset();
    const gate = deferred<any>();
    update = () => gate.promise;
    const v = await render(h(StrictMode, null, h(ScheduledTaskCard, { call: { action: 'created', task: a } })));
    await click(byText(v.host, 'Resume'));
    if (retired === 'identity-return') {
      await v.rerender(h(StrictMode, null, h(ScheduledTaskCard, { call: { action: 'created', task: { ...a, id: 'b' } } })));
      await v.rerender(h(StrictMode, null, h(ScheduledTaskCard, { call: { action: 'created', task: a } })));
    } else if (retired === 'unmount') await v.unmount();
    else
      await act(async () => {
        store.set({ route: { name: 'home' } });
        store.set({ route: { name: 'scheduled' } });
      });
    gate.resolve({ ...a, status: 'ACTIVE' });
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'update'),
      [['update', 'a', { status: 'ACTIVE' }]],
    );
    if (retired !== 'unmount') {
      assert.ok(byText(v.host, 'Resume'));
      await v.unmount();
    }
  });
}

test('card status: navigation intent does not supersede an independent pending status update', async () => {
  reset();
  const statusGate = deferred<any>();
  const runGate = deferred<string>();
  update = () => statusGate.promise;
  run = () => runGate.promise;
  const v = await render(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
  try {
    await click(byText(v.host, 'Resume'));
    await click(byText(v.host, 'Run now'));
    statusGate.resolve({ ...a, status: 'ACTIVE' });
    await flush();
    assert.ok(byText(v.host, 'Pause'));
    runGate.resolve('run-chat');
    await flush();
    assert.deepEqual(store.get().route, { name: 'thread', id: 'run-chat' });
  } finally {
    await v.unmount();
  }
});

test('card status: retired failure remains visible and a replacement can retry', async () => {
  reset();
  const gate = deferred<any>();
  update = () => gate.promise;
  const v = await render(h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
  try {
    await click(byText(v.host, 'Resume'));
    await v.rerender(h(ScheduledTaskCard, { call: { action: 'created', task: { ...a, id: 'b' } } }));
    gate.reject(new Error('write refused'));
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      [['toast', 'write refused', 'error']],
    );
    assert.ok(byText(v.host, 'Resume'));
    update = async (_id, patch) => ({ ...a, ...patch });
    await click(byText(v.host, 'Resume'));
    assert.ok(byText(v.host, 'Pause'));
  } finally {
    await v.unmount();
  }
});
