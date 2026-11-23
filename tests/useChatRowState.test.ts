// src/session/useChatRowState.ts: a chat's row state read live from the stores, from the caller's record or the store's,
// and nothing while the window doesn't know the chat (a session just started, before its chat is listed).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/pages-kit.ts';
import { EMPTY_SESSION } from '../src/store/session/sessionState.ts';
import { stubStore } from './support/stubs.ts';
import { putAdapterTasks } from '../src/store/backgroundTasks.ts';
import { installNativeStub } from './support/ports/native.ts';

const { createElement: h, act } = await import('react');
const store = fakeStore<any>({ threads: {}, runtime: {}, pending: [], elsewhere: {}, unread: {}, agentTabs: {} });
stubStore({ useStore: store.useStore, chatOf: (id: string) => (id === 'native-kid' ? 'kid' : id) });
const empty = { children: {}, deliveries: {}, proposals: {}, queue: [], plans: {}, wrapUps: {} };
let notify: (view: any) => void = () => {};
installNativeStub({ orchestration: { snapshot: async () => empty, onChanged: (cb: any) => ((notify = cb), () => {}) } });
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();
const sessions = fakeStore<any>({ sessions: {} });
let session = EMPTY_SESSION;
const ensured: string[] = [];
let owner: string | undefined;
let loaded = false;
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: (id: string) => ((owner = id), session),
    useSessionField: (id: any, pick: any) => pick((((id: string) => ((owner = id), session)) as (id: any) => any)(id)),
    useSessionLoaded: () => loaded,
    refreshSession: async () => {},
    useSessions: sessions.useStore,
    ensureSession: (id: string) => void ensured.push(id),
  },
});
const { useChatRowState, useChatTurn } = await import('../src/session/useChatRowState.ts');

let read: any = null;
function Probe({ id, linked, own }: any) {
  read = useChatRowState(id, linked, own);
  return null;
}

test("a chat's row state from the store's record, the caller's own, or nothing for a chat not listed yet", async () => {
  const v = await render(h(Probe, { id: 'kid' }));
  assert.ok(read === null, 'not listed yet');
  await act(async () => store.setState({ threads: { kid: { id: 'kid', cwd: '/r' } }, unread: { kid: true } }));
  assert.deepEqual(read, { state: 'unread', elsewhere: undefined, backgroundRunning: false, attentionCount: 0 });
  await v.rerender(h(Probe, { id: 'kid', linked: { lastReport: { how: 'failed' } } }));
  assert.equal(read.state, 'failed');
  await v.rerender(h(Probe, { id: 'search-hit', own: { id: 'search-hit', cwd: '/r' } }));
  assert.equal(read.state, 'idle', "the caller's record, though the store doesn't list it");
  await v.unmount();
});

test('turn availability follows the requested chat snapshot, including revision zero', async () => {
  let turn: unknown;
  function TurnProbe({ id }: { id: string }) {
    turn = useChatTurn(id);
    return null;
  }
  const v = await render(h(TurnProbe, { id: 'parent' }));
  assert.equal(turn, null);
  session = { ...EMPTY_SESSION, turn: 'idle' };
  loaded = true;
  await v.rerender(h(TurnProbe, { id: 'parent' }));
  assert.equal(turn, 'idle');
  session = { ...session, turn: 'running' };
  await v.rerender(h(TurnProbe, { id: 'other' }));
  assert.equal(owner, 'other');
  assert.equal(turn, 'running');
  session = EMPTY_SESSION;
  loaded = false;
  await v.unmount();
});

// the sidebar's 30 streaming chats: a streamed frame replaces runtime[id].turns, and only a real state change re-renders a row
const ids = Array.from({ length: 30 }, (_, i) => `c${i}`);
const renders: Record<string, number> = {};
const seen: Record<string, string | undefined> = {};
function Row({ id }: { id: string }) {
  renders[id] = (renders[id] ?? 0) + 1;
  seen[id] = useChatRowState(id)?.state;
  return null;
}
const turn = (n: number, status = 'inProgress') => ({ id: 't', status, items: [{ n }] });
const live = (n: number) => ({ activeTurnId: 't', turns: [turn(n)], error: null });
const total = () => ids.reduce((sum, id) => sum + (renders[id] ?? 0), 0);

test('30 streaming chats: a streamed frame renders no row, a state change renders only its own', async () => {
  const threads = Object.fromEntries(ids.map((id) => [id, { id, cwd: '/r' }]));
  store.setState({ threads, runtime: Object.fromEntries(ids.map((id) => [id, live(0)])), pending: [], unread: {}, elsewhere: {} });
  sessions.setState({ sessions: {} });
  ensured.length = 0;
  const v = await render(
    h(
      'div',
      null,
      ids.map((id) => h(Row, { id, key: id })),
    ),
  );
  assert.equal(seen.c0, 'working');
  assert.equal(ensured.length, 30, 'each row asks main for its chat once');
  const before = total();
  for (let n = 1; n <= 20; n++)
    await act(async () =>
      store.setState((s: any) => ({ runtime: Object.fromEntries(ids.map((id) => [id, live(n)])), pending: [...s.pending] })),
    );
  assert.equal(total() - before, 0, 'before: every row rendered on every frame (30 x 20 renders)');

  // a session patch that changes no status (a rev bump with the turn still running) renders nothing
  await act(async () => sessions.setState({ sessions: { c3: { ...EMPTY_SESSION, rev: 1, turn: 'running' } } }));
  await act(async () => sessions.setState({ sessions: { c3: { ...EMPTY_SESSION, rev: 2, turn: 'running' } } }));
  assert.equal(total() - before, 0);
  assert.equal(seen.c3, 'working');

  // each transition updates exactly its row
  const only = async (id: string, change: () => void, state: string) => {
    const at = total();
    const own = renders[id];
    await act(async () => change());
    assert.equal(seen[id], state);
    assert.equal(renders[id] - own, 1, `${id} renders once for ${state}`);
    assert.equal(total() - at, 1, 'no other row renders');
  };
  await only(
    'c3',
    () => sessions.setState({ sessions: { c3: { ...EMPTY_SESSION, rev: 3, turn: 'awaitingUser', questions: [{ status: 'pending' }] } } }),
    'input',
  );
  await only('c3', () => sessions.setState({ sessions: { c3: { ...EMPTY_SESSION, rev: 4, turn: 'crashed' } } }), 'error');
  await only('c3', () => sessions.setState({ sessions: { c3: { ...EMPTY_SESSION, rev: 5, turn: 'idle' } } }), 'idle');
  await only(
    'c4',
    () =>
      store.setState((s: any) => ({
        unread: { ...s.unread, c4: true },
        runtime: { ...s.runtime, c4: { activeTurnId: null, turns: [turn(0, 'completed')], error: null } },
      })),
    'unread',
  );
  await only(
    'c5',
    () =>
      store.setState((s: any) => ({
        pending: [{ threadId: 'c5', method: 'item/commandExecution/requestApproval' }],
        runtime: { ...s.runtime, c5: live(21) },
      })),
    'approval',
  );
  await only(
    'c6',
    () => store.setState((s: any) => ({ runtime: { ...s.runtime, c6: { activeTurnId: null, turns: [turn(21, 'failed')], error: null } } })),
    'error',
  );
  await only('c7', () => putAdapterTasks('c7', [{ id: 'k', status: 'running' } as any]), 'working');
  putAdapterTasks('c7', []);
  await v.unmount();
});

test('rowRuntime shares one object per combination of flags, so lists of them compare equal while nothing changes', async () => {
  const { rowRuntime } = await import('../src/session/chatRowState.ts');
  assert.equal(rowRuntime(undefined), undefined);
  const a: any = { activeTurnId: 't', error: null, turns: [{ status: 'inProgress' }] };
  assert.equal(rowRuntime(a), rowRuntime({ ...a, turns: [{ status: 'inProgress' }, { status: 'inProgress' }] }));
  assert.deepEqual(rowRuntime(a), { activeTurnId: true, error: false, failed: false });
  assert.equal(rowRuntime({ activeTurnId: 't' } as any), rowRuntime(a), 'a runtime not loaded yet has no turns to fail');
  assert.deepEqual(rowRuntime({ activeTurnId: null, error: 'x', turns: [{ status: 'failed' }] } as any), {
    activeTurnId: false,
    error: true,
    failed: true,
  });
});

test('wrap-up and browser hand-off attention follows the owning chat across new turns and chat switches', async () => {
  store.setState({ threads: { kid: { id: 'kid', cwd: '/r' }, parent: { id: 'parent', cwd: '/r' } }, agentTabs: {} });
  sessions.setState({ sessions: {} });
  const v = await render(h(Probe, { id: 'kid' }));
  await act(async () => notify({ ...empty, wrapUps: { parent: { ask: 'Parent?' } } }));
  assert.equal(read.attentionCount, 0);
  await act(async () => notify({ ...empty, wrapUps: { kid: { ask: 'Child?' } } }));
  assert.equal(read.attentionCount, 1);
  assert.equal(read.state, 'input');
  await act(async () => sessions.setState({ sessions: { kid: { ...EMPTY_SESSION, rev: 1, turn: 'running' } } }));
  assert.equal(read.attentionCount, 0);
  await act(async () => notify(empty));
  await act(async () => sessions.setState({ sessions: { kid: { ...EMPTY_SESSION, rev: 2 } } }));
  await act(async () => store.setState({ agentTabs: { 'native-kid': [{ signin: { url: 'https://example.test' } }] } }));
  assert.equal(read.attentionCount, 1, 'a hand-off reported under the native segment still belongs to its stable chat');
  await v.rerender(h(Probe, { id: 'parent' }));
  assert.equal(read.attentionCount, 0);
  await v.rerender(h(Probe, { id: 'kid' }));
  await act(async () => store.setState({ agentTabs: {} }));
  assert.equal(read.attentionCount, 0);
  await v.unmount();
});
