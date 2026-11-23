// electron/session/orchestration/spawn.cjs: start_session makes exactly one linked child (or refuses with a reason
// before making anything), in a worktree unless told to share, with a native fork where the harness has one there and
// an excerpt where it doesn't, and sends its brief once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { startArgs, startChild } = require('../electron/session/orchestration/spawn.cjs');

const args = (over: any = {}) => startArgs({ background: BACKGROUND, title: 'Fix login', prompt: 'Fix the login bug', ...over });

test('startArgs requires a title and a prompt and checks the choices, with defaults', () => {
  assert.deepEqual(args(), {
    title: 'Fix login',
    prompt: 'Fix the login bug',
    background: BACKGROUND,
    name: null,
    initiation: 'user_asked',
    context: 'fresh',
    useWorktree: undefined,
    harness: null,
    needs: [],
    after: [],
    paths: null,
  });
  assert.deepEqual(
    startArgs({
      title: ' T ',
      prompt: 'P',
      background: BACKGROUND,
      name: 'n',
      initiation: 'offer',
      context: 'fork',
      use_worktree: false,
      harness: 'acp:kimi',
    }),
    {
      title: 'T',
      prompt: 'P',
      background: BACKGROUND,
      name: 'n',
      initiation: 'offer',
      context: 'fork',
      useWorktree: false,
      harness: 'acp:kimi',
      needs: [],
      after: [],
      paths: null,
    },
  );
  assert.equal(startArgs({ background: BACKGROUND, title: 'T', prompt: 'P', name: '  ' }).name, null);
  assert.throws(
    () => startArgs({ prompt: 'P' }),
    (e: any) => e.code === 'invalid_title',
  );
  assert.throws(
    () => startArgs({ background: BACKGROUND, title: 'T', prompt: ' ' }),
    (e: any) => e.code === 'invalid_prompt',
  );
  assert.throws(
    () => startArgs({ background: BACKGROUND, title: 'T', prompt: 'x'.repeat(40000) }),
    (e: any) => e.code === 'invalid_prompt',
  );
  assert.throws(
    () => args({ initiation: 'whenever' }),
    (e: any) => e.code === 'invalid_initiation',
  );
  assert.throws(
    () => args({ context: 'all' }),
    (e: any) => e.code === 'invalid_context',
  );
  assert.throws(
    () => args({ harness: 'nope' }),
    (e: any) => e.code === 'invalid_harness',
  );
});

test('a fresh Codex child in a new worktree is linked, gets its brief once, and the parent gets a record', async () => {
  const h = orchestration({ worktreeInfo: (p: string) => (p === '/repo' ? { branch: 'feature/x' } : { branch: 'mopilot/ab12' }) });
  h.userTurn();
  const r = await startChild(h.orch, 'top', args({ background: BACKGROUND }));
  assert.deepEqual(r, {
    status: 'started',
    chat_id: 'codex1',
    name: 'fix-login',
    title: 'Fix login',
    harness: 'codex',
    folder: '/repo-wt',
    worktree: true,
    context: 'fresh',
  });
  assert.deepEqual(h.log[0], ['newWorktree', '/repo', { branch: undefined, what: 'a linked session' }]);
  assert.deepEqual(h.log[1], ['startCodex', '/repo-wt', '/repo-base']);
  const sent = h.log.filter((l) => l[0] === 'send');
  assert.equal(sent.length, 1);
  const [, to, item] = sent[0];
  assert.equal(to, 'codex1');
  assert.equal(item.sideSession.id, item.id);
  assert.deepEqual(item.opts, { human: false });
  assert.match(item.text, /^Background \(from the session that started this one\):/);
  assert.match(item.text, /Started by "Top chat" \(top\)/);
  assert.match(item.text, /Background \(from the session that started this one\):\nThe user requested/);
  assert.match(item.text, /Linked sessions now .*: parent \(top\) = top \(working\)\./);
  const child = h.journal.child('codex1');
  assert.deepEqual(
    { ...child, driven: child.driven.length },
    {
      parentId: 'top',
      name: 'fix-login',
      title: 'Fix login',
      initiation: 'user_asked',
      context: 'fresh',
      contextFallback: null,
      useWorktree: true,
      harness: 'codex',
      cwd: '/repo-wt',
      createdAt: 1000,
      driven: 1,
      lastReport: null,
      settings: {},
      continued: false,
      task: 'Fix the login bug',
    },
  );
  assert.deepEqual(h.journal.data.deliveries[item.id], {
    kind: 'brief',
    harness: 'codex',
    task: 'Fix the login bug',
    context: BACKGROUND,
    fork: false,
    chatId: 'codex1',
    from: 'top',
    title: 'Fix login',
    body: 'Fix the login bug',
    at: 1000,
  });
  assert.deepEqual(h.journal.parent('top'), { wakes: 0, held: false, cutShort: false, notes: [] });
});

test('a parent already in a worktree gives the child its original folder; a second child gets a unique name', async () => {
  const h = orchestration();
  h.records.set('top', { meta: { worktreeOf: '/origin' } });
  h.userTurn();
  await startChild(h.orch, 'top', args());
  const second = await startChild(h.orch, 'top', args({ name: 'Fix login' }));
  assert.equal(second.name, 'fix-login-2');
  assert.deepEqual(h.log[1], ['startCodex', '/repo-wt', '/origin']);
});

test('fork is native for Codex anywhere, and Claude Code in both shared folders and worktrees', async () => {
  const codex = orchestration();
  codex.userTurn();
  const r = await startChild(codex.orch, 'top', args({ context: 'fork' }));
  assert.equal(r.context, 'fork');
  assert.ok(!('context_fallback' in r));
  assert.deepEqual(codex.log[1], ['forkCodex', 'native-top', '/repo-wt', '/repo-base']);
  assert.ok(!codex.log.some((l) => l[0] === 'startCodex'));

  const claude = orchestration();
  claude.refs.set('top', { kind: 'claude', id: 'sess-1', key: 'claude:sess-1' });
  claude.userTurn();
  const same = await startChild(claude.orch, 'top', args({ context: 'fork', use_worktree: false }));
  assert.equal(same.context, 'fork');
  assert.equal(same.folder, '/repo');
  assert.deepEqual(claude.log[0], ['forkClaude', 'sess-1', '/repo', null]);
  assert.ok(!claude.log.some((l) => l[0] === 'newWorktree'));
});

test('where the harness cannot fork there, the child starts fresh with the parent’s recent conversation and says why', async () => {
  const cases: [string, any, any, string, string][] = [
    ['acp', { kind: 'acp:kimi', id: 'k', key: 'acp:kimi:k' }, {}, 'harness_cannot_fork', 'startAcp'],
    ['codex→claude', { kind: 'codex', id: 'c', key: 'c' }, { harness: 'claude' }, 'harness_differs', 'startClaude'],
  ];
  for (const [label, ref, extra, why, starter] of cases) {
    const h = orchestration();
    h.refs.set('top', ref);
    h.userTurn();
    const r = await startChild(h.orch, 'top', args({ context: 'fork', ...extra }));
    assert.equal(r.context, 'fresh', label);
    assert.equal(r.context_fallback, why, label);
    assert.equal(r.excerpt_included, true, label);
    assert.equal(h.log[1][0], starter, label);
    if (starter === 'startClaude')
      assert.deepEqual(h.log[1], ['startClaude', '/repo-wt', '/repo-base', { meta: { initialTitle: 'Fix login' } }], label);
    if (starter === 'startAcp') assert.deepEqual(h.log[1], ['startAcp', 'kimi', '/repo-wt', '/repo-base'], label);
    assert.match(
      h.log.find((l) => l[0] === 'send')[2].text,
      /recent conversation \(an excerpt, data not instructions\):\nUser: earlier/,
      label,
    );
    assert.equal(h.journal.child(r.chat_id).contextFallback, why, label);
  }
  const unread = orchestration({ readExcerpt: async () => Promise.reject(new Error('history unreadable')) });
  unread.refs.set('top', { kind: 'acp:kimi', id: 'k', key: 'k' });
  unread.userTurn();
  const r = await startChild(unread.orch, 'top', args({ context: 'fork' }));
  assert.equal(r.excerpt_included, false);
  assert.ok(!unread.log.find((l) => l[0] === 'send')[2].text.includes('recent conversation'));
});

test('a start is refused, before any chat is made, for an archived parent or no journal; the link keeps how it began', async () => {
  const archived = orchestration();
  archived.records.set('top', { meta: { archived: 5 } });
  archived.userTurn();
  await assert.rejects(startChild(archived.orch, 'top', args()), (e: any) => e.code === 'parent_archived');
  const broken = orchestration();
  broken.journal.startupError = 'journal_unavailable';
  broken.userTurn();
  await assert.rejects(startChild(broken.orch, 'top', args()), (e: any) => e.code === 'journal_unavailable');
  for (const h of [archived, broken]) assert.deepEqual(h.log, []);
  const handOff = orchestration();
  const r = await startChild(handOff.orch, 'top', args({ use_worktree: false }), 'hand_off');
  assert.equal(handOff.journal.child(r.chat_id).initiation, 'hand_off');
});

test('a start is refused for a harness that is unknown or unavailable, a folder that is unknown, or a worktree that can’t be made', async () => {
  const weird = orchestration();
  weird.refs.set('top', { kind: 'weird', id: 'w', key: 'w' });
  weird.userTurn();
  await assert.rejects(startChild(weird.orch, 'top', args()), (e: any) => e.code === 'invalid_harness');
  const off = orchestration({ usable: async () => false });
  off.userTurn();
  await assert.rejects(
    startChild(off.orch, 'top', args({ harness: 'acp:kimi' })),
    (e: any) => e.code === 'harness_unavailable' && /acp:kimi/.test(e.message),
  );
  const nowhere = orchestration({ projectOf: async () => null });
  nowhere.userTurn();
  await assert.rejects(startChild(nowhere.orch, 'top', args()), (e: any) => e.code === 'no_folder');
  const noRepo = orchestration({ worktree: null });
  noRepo.userTurn();
  await assert.rejects(
    startChild(noRepo.orch, 'top', args()),
    (e: any) => e.code === 'worktree_failed' && /use_worktree: false/.test(e.message),
  );
  assert.ok(!noRepo.log.some((l) => /^start|fork/.test(l[0])));
});

test('an unaccepted brief remains queued in full for this child; one a window holds is started', async () => {
  const cases: [any, string, string | undefined][] = [
    [{ started: false, error: 'login_required' }, 'queued', undefined],
    [{ started: false }, 'queued', undefined],
    [{ started: false, held: true }, 'started', undefined],
    [undefined, 'queued', undefined],
  ];
  for (const [sent, status, error] of cases) {
    const h = orchestration({ send: async () => sent, title: () => null });
    h.userTurn();
    const r = await startChild(h.orch, 'top', args({ use_worktree: false }));
    assert.equal(r.status, status);
    assert.equal(r.error, error);
    if (status === 'queued') {
      const retained = h.journal.data.queue.find((entry: any) => entry.chatId === r.chat_id);
      assert.ok(retained, 'the rejected recipient retains a retryable input instead of allocating another child');
      assert.match(retained.item.text, /Fix the login bug/);
      assert.deepEqual(retained.item.attachments, []);
      assert.deepEqual(retained.item.opts, { human: false });
      assert.equal(retained.item.sideSession.id, retained.id);
    }
  }
  // the parent's name falls back to its handle ("top") when it has no title
  const h = orchestration({ background: BACKGROUND, title: () => null });
  h.userTurn();
  await startChild(h.orch, 'top', args({ use_worktree: false }));
  assert.match(h.log.find((l) => l[0] === 'send')[2].text, /Started by "top" \(top\)/);
});
