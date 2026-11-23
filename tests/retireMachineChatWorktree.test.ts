// Archiving or deleting a chat on a machine never retires a worktree on this Mac (src/store/actions.ts runArchive and runDelete read the chat's folder through src/lib/hostChats.ts chatFolderHere): its folder is the machine's path, which may also exist here (the same path on both), and this Mac's cleanup script, branch deletion and pruning are for this Mac's worktrees.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resolvedEnvironment, resetAll, flush, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
let allowed = true;
mock.module(new URL('../src/lib/host.ts', import.meta.url).href, {
  namedExports: { hostAllowedNow: () => allowed, useHostAccess: () => allowed, useHostAnswered: () => true },
});
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { resetHostChats } = await import('../src/lib/hostChats.ts');

const REMOTE = 'acp:host-claude:m1';
const LOCAL = 'acp:kimi:l1';
/** Which chats the machine list holds; a deleted chat is gone from it, as from main's ownership map. */
let owned: { chatId: string; hostId: string }[] = [];
const RETIRING = ['git.worktreeInfo', 'env.resolve', 'env.runScript', 'git.worktreeArchive', 'git.worktreePrune'];
const retired = () => RETIRING.flatMap((c) => callsOf(c).map(() => c));

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  resetHostChats();
  allowed = true;
  owned = [{ chatId: REMOTE, hostId: 'box' }];
  impl['host.remoteChats'] = async () => owned;
  impl['session.snapshot'] = async () => null;
  // the machine's folder is also a managed worktree here: the same path on both
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/a' });
  impl['env.resolve'] = async () => resolvedEnvironment({ cleanup: 'down' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  impl['api.threadArchive'] = async () => ({});
  impl['git.worktreeArchive'] = async () => ({ ok: true, removed: true, deleted: { branch: 'mopilot/a1' } });
  impl['git.worktreePrune'] = async () => [];
  impl['chats.delete'] = async () => {
    owned = [];
    return { remoteDeletionPending: false };
  };
  // no other chat works in the folder, so a chat of this Mac archived here would retire the worktree
  set({
    conn: 'ready',
    home: '/home/me',
    prefs: { ...st().prefs, deleteBranchOnArchive: true, autoDeleteWorktrees: true },
    threads: { [REMOTE]: { id: REMOTE, name: 'Remote', cwd: '/wt/a' } as any },
    threadOrder: [REMOTE],
  });
});

test('archiving a chat on a machine runs no cleanup script, deletes no branch and prunes nothing on this Mac', async () => {
  await S.archiveThread(REMOTE);
  await flush();
  assert.deepEqual(retired(), []);
  assert.deepEqual(st().threadOrder, []);
});

test('deleting a chat on a machine does the same, though the delete has already dropped its machine when the cleanup would run', async () => {
  await S.deleteThread(REMOTE);
  await flush();
  assert.equal(callsOf('chats.delete').length, 1);
  assert.deepEqual(retired(), []);
});

test('a chat of this Mac in the same folder is retired as before, with Host on or off', async () => {
  set({ threads: { [LOCAL]: { id: LOCAL, name: 'Local', cwd: '/wt/a' } as any }, threadOrder: [LOCAL] });
  await S.archiveThread(LOCAL);
  await flush();
  assert.deepEqual(callsOf('env.runScript'), [['/wt/a', 'down']]);
  assert.deepEqual(callsOf('git.worktreeArchive'), [['/wt/a']]);
  resetAll();
  allowed = false;
  set({ threads: { [REMOTE]: { id: REMOTE, name: 'Remote', cwd: '/wt/a' } as any }, threadOrder: [REMOTE] });
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/a' });
  impl['env.resolve'] = async () => resolvedEnvironment({ cleanup: 'down' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  impl['api.threadList'] = async () => ({ data: [], nextCursor: null });
  impl['git.worktreeArchive'] = async () => ({ ok: true, removed: true });
  impl['git.worktreePrune'] = async () => [];
  await S.archiveThread(REMOTE);
  await flush();
  assert.deepEqual(callsOf('env.runScript'), [['/wt/a', 'down']], 'without Host nothing is on a machine');
});

test('a chat with no folder, or one this window no longer lists, has no worktree to retire, whoever owns it', async () => {
  set({ threads: { [LOCAL]: { id: LOCAL, name: 'Local' } as any }, threadOrder: [LOCAL] });
  await S.archiveThread(LOCAL);
  await S.archiveThread('acp:kimi:gone');
  await S.deleteThread(LOCAL);
  await S.deleteThread('acp:kimi:gone');
  await flush();
  assert.deepEqual(retired(), []);
});
