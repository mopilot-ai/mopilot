// src/store/store.ts: chat actions — stop, goals, rename, archive, delete, fork, review, tasks and shell commands.
import { test, mock, beforeEach, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, callsOf, impl, resolvedEnvironment, listeners, resetAll, flush, bootImpls } from './support/store-harness.ts';
import * as lifecycle from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store, sessions, resetState } = await loadStore();
const S = store;
const panes = await import('../src/store/panes.ts');
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const { noteOwner } = await import('../src/harness/ownership.ts');
const { retireWorktree } = await import('../src/store/projects.ts');
const texts = () => st().toasts.map((t) => t.text);
noteOwner('cl', 'claude');

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  lifecycle.resetDeletionLifetime();
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('interrupt stops the running turn on the chat harness; a pending Codex one waits for its turn id (an ACP or Claude chat still starting stops at once)', async () => {
  set({
    runtime: {
      none: { activeTurnId: null } as any,
      pend: { activeTurnId: 'pending-1', turns: [] } as any,
      'acp:k:1': { activeTurnId: 't' } as any,
      'acp:k:2': { activeTurnId: 'pending-2' } as any,
      cl: { activeTurnId: 'pending-3' } as any,
      cx: { activeTurnId: 't' } as any,
    },
  });
  await S.interrupt('none');
  await S.interrupt('missing');
  await S.interrupt('pend');
  await S.interrupt('acp:k:1');
  // still starting its agent or CLI (cl): main keeps the prompt from going
  await S.interrupt('acp:k:2');
  await S.interrupt('cl');
  await S.interrupt('cx');
  assert.deepEqual(
    [callsOf('acp.acpInterrupt'), callsOf('claude.claudeStop'), callsOf('sem.pauseCodexGoal')],
    [[['acp:k:1'], ['acp:k:2']], [['cl']], [['cx']]],
  );
});

test('setGoalState notifies from the one window whose report changed main, when a running goal ends', async () => {
  set({ threads: { g: { id: 'g', name: 'Goal chat' } as any } });
  sessions.useSessions.setState({ sessions: { g: { ...sessions.sessionOf('g'), rev: 2, goal: { status: 'active' } as any } } });
  impl['session.patch'] = async () => true;
  assert.equal(await S.setGoalState('g', { status: 'complete', objective: 'o' } as any), true);
  assert.deepEqual(
    callsOf('app.notify').map(([k, id, o]) => [k, id, o.body, o.status]),
    [['goal', 'g', 'Goal complete', 'complete']],
  );
  // already so in main, or nothing worth saying
  sessions.useSessions.setState({ sessions: { g: { ...sessions.sessionOf('g'), rev: 2, goal: { status: 'active' } as any } } });
  impl['session.patch'] = async () => false;
  assert.equal(await S.setGoalState('g', { status: 'complete' } as any), false);
  impl['session.patch'] = async () => true;
  await S.setGoalState('g', { status: 'paused' } as any);
  assert.equal(callsOf('app.notify').length, 1);
  // loadGoal reads Codex's goal; a failure is ignored
  impl['api.threadGoal'] = async () => ({});
  await S.loadGoal('g');
  impl['api.threadGoal'] = () => Promise.reject(new Error('x'));
  await S.loadGoal('g');
  await flush();
  assert.deepEqual(callsOf('session.patch').at(-1), ['g', { goal: null }]);
});

test('goal, compact, rename and fork semantics run, or say why they cannot', async () => {
  const ran: any[] = [];
  impl['run.runSemantic'] = async (chat: string, sem: string, args: string) => (
    ran.push([chat, sem, args]), sem === 'compact' ? { ok: false, state: 'disabled', why: null } : { ok: true, value: `${sem}:${args}` }
  );
  impl['run.refusalText'] = (_r: any, sem: string) => `no ${sem}`;
  await S.pauseGoal('c');
  await S.resumeGoal('c');
  await S.clearGoal('c');
  await S.clearGoal('c', true);
  await S.extendGoal('c');
  await S.setGoalBudget('c', 5000);
  await S.setGoalBudget('c', null);
  await S.editGoal('c', 'new aim');
  assert.equal(await S.compactThread('c'), false);
  assert.equal(await S.forkThread('c'), 'fork:');
  assert.deepEqual(
    ran.map((r) => r.slice(1).join(' ')),
    [
      'goal pause',
      'goal resume',
      'goal clear',
      'goal clear human',
      'goal extend',
      'goal budget 5000',
      'goal budget none',
      'goal edit new aim',
      'compact ',
      'fork ',
    ],
  );
  assert.deepEqual(texts(), ['no compact']);
  // a basic harness's chat asks its caps too: compaction it lists runs, the rest say why
  set({ segments: { k: [{ nativeId: 'acp:kimi:1', harness: 'codex', start: 0 }] as any } });
  impl['run.runSemantic'] = async (chat: string, sem: string, args: string) => (
    ran.push([chat, sem, args]), sem === 'compact' ? { ok: true, value: 'sent' } : { ok: false, state: 'absent', why: null }
  );
  await S.compactThread('k');
  assert.equal(await S.forkThread('k'), undefined);
  assert.deepEqual(ran.slice(10), [
    ['k', 'compact', ''],
    ['k', 'fork', ''],
  ]);
  assert.deepEqual(texts().slice(1), ['no fork']);
});

test('showGoal says what the goal is', async () => {
  await S.showGoal(null);
  impl['api.threadGoal'] = async () => ({ goal: { status: 'active', objective: 'ship' } });
  impl['session.patch'] = async () => true;
  await S.showGoal('s');
  assert.deepEqual(texts(), ['No goal set. Use /goal <objective> to set one.', 'Goal (active): ship']);
});

test('renameThread names the chat through its harness', async () => {
  impl['run.runSemantic'] = async () => ({ ok: true });
  set({ threads: { a: { id: 'a', name: 'old' } as any } });
  await S.renameThread('a', 'New');
  await S.renameThread('acp:k:1', 'Kimi');
  assert.deepEqual(callsOf('run.runSemantic')[0], ['a', 'rename', 'New']);
  assert.deepEqual(callsOf('acp.acpRename'), [['acp:k:1', 'Kimi']]);
  assert.equal((st().threads.a as any).name, 'New');
  assert.equal((st().threads['acp:k:1'] as any).name, 'Kimi');
  // refused: said, and the name stays
  impl['run.runSemantic'] = async () => ({ ok: false });
  impl['run.refusalText'] = (_r: any, sem: string) => `no ${sem}`;
  await S.renameThread('a', 'Refused');
  assert.equal((st().threads.a as any).name, 'New');
  assert.equal(st().toasts.at(-1)?.text, 'no rename');
});

test('renaming a switched chat renames its first native session, on the harness that holds it', async () => {
  const { registerSemantic } = await import('../src/harness/adapters/semantics.ts');
  const renamed: unknown[][] = [];
  registerSemantic('claude', 'rename', ({ chatId, args }) => void renamed.push(['claude', chatId, args]));
  registerSemantic('codex', 'rename', ({ chatId, args }) => void renamed.push(['codex', chatId, args]));
  noteOwner('claude:s1', 'claude');
  const seg = (harness: string, nativeId: string, start: number) => ({ harness, nativeId, start }) as any;
  set({
    threads: { 'claude:s1': { id: 'claude:s1', name: 'a' } as any, cx1: { id: 'cx1', name: 'b' } as any },
    // a Claude chat now on Codex, and a Codex chat now on Claude Code
    segments: { 'claude:s1': [seg('claude', 's1', 0), seg('codex', 'cx9', 2)], cx1: [seg('codex', 'cx1', 0), seg('claude', 's9', 1)] },
  });
  const asked = callsOf('run.runSemantic').length;
  await S.renameThread('claude:s1', 'On Codex now');
  await S.renameThread('cx1', 'On Claude now');
  assert.deepEqual(renamed, [
    ['claude', 'claude:s1', 'On Codex now'],
    ['codex', 'cx1', 'On Claude now'],
  ]);
  assert.equal(callsOf('run.runSemantic').length, asked, 'not through the current segment');
  assert.equal((st().threads['claude:s1'] as any).name, 'On Codex now');
  assert.equal((st().threads.cx1 as any).name, 'On Claude now');
});

test('retiring a worktree counts the open chats past the loaded pages, and leaves one another chat still uses', async () => {
  const pages: Record<string, any> = {
    p2: { data: [{ id: 'old', cwd: '/wt/old' }, { id: 'gone', cwd: '/wt/gone' }, { id: 'nocwd' }], nextCursor: 'p3' },
    p3: { data: [{ id: 'older', cwd: '/wt/older/app' }], nextCursor: null },
  };
  set({
    home: '/home/me',
    threads: { a: { id: 'a', cwd: '/wt/a' } as any, fork: { id: 'fork', cwd: '/wt/f/app/src' } as any },
    threadsCursor: 'p2',
    claudeArchived: { gone: 1 },
  });
  impl['api.threadList'] = async (p: any) => pages[p.cursor];
  impl['env.resolve'] = async () => resolvedEnvironment({ cleanup: 'down' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/x' });
  await retireWorktree('/wt/x');
  // the chats Codex lists past the sidebar's 100 keep their worktrees; an archived one doesn't
  assert.deepEqual(callsOf('git.worktreePrune').at(-1), [
    '/home/me/.mopilot/worktrees',
    15,
    ['/wt/a', '/wt/f/app/src', '/wt/old', '/wt/older/app'],
  ]);
  assert.deepEqual(callsOf('env.runScript'), [['/wt/x', 'down']]);
  // a fork still works in the worktree: no cleanup script, nothing pruned
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/f/app' });
  await retireWorktree('/wt/f/app');
  assert.equal(callsOf('env.runScript').length, 1);
  assert.equal(callsOf('git.worktreePrune').length, 1);
  // the rest can't be listed: its cleanup runs, but nothing is pruned
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/y' });
  impl['api.threadList'] = () => Promise.reject(new Error('Codex is not connected'));
  await retireWorktree('/wt/y');
  assert.deepEqual(callsOf('env.runScript').at(-1), ['/wt/y', 'down']);
  assert.equal(callsOf('git.worktreePrune').length, 1);
  // nor when the pages never end
  impl['api.threadList'] = async () => ({ data: [], nextCursor: 'again' });
  await retireWorktree('/wt/y');
  assert.equal(callsOf('api.threadList').length, 2 + 2 + 1 + 200);
  assert.equal(callsOf('git.worktreePrune').length, 1);
});

test('archiveThread hides the chat everywhere, cleans its worktree up, and Undo brings it back', async () => {
  set({
    conn: 'ready',
    home: '/home/me',
    route: { name: 'thread', id: 'a' } as any,
    threads: { a: { id: 'a', name: 'Alpha', cwd: '/wt/a' } as any, b: { id: 'b', cwd: '/w/b' } as any, c: { id: 'c' } as any },
    threadOrder: ['a', 'b'],
    archived: [{ id: 'a', old: true } as any],
  });
  impl['git.worktreeInfo'] = async () => ({ repo: '/w/repo', path: '/wt/a' });
  impl['env.resolve'] = async () => resolvedEnvironment({ setup: 's', cleanup: 'rm -rf build' });
  impl['env.runScript'] = async () => ({ exitCode: 1, output: 'fail' });
  impl['api.threadArchive'] = () => Promise.reject(new Error('x'));
  await S.archiveThread('a');
  await flush();
  assert.deepEqual(st().threadOrder, ['b']);
  assert.equal(st().threads.a, undefined);
  assert.ok(st().claudeArchived.a);
  assert.deepEqual(st().route, { name: 'home' });
  assert.deepEqual(
    st().archived.map((t: any) => [t.id, !!t.old]),
    [['a', false]],
  );
  assert.deepEqual(callsOf('env.runScript'), [['/wt/a', 'rm -rf build']]);
  assert.deepEqual(callsOf('git.worktreePrune'), [['/home/me/.mopilot/worktrees', 15, ['/w/b']]]);
  assert.equal(callsOf('api.threadArchive').length, 1);
  assert.deepEqual(texts(), ['Archived “Alpha”', 'Cleanup script failed (exit 1): fail']);
  // Undo: restored from Codex
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: false });
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'a', name: 'Alpha' } });
  st().toasts[0].action!.run();
  await flush();
  assert.deepEqual(st().threadOrder, ['a', 'b']);
  assert.equal(st().claudeArchived.a, undefined);
  // Undo failing says so
  set({ toasts: [] });
  impl['api.threadArchive'] = async () => ({});
  await S.archiveThread('c');
  impl['git.worktreeRestore'] = () => Promise.reject(new Error('x'));
  const err = mock.method(console, 'error', () => {});
  impl['api.threadUnarchive'] = async () => null;
  impl['api.threadList'] = () => Promise.reject(new Error('x'));
  st().toasts[0].action!.run();
  await flush();
  err.mock.restore();
  // a Claude chat, a chat that isn't loaded, and auto-delete off
  set({ toasts: [], prefs: { ...st().prefs, autoDeleteWorktrees: false }, threads: { cl: { id: 'cl', cwd: '/x' } as any } });
  impl['env.resolve'] = async () => resolvedEnvironment({ setup: 's' });
  await S.archiveThread('cl');
  await S.archiveThread('missing');
  await flush();
  assert.equal(callsOf('api.threadArchive').length, 3);
  assert.equal(callsOf('git.worktreePrune').length, 1);
  assert.deepEqual(texts(), ['Archived “New chat”', 'Archived “New chat”']);
  // not a managed worktree: no cleanup
  impl['git.worktreeInfo'] = async () => null;
  await S.archiveThread('acp:k:2');
  impl['acp.loadAcpThreads'] = () => {
    throw new Error('restore failed');
  };
  st().toasts.at(-1)!.action!.run();
  await flush();
  assert.equal(texts().at(-1), "Couldn't restore chat: restore failed");
  impl['acp.loadAcpThreads'] = () => {
    throw 'plain';
  };
  st().toasts.at(-2)!.action!.run();
  await flush();
  assert.equal(texts().at(-1), "Couldn't restore chat: plain");
});

test("archiving a Claude Code or basic harness chat keeps only Sage's archive: Codex is never asked", async () => {
  set({ threads: { cl: { id: 'cl', name: 'C' } as any, 'acp:k:9': { id: 'acp:k:9', name: 'K' } as any } });
  await S.archiveThread('cl');
  await S.archiveThread('acp:k:9');
  assert.equal(callsOf('api.threadArchive').length, 0);
  assert.ok(st().claudeArchived.cl && st().claudeArchived['acp:k:9']);
});

test('archiveThread still archives when the worktree cleanup or forgetting desktop access fails', async () => {
  set({ conn: 'ready', threads: { f: { id: 'f', name: 'Failing', cwd: '/wt/f' } as any }, threadOrder: ['f'] });
  impl['git.worktreeInfo'] = () => Promise.reject(new Error('no git'));
  impl['computer.forget'] = () => Promise.reject(new Error('no helper'));
  await S.archiveThread('f');
  await flush();
  assert.deepEqual(st().threadOrder, []);
  assert.deepEqual(callsOf('computer.forget'), [['f']]);
  assert.deepEqual(texts(), ['Archived “Failing”']);
});

test('unarchiveThread recreates a removed worktree and lists the chat again on its harness', async () => {
  set({
    home: '/home/me',
    worktreeOf: { u1: '/repo' },
    archived: [
      { id: 'u1', cwd: '/wt/u1' },
      { id: 'cl', cwd: '/wt/cl' },
      { id: 'acp:k:1' },
      { id: 'u3', cwd: '/wt/u3' },
      { id: 'u4', cwd: '/wt/u4' },
    ] as any,
    claudeArchived: { u1: 1, cl: 1, 'acp:k:1': 1 },
  });
  impl['git.worktreeRestore'] = async (cwd: string) =>
    cwd === '/wt/u1'
      ? { ok: true, restored: true, branch: 'b1', worktree: '/wt/u1' }
      : cwd === '/wt/cl'
        ? { ok: true, restored: true, branch: 'b2', worktree: '/wt/cl', repo: '/r' }
        : cwd === '/wt/u3'
          ? { ok: false, error: 'Not a MoPilot worktree' }
          : { ok: false, error: 'branch gone' };
  impl['env.resolve'] = async () => resolvedEnvironment({ setup: 'go' });
  impl['env.runScript'] = async () => ({ exitCode: 0, output: '' });
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'u1' } });
  await S.unarchiveThread('u1');
  // Settings' branch prefix names the kept branch
  assert.deepEqual(callsOf('git.worktreeRestore')[0], ['/wt/u1', '/home/me/.mopilot/worktrees', '/repo', 'mopilot/']);
  assert.deepEqual(
    callsOf('env.runScript').map(([d]) => d),
    ['/wt/u1'],
  );
  assert.deepEqual(callsOf('env.resolve')[0], ['/repo']);
  await S.unarchiveThread('cl');
  assert.deepEqual(callsOf('env.resolve')[1], ['/r']);
  await S.unarchiveThread('acp:k:1');
  assert.equal(callsOf('claude.loadClaudeThreads').length, 1);
  assert.equal(callsOf('acp.loadAcpThreads').length, 1);
  await S.unarchiveThread('u3');
  await S.unarchiveThread('u4');
  assert.deepEqual(texts(), ['Restored worktree on b1', 'Restored worktree on b2', "Couldn't restore this chat's worktree: branch gone"]);
  assert.deepEqual(st().claudeArchived, {});
  assert.deepEqual(st().archived, []);
  // a chat with no worktree record: restore keyed on the folder
  set({ archived: [{ id: 'u5', cwd: '/wt/u5' }] as any });
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: true, branch: 'b5', worktree: '/wt/u5' });
  await S.unarchiveThread('u5');
  assert.deepEqual(callsOf('env.resolve').at(-1), ['/wt/u5']);
  impl['git.worktreeRestore'] = async () => ({ ok: false });
  set({ archived: [{ id: 'u6', cwd: '/wt/u6' }] as any });
  await S.unarchiveThread('u6');
  assert.equal(texts().length, 4);
});

test('unarchiveThread keeps a chat Codex would not unarchive in the archived list and rejects with why', async () => {
  const restoreFailed = "Couldn't restore this chat's worktree: no IPC";
  // the worktree restore request itself failing is reported like a failed restore, and the chat still comes back
  set({ archived: [{ id: 'w1', cwd: '/wt/w1' }] as any, claudeArchived: { w1: 5 } });
  impl['git.worktreeRestore'] = () => Promise.reject(new Error('no IPC'));
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'w1' } });
  await S.unarchiveThread('w1');
  assert.deepEqual(texts(), [restoreFailed]);
  assert.ok(st().threads.w1);
  set({ archived: [{ id: 'w2', cwd: '/wt/w2' }] as any, toasts: [] });
  impl['git.worktreeRestore'] = () => Promise.reject('plain');
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'w2' } });
  await S.unarchiveThread('w2');
  assert.deepEqual(texts(), ["Couldn't restore this chat's worktree: plain"]);
  set({ toasts: [] });
  // Codex refuses and still lists it as archived: nothing changes (no worktree rebuilt), and the caller is told why
  impl['git.worktreeRestore'] = async () => ({ ok: true, restored: true, branch: 'b', worktree: '/wt/k1' });
  impl['api.threadUnarchive'] = () => Promise.reject(new Error('archive locked'));
  impl['api.threadList'] = async (p: any) => ({ data: p.archived ? [{ id: 'k1' }] : [], nextCursor: null });
  set({ archived: [{ id: 'k1', cwd: '/wt/k1' }, { id: 'other' }] as any, claudeArchived: { k1: 7 } });
  const restores = callsOf('git.worktreeRestore').length;
  await assert.rejects(S.unarchiveThread('k1'), /archive locked/);
  assert.deepEqual(
    st().archived.map((t: any) => t.id),
    ['k1', 'other'],
  );
  assert.deepEqual(st().claudeArchived, { k1: 7 });
  assert.equal(callsOf('git.worktreeRestore').length, restores);
  assert.deepEqual(callsOf('api.threadList').at(-1), [{ limit: 200, archived: true, sortKey: 'updated_at' }]);
  // Codex can't say either: treated as still archived, so nothing is lost
  impl['api.threadList'] = () => Promise.reject(new Error('down'));
  await assert.rejects(S.unarchiveThread('k1'), /archive locked/);
  assert.deepEqual(st().claudeArchived, { k1: 7 });
  assert.deepEqual(callsOf('app.ignored').at(-1), ['list the chats Codex has archived', 'down']);
  // Codex had not archived it (its archive is only kept in step): it comes back, the refusal only recorded
  impl['api.threadList'] = async (p: any) => ({ data: p.archived ? [] : [{ id: 'k1' }], nextCursor: null });
  await S.unarchiveThread('k1');
  assert.ok(st().threads.k1);
  assert.deepEqual(st().claudeArchived, {});
  assert.deepEqual(
    st().archived.map((t: any) => t.id),
    ['other'],
  );
  assert.equal(callsOf('git.worktreeRestore').length, restores + 1);
  assert.deepEqual(callsOf('app.ignored').at(-1), ['unarchive the chat in Codex too', 'archive locked']);
  // a second click while it runs joins the first
  let release!: () => void;
  impl['api.threadUnarchive'] = () => new Promise((r) => (release = () => r({ thread: { id: 'k2' } })));
  set({ archived: [{ id: 'k2' }] as any });
  const first = S.unarchiveThread('k2');
  assert.equal(S.unarchiveThread('k2'), first);
  release();
  await first;
  assert.equal(callsOf('api.threadUnarchive').filter(([id]) => id === 'k2').length, 1);
  assert.ok(st().threads.k2);
  impl['api.threadUnarchive'] = async () => ({ thread: { id: 'k2' } });
  await S.unarchiveThread('k2');
  assert.equal(callsOf('api.threadUnarchive').filter(([id]) => id === 'k2').length, 2, 'a later click runs again');
});

test('deleteThread delegates whole-chat identity to main and applies its successful receipt', async () => {
  set({
    threads: { d: { id: 'd', cwd: '/wt/d' } as any, cl: { id: 'cl' } as any },
    threadOrder: ['d', 'cl'],
    archived: [{ id: 'd' }] as any,
    claudeArchived: { d: 1, cl: 1 },
    segments: {
      d: [
        { nativeId: 'd', harness: 'codex', start: 0 },
        { nativeId: 'c2', harness: 'claude', start: 1 },
        { nativeId: 'x3', harness: 'codex', start: 2 },
        { nativeId: 'c2', harness: 'claude', start: 3 },
      ] as any,
    },
  });
  impl['chats.delete'] = async (id: string) => lifecycle.deleteReceipt(id, id === 'd' ? ['d', 'c2', 'x3'] : [id]);
  impl['git.worktreeInfo'] = () => Promise.reject(new Error('x'));
  await S.deleteThread('d');
  assert.deepEqual(callsOf('chats.delete'), [['d']]);
  assert.deepEqual([st().threadOrder, st().archived, st().segments, st().claudeArchived], [['cl'], [], {}, { cl: 1 }]);
  await S.deleteThread('cl');
  await S.deleteThread('acp:k:1');
  assert.deepEqual(callsOf('chats.delete'), [['d'], ['cl'], ['acp:k:1']]);
  assert.deepEqual(st().claudeArchived, {});
  assert.equal(callsOf('git.worktreeInfo').length, 1);
});

test('a side chat forks into the pane, held and loaded, with the selection as its draft', async () => {
  impl['codex.fork'] = async () => ({ thread: { id: 'side', ephemeral: true } });
  // from the chat on screen: the side chat opens in its pane (another chat's would be parked with it)
  set({ route: { name: 'thread', id: 'main' } });
  assert.equal(await S.openSideChat('main', 'picked'), 'side');
  assert.deepEqual(callsOf('codex.fork'), [[{ threadId: 'main', excludeTurns: true, ephemeral: true }, true]]);
  assert.equal(st().runtime.side.loaded, true);
  assert.deepEqual(st().drafts.side.attachments, [S.selectionAttachment('picked')]);
  assert.deepEqual(
    st().paneTabs.map((t) => [t.kind, t.threadId]),
    [['chat', 'side']],
  );
  assert.ok(st().threads.side);
  // held: opening it doesn't read it from disk
  await S.openThread('side');
  assert.equal(callsOf('api.threadTurns').length, 0);
});

test('background terminals: listed for Codex chats, stopped under the lease', async () => {
  impl['api.backgroundTerminals'] = async () => ({ data: [{ processId: 7, command: 'npm run dev', itemId: 'i', cwd: '/w', osPid: 9 }] });
  assert.deepEqual(await S.listBackgroundTerminals('cx'), [{ itemId: 'i', processId: '7', command: 'npm run dev', cwd: '/w', osPid: 9 }]);
  impl['api.backgroundTerminals'] = () => Promise.reject(new Error('x'));
  assert.deepEqual(await S.listBackgroundTerminals('cx'), []);
  assert.deepEqual(await S.listBackgroundTerminals('cl'), []);
  // a basic harness's chat lists none, and Codex is never asked about it
  const asked = callsOf('api.backgroundTerminals').length;
  assert.deepEqual(await S.listBackgroundTerminals('acp:k:1'), []);
  assert.equal(callsOf('api.backgroundTerminals').length, asked);
  set({ codexCompat: { versionStatus: 'ok', probes: { 'codex.backgroundTerminals': false }, flags: {}, cliVersion: '1' } as any });
  assert.deepEqual(await S.listBackgroundTerminals('cx'), []);
  impl['codex.leased'] = async () => ({ result: { terminated: true } });
  assert.equal(await S.terminateBackgroundTerminal('cx', '7'), true);
  assert.deepEqual(callsOf('codex.leased').at(-1), ['cx', 'thread/backgroundTerminals/terminate', { processId: '7' }]);
  impl['codex.leased'] = async () => ({ locked: true });
  assert.equal(await S.terminateBackgroundTerminal('cx', '7'), false);
  impl['codex.leased'] = () => Promise.reject(new Error('dead'));
  assert.equal(await S.terminateBackgroundTerminal('cx', '7'), false);
  impl['codex.leased'] = () => Promise.reject('plain');
  await S.terminateBackgroundTerminal('cx', '7');
  assert.deepEqual(texts().slice(-2), ["Couldn't stop it: dead", "Couldn't stop it: plain"]);
});

test('revertThread drops the turn and every later one', async () => {
  set({ runtime: { r: { turns: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] } as any } });
  impl['codex.leased'] = async () => ({ result: {} });
  assert.equal(await S.revertThread('r', 'b'), true);
  assert.deepEqual(callsOf('codex.leased')[0], ['r', 'thread/revert', { threadId: 'r', beforeTurnId: 'b' }]);
  assert.deepEqual(
    st().runtime.r.turns.map((t) => t.id),
    ['a'],
  );
  assert.equal(await S.revertThread('r', 'zz'), true);
  assert.deepEqual(
    st().runtime.r.turns.map((t) => t.id),
    ['a'],
  );
  impl['codex.leased'] = async () => ({ locked: true });
  assert.equal(await S.revertThread('r', 'a'), false);
});

test('startReview: Claude asks in words, Codex runs review/start, and a new chat is made when needed', async () => {
  impl['proxy.send'] = async () => ({ action: 'started', id: 'review-input' });
  assert.equal(await S.startReview('cl', { type: 'custom', instructions: 'check auth' }), 'cl');
  assert.deepEqual(callsOf('proxy.send')[0].slice(0, 2), ['cl', '/code-review check auth']);
  impl['codex.leased'] = async () => ({ result: { turn: { id: 'RV', status: 'inProgress', items: [] } } });
  assert.equal(await S.startReview('cx', { type: 'uncommittedChanges' }), 'cx');
  assert.deepEqual(callsOf('codex.leased')[0], [
    'cx',
    'review/start',
    { threadId: 'cx', target: { type: 'uncommittedChanges' }, delivery: 'inline' },
  ]);
  assert.equal(st().runtime.cx.activeTurnId, 'RV');
  impl['codex.leased'] = async () => ({ result: {} });
  await S.startReview('cx', { type: 'uncommittedChanges' });
  assert.equal(st().runtime.cx.turns.length, 1);
  impl['codex.leased'] = async () => ({ locked: true });
  assert.equal(await S.startReview('cx', {} as any), 'cx');
  // no chat: a new Codex chat in the new-chat folder
  set({ conn: 'ready', home: '/home/me' });
  impl['codex.startThread'] = async () => ({ thread: { id: 'nr' } });
  impl['codex.leased'] = async () => ({ result: { turn: { id: 'R2', items: [] } } });
  assert.equal(await S.startReview(null, { type: 'uncommittedChanges' }), 'nr');
  assert.deepEqual(st().route, { name: 'thread', id: 'nr' });
  assert.equal(callsOf('codex.startThread')[0][0].cwd, '/home/me');
  // Codex can't run: a Claude Code chat
  set({ conn: 'error', claude: { status: { state: 'ready' } as any, models: [] } });
  impl['claude.startClaudeThread'] = () => 'cr';
  assert.equal(await S.startReview(null, { type: 'baseBranch', branch: 'main' }), 'cr');
  assert.equal(callsOf('proxy.send').at(-1)![0], 'cr');
  // main refuses the ask: the composer that ran /review keeps it, and a new chat's composer holds the review ask
  impl['proxy.send'] = () => Promise.reject(new Error('refused'));
  assert.equal(await S.startReview('cl', { type: 'uncommittedChanges' }), false);
  impl['claude.startClaudeThread'] = () => 'cr2';
  assert.equal(await S.startReview(null, { type: 'custom', instructions: 'check auth' }), 'cr2');
  assert.match(st().drafts.cr2.text, /check auth/);
});

test('startReview on a basic harness runs the /review it lists, never Codex review/start, or says why it cannot', async () => {
  const ran: any[] = [];
  impl['run.runSemantic'] = async (...args: any[]) => (ran.push(args), { ok: true });
  assert.equal(await S.startReview('acp:k:1', { type: 'uncommittedChanges' }), 'acp:k:1');
  assert.equal(await S.startReview('acp:k:1', { type: 'custom', instructions: 'auth only' }), 'acp:k:1');
  assert.equal(await S.startReview('acp:k:1', { type: 'commit', sha: 'abc' }), 'acp:k:1');
  assert.deepEqual(
    ran.map((a) => a.slice(0, 3)),
    [
      ['acp:k:1', 'review', ''],
      ['acp:k:1', 'review', 'auth only'],
      ['acp:k:1', 'review', ran[2][2]],
    ],
  );
  assert.match(ran[2][2], /commit abc/);
  impl['run.runSemantic'] = async () => ({ ok: false, state: 'absent', why: null });
  impl['run.refusalText'] = (_r: any, sem: string) => `no ${sem}`;
  assert.equal(await S.startReview('acp:k:1', { type: 'uncommittedChanges' }), false);
  assert.deepEqual(texts(), ['no review']);
  assert.equal(callsOf('codex.leased').length, 0);
});

test('startReview in a new chat checks what the harness running it has turned off, and says so', async () => {
  set({
    conn: 'ready',
    codexCompat: { versionStatus: 'ok', probes: { 'codex.review': false }, flags: {}, cliVersion: '1' } as any,
    prefs: { ...st().prefs, defaultHarness: 'acp:kimi' },
    basicHarnesses: [{ id: 'kimi', state: 'admitted' }] as any,
  });
  // new chats go to a basic harness, but the review runs on Codex, whose review probe failed
  assert.equal(await S.startReview(null, { type: 'uncommittedChanges' }), false);
  assert.equal(texts().length, 1);
  assert.equal(callsOf('codex.startThread').length, 0);
});

test('reopening a side chat focuses its tab and adds the selection to its composer or draft', async () => {
  const frames: (() => void)[] = [];
  const raf = (globalThis as any).requestAnimationFrame;
  (globalThis as any).requestAnimationFrame = (cb: () => void) => frames.push(cb);
  const handled: string[] = [];
  const focused: string[] = [];
  const onSelection = (e: any) => {
    if (e.detail.text === 'composer') {
      handled.push(e.detail.threadId);
      e.detail.handled = true;
    }
  };
  const onFocus = (e: any) => focused.push(e.detail.threadId);
  window.addEventListener('composer-add-selection', onSelection);
  window.addEventListener('focus-composer', onFocus);
  try {
    const side = { id: 'tab-side', kind: 'chat', threadId: 'side', sourceChatId: 'main' } as any;
    set({
      route: { name: 'thread', id: 'main' },
      paneTabs: [{ id: 'files', kind: 'files' } as any, side],
      paneActive: 'files',
      diffPanel: { open: false } as any,
      paneFull: true,
      drafts: { side: { text: 'half', attachments: [] } } as any,
    });
    // a mounted composer takes the selection itself
    assert.equal(await S.openSideChat('main', 'composer'), 'side');
    assert.deepEqual(handled, ['side']);
    assert.deepEqual(st().drafts.side, { text: 'half', attachments: [] });
    assert.deepEqual([st().paneActive, st().diffPanel.open, st().paneFull], ['tab-side', true, false]);
    assert.deepEqual(focused, []);
    frames.splice(0).forEach((f) => f());
    assert.deepEqual(focused, ['side']);
    // otherwise the selection joins the draft, which keeps its text
    assert.equal(await S.openSideChat('main', 'quoted'), 'side');
    assert.deepEqual(st().drafts.side, { text: 'half', attachments: [S.selectionAttachment('quoted')] });
    // a chat with no draft yet starts an empty one
    set({ drafts: {} });
    await S.openSideChat('main', 'fresh');
    assert.deepEqual(st().drafts.side, { text: '', attachments: [S.selectionAttachment('fresh')] });
    assert.equal(callsOf('codex.fork').length, 0);

    // the parent was deselected meanwhile: its side chat stays parked with it instead of taking this pane
    set({
      route: { name: 'thread', id: 'other' },
      paneTabs: [{ id: 'files', kind: 'files' } as any],
      paneActive: 'files',
      diffPanel: { open: true } as any,
      chatPanes: { main: { tabs: [side], active: '', open: false, full: false } },
    });
    frames.length = 0;
    assert.equal(await S.openSideChat('main'), 'side');
    assert.deepEqual(st().chatPanes.main, { tabs: [side], active: 'tab-side', open: true, full: false });
    assert.deepEqual(
      st().paneTabs.map((t) => t.id),
      ['files'],
    );
    assert.equal(st().paneActive, 'files');
    assert.equal(frames.length, 0);
  } finally {
    window.removeEventListener('composer-add-selection', onSelection);
    window.removeEventListener('focus-composer', onFocus);
    (globalThis as any).requestAnimationFrame = raf;
  }
});

test('a side chat chosen on a blank tab converts that tab in place, or parks with its parent', async () => {
  impl['codex.fork'] = async () => ({ thread: { id: 'side2', ephemeral: true } });
  const blank = { id: 'b1', kind: 'browser' } as any;
  set({
    route: { name: 'thread', id: 'main' },
    paneTabs: [{ id: 'files', kind: 'files' } as any, blank],
    paneActive: 'files',
    diffPanel: { open: false } as any,
  });
  assert.equal(await S.openSideChat('main', undefined, 'b1'), 'side2');
  assert.deepEqual(
    st().paneTabs.map((t) => [t.id, t.kind, t.threadId, t.sourceChatId]),
    [
      ['files', 'files', undefined, undefined],
      ['b1', 'chat', 'side2', 'main'],
    ],
  );
  assert.deepEqual([st().paneActive, st().diffPanel.open], ['b1', true]);
  // a tab that is no longer blank is left alone
  const before = st().paneTabs;
  S.openPaneTab('chat', { threadId: 'x', sourceChatId: 'main' }, 'b1');
  assert.equal(st().paneTabs, before);
  // the fork finished after the user moved to another chat: the converted tab goes with its parent
  set({
    route: { name: 'thread', id: 'other' },
    paneTabs: [{ id: 'files', kind: 'files' } as any, blank],
    paneActive: 'b1',
    diffPanel: { open: true } as any,
    chatPanes: {},
  });
  S.openPaneTab('chat', { threadId: 'side3', sourceChatId: 'main' }, 'b1');
  assert.deepEqual(
    st().paneTabs.map((t) => t.id),
    ['files'],
  );
  assert.equal(st().paneActive, 'files');
  assert.deepEqual(
    st().chatPanes.main.tabs.map((t) => [t.id, t.kind, t.threadId]),
    [['b1', 'chat', 'side3']],
  ); // any other kind converts in place in the window that asked, whichever chat is on screen
  set({
    paneTabs: [blank, { id: 'files', kind: 'files' } as any],
    paneActive: 'files',
    diffPanel: { open: false } as any,
    paneFull: false,
  });
  S.openPaneTab('terminal', { cwd: '/w' }, 'b1');
  assert.deepEqual(
    st().paneTabs.map((t) => [t.id, t.kind, t.cwd]),
    [
      ['b1', 'terminal', '/w'],
      ['files', 'files', undefined],
    ],
  );
  assert.deepEqual([st().paneActive, st().diffPanel.open], ['b1', true]);
});

test('a chat tab takes the chat on screen as its source, and one for another chat is parked with it', () => {
  set({ route: { name: 'thread', id: 'main' }, paneTabs: [], chatPanes: {} });
  S.openPaneTab('chat', { threadId: 's1' });
  assert.deepEqual(
    st().paneTabs.map((t) => [t.kind, t.threadId, t.sourceChatId]),
    [['chat', 's1', 'main']],
  );
  // outside a chat there is no source, so the tab simply opens
  set({ route: { name: 'home' } as any, paneTabs: [] });
  S.openPaneTab('chat', { threadId: 's2' });
  assert.deepEqual(
    st().paneTabs.map((t) => [t.threadId, t.sourceChatId]),
    [['s2', undefined]],
  );
  assert.equal(st().diffPanel.open, true);
  set({ route: { name: 'thread', id: 'other' }, paneTabs: [], chatPanes: {}, diffPanel: { open: false } as any });
  S.openPaneTab('chat', { threadId: 's3', sourceChatId: 'main' });
  assert.deepEqual(st().paneTabs, []);
  assert.deepEqual(
    st().chatPanes.main.tabs.map((t) => t.threadId),
    ['s3'],
  );
  assert.equal(st().diffPanel.open, false);
});

test('navigation bookmarks toggle per chat', () => {
  S.toggleNavigationBookmark('c1', 'm1');
  S.toggleNavigationBookmark('c1', 'm2');
  S.toggleNavigationBookmark('c2', 'm1');
  assert.deepEqual(st().navigationBookmarks, { c1: ['m1', 'm2'], c2: ['m1'] });
  S.toggleNavigationBookmark('c1', 'm1');
  S.toggleNavigationBookmark('c2', 'm1');
  assert.deepEqual(st().navigationBookmarks, { c1: ['m2'] });
});

test('agent tab pushes merge into the store, and hiding the pane on an active agent tab tells main', async () => {
  const push = listeners['browser.onAgentTabs'];
  push({ chatId: 'c', tabs: [{ tabKey: null, active: true, takenOver: false }] });
  assert.deepEqual(st().agentTabs.c, [{ tabKey: null, active: true, takenOver: false }]);
  const agentTab = { id: 'br', kind: 'browser', agentChat: 'c' } as any;
  set({ paneTabs: [agentTab], diffPanel: { open: true } as any });
  set({ diffPanel: { open: false } as any });
  assert.deepEqual(callsOf('browser.paneHidden'), [[['c']]]);
  // closing a pane with no agent at work, or a pane already closed, says nothing
  set({ paneTabs: [{ id: 'files', kind: 'files' } as any], diffPanel: { open: true } as any });
  set({ diffPanel: { open: false } as any });
  set({ paneTabs: [agentTab] });
  assert.equal(callsOf('browser.paneHidden').length, 1);
  // a failed snapshot or a failed paneHidden is left to the pushes
  const { startAgentTabs } = await import('../src/store/panes.ts');
  impl['browser.agentTabs'] = () => Promise.reject(new Error('gone'));
  impl['browser.paneHidden'] = () => Promise.reject(new Error('gone'));
  startAgentTabs();
  set({ diffPanel: { open: true } as any });
  set({ diffPanel: { open: false } as any });
  await flush();
  assert.equal(callsOf('browser.paneHidden').length, 3);
  assert.deepEqual(st().agentTabs.c, [{ tabKey: null, active: true, takenOver: false }]);
});

test("a closed browser pane tab's page goes in main; a popup main opened becomes a pane tab bound to its page", async () => {
  set({
    paneTabs: [
      { id: 'b1', kind: 'browser', url: 'https://a.test/' },
      { id: 'f', kind: 'files' },
    ] as any,
    diffPanel: { open: true } as any,
  });
  const before = callsOf('browser.view.close').length;
  set({ paneTabs: [{ id: 'f', kind: 'files' }] as any });
  // (every startAgentTabs subscription reports it; this file started it more than once)
  const closed = () => [
    ...new Set(
      callsOf('browser.view.close')
        .slice(before)
        .map(([id]: any) => id),
    ),
  ];
  assert.deepEqual(closed(), ['b1']);
  // a failed close is left alone (the page went already)
  impl['browser.view.close'] = () => Promise.reject(new Error('gone'));
  set({ paneTabs: [{ id: 'b2', kind: 'browser' }] as any });
  set({ paneTabs: [] });
  await flush();
  assert.deepEqual(closed(), ['b1', 'b2']);
  // open-browser-view: a new pane tab with main's pane id, in front; again, it is only fronted
  set({ paneTabs: [{ id: 'f', kind: 'files' }] as any, paneActive: 'f', diffPanel: { open: false } as any });
  S.openBrowserViewTab({ paneId: 'browser-p1', url: 'https://idp.test/', title: 'Sign in' });
  assert.deepEqual(st().paneTabs.at(-1), { id: 'browser-p1', kind: 'browser', url: 'https://idp.test/', title: 'Sign in' });
  assert.equal(st().paneActive, 'browser-p1');
  assert.equal(st().diffPanel.open, true);
  set({ paneActive: 'f', diffPanel: { open: false } as any });
  S.openBrowserViewTab({ paneId: 'browser-p1', url: 'https://idp.test/' });
  assert.equal(st().paneTabs.length, 2);
  assert.equal(st().paneActive, 'browser-p1');
  S.openBrowserViewTab({ paneId: 'browser-p2', url: 'https://b.test/', title: '' });
  assert.equal(st().paneTabs.at(-1)?.title, 'https://b.test/');
  for (const bad of [null, undefined, {}, { paneId: '', url: 'x' }, { paneId: 'p' }, { paneId: 5, url: 'x' }]) S.openBrowserViewTab(bad);
  assert.equal(st().paneTabs.length, 3);
});

test('a delayed goal read cannot overwrite a newer pushed goal for the same chat', async () => {
  sessions.useSessions.setState({ sessions: { g: { ...sessions.sessionOf('g'), goal: { status: 'active', objective: 'old' } as any } } });
  let finish!: (r: any) => void;
  impl['api.threadGoal'] = () => new Promise((r) => (finish = r));
  const pending = S.loadGoal('g');
  sessions.useSessions.setState({ sessions: { g: { ...sessions.sessionOf('g'), goal: { status: 'active', objective: 'new' } as any } } });
  finish({ goal: { status: 'complete', objective: 'old' } });
  await pending;
  assert.deepEqual(callsOf('session.patch'), []);
  assert.equal(sessions.sessionOf('g').goal?.objective, 'new');
});

test('goal reads cannot publish into a different native segment or harness', async () => {
  for (const changed of ['native', 'harness']) {
    resetAll();
    set({ segments: { g: [{ harness: 'codex', nativeId: 'old', start: 0, count: null }] as any } });
    let finish!: (r: any) => void;
    impl['api.threadGoal'] = () => new Promise((r) => (finish = r));
    const pending = S.loadGoal('g');
    set({
      segments: {
        g: [
          { harness: changed === 'native' ? 'codex' : 'claude', nativeId: changed === 'native' ? 'new' : 'old', start: 0, count: null },
        ] as any,
      },
    });
    finish({ goal: { status: 'complete', objective: 'old' } });
    await pending;
    assert.deepEqual(callsOf('session.patch'), []);
  }
});

test('the latest goal read wins per chat while an unrelated chat still publishes independently', async () => {
  const finishes: ((r: any) => void)[] = [];
  impl['api.threadGoal'] = () => new Promise((r) => finishes.push(r));
  impl['session.patch'] = async () => false;
  const old = S.loadGoal('g');
  const current = S.loadGoal('g');
  const other = S.loadGoal('other');
  finishes[0]({ goal: { status: 'stopped', objective: 'old' } });
  await old;
  assert.deepEqual(callsOf('session.patch'), []);
  finishes[2]({ goal: { status: 'active', objective: 'independent' } });
  await other;
  finishes[1]({ goal: { status: 'complete', objective: 'latest' } });
  await current;
  assert.deepEqual(callsOf('session.patch'), [
    ['other', { goal: { status: 'active', objective: 'independent' } }],
    ['g', { goal: { status: 'complete', objective: 'latest' } }],
  ]);
});

test('tabs the user opens belong to the chat on screen, with their own file tab per chat', () => {
  set({ route: { name: 'thread', id: 'main' }, paneTabs: [], paneActive: '' });
  S.openPaneTab('terminal', { cwd: '/r' });
  S.openPaneTab('file', { path: '/r/a.ts' });
  S.openPaneTab('browser', { url: 'https://x.test', agentChat: 'agent' });
  S.openPaneTab('files');
  S.openBrowserViewTab({ paneId: 'browser-pop', url: 'https://idp.test/' });
  assert.deepEqual(
    st().paneTabs.map((t) => [t.kind, t.ownerChat]),
    [
      ['terminal', 'main'],
      ['file', 'main'],
      ['browser', undefined],
      ['files', undefined],
      ['browser', 'main'],
    ],
  );
  set({ route: { name: 'thread', id: 'other' } });
  S.openPaneTab('file', { path: '/r/a.ts' });
  S.openPaneTab('file', { path: '/r/a.ts' });
  assert.deepEqual(
    st()
      .paneTabs.filter((t) => t.kind === 'file')
      .map((t) => [t.path, t.ownerChat]),
    [
      ['/r/a.ts', 'main'],
      ['/r/a.ts', 'other'],
    ],
  );
  set({ route: { name: 'home' } as any });
  S.openPaneTab('skill', { path: '/s' });
  const skill = st().paneTabs.find((t) => t.kind === 'skill' && t.path === '/s');
  assert.ok(skill);
  assert.equal(skill.ownerChat, undefined);
  assert.equal(
    new Set(
      st()
        .paneTabs.filter((t) => t.kind === 'file')
        .map((t) => t.id),
    ).size,
    2,
  );
});

test("deleting a chat closes the tabs it owned and the toggle ignores another chat's front tab", async () => {
  const mine = { id: 't1', kind: 'terminal', ownerChat: 'gone' } as any;
  const other = { id: 't2', kind: 'terminal', ownerChat: 'kept' } as any;
  set({ route: { name: 'thread', id: 'kept' }, paneTabs: [mine, other], paneActive: 't1', diffPanel: { open: true } as any });
  S.togglePaneTab('terminal');
  assert.equal(st().diffPanel.open, true, "a hidden terminal of another chat does not count as this chat's");
  assert.equal(st().paneTabs.length, 3);
  set({ paneTabs: [mine, other], paneActive: 't2' });
  panes.closeOwnedPaneTabs('none');
  assert.equal(st().paneTabs.length, 2);
  await S.deleteThread('gone');
  assert.deepEqual(
    st().paneTabs.map((t) => t.id),
    ['t2'],
  );
  assert.equal(st().paneActive, 't2');
  set({ paneActive: 't1' });
  await S.deleteThread('kept');
  assert.deepEqual([st().paneTabs.length, st().paneActive, st().diffPanel.open], [0, '', false]);
});

test('toggling a pane tab from a route without a chat closes the open pane', () => {
  set({
    route: { name: 'home' } as any,
    paneTabs: [{ id: 't', kind: 'terminal' } as any],
    paneActive: 't',
    diffPanel: { open: true } as any,
  });
  S.togglePaneTab('terminal');
  assert.equal(st().diffPanel.open, false);
});
