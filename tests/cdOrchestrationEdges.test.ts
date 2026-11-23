// Public linked-session entrypoints preserve trusted settings, offer supersession, reserved ownership and allocation cleanup at failure boundaries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND as background } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const task = (title = 'Task', extra: any = {}) => ({ title, prompt: 'Complete the assigned work', background, ...extra });
const reserve = async (h: any) => {
  const waiting = h.orch.start('top', { title: 'Reserved task', initiation: 'offer' });
  const id = Object.keys(h.journal.data.proposals)[0];
  const result = await h.orch.act(id, 'start');
  await waiting;
  return { id, chatId: result.chat_id };
};

test('fresh tool settings reach the child configuration while malformed combined briefs and nonstring fields never dispatch', async () => {
  const h = orchestration();
  h.userTurn();
  const captured: any[] = [];
  h.orch.o.childOptions = async (_id: string, _kind: string, args: any) => {
    captured.push(args);
    return { model: args.model, effort: args.effort, permission: args.permission, ignored: ['Requested cheaper settings applied'] };
  };
  const result = await h.orch.start('top', task('Configured', { model: 'sonnet', effort: 'low', permission_mode: 'read-only' }));
  assert.deepEqual(h.journal.child(result.chat_id).settings, {
    model: 'sonnet',
    effort: 'low',
    permission: 'read-only',
    ignored: ['Requested cheaper settings applied'],
  });
  assert.deepEqual(result.ignored, ['Requested cheaper settings applied']);
  await h.orch.start('top', task('Invalid field types', { model: 7, effort: {}, permission_mode: false }));
  assert.equal(captured[1].model, undefined);
  assert.equal(captured[1].effort, undefined);
  assert.equal(captured[1].permission, undefined);
  assert.throws(() => h.orch.start('top', { title: 'Oversized', prompt: 'p'.repeat(20000), background: 'b'.repeat(12001) }), {
    code: 'invalid_prompt',
  });
});

test('card settings are trusted user choices, validated for each setting and never confused with raw tool arguments', async () => {
  for (const value of [7, ' ', 'x'.repeat(201)]) {
    const h = orchestration();
    h.userTurn();
    const p = await h.orch.start('top', task('Proposal', { initiation: 'own_initiative' }));
    await assert.rejects(h.orch.act(p.task_id, 'start', { model: value }), { code: 'invalid_options' });
    assert.equal(h.journal.proposal(p.task_id).status, 'open');
    assert.equal(h.log.length, 0);
  }
  const h = orchestration();
  h.userTurn();
  let requested: any;
  h.orch.o.childOptions = async (_id: string, _kind: string, args: any) => ((requested = args), {});
  const p = await h.orch.start('top', task('Pick settings', { initiation: 'own_initiative' }));
  await h.orch.act(p.task_id, 'start', { model: ' sonnet ', effort: ' low ', permission: ' read-only ' });
  assert.deepEqual([requested.model, requested.effort, requested.permission, requested.userSelected], ['sonnet', 'low', 'read-only', true]);
});

test('a human replacement supersedes all unanswered offers without starting a session, including an abandoned call', async () => {
  const h = orchestration();
  h.userTurn();
  const notifications: any[] = [];
  h.orch.o.notifyOffer = (...args: any[]) => notifications.push(args);
  const waiting = h.orch.start('top', { title: 'First offer', initiation: 'offer' });
  const id = Object.keys(h.journal.data.proposals)[0];
  h.journal.change(
    (data: any) => (data.proposals.abandoned = { ...data.proposals[id], args: { ...data.proposals[id].args, title: 'Abandoned offer' } }),
  );
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { id: 'new-user-message', text: 'Something else', opts: { human: true } } });
  const answer = await waiting;
  assert.deepEqual([answer.status, answer.answer], ['dismissed', 'superseded']);
  assert.equal(h.journal.proposal(id).status, 'dismissed');
  assert.equal(h.journal.proposal('abandoned').status, 'dismissed');
  assert.deepEqual(notifications, [['top', 'First offer']]);
  assert.equal(
    h.log.some((row: any[]) => row[0] === 'startCodex'),
    false,
  );
});

test('a formerly accepted proposal cannot fill a missing, unrelated, detached or archived reserved recipient', async () => {
  for (const mutation of ['missing', 'unrelated', 'detached', 'archived']) {
    const h = orchestration();
    h.userTurn();
    const p = await reserve(h);
    if (mutation === 'missing') delete h.journal.data.children[p.chatId];
    if (mutation === 'unrelated') h.journal.child(p.chatId).parentId = 'other';
    if (mutation === 'detached') h.journal.child(p.chatId).detached = true;
    if (mutation === 'archived') h.records.get(p.chatId).meta.archived = 10;
    await assert.rejects(h.orch.start('top', { proposal_id: p.id, prompt: 'Fill reserved task', background }), { code: 'start_cancelled' });
    assert.equal(h.journal.proposal(p.id).status, 'briefing');
    assert.equal(h.log.filter((row: any[]) => row[0] === 'send').length, 0);
  }
});

test('legacy reserved settings and a parent without a stored worktree marker refill the same native child', async () => {
  const h = orchestration();
  h.userTurn();
  const p = await reserve(h);
  delete h.journal.child(p.chatId).settings;
  h.records.get('top').meta = {};
  const result = await h.orch.start('top', { proposal_id: p.id, prompt: 'Fill old reserved task', background });
  assert.equal(result.chat_id, p.chatId);
  assert.equal(result.folder, '/repo-wt');
  assert.deepEqual(h.journal.child(p.chatId).settings, {});
  assert.equal(h.log.filter((row: any[]) => row[0] === 'startCodex').length, 1);
});

test('a failed journal publication archives only new unused allocations and never an already reserved child', async () => {
  for (const reserved of [false, true]) {
    let forbiddenId: string | null = null;
    let oldBrief: string | null = null;
    let failNew = false;
    const h = orchestration({
      write: (data: any) => {
        if (failNew && Object.values(data.children).some((c: any) => c.driven?.length)) throw new Error('cannot save linked task');
        if (forbiddenId && data.children[forbiddenId]?.driven[0] !== oldBrief) throw new Error('cannot save linked task');
      },
    });
    h.userTurn();
    const discarded: string[] = [];
    h.starter.discardWorktree = async (cwd: string) => {
      discarded.push(cwd);
    };
    if (reserved) {
      const p = await reserve(h);
      forbiddenId = p.chatId;
      oldBrief = h.journal.child(p.chatId).driven[0];
      await assert.rejects(h.orch.start('top', { proposal_id: p.id, prompt: 'Fill reserved task', background }), /cannot save linked task/);
      assert.equal(h.records.get(p.chatId).meta.archived, undefined);
      assert.equal(discarded.length, 0);
    } else {
      const original = h.starter.startCodex;
      h.starter.startCodex = async (...args: any[]) => {
        const id = await (original as any)(...args);
        failNew = true;
        return id;
      };
      await assert.rejects(h.orch.start('top', task()), /cannot save linked task/);
      assert.deepEqual(discarded, []);
      assert.equal(h.records.get('codex1').meta.archived, 1000);
    }
    assert.equal(h.log.filter((row: any[]) => row[0] === 'send').length, 0);
  }
});

test('shared notes are merged with authorized directories for native forks and truthful fresh fallbacks', async () => {
  for (const family of ['codex', 'claude', 'acp:kimi', 'declined-fork']) {
    const h = orchestration();
    h.userTurn();
    h.refs.set('top', { kind: family === 'declined-fork' ? 'codex' : family, id: 'parent', key: 'top' });
    h.orch.o.childOptions = async () => ({ ignored: family === 'claude' ? ['Existing note'] : undefined });
    h.orch.o.prepareNotes = async () => ({ path: '/shared-notes', additionalDirectories: ['/shared-notes'] });
    h.orch.o.grantParentNotes = async () => (family === 'acp:kimi' ? {} : { degraded: 'Current turn needs native approval' });
    if (family === 'declined-fork') (h.starter as any).forkCodex = async () => null;
    const result = await h.orch.start('top', task('Fork', { context: 'fork' }));
    assert.equal(h.journal.child(result.chat_id).notesPath, '/shared-notes');
    assert.deepEqual(h.journal.child(result.chat_id).settings.additionalDirectories, ['/shared-notes']);
    if (family === 'acp:kimi') assert.equal(result.context_fallback, 'harness_cannot_fork');
    else assert.ok(result.ignored.includes('Current turn needs native approval'));
    if (family === 'declined-fork') assert.equal(result.context_fallback, 'fork_needs_same_folder');
  }
});

test('a prepared plain-folder child is archived without removing the shared folder, and an archiving root never wakes', async () => {
  const { discardPrepared } = require('../electron/session/orchestration/preparedChild.cjs');
  const h = orchestration();
  h.records.set('unused', { meta: {} });
  await discardPrepared(h.orch, { chatId: 'unused', cwd: '/shared', worktreeOf: null });
  assert.equal(h.records.get('unused').meta.archived, 1000);
  h.orch.archiving.add('top');
  assert.equal(h.orch.maybeWake('top'), false);
  h.orch.archiving.clear();
  const { authorizeStart } = require('../electron/session/orchestration/startPolicy.cjs');
  await assert.rejects(authorizeStart(h.orch, 'top', { clicked: true, reserved: true }), { code: 'not_user_turn' });
});

test('idle callers cannot directly start work, incomplete internal briefs allocate nothing, and committed fork placement transfers ownership', async () => {
  const h = orchestration();
  assert.throws(() => h.orch.start('top', task()), { code: 'not_user_turn' });
  const { startArgs, startChild } = require('../electron/session/orchestration/spawn.cjs');
  await assert.rejects(startChild(h.orch, 'top', { ...startArgs(task()), prompt: null }), { code: 'invalid_prompt' });
  assert.equal(h.log.length, 0);
  h.userTurn();
  h.orch.o.worktreeInfo = () => ({ branch: 'parent-tip', sourceBranch: 'main' });
  const retained: string[] = [];
  h.starter.retainWorktree = (cwd: string) => {
    retained.push(cwd);
    return true;
  };
  const child = await h.orch.start('top', task('Committed fork', { context: 'fork' }));
  assert.equal(child.context, 'fork');
  assert.deepEqual(h.log[0], ['newWorktree', '/repo', { branch: 'parent-tip', startPoint: 'head', what: 'a linked session' }]);
  assert.deepEqual(retained, ['/repo-wt']);
});
