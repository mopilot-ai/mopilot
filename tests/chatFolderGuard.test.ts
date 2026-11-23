// electron/session/chatFolderGuard.cjs: a turn in a chat whose folder was deleted is refused on every harness with a
// message that says so, instead of the harness failing to start there (the Claude Agent SDK's "libc" error).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { loadMain, unloadMain } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const { chatFolderGuard, missingFolderError } = require('../electron/session/chatFolderGuard.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController, queueItem } = require('../electron/session/controller.cjs');
after(() => unloadMain());

const gone = '/Users/me/.codex/worktrees/d343/mopilot';

const appState = () => ({ prefs: { worktreeRoot: '/wt', branchPrefix: 'codex/' } });
/** A guard over fake folders: `there` exist; restore answers from `restores` by folder. */
function fake(o: {
  folders: Record<string, string | null>;
  there?: string[];
  restores?: Record<string, any>;
  script?: string;
  exit?: number;
}) {
  const log: any[] = [];
  const there = new Set(o.there ?? []);
  const guard = chatFolderGuard({
    chatProject: async (id: string) => o.folders[id],
    state: appState,
    exists: (p: string) => there.has(p),
    restore: async (...a: any[]) => (log.push(['restore', ...a]), o.restores?.[a[0]] ?? { ok: false, error: 'Not a MoPilot worktree' }),
    setupScript: (repo: string) => (log.push(['setup', repo]), o.script ?? ''),
    runScript: async (cwd: string, script: string) => (
      log.push(['run', cwd, script]), { exitCode: o.exit ?? 0, output: 'npm ERR! gone\n' }
    ),
  });
  return { guard, log };
}

test('a deleted managed worktree comes back from its kept branch, with its setup script, before the turn starts', async () => {
  const restored = { ok: true, restored: true, branch: 'codex/d343', worktree: gone, path: gone, repo: '/repo' };
  const { guard, log } = fake({ folders: { a: gone }, restores: { [gone]: restored }, script: 'npm ci' });
  await guard({ chatId: 'a' });
  // the chat records no project: worktreeRestore reads it from the holder's marker
  assert.deepEqual(log, [
    ['restore', gone, '/wt', null, 'codex/'],
    ['setup', '/repo'],
    ['run', gone, 'npm ci'],
  ]);
  // no setup script: nothing runs; already there (another restore won): nothing to set up
  const quiet = fake({ folders: { a: gone }, restores: { [gone]: restored } });
  await quiet.guard({ chatId: 'a' });
  assert.deepEqual(
    quiet.log.map((x) => x[0]),
    ['restore', 'setup'],
  );
  const raced = fake({ folders: { a: gone }, restores: { [gone]: { ok: true, restored: false } } });
  await raced.guard({ chatId: 'a' });
  assert.deepEqual(
    raced.log.map((x) => x[0]),
    ['restore'],
  );
});

test('a folder that is there, or none read, goes on; a missing one that is not ours, or cannot come back, is refused by name', async () => {
  const { guard, log } = fake({
    folders: { here: '/here', none: null, other: '/gone/repo', branchless: gone },
    there: ['/here'],
    restores: { [gone]: { ok: false, error: 'The branch for this worktree (…/d343) is gone' } },
  });
  await guard({ chatId: 'here' });
  await guard({ chatId: 'none' });
  assert.deepEqual(log, []);
  await assert.rejects(guard({ chatId: 'other' }), { message: missingFolderError('/gone/repo') });
  assert.match(
    missingFolderError('/gone/repo'),
    /^This chat's folder no longer exists: "\/gone\/repo"\. Restore the folder, or continue in a new chat\.$/,
  );
  await assert.rejects(guard({ chatId: 'branchless' }), {
    message: missingFolderError(gone, 'The branch for this worktree (…/d343) is gone'),
  });
  assert.match(missingFolderError(gone, 'why'), /no longer exists: .*mopilot"\. Its worktree couldn't be restored: why\. Restore/);
  // a failure without a reason is still refused by name
  const silent = fake({ folders: { a: gone }, restores: { [gone]: { ok: false } } });
  await assert.rejects(silent.guard({ chatId: 'a' }), { message: missingFolderError(gone) });
});

test('a setup script that fails stops the turn with its output; restores of one folder at once share one attempt', async () => {
  const restored = { ok: true, restored: true, worktree: gone, repo: '/repo' };
  const failing = fake({ folders: { a: gone }, restores: { [gone]: restored }, script: 'npm ci', exit: 1 });
  await assert.rejects(failing.guard({ chatId: 'a' }), {
    message: "Restored this chat's worktree, but its setup script failed (exit 1): npm ERR! gone",
  });
  const { guard, log } = fake({ folders: { a: gone, b: gone }, restores: { [gone]: restored } });
  await Promise.all([guard({ chatId: 'a' }), guard({ chatId: 'b' })]);
  assert.equal(log.filter((x) => x[0] === 'restore').length, 1);
  // the next send after it is done checks again
  await guard({ chatId: 'a' });
  assert.equal(log.filter((x) => x[0] === 'restore').length, 2);
});

test('by default it reads the disk, restores through platform/git.cjs and the root under the home folder', async () => {
  const guard = chatFolderGuard({ chatProject: async () => '/no/such/folder/anywhere', state: () => null });
  await assert.rejects(guard({ chatId: 'x' }), { message: missingFolderError('/no/such/folder/anywhere') });
  await chatFolderGuard({ chatProject: async () => process.cwd(), state: () => null })({ chatId: 'x' });
});

test('on every harness the controller refuses the start, shows why, and never reaches the adapter', async () => {
  const kindOf = (id: string) => (id.startsWith('cl') ? 'claude' : id.startsWith('acp') ? 'acp:kimi' : 'codex');
  const rec = (id: string) => ({ id, segments: [{ kind: kindOf(id), nativeId: id }] });
  const ids = ['cx1', 'cl1', 'acp1'];
  const reached: string[] = [];
  const step = (what: string) => async (chatId: string) => (reached.push(`${what}:${chatId}`), { started: true });
  const results: any[] = [];
  const state = new SessionStore();
  const c = new ChatController({
    state,
    chats: { record: rec, records: new Map(ids.map((id) => [id, rec(id)])) },
    codex: { startTurn: step('codex'), startGoal: step('codex'), steer: step('codex') },
    claudeTurns: { startTurn: step('claude'), steer: step('claude'), crashed: () => {} },
    acpTurns: { startTurn: step('acp') },
    claude: { send: async () => true },
    acp: { send: async () => true },
    beforeDispatch: chatFolderGuard({ chatProject: async (id: string) => `/gone/${id}`, state: appState, exists: () => false }),
    onDispatchResult: (e: any) => void results.push([e.chatId, e.result.error]),
  });
  for (const id of ids) {
    const r = await c.start(id, queueItem({ text: 'why no PR status?' }));
    assert.equal(r.started, false);
    assert.equal(r.error, missingFolderError(`/gone/${id}`));
    assert.equal(state.get(id).turn, 'crashed');
    assert.equal(state.get(id).crashed, missingFolderError(`/gone/${id}`));
  }
  assert.deepEqual(reached, []);
  // background senders (peer messages, scheduled tasks, PR autofix) hear the same failure
  assert.deepEqual(
    results,
    ids.map((id) => [id, missingFolderError(`/gone/${id}`)]),
  );
});

test("main puts the guard on the controller, reading the chat's current folder", async () => {
  const restoreCalls: unknown[][] = [];
  const restoring = mock.method(require('../electron/platform/git.cjs'), 'worktreeRestore', async (...args: unknown[]) => {
    restoreCalls.push(args);
    return { ok: true, restored: false };
  });
  try {
    const h = await loadMain();
    await h.ready();
    const guard = h.one('ChatController').opts.beforeDispatch;
    assert.equal(typeof guard, 'function');
    // a chat main can't read a folder for is left to its harness
    await guard({ chatId: 'unknown-chat' });
    const chats = h.one('ChatsStore');
    chats.records.set('fork', { id: 'fork', segments: [{ kind: 'codex', nativeId: 'fork' }], meta: { worktreeOf: '/repo' } });
    chats.record = (id: string) => chats.records.get(id);
    h.one('CodexAdapter').folderOf = async () => gone;
    await guard({ chatId: 'fork' });
    assert.equal(restoreCalls.at(-1)?.[2], '/repo');
  } finally {
    restoring.mock.restore();
  }
});

/** A store like electron/platform/chats.cjs: every meta write commits a new record object. */
function recordStore(meta: object = {}) {
  const records = new Map<string, any>([['c', { segments: [{ kind: 'claude', nativeId: 's1' }], meta }]]);
  const store = {
    records,
    patchMeta: (id: string, patch: object) => (records.set(id, { ...records.get(id), meta: { ...records.get(id).meta, ...patch } }), true),
  };
  return store;
}

test('a meta write while the folder is read (a held goal, unread) keeps the send; a harness switch or new origin refuses it', async () => {
  // #3497 compared record objects, so Claude's Clear, which saves goalHeld just before it sends "/goal clear", was refused
  const run = async (change: (s: ReturnType<typeof recordStore>) => void, opts: { there?: boolean; meta?: object } = {}) => {
    const store = recordStore(opts.meta);
    const restores: unknown[][] = [];
    const guard = chatFolderGuard({
      chatProject: async () => (change(store), '/wt/a'),
      state: appState,
      chats: () => store,
      exists: () => opts.there ?? true,
      restore: async (...a: unknown[]) => (restores.push(a), change(store), { ok: true, restored: false }),
    });
    return { done: guard({ chatId: 'c' }), restores };
  };
  await (await run((s) => s.patchMeta('c', { goalHeld: { objective: 'make it SLOW' } }))).done;
  await (await run((s) => s.patchMeta('c', { unread: true }))).done;
  const changed = /This chat's project changed/;
  await assert.rejects(
    (await run((s) => s.records.set('c', { ...s.records.get('c'), segments: [{ kind: 'codex', nativeId: 't1' }] }))).done,
    changed,
  );
  await assert.rejects((await run((s) => s.patchMeta('c', { worktreeOf: '/other' }))).done, changed);
  await assert.rejects((await run((s) => s.records.delete('c'))).done, changed);
  // a missing folder restores through the same check: a meta write during the restore is no change either
  const missing = await run((s) => s.patchMeta('c', { pinned: true }), { there: false, meta: { worktreeOf: '/repo' } });
  await missing.done;
  assert.equal(missing.restores.length, 1);
});
