// Required sidebar rows load hidden main sessions and follow their revisions without rendering again for streamed content.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/dom.ts';
import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { create } from 'zustand';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
import type { Thread } from '../src/store/types';

const snapshots = new Map<string, unknown>();
const calls: string[] = [];
let onPatch: (patch: unknown) => void;
installNativeStub({
  session: {
    snapshot: async (id: string) => {
      calls.push(id);
      return snapshots.get(id);
    },
    onPatch: (cb: typeof onPatch) => {
      onPatch = (patch) => {
        cb(patch);
        flushSessionPatches();
      };
    },
  },
});
const store = create<any>(() => ({
  threads: {},
  threadOrder: [],
  momoChats: {},
  runtime: {},
  pending: [],
  elsewhere: {},
  route: { name: 'home' },
}));
stubStore({ useStore: store });
const lineage = { children: {}, deliveries: {}, proposals: {}, queue: [] };
mock.module('../src/session/harness/claude/desktopLineage.ts', {
  namedExports: {
    useSidebarLineage: () => lineage,
    useFamilyLineage: () => lineage,
    sidebarLineageNow: () => lineage,
    familyLineageNow: () => lineage,
    useLineageStamp: () => '',
  },
});
const { useRequiredChats } = await import('../src/components/sidebar/useRequiredChats.ts');
const { useSessions, startSessions, flushSessionPatches } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
startSessions();
const snap = (rev: number, turn: typeof EMPTY_SESSION.turn) => ({ ...EMPTY_SESSION, rev, turn });
const chat = (id: string) => ({ id, cwd: '/repo', status: { type: 'idle' } }) as Thread;
let renders = 0;
function Probe({ roots }: { roots: Thread[] }) {
  const required = useRequiredChats(roots, null);
  renders++;
  return h('output', null, JSON.stringify([...required]));
}

test('hidden snapshots arriving after mount reveal work on every harness, with stable rendering while it streams', async () => {
  for (const id of ['codex-hidden', 'claude-hidden', 'acp:gemini:hidden']) {
    useSessions.setState({ sessions: {}, loaded: {} });
    calls.length = 0;
    const pending = deferred();
    snapshots.set(id, pending.promise);
    const roots = [chat(id)];
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(StrictMode, null, h(Probe, { roots }))));
      assert.deepEqual(calls, [id], 'Strict Mode coalesces the hidden-row read');
      assert.equal(host.textContent, '[]');
      await act(async () => pending.resolve(snap(1, 'running')));
      assert.equal(host.textContent, JSON.stringify([id]));
      const before = renders;
      for (let rev = 2; rev < 8; rev++) await act(async () => onPatch({ chatId: id, rev, patch: { turn: 'running' } }));
      assert.equal(renders, before, 'unchanged visibility does not render the list on each patch');
      await act(async () => onPatch({ chatId: id, rev: 8, patch: { turn: 'idle' } }));
      assert.equal(host.textContent, '[]');
      await act(async () => onPatch({ chatId: id, rev: 7, patch: { turn: 'running' } }));
      assert.equal(host.textContent, '[]', 'an obsolete activity patch cannot expand the fold again');
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('late hidden-session success or failure cannot expand a replacement list, and a failed read can retry on remount', async () => {
  for (const reject of [false, true]) {
    useSessions.setState({ sessions: {}, loaded: {} });
    calls.length = 0;
    const id = 'acp:provider:old\n"session"';
    const old = deferred();
    snapshots.set(id, old.promise);
    snapshots.set('new', snap(1, 'running'));
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      await act(async () => root.render(h(Probe, { roots: [chat(id)] })));
      assert.deepEqual(calls, [id], 'membership encoding preserves delimiters and quotes');
      await act(async () => root.render(h(Probe, { roots: [chat('new')] })));
      assert.equal(host.textContent, '["new"]');
      await act(async () => {
        if (reject) old.reject(new Error('snapshot failed'));
        else old.resolve(snap(1, 'running'));
      });
      assert.equal(host.textContent, '["new"]');
      snapshots.set(id, snap(2, 'running'));
      await act(async () => root.render(h(Probe, { roots: [chat(id)] })));
      assert.equal(host.textContent, JSON.stringify([id]));
      assert.equal(calls.filter((call) => call === id).length, reject ? 2 : 1);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('adapter task progress does not render unrelated lists or a list whose activity is unchanged', async () => {
  const { putAdapterTasks } = await import('../src/store/backgroundTasks.ts');
  const ids = Array.from({ length: 30 }, (_, i) => `idle-project-${i}`);
  const threads = Object.fromEntries(ids.map((id) => [id, chat(id)]));
  store.setState({ threads, threadOrder: ids, runtime: {}, pending: [], elsewhere: {}, route: { name: 'home' } });
  useSessions.setState({ sessions: Object.fromEntries(ids.map((id) => [id, snap(1, 'idle')])), loaded: {} });
  const host = document.createElement('div');
  const root = createRoot(host);
  const task = {
    id: 'task',
    type: 'local_bash',
    description: 'Server',
    status: 'running',
    summary: null,
    toolUseId: null,
    subagentType: null,
    workflowName: null,
    parentTaskId: null,
    ambient: false,
    startedAt: 1,
  };
  try {
    await act(async () => root.render(h('div', null, ...ids.map((id) => h(Probe, { key: id, roots: [threads[id]] })))));
    let before = renders;
    await act(async () => putAdapterTasks('unrelated-chat', [task]));
    await act(async () => putAdapterTasks('unrelated-chat', [{ ...task, summary: 'still working' }]));
    assert.equal(renders, before, 'no project owns the updated chat');
    await act(async () => putAdapterTasks(ids[0], [task]));
    assert.equal(renders - before, 1, 'starting work invalidates only its owning list');
    before = renders;
    await act(async () => putAdapterTasks(ids[0], [{ ...task, summary: 'still working' }]));
    assert.equal(renders, before, 'progress leaves the active-task membership unchanged');
    await act(async () => putAdapterTasks(ids[0], [{ ...task, status: 'completed' }]));
    assert.equal(renders - before, 1, 'settling work updates its owning list');
    assert.equal(host.querySelector('output')?.textContent, '[]');
  } finally {
    await act(async () => root.unmount());
    putAdapterTasks('unrelated-chat', []);
    putAdapterTasks(ids[0], []);
  }
});

test('a real external-write snapshot keeps running work visible after the local turn crashed', async () => {
  const require = createRequire(import.meta.url);
  const { SessionStore } = require('../electron/session/state.cjs');
  const { ExternalWrites } = require('../electron/session/contract/reconcile.cjs');
  const main = new SessionStore();
  const id = 'claude-crashed-then-external';
  main.patch(id, { turn: 'crashed' });
  const external = new ExternalWrites({ state: main, now: () => 1000, mtime: () => 1000 });
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    assert.equal(await external.reconcile(id, '/fixture', () => true), true);
    const snapshot = main.snapshot(id);
    assert.equal(snapshot.turn, 'crashed');
    assert.equal(snapshot.runningElsewhere, true);
    snapshots.set(id, snapshot);
    store.setState({ threads: { [id]: chat(id) }, threadOrder: [id], runtime: {}, pending: [], elsewhere: {}, route: { name: 'home' } });
    useSessions.setState({ sessions: {}, loaded: {} });
    await act(async () => root.render(h(Probe, { roots: [chat(id)] })));
    assert.equal(host.textContent, JSON.stringify([id]));
  } finally {
    external.forget(id);
    await act(async () => root.unmount());
  }
});
