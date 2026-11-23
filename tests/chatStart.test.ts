// electron/platform/chatStart.cjs: main makes a chat with no window on any harness, in a folder or a worktree started
// from a chosen branch, as a fork where the harness has one; and the input id main gives a delivered item reaches the
// harness as its client id, carried through the queue (electron/session/contract/inputGuard.cjs, queueItem.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ChatStarter } = require('../electron/platform/chatStart.cjs');
const { clientIdOf } = require('../electron/session/contract/inputGuard.cjs');
const { queueItem } = require('../electron/session/queueItem.cjs');

function starter(over: any = {}) {
  const log: any[] = [];
  const s = new ChatStarter({
    prefs: () => ({ model: 'm', effort: 'high', branchPrefix: 'mp/' }),
    codexThread: async ({ cwd }: any) => (log.push(['thread', cwd]), { id: 'th1' }),
    claudeSession: (...a: any[]) => log.push(['claude', ...a]),
    acpSession: (...a: any[]) => log.push(['acp', ...a]),
    chats: { patchMeta: (...a: any[]) => (log.push(['meta', ...a]), true) },
    worktree: async (cwd: string, o: any) => (
      log.push(['worktree', cwd, o]), over.wt ?? { ok: true, path: `${cwd}/wt`, worktree: `${cwd}/wt`, repo: cwd }
    ),
    script: async () => ({ exitCode: 0, output: '' }),
    started: (e: any) => log.push(['started', e]),
    home: '/home/me',
    ...over,
  });
  return { s, log };
}

test('newWorktree starts from the branch asked for, and names what it is for when it cannot make one', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'chatstart-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  const { s, log } = starter();
  assert.deepEqual(await s.newWorktree(repo, { branch: 'feature/x', what: 'a linked session' }), { path: `${repo}/wt` });
  assert.deepEqual(log[0], [
    'worktree',
    repo,
    { prefix: 'mp/', root: path.join('/home/me', '.mopilot', 'worktrees'), branch: 'feature/x' },
  ]);
  const failing = starter({ wt: { ok: false, error: 'dirty' } });
  assert.equal(await failing.s.newWorktree(repo, { what: 'a linked session' }), null);
  assert.ok(!('branch' in failing.log[0][2]));
  // a folder that can't hold one says why, so a caller can tell it from a failure
  const plain = starter({ wt: { ok: false, unsupported: true, error: "This folder isn't a git repository" } });
  assert.deepEqual(await plain.s.newWorktree(repo), { unsupported: "This folder isn't a git repository" });
});

test('a Claude Code chat may continue a copy of another session in the same folder', () => {
  const { s, log } = starter();
  const id = s.startClaude('/repo', null, { forkFrom: 'sess-1' });
  assert.match(id, /^claude:/);
  assert.deepEqual(log[0], ['claude', id, { cwd: '/repo', forkFrom: 'sess-1' }]);
  const plain = s.startClaude('/repo', '/origin');
  assert.deepEqual(log[3], ['claude', plain, { cwd: '/repo' }]);
  assert.deepEqual(log[4], ['meta', plain, { worktreeOf: '/origin', config: { model: null, effort: null } }]);
});

test('a Claude chat main starts keeps the new-chat model and effort, so a later pick in another chat never moves it', () => {
  const own: any[] = [];
  const { s, log } = starter({
    prefs: () => ({ claudeSelection: { model: 'sonnet', effort: 'low', fast: true } }),
    claudeOwn: (...a: any[]) => own.push(a),
  });
  const id = s.startClaude('/repo', null);
  assert.deepEqual(log[1], ['meta', id, { config: { model: 'sonnet', effort: 'low' } }]);
  assert.deepEqual(own, [[id, { model: 'sonnet', effort: 'low' }]]);
  // a model or effort given for the chat (a linked session's, a scheduled task's) wins over the defaults
  const child = s.startClaude('/repo', null, { effort: 'high', permission: 'plan' });
  assert.deepEqual(log.at(-2), ['meta', child, { config: { model: 'sonnet', effort: 'high', permission: 'plan' } }]);
});

test('a Codex fork is announced like a new thread; without a fork hook it is refused', async () => {
  const params: any[] = [];
  const { s, log } = starter({ codexFork: async (p: any) => (params.push(p), { id: 'fork1' }) });
  assert.equal(await s.forkCodex('th0', '/repo/wt', '/repo'), 'fork1');
  assert.deepEqual(params, [{ threadId: 'th0', cwd: '/repo/wt', excludeTurns: true, deferGoalContinuation: true }]);
  assert.deepEqual(log[0], ['meta', 'fork1', { config: { model: 'm', effort: 'high', serviceTier: null }, worktreeOf: '/repo' }]);
  assert.deepEqual(log[1], [
    'started',
    { harness: 'codex', chatId: 'fork1', cwd: '/repo/wt', worktreeOf: '/repo', config: { model: 'm', effort: 'high', serviceTier: null } },
  ]);
  await assert.rejects(starter().s.forkCodex('th0', '/repo', null), /fork is not available/);
  const noPrefs = starter({ prefs: () => null, codexFork: async () => ({ id: 'f2' }) });
  await noPrefs.s.forkCodex('t', '/r', null);
  assert.deepEqual(noPrefs.log[0], ['meta', 'f2', { config: { model: null, effort: null, serviceTier: null } }]);
});

test('a delivered item keeps the id main gave it as the harness client id, through the queue; any other input gets a new one', () => {
  assert.equal(clientIdOf({ peer: { messageId: 'peer-1' }, sideSession: { id: 'x' } }), 'peer-1');
  assert.equal(clientIdOf({ sideSession: { id: 'wake-1' } }), 'wake-1');
  const a = clientIdOf({ text: 'typed' });
  assert.match(a, /^[0-9a-f-]{36}$/);
  assert.notEqual(clientIdOf(undefined), a);
  const q = queueItem({ id: 'wake-1', sideSession: { id: 'wake-1', extra: 1 }, text: 't', opts: { human: false } }, null);
  assert.deepEqual(q.sideSession, { id: 'wake-1' });
  assert.ok(!('sideSession' in queueItem({ text: 'typed', sideSession: { id: 5 } }, 'w')));
});

test('a linked Claude fork resumes an already persisted copy in its own worktree', async () => {
  const { s, log } = starter({ claudeFork: async (...a: any[]) => (log.push(['fork', ...a]), { sessionId: 'child-copy' }) });
  const id = await s.forkClaude('parent', '/repo/worktree', '/repo');
  assert.equal(id, 'claude:child-copy');
  assert.deepEqual(log[0], ['fork', 'parent', '/repo/worktree']);
  assert.deepEqual(log[1], ['claude', id, { cwd: '/repo/worktree', resume: true }]);
  assert.deepEqual(log[2], ['meta', id, { worktreeOf: '/repo', config: { model: null, effort: null } }]);
  // windows read the copied conversation when the chat opens, rather than showing it as a new, empty chat
  assert.deepEqual(log.at(-1), ['started', { harness: 'claude', chatId: id, cwd: '/repo/worktree', worktreeOf: '/repo', history: true }]);
  await assert.rejects(starter().s.forkClaude('parent', '/repo', null), /persistent fork is not available/);
});
