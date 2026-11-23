// The new-chat "Turn on Worktree" suggestion (src/components/composer/WorktreeHint.tsx) and which chats run in a folder (src/session/chatRunning.ts).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement } from 'react';
import { fakeStore, popoverExports, render, click, flush } from './support/shell-chrome-kit.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const BASE = { threads: {}, runtime: {}, newChatWorktree: null, newChatWorktreeHintOff: null, prefs: { worktreeDefault: false } };
const store = fakeStore<any>(BASE);
const sessions = fakeStore<any>({ sessions: {} });
let lists: Record<string, any> = {};
const loads: string[] = [];
stubStore({
  useStore: store.useStore,
  setState: store.setState,
  newChatWorktreeOn: (s: any) => s.newChatWorktree ?? s.prefs.worktreeDefault === true,
  setNewChatWorktree: () => assert.fail('the suggestion never changes the saved default'),
});
mock.module('../src/store/session/useSession.ts', { namedExports: { flushSessionPatches: () => {}, useSessions: sessions.useStore } });
installNativeStub({
  git: {
    branches: async (p: string) => {
      loads.push(p);
      return lists[p] ?? null;
    },
  },
});
mock.module('../src/components/ui/Popover.tsx', { namedExports: popoverExports });
const { WorktreeHint } = await import('../src/components/composer/WorktreeHint.tsx');
const { chatRunning, runningInFolder, sessionBusy } = await import('../src/session/chatRunning.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');

const REPO = { current: 'main', default: 'main', branches: ['main'], commits: true };
const live = (turn: string) => ({ ...EMPTY_SESSION, rev: 3, turn });
const reset = (state: any = {}, sess: Record<string, any> = {}) => {
  store.reset({ ...BASE, ...state });
  sessions.reset({ sessions: sess });
  lists = { '/repo': REPO };
  loads.length = 0;
};
const hint = (path = '/repo') => createElement(WorktreeHint, { path });
const banner = (host: Element) => host.querySelector('.wt-hint') as HTMLElement | null;

test("chatRunning: main's session once it has one, else the native runtime or list status", () => {
  assert.equal(chatRunning(undefined, live('running') as any, undefined), true);
  assert.equal(chatRunning({ status: { type: 'active' } } as any, live('idle') as any, { activeTurnId: 't' } as any), false);
  assert.equal(chatRunning(undefined, EMPTY_SESSION, { activeTurnId: 't' } as any), true);
  assert.equal(chatRunning({ status: { type: 'active' } } as any, EMPTY_SESSION, undefined), true);
  assert.equal(chatRunning({ status: { type: 'idle' } } as any, EMPTY_SESSION, { activeTurnId: null } as any), false);
  assert.equal(chatRunning(undefined, EMPTY_SESSION, undefined), false);
});

test('sessionBusy: the chats main has a session for, busy while running or waiting on the user', () => {
  assert.deepEqual(sessionBusy({ a: live('running'), b: live('awaitingUser'), c: live('idle'), d: EMPTY_SESSION } as any), {
    a: true,
    b: true,
    c: false,
  });
});

test('runningInFolder: a turn under way, on any harness, in the folder itself', () => {
  const s = (threads: any, runtime: any = {}) => ({ threads, runtime });
  // Codex from its list status, Claude from main's session, ACP from the runtime; trailing slashes don't matter
  assert.equal(runningInFolder('/repo', s({ c: { id: 'c', cwd: '/repo', status: { type: 'active' } } }), {}), true);
  assert.equal(runningInFolder('/repo/', s({ cl: { id: 'cl', cwd: '/repo' } }), { cl: true }), true);
  assert.equal(runningInFolder('/repo', s({ a: { id: 'acp:kimi:1', cwd: '/repo//' } }, { 'acp:kimi:1': { activeTurnId: 't' } }), {}), true);
  // main's idle session wins over a stale list status; an id that is an Object.prototype key is still just an id
  assert.equal(runningInFolder('/repo', s({ cl: { id: 'cl', cwd: '/repo', status: { type: 'active' } } }), { cl: false }), false);
  assert.equal(runningInFolder('/repo', s({ x: { id: 'constructor', cwd: '/repo' } }), {}), false);
  // another folder, a worktree's folder, a subfolder, or no folder at all
  assert.equal(runningInFolder('/repo', s({ c: { id: 'c', cwd: '/other', status: { type: 'active' } } }), {}), false);
  assert.equal(runningInFolder('/repo', s({ c: { id: 'c', cwd: '/wt/ab12/repo', status: { type: 'active' } } }), {}), false);
  assert.equal(runningInFolder('/repo', s({ c: { id: 'c', cwd: '/repo/sub', status: { type: 'active' } } }), {}), false);
  assert.equal(runningInFolder('/repo', s({ c: { id: 'c', cwd: '', status: { type: 'active' } } }), {}), false);
  assert.equal(runningInFolder('/', s({ c: { id: 'c', cwd: '/', status: { type: 'active' } } }), {}), true);
});

test('another chat running in the folder: the suggestion turns Worktree on for this draft only', async () => {
  reset({ threads: { c: { id: 'c', cwd: '/repo' } } }, { c: live('running') });
  const { host, unmount } = await render(hint());
  await flush();
  assert.ok(banner(host));
  assert.equal(banner(host)!.querySelector('.fa-title')!.textContent, 'Turn on Worktree');
  await click(banner(host)!.querySelector('.fa-dont'));
  assert.equal(store.getState().newChatWorktree, true);
  assert.equal(store.getState().prefs.worktreeDefault, false, 'the saved default stays');
  assert.equal(banner(host), null, 'gone once Worktree is on');
  await unmount();
});

test('dismissing hides it for this folder only; it never shows with Worktree on, idle chats or a folder that has none', async () => {
  reset({ threads: { c: { id: 'c', cwd: '/repo' }, d: { id: 'd', cwd: '/repo2' } } }, { c: live('running'), d: live('running') });
  lists['/repo2'] = REPO;
  const { host, rerender, unmount } = await render(hint());
  await flush();
  await click(banner(host)!.querySelector('[aria-label="Dismiss"]'));
  assert.equal(store.getState().newChatWorktreeHintOff, '/repo');
  assert.equal(banner(host), null);
  await rerender(hint('/repo2'));
  await flush();
  assert.ok(banner(host), 'another folder still suggests it');
  // the saved default already on
  store.setState({ prefs: { worktreeDefault: true } });
  await flush();
  assert.equal(banner(host), null);
  store.setState({ prefs: { worktreeDefault: false } });
  await flush();
  assert.ok(banner(host));
  // the other chat finishing takes it away
  sessions.setState({ sessions: { d: live('idle') } });
  await flush();
  assert.equal(banner(host), null);
  await unmount();
});

test('a folder that is not a repository, or has no commits, never suggests it; nothing is read while no chat runs there', async () => {
  reset({ threads: { c: { id: 'c', cwd: '/plain' } } });
  lists['/empty'] = { current: 'main', default: null, branches: [], commits: false };
  const { host, rerender, unmount } = await render(hint('/plain'));
  await flush();
  assert.deepEqual(loads, [], 'no chat runs in the folder: no git call');
  sessions.setState({ sessions: { c: live('running') } });
  await flush();
  assert.deepEqual(loads, ['/plain']);
  assert.equal(banner(host), null);
  store.setState({ threads: { c: { id: 'c', cwd: '/empty' } } });
  await rerender(hint('/empty'));
  await flush();
  assert.equal(banner(host), null);
  await unmount();
});

test('runningInFolder indexes the chats by folder once per chat list, and a streamed frame only reads that folder', () => {
  const threads: any = {
    a: { id: 'a', cwd: '/repo/' },
    b: { id: 'b', cwd: '/repo/.worktrees/b' },
    c: { id: 'c', cwd: '/other' },
    d: { id: 'd' },
  };
  const running = (id: string) => ({ [id]: { activeTurnId: 't' } }) as any;
  assert.equal(runningInFolder('/repo', { threads, runtime: running('a') }, {}), true, 'a trailing slash is the same folder');
  assert.equal(runningInFolder('/repo', { threads, runtime: running('b') }, {}), false, 'a worktree is its own folder');
  assert.equal(runningInFolder('/repo', { threads, runtime: running('d') }, {}), false, 'a chat with no folder matches none');
  assert.equal(runningInFolder('/repo', { threads, runtime: running('c') }, {}), false);
  assert.equal(runningInFolder('/repo', { threads, runtime: {} }, { a: true }), true, "main's session wins over the native runtime");
  assert.equal(runningInFolder('/repo', { threads, runtime: running('a') }, { a: false }), false);
  assert.equal(runningInFolder('/nowhere', { threads, runtime: running('a') }, {}), false);
  // a chat added to the list is seen: the index belongs to the list object it was built from
  assert.equal(runningInFolder('/new', { threads: { ...threads, e: { id: 'e', cwd: '/new' } }, runtime: running('e') }, {}), true);
});
