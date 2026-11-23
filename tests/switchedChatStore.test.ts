// A chat that switched harness, store side (#1941): its fork goes through forkSwitchedChat (src/store/actions.ts
// forkThread), and switched chats Codex does not list stay in the sidebar (src/store/connection.ts loadThreads): a fork's
// Codex rollout holds no message of its own, so thread/list leaves out a switched chat's fork whose first part is Codex.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resetAll } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, resetState } = await loadStore();
const st = () => store.useStore.getState();
const set = store.useStore.setState;
const seg = (harness: string, nativeId: string) => ({ harness, nativeId, start: 0, count: null, model: null, handoff: null });

beforeEach(() => {
  resetAll();
  resetState();
});

test('a switched chat main holds but Codex does not list is read and listed; others are left out', async () => {
  set({
    claudeArchived: { gone: 1 },
    // forks made here; 'old' is a switched chat that is no fork (just past the first page): never read
    chatForkOf: {
      fork: 'src',
      listed: 'src',
      gone: 'src',
      'claude:k': 'src',
      'acp:kimi:1': 'src',
      lone: 'src',
      broken: 'src',
      nosegs: 'src',
    },
    segments: {
      old: [seg('codex', 'old'), seg('claude', 'claude:o')],
      fork: [seg('codex', 'fork'), seg('claude', 'claude:f')],
      listed: [seg('codex', 'listed'), seg('claude', 'claude:l')],
      gone: [seg('codex', 'gone'), seg('claude', 'claude:g')],
      'claude:k': [seg('claude', 'claude:k'), seg('codex', 'kx')],
      'acp:kimi:1': [seg('acp:kimi', 'acp:kimi:1'), seg('codex', 'ax')],
      lone: [seg('codex', 'lone')],
      broken: [seg('codex', 'broken'), seg('claude', 'claude:b')],
    } as any,
  });
  impl['api.threadList'] = async () => ({ data: [{ id: 'listed' }], nextCursor: null });
  impl['api.threadRead'] = async (id: string) => {
    if (id === 'broken') throw new Error('no rollout');
    return { thread: { id, name: `${id} (fork)` } };
  };
  await store.loadThreads();
  // only the unlisted, unarchived switched chat whose first part is Codex is read; one that can't be read stays out
  assert.deepEqual(
    callsOf('api.threadRead')
      .map(([id]) => id)
      .sort(),
    ['broken', 'fork'],
  );
  assert.deepEqual(st().threadOrder, ['fork', 'listed']);
  assert.equal(st().threads.fork.name, 'fork (fork)');
  // a next page reads nothing more
  await store.loadThreads(true);
  assert.equal(callsOf('api.threadRead').length, 2);
});

test('a fork archived while it was read stays out; nothing missing reads nothing', async () => {
  set({ chatForkOf: { fork: 'src' }, segments: { fork: [seg('codex', 'fork'), seg('claude', 'claude:f')] } as any });
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  impl['api.threadRead'] = async (id: string) => (set({ claudeArchived: { [id]: 1 } }), { thread: { id } });
  await store.loadThreads();
  assert.equal(st().threads.fork, undefined);
  resetAll();
  resetState();
  set({ segments: { listed: [seg('codex', 'listed'), seg('claude', 'claude:l')] } as any });
  impl['api.threadList'] = async () => ({ data: [{ id: 'listed' }], nextCursor: null });
  await store.loadThreads();
  assert.deepEqual(callsOf('api.threadRead'), []);
  assert.deepEqual(st().threadOrder, ['listed']);
});

test("a switched chat's fork forks every part itself, not through its current harness's fork", async () => {
  set({
    threads: { sw: { id: 'sw', name: 'chat' } as any },
    segments: { sw: [seg('codex', 'sw'), { ...seg('codex', 'sw2'), start: 1, handoff: { mode: 'auto', tokens: 1, text: 'h' } }] } as any,
  });
  impl['api.threadRename'] = async () => ({});
  impl['codex.fork'] = async (p: any) => ({ thread: { id: `${p.threadId}-f`, cwd: '/w' } });
  assert.equal(await store.forkThread('sw'), 'sw-f');
  assert.deepEqual(callsOf('run.runSemantic'), []);
  assert.deepEqual(
    st().segments['sw-f'].map((g: any) => g.nativeId),
    ['sw-f', 'sw2-f'],
  );
  assert.equal(st().threads['sw-f'].name, 'chat (fork)');
  assert.equal(st().chatForkOf['sw-f'], 'sw');
});
