// Linked-session placement follows the parent's worktree history; shared-note identity is independent of authorized-directory ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration, SESSION_BACKGROUND } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { startArgs, startChild, makeChild } = require('../electron/session/orchestration/spawn.cjs');
const { rosterFor } = require('../electron/session/orchestration/family.cjs');
const { settleDependants } = require('../electron/session/orchestration/dependants.cjs');
const args = (extra = {}) =>
  startArgs({ title: 'Separate work', prompt: 'Read the assigned files', background: SESSION_BACKGROUND, ...extra });

test('omitted placement shares a plain folder on every harness and a managed/history checkout gets an independent worktree', async () => {
  assert.equal(args().useWorktree, undefined);
  for (const kind of ['codex', 'claude', 'acp:kimi']) {
    const h = orchestration();
    h.records.get('top').meta = {};
    h.refs.set('top', { kind, id: 'parent-native', key: 'top' });
    const made = await makeChild(h.orch, 'top', args());
    assert.equal(made.cwd, '/repo');
    assert.equal(made.worktreeOf, null);
    assert.equal(
      h.log.some((r: any[]) => r[0] === 'newWorktree'),
      false,
    );
  }
  const managed = orchestration({ worktreeInfo: () => ({ branch: 'feature', sourceBranch: 'main' }) });
  managed.records.get('top').meta = {};
  assert.equal((await makeChild(managed.orch, 'top', args())).cwd, '/repo-wt');
  const old = orchestration();
  old.records.get('top').meta = { worktreeOf: '/base' };
  assert.equal((await makeChild(old.orch, 'top', args())).cwd, '/repo-wt');
  const own = orchestration();
  own.records.get('top').meta = {};
  assert.equal((await makeChild(own.orch, 'top', args({ use_worktree: true }))).cwd, '/repo-wt');
  const shared = orchestration();
  shared.records.get('top').meta = { worktreeOf: '/base' };
  assert.equal((await makeChild(shared.orch, 'top', args({ use_worktree: false }))).cwd, '/repo');
});

test('the prepared notes path is persisted and used by briefs, delivery records and the family roster after inherited directories', async () => {
  const h = orchestration();
  h.userTurn();
  h.orch.o.childOptions = async () => ({ additionalDirectories: ['/user-allowed-first'] });
  h.orch.o.prepareNotes = async () => ({ path: '/actual/shared-notes', additionalDirectories: ['/actual/shared-notes'] });
  const r = await startChild(h.orch, 'top', args());
  const child = h.journal.child(r.chat_id);
  assert.equal(child.notesPath, '/actual/shared-notes');
  const delivery: any = Object.values(h.journal.data.deliveries).find((d: any) => d.kind === 'brief');
  assert.equal(delivery.notesPath, '/actual/shared-notes');
  const text = h.log.find((row: any[]) => row[0] === 'send')[2].text;
  assert.match(text, /Shared session notes: \/actual\/shared-notes/);
  assert.doesNotMatch(text, /Shared session notes: \/user-allowed-first/);
  assert.match(rosterFor(h.controller, h.journal, 'top'), /Shared session notes: \/actual\/shared-notes/);
  const saved = child.settings;
  const r2 = await startChild(h.orch, 'top', { ...args(), reservedChatId: r.chat_id });
  assert.equal(h.journal.child(r2.chat_id).notesPath, '/actual/shared-notes');
  assert.deepEqual(saved.additionalDirectories, ['/user-allowed-first', '/actual/shared-notes']);
});

test('a delayed dependent uses the dedicated notes identity and old journals recover it only from the notes directory owner', async () => {
  const h = orchestration();
  h.userTurn();
  h.orch.o.childOptions = async () => ({ additionalDirectories: ['/user-first'] });
  h.orch.o.prepareNotes = async () => ({ path: '/family-notes', additionalDirectories: ['/family-notes'] });
  const first = await startChild(h.orch, 'top', args());
  h.states.set(first.chat_id, { turn: 'running', activeTurn: { id: 'worker' } });
  const wait = await startChild(h.orch, 'top', args({ title: 'dependent', after: [first.name] }));
  assert.equal(wait.status, 'waiting');
  h.states.set(first.chat_id, { turn: 'idle' });
  h.journal.child(first.chat_id).lastReport = { how: 'finished', report: 'done', at: 1000 };
  await settleDependants(h.orch);
  await new Promise((r) => setImmediate(r));
  const delivered = h.log.filter((row: any[]) => row[0] === 'send' && row[1] === wait.chat_id);
  assert.equal(delivered.length, 1, 'the waiting brief actually reached its own child');
  const text = delivered[0][2].text;
  const record: any = Object.values(h.journal.data.deliveries).find((d: any) => d.chatId === wait.chat_id);
  assert.equal(record.notesPath, '/family-notes');
  assert.match(text, /Shared session notes: \/family-notes/);
  delete h.journal.child(first.chat_id).notesPath;
  delete h.journal.child(wait.chat_id).notesPath;
  h.orch.o.notesDirectory = (id: string) => `/private-notes/${id}`;
  assert.match(
    rosterFor(h.controller, h.journal, 'top', h.orch.archived, h.orch.o.notesDirectory),
    /Shared session notes: \/private-notes\/top/,
  );
  assert.doesNotMatch(rosterFor(h.controller, h.journal, 'top'), /Shared session notes: \/user-first/);
});

test('shared-worktree ancestry, detached roots and malformed cycles resolve omitted placement without leaking unrelated history', () => {
  const { worktreeHistory, worktreeFor } = require('../electron/session/orchestration/placement.cjs');
  const h = orchestration();
  h.records.get('top').meta = { worktreeOf: '/base' };
  h.journal.data.children.child = { parentId: 'top', useWorktree: false };
  assert.equal(worktreeHistory(h.orch, 'child'), true);
  h.journal.data.children.child.detached = true;
  assert.equal(worktreeHistory(h.orch, 'child'), false);
  h.journal.data.children.child = { parentId: 'top', useWorktree: true };
  assert.equal(worktreeHistory(h.orch, 'child'), true);
  h.journal.data.children.child = { parentId: 'child', useWorktree: false };
  assert.equal(worktreeHistory(h.orch, 'child'), false);
  h.journal.data.children.child = { parentId: '', useWorktree: false };
  assert.equal(worktreeHistory(h.orch, 'child'), false);
  h.records.set('empty', {});
  assert.equal(worktreeHistory(h.orch, 'empty'), false);
  assert.equal(worktreeFor(h.orch, 'top', '/repo', false), false);
  assert.equal(worktreeFor(h.orch, 'missing', '/repo', true), true);
});

test('notes identity fallback covers a root, a child, a stale journal and arbitrary granted-directory order', () => {
  const { notesPathFor } = require('../electron/session/orchestration/family.cjs');
  const h = orchestration();
  assert.equal(notesPathFor(h.journal, 'top'), null);
  assert.equal(
    notesPathFor(h.journal, 'top', () => undefined),
    null,
  );
  h.journal.data.children.a = { parentId: 'top', notesRoot: 'top', settings: { additionalDirectories: ['/unrelated'] } };
  assert.equal(
    notesPathFor(h.journal, 'a', (id: string) => `/private/${id}`),
    '/private/top',
  );
  h.journal.data.children.b = { parentId: 'top', notesRoot: 'top', notesPath: '/real' };
  assert.equal(notesPathFor(h.journal, 'top'), '/real');
  assert.equal(notesPathFor(h.journal, 'a'), '/real');
  assert.equal(notesPathFor(h.journal, 'b'), '/real');
});

test('proposal cards display effective omitted placement and keep explicit user choices', () => {
  const { orchestrationView } = require('../electron/app/orchestration.cjs');
  const proposals: any = {};
  for (const [id, context, useWorktree] of [
    ['plain', 'fresh', undefined],
    ['managed', 'fresh', undefined],
    ['own', 'fresh', true],
    ['shared', 'fresh', false],
    ['fork', 'fork', undefined],
  ] as const)
    proposals[id] = { parentId: id, status: 'open', createdAt: 0, expiresAt: 9999, args: { context, useWorktree, title: id } };
  const view = orchestrationView({ children: {}, parents: {}, deliveries: {}, proposals }, 1000, (id: string) => id === 'managed');
  assert.deepEqual(Object.fromEntries(Object.entries(view.proposals).map(([id, p]: any) => [id, p.place])), {
    plain: 'folder',
    managed: 'worktree',
    own: 'worktree',
    shared: 'folder',
    fork: 'fork',
  });
});
