// Scheduled action completions preserve newer navigation while task writes still finish.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { deferred } from './support/async-scenarios.ts';
import { importsToStub } from './support/source-modules.ts';
import { fakeStore, render, click, byText, flush } from './support/pages-kit.ts';
import { createElement as h, act, StrictMode } from 'react';
// pure: the action owner compares views with the real selectors
import * as split from '../src/store/split.ts';
import { installNativeStub } from './support/ports/native.ts';
const detail = new URL('../src/components/pages/scheduled/TaskDetail.tsx', import.meta.url);
const owner = new URL('../src/session/useActionView.ts', import.meta.url);
const card = new URL('../src/components/thread/ScheduledTaskCard.tsx', import.meta.url);
const base = new URL('../', import.meta.url);
const at = (p: string) => new URL(p, base).href;
const store = fakeStore<any>({ threads: {}, basicHarnesses: [], prefs: {}, route: { name: 'scheduled' } });
const sched = fakeStore<any>({ selected: 'a', editing: null });
const calls: any[] = [];
let run: () => Promise<string>;
let remove: () => Promise<void>;
let list: () => Promise<any>;
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
  [at('src/store/split.ts')]: split,
  [at('src/store/session/useSession.ts')]: { flushSessionPatches: () => {}, useSessions: (s: any) => s({ sessions: {} }) },
  [at('src/components/pages/scheduled/state.ts')]: {
    useSched: sched.useStore,
    reload: async () => {
      calls.push(['reload']);
    },
  },
  [at('src/lib/automations.ts')]: {
    taskState: (t: any) => ({ kind: t.status === 'ACTIVE' ? 'unscheduled' : 'paused' }),
    TASK_STATE_LABEL: { paused: 'Paused', ended: 'Ended', unscheduled: 'No next run' },
    deleteAutomation: (id: string) => {
      calls.push(['delete', id]);
      return remove();
    },
  },
  [at('src/lib/hostMachines.ts')]: { useHostMachines: () => ({ machines: [], resolved: true }) },
  [at('src/lib/ignored.ts')]: { errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)) },
  [at('src/lib/scheduleTask.ts')]: { whereItRuns: () => [], runWithLabel: () => 'Codex', runsInLabel: () => 'MoPilot' },
  [at('src/components/ui/Popover.tsx')]: {
    useAnchor: () => ({}),
    Menu: ({ children }: any) => children,
    MenuItem: ({ children, onSelect }: any) => h('button', { onClick: onSelect }, children),
  },
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
      return { ...a, ...patch };
    },
  },
});
for (const [file, names] of importsToStub(
  [detail, card, owner],
  (m) => m.href === at('src/lib/native.ts') || m.href === at('src/lib/latestLoader.ts') || m.href === at('shared/scheduleTask.mjs'),
))
  mock.module(file, { namedExports: Object.fromEntries([...names].map((n) => [n, overrides[file]?.[n] ?? (() => null)])) });
const { TaskDetail } = await import(detail.href);
const { ScheduledTaskCard } = await import(card.href);
const reset = () => {
  calls.length = 0;
  list = async () => ({ tasks: [a] });
  sched.set({ selected: 'a' });
  store.set({ route: { name: 'scheduled' }, paneActive: null });
  sched.set({ editing: null });
  (globalThis as any).confirm = () => true;
};
test('delete A finishes but does not clear a newer task B selection', async () => {
  reset();
  const gate = deferred<void>();
  remove = () => gate.promise;
  const v = await render(h(TaskDetail, { a }));
  try {
    await click(byText(v.host, 'Delete'));
    await act(async () => sched.set({ selected: 'b' }));
    await v.rerender(h(TaskDetail, { a: { ...a, id: 'b', name: 'Task B' }, key: 'b' }));
    gate.resolve();
    await flush();
    assert.deepEqual(
      calls.filter((c) => c[0] === 'delete'),
      [['delete', 'a']],
    );
    assert.equal(sched.get().selected, 'b');
  } finally {
    await v.unmount();
  }
});
for (const surface of ['detail', 'card']) {
  test(`${surface} Run now completes independently without navigating after unmount`, async () => {
    reset();
    const gate = deferred<string>();
    run = () => gate.promise;
    const v = await render(surface === 'detail' ? h(TaskDetail, { a }) : h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
    await click(byText(v.host, 'Run now'));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'run'),
      [['run', 'a']],
    );
    await v.unmount();
    store.set({ route: { name: 'thread', id: 'newer-chat' } });
    gate.resolve('run-a');
    await flush();
    assert.deepEqual(store.get().route, { name: 'thread', id: 'newer-chat' });
  });
  test(`${surface} Run now navigates when its initiating view is still current`, async () => {
    reset();
    const gate = deferred<string>();
    run = () => gate.promise;
    const v = await render(surface === 'detail' ? h(TaskDetail, { a }) : h(ScheduledTaskCard, { call: { action: 'created', task: a } }));
    try {
      await click(byText(v.host, 'Run now'));
      gate.resolve('run-a');
      await flush();
      assert.deepEqual(store.get().route, { name: 'thread', id: 'run-a' });
    } finally {
      await v.unmount();
    }
  });
}

const view = (surface: string, task = a) =>
  surface === 'detail' ? h(TaskDetail, { a: task }) : h(ScheduledTaskCard, { call: { action: 'created', task } });
for (const surface of ['detail', 'card']) {
  for (const retire of ['task', 'route-away-back', 'pane', 'unmount']) {
    test(`${surface}: ${retire} retires pending navigation, including reused task identity`, async () => {
      reset();
      const gate = deferred<string>();
      run = () => gate.promise;
      const v = await render(h(StrictMode, null, view(surface)));
      let mounted = true;
      try {
        await click(byText(v.host, 'Run now'));
        if (retire === 'task') {
          await v.rerender(h(StrictMode, null, view(surface, { ...a, id: 'b' })));
          await v.rerender(h(StrictMode, null, view(surface)));
        } else if (retire === 'route-away-back') {
          const oldRoute = store.get().route;
          await act(async () => {
            store.set({ route: { name: 'settings' } });
            store.set({ route: oldRoute });
          });
        } else if (retire === 'pane') {
          await act(async () => store.set({ paneActive: 'new-pane' }));
        } else {
          await v.unmount();
          mounted = false;
        }
        gate.resolve('retired-run');
        await flush();
        assert.equal(calls.filter((c) => c[0] === 'navigate').length, 0);
        assert.deepEqual(
          calls.filter((c) => c[0] === 'run'),
          [['run', 'a']],
        );
      } finally {
        if (mounted) await v.unmount();
      }
    });
  }
  for (const order of ['older-first', 'newer-first']) {
    test(`${surface}: two accepted runs finish ${order}; only latest action navigates`, async () => {
      reset();
      const older = deferred<string>();
      const newer = deferred<string>();
      let count = 0;
      run = () => (++count === 1 ? older.promise : newer.promise);
      const v = await render(view(surface));
      try {
        await click(byText(v.host, 'Run now'));
        await click(byText(v.host, 'Run now'));
        if (order === 'older-first') {
          older.resolve('old');
          await flush();
          assert.equal(
            calls.some((c) => c[0] === 'navigate'),
            false,
          );
          newer.resolve('new');
        } else {
          newer.resolve('new');
          await flush();
          older.resolve('old');
        }
        await flush();
        assert.equal(count, 2);
        assert.deepEqual(
          calls.filter((c) => c[0] === 'navigate'),
          [['navigate', { name: 'thread', id: 'new' }]],
        );
      } finally {
        await v.unmount();
      }
    });
  }
  test(`${surface}: obsolete rejection remains visible without blocking replacement run`, async () => {
    reset();
    const older = deferred<string>();
    const newer = deferred<string>();
    let count = 0;
    run = () => (++count === 1 ? older.promise : newer.promise);
    const v = await render(h(StrictMode, null, view(surface)));
    try {
      await click(byText(v.host, 'Run now'));
      await click(byText(v.host, 'Run now'));
      older.reject(new Error('run failed'));
      await flush();
      assert.deepEqual(
        calls.filter((c) => c[0] === 'toast'),
        [['toast', 'run failed', 'error']],
      );
      newer.resolve('retry-run');
      await flush();
      assert.deepEqual(store.get().route, { name: 'thread', id: 'retry-run' });
    } finally {
      await v.unmount();
    }
  });
  test(`${surface}: current failure can be retried in Strict Mode`, async () => {
    reset();
    run = async () => {
      throw new Error('current failure');
    };
    const v = await render(h(StrictMode, null, view(surface)));
    try {
      await click(byText(v.host, 'Run now'));
      assert.deepEqual(
        calls.filter((c) => c[0] === 'toast'),
        [['toast', 'current failure', 'error']],
      );
      run = async () => 'retry';
      await click(byText(v.host, 'Run now'));
      assert.deepEqual(store.get().route, { name: 'thread', id: 'retry' });
    } finally {
      await v.unmount();
    }
  });
}
for (const retirement of ['selection-away-back', 'editor', 'unmount']) {
  test(`delete: ${retirement} suppresses only UI completion and still reloads`, async () => {
    reset();
    const gate = deferred<void>();
    remove = () => gate.promise;
    const v = await render(h(StrictMode, null, view('detail')));
    let mounted = true;
    try {
      await click(byText(v.host, 'Delete'));
      if (retirement === 'selection-away-back')
        await act(async () => {
          sched.set({ selected: 'b' });
          sched.set({ selected: 'a' });
        });
      else if (retirement === 'editor') await act(async () => sched.set({ editing: { id: 'new' } }));
      else {
        await v.unmount();
        mounted = false;
      }
      gate.resolve();
      await flush();
      assert.equal(sched.get().selected, 'a');
      assert.deepEqual(
        calls.filter((c) => c[0] === 'delete' || c[0] === 'reload'),
        [['delete', 'a'], ['reload']],
      );
    } finally {
      if (mounted) await v.unmount();
    }
  });
}
test('delete: current completion clears selection; failure remains visible and retry works', async () => {
  reset();
  remove = async () => {
    throw new Error('delete failed');
  };
  const v = await render(h(StrictMode, null, view('detail')));
  try {
    await click(byText(v.host, 'Delete'));
    assert.equal(sched.get().selected, 'a');
    assert.deepEqual(
      calls.filter((c) => c[0] === 'toast'),
      [['toast', "Couldn't delete the task: delete failed", 'error']],
    );
    remove = async () => {};
    await click(byText(v.host, 'Delete'));
    assert.equal(sched.get().selected, null);
  } finally {
    await v.unmount();
  }
});
test('delete failure after disposal remains visible', async () => {
  reset();
  const gate = deferred<void>();
  remove = () => gate.promise;
  const v = await render(view('detail'));
  await click(byText(v.host, 'Delete'));
  await v.unmount();
  gate.reject(new Error('disk failed'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [['toast', "Couldn't delete the task: disk failed", 'error']],
  );
});
test('card: pending lookup preserves accepted run after disposal, without navigation', async () => {
  reset();
  const lookup = deferred<any>();
  list = () => lookup.promise;
  run = async () => 'late-run';
  const v = await render(view('card'));
  await click(byText(v.host, 'Run now'));
  await v.unmount();
  assert.equal(
    calls.some((c) => c[0] === 'run'),
    false,
  );
  lookup.resolve({ tasks: [a] });
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'run'),
    [['run', 'a']],
  );
  assert.equal(
    calls.some((c) => c[0] === 'navigate'),
    false,
  );
});
test('card: lookup rejection after disposal remains visible', async () => {
  reset();
  const lookup = deferred<any>();
  list = () => lookup.promise;
  const v = await render(view('card'));
  await click(byText(v.host, 'Run now'));
  await v.unmount();
  lookup.reject(new Error('lookup failed'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'toast'),
    [['toast', 'lookup failed', 'error']],
  );
});
test('unrelated list and store refreshes do not retire the current action', async () => {
  reset();
  const gate = deferred<string>();
  run = () => gate.promise;
  const v = await render(view('detail'));
  try {
    await click(byText(v.host, 'Run now'));
    await act(async () => {
      sched.set({ list: [a] });
      store.set({ prefs: { schedulerOff: true } });
    });
    gate.resolve('current');
    await flush();
    assert.deepEqual(store.get().route, { name: 'thread', id: 'current' });
  } finally {
    await v.unmount();
  }
});
for (const order of ['older-first', 'newer-first']) {
  test(`two cards retain both runs but latest clicked card owns navigation: ${order}`, async () => {
    reset();
    const older = deferred<string>();
    const newer = deferred<string>();
    let count = 0;
    run = () => (++count === 1 ? older.promise : newer.promise);
    list = async () => ({ tasks: [a, { ...a, id: 'b' }] });
    const v = await render(h('div', null, view('card'), view('card', { ...a, id: 'b' })));
    try {
      const cards = v.host.querySelectorAll('section');
      await click(byText(cards[0], 'Run now'));
      await click(byText(cards[1], 'Run now'));
      if (order === 'older-first') {
        older.resolve('old');
        await flush();
        assert.equal(
          calls.some((c) => c[0] === 'navigate'),
          false,
        );
        newer.resolve('new');
      } else {
        newer.resolve('new');
        await flush();
        older.resolve('old');
      }
      await flush();
      assert.deepEqual(
        calls.filter((c) => c[0] === 'run'),
        [
          ['run', 'a'],
          ['run', 'b'],
        ],
      );
      assert.deepEqual(
        calls.filter((c) => c[0] === 'navigate'),
        [['navigate', { name: 'thread', id: 'new' }]],
      );
    } finally {
      await v.unmount();
    }
  });
}

test('a status-only edit does not retire an already accepted Run now navigation', async () => {
  reset();
  const gate = deferred<string>();
  run = () => gate.promise;
  const v = await render(view('card'));
  try {
    await click(byText(v.host, 'Run now'));
    await click(byText(v.host, 'Resume'));
    assert.deepEqual(
      calls.filter((c) => c[0] === 'update'),
      [['update', 'a', { status: 'ACTIVE' }]],
    );
    assert.ok(byText(v.host, 'Pause'));
    assert.equal(
      calls.some((c) => c[0] === 'navigate'),
      false,
    );
    gate.resolve('accepted-run');
    await flush();
    assert.deepEqual(store.get().route, { name: 'thread', id: 'accepted-run' });
  } finally {
    await v.unmount();
  }
});
