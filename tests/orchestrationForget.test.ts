// electron/session/orchestration/forget.cjs and the deletion hook: a deleted chat leaves the orchestration journal in
// one write (its link, notes, proposals, task list, wrap-up box, waiting items and shown items); its children report to
// the session above it (Claude Desktop's relink), or become top-level when none is, and its parent is told, without
// waking anyone; a journal that can't be written keeps everything and tries again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');
const { holds, forget } = require('../electron/session/orchestration/forget.cjs');
const { orchestrationView } = require('../electron/app/orchestration.cjs');
const { ChatDeletion } = require('../electron/session/chatDeletion.cjs');
const { addHook } = require('../electron/session/hookChain.cjs');

const child = (parentId: string, name: string) => ({
  parentId,
  name,
  title: name.toUpperCase(),
  createdAt: 1,
  driven: [],
  lastReport: null,
});
const parent = (notes: any[] = []) => ({ wakes: 0, held: false, cutShort: false, notes });
const proposal = (parentId: string, status = 'open') => ({
  parentId,
  kind: 'own_initiative',
  status,
  args: { background: BACKGROUND, title: 't', prompt: 'p' },
  createdAt: 1,
  expiresAt: 9e15,
  chatId: null,
});
const queued = (id: string, chatId: string) => ({ id, chatId, item: { id, text: 'x' }, at: 1 });

/**
 * top → mid → leaf, top → sib; each with something in every part of the journal. `writes` counts the journal's
 * writes and `fail` makes the next ones throw.
 */
function seeded(over: any = {}) {
  const io = { writes: 0, published: 0, fail: false };
  const journal = new OrchestrationJournal({
    file: '/nonexistent/orchestration.json',
    write: () => {
      if (io.fail) throw new Error('disk full');
      io.writes++;
    },
    publish: () => io.published++,
  });
  const h = orchestration({ ...over, journal });
  journal.change((d: any) => {
    d.children = { mid: child('top', 'mid'), leaf: child('mid', 'leaf'), sib: child('top', 'sib') };
    d.parents = {
      top: parent([{ childId: 'sib', body: 'sib finished', at: 1, wakes: false }]),
      mid: parent([{ childId: 'leaf', body: 'leaf finished', at: 1, wakes: true }]),
    };
    d.proposals = {
      task_mid: proposal('mid'),
      task_top: proposal('top'),
      task_leaf: proposal('leaf', 'started'),
      task_made_mid: { ...proposal('top', 'started'), chatId: 'mid' },
    };
    d.plans = { mid: { turn: 't', items: [{ content: 'a', status: 'pending' }], at: 1 }, top: { turn: 't', items: [], at: 1 } };
    d.wrapUps = {
      mid: { turn: 't', recap: 'r', ask: null, actions: [], at: 1 },
      sib: { turn: 't', recap: 's', ask: null, actions: [], at: 1 },
    };
    d.deliveries = {
      b1: { kind: 'brief', chatId: 'mid', at: 1 },
      w1: { kind: 'wake', chatId: 'mid', at: 1, notes: [] },
      m1: { kind: 'message', chatId: 'top', from: 'mid', body: 'hi', at: 1 },
      b2: { kind: 'brief', chatId: 'leaf', at: 1 },
    };
    d.queue = [queued('q1', 'mid'), queued('q2', 'leaf'), queued('q3', 'sib'), queued('q4', 'mid')];
  });
  for (const id of ['mid', 'leaf', 'sib']) h.records.set(id, { meta: {} });
  // sib is busy, so the queue's own pump sends nothing and writes only what forgetting writes
  h.states.set('sib', { turn: 'running' });
  io.writes = 0;
  io.published = 0;
  return { ...h, io };
}

test('deleting a child forgets everything of it in one write; its parent is told, not woken; its children report to that parent', () => {
  const h = seeded();
  h.orch.chatDeleted('mid');
  assert.equal(h.io.writes, 1, 'one write');
  assert.equal(h.io.published, 1);
  const d = h.journal.data;
  assert.deepEqual(Object.keys(d.children).sort(), ['leaf', 'sib'], 'mid is gone');
  assert.deepEqual(
    [d.children.leaf.parentId, d.children.leaf.deletedParent],
    ['top', { id: 'mid', title: 'MID' }],
    'leaf reports to the session above mid, which it remembers',
  );
  assert.equal(d.parents.mid, undefined);
  assert.deepEqual(Object.keys(d.proposals).sort(), ['task_leaf', 'task_made_mid', 'task_top']);
  assert.equal(d.proposals.task_made_mid.chatId, null, 'the card that started mid no longer opens it');
  assert.deepEqual(Object.keys(d.plans), ['top']);
  assert.deepEqual(Object.keys(d.wrapUps), ['sib']);
  assert.deepEqual(Object.keys(d.deliveries).sort(), ['b2', 'm1'], 'a message mid sent to top stays in top');
  assert.deepEqual(
    d.queue.map((e: any) => e.id),
    ['q2', 'q3'],
    "mid's own items are dropped; what it sent leaf still waits for leaf, a linked session still",
  );
  assert.deepEqual(d.parents.top.notes.slice(-3), [
    { childId: 'mid', body: 'The session mid (mid) was deleted. 2 waiting messages for it were not sent.', at: 1000, wakes: false },
    // what leaf reported that mid had not read goes up with it (sib still works, so it wakes no one yet)
    { childId: 'leaf', body: 'leaf finished', at: 1, wakes: true },
    {
      childId: 'leaf',
      body: 'Sessions started by a session of yours since deleted now report to you: leaf (leaf).',
      at: 1000,
      wakes: false,
    },
  ]);
  assert.equal(d.parents.top.notes.length, 4, 'the earlier note stays');
  assert.equal(d.parents.leaf, undefined, 'leaf starts no sessions, so no wake would ever carry a note to it');
  // what windows get no longer names it
  const view = orchestrationView(d);
  assert.ok(!('mid' in view.children) && !('mid' in view.plans) && !('mid' in view.wrapUps) && !view.queue.includes('mid'));
  assert.ok(!Object.values(view.proposals).some((p: any) => p.parentId === 'mid'));
  // nothing is left to forget, so a second call writes nothing
  h.orch.chatDeleted('mid');
  assert.equal(h.io.writes, 1);
  // the queue then drains to leaf, which is idle; nobody was woken: every note it left waits
  h.flush();
  assert.deepEqual(
    h.log.filter((l: any) => l[0] === 'send').map((l: any) => [l[1], l[2].id, l[2].opts.human]),
    [['leaf', 'q2', false]],
  );
  assert.deepEqual(
    h.journal.data.queue.map((e: any) => e.id),
    ['q3'],
  );
});

test('a deleted top chat leaves its children top-level; a chat the journal never held writes nothing', () => {
  const h = seeded();
  h.orch.chatDeleted('unlinked');
  assert.equal(h.io.writes, 0);
  h.orch.chatDeleted('top');
  const d = h.journal.data;
  assert.deepEqual(Object.keys(d.children).sort(), ['leaf'], 'mid and sib are top-level; leaf keeps mid');
  assert.equal(d.parents.top, undefined);
  assert.deepEqual(Object.keys(d.plans), ['mid']);
  assert.ok(!('m1' in d.deliveries));
  assert.equal(d.parents.sib, undefined);
  assert.deepEqual(d.parents.mid.notes.at(-1), {
    childId: 'top',
    body: 'The chat that started this one (top) was deleted; this chat is top-level now.',
    at: 1000,
    wakes: false,
  });
  assert.equal(d.parents.mid.notes.length, 2, "mid keeps leaf's note and is told");
  assert.deepEqual(
    h.log.filter((l: any) => l[0] === 'send').map((l: any) => [l[1], l[2].id]),
    [
      ['mid', 'q1'],
      ['sib', 'q3'],
      ['mid', 'q4'],
    ],
  );
  assert.deepEqual(
    d.queue.map((e: any) => e.id),
    ['q2'],
  );
});

test('a journal that cannot be written keeps everything, tells no window, and forgets on the next try', () => {
  const h = seeded();
  const before = structuredClone(h.journal.data);
  h.io.fail = true;
  assert.doesNotThrow(() => h.orch.chatDeleted('mid'));
  assert.doesNotThrow(() => h.orch.chatDeleted('leaf'));
  assert.deepEqual(h.journal.data, before, 'commit or nothing');
  assert.equal(h.io.published, 0);
  // the next turn end (the pump) tries again, for both
  h.io.fail = false;
  h.orch.pump();
  assert.equal(h.io.writes, 1);
  const d = h.journal.data;
  assert.deepEqual(Object.keys(d.children), ['sib']);
  assert.equal(d.parents.leaf, undefined, 'a deleted orphan is not told');
  assert.equal(d.parents.top.notes.length, 2, 'only the surviving parent is told, once');
});

test('a deleted child that kept its parent from waking lets the wake go, carrying the note', async () => {
  const h = orchestration();
  h.userTurn();
  const a = (await h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'p', use_worktree: false })).chat_id;
  const b = (await h.orch.start('top', { background: BACKGROUND, title: 'B', prompt: 'p', use_worktree: false })).chat_id;
  h.states.set('top', { turn: 'idle' });
  h.states.set(a, { turn: 'running' });
  // b finishes the brief top sent it: a wake waits only for a
  h.orch.finished({ chatId: b, inputToken: `pending-${h.journal.child(b).driven[0]}`, text: 'b done', completed: true });
  h.flush();
  assert.ok(!h.log.some((l: any) => l[0] === 'send' && l[1] === 'top'));
  const name = h.journal.child(a).name;
  h.orch.chatDeleted(a);
  h.flush();
  const wake = h.log.find((l: any) => l[0] === 'send' && l[1] === 'top');
  assert.ok(wake, 'the parent is woken');
  assert.ok(wake[2].text.includes(`The session ${name} (${a}) was deleted.`));
  assert.ok(wake[2].text.includes('b done'));
  assert.equal(h.journal.child(a), null);
});

test('deleting a parent retires its pending start before allocation while independent descendants remain', async () => {
  let release!: () => void;
  const h = seeded({ usable: () => new Promise<boolean>((r) => (release = () => r(true))) });
  h.journal.change((d: any) => (d.parents.mid.notes = []));
  h.userTurn('mid');
  const started = h.orch.start('mid', { proposal_id: 'task_mid' });
  const cancelled = assert.rejects(started, (error: any) => error.code === 'start_cancelled');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.journal.proposal('task_mid').status, 'starting');
  h.orch.chatDeleted('mid');
  assert.equal(h.journal.proposal('task_mid').status, 'starting', 'its start still writes to it');
  assert.equal(holds(h.journal.data, new Set(['mid'])), false, 'nothing else of mid is left');
  release();
  await cancelled;
  h.orch.pump();
  assert.equal(h.journal.proposal('task_mid'), null);
  assert.equal(
    h.log.some((row: any[]) => /^(startCodex|forkCodex|newWorktree)$/.test(row[0])),
    false,
    'the retired start creates and dispatches no child',
  );
  assert.equal(h.journal.child('leaf').parentId, 'top', 'its existing child survives, reporting to the session above it');
  assert.ok(h.records.has('leaf'));
  assert.equal(h.journal.child('sib').parentId, 'top', 'the sibling retains its unrelated family');
});

test('an orphan with sessions of its own is told; a refused send of what waited for it is only noted', async () => {
  const h = seeded({ send: async () => Promise.reject(new Error('harness gone')) });
  // mid is top-level here, so nothing is above it to report to
  h.journal.change((d: any) => {
    delete d.children.mid;
    d.children.gc = child('leaf', 'gc');
  });
  h.orch.chatDeleted('mid');
  await new Promise((r) => setImmediate(r));
  assert.match(h.journal.parent('leaf').notes[0].body, /^The chat that started this one \(mid\) was deleted/);
  assert.equal(h.journal.child('gc').parentId, 'leaf');
  assert.deepEqual(
    h.journal.data.queue.map((e: any) => e.id),
    ['q3'],
    'the refused item was taken off the queue once',
  );
});

test('an unusable journal is left alone', () => {
  const h = seeded();
  h.journal.startupError = 'journal_unavailable';
  assert.doesNotThrow(() => h.orch.chatDeleted('mid'));
  assert.equal(h.io.writes, 0);
});

test('forget keeps the notes it adds to a parent within the kept number', () => {
  const d: any = {
    children: { c: child('p', 'c') },
    parents: { p: parent(Array.from({ length: 40 }, (_, i) => ({ childId: 'x', body: `n${i}`, at: i, wakes: false }))) },
    proposals: {},
    plans: {},
    wrapUps: {},
    deliveries: {},
    queue: [queued('q', 'c')],
    dependants: {},
  };
  assert.deepEqual(forget(d, new Set(['c']), 5), { told: ['p'], release: [], relinked: [] });
  assert.equal(d.parents.p.notes.length, 32);
  assert.equal(d.parents.p.notes.at(-1).body, 'The session c (c) was deleted. 1 waiting message for it was not sent.');
});

/** ChatDeletion around a memory-only store whose one chat is `root`. */
function deletion(remove = async () => {}) {
  const store: any = {
    records: new Map([['root', { segments: [{ kind: 'codex', nativeId: 'root' }] }]]),
    newer: new Set(),
    unreadable: new Set(),
    record(id: string) {
      return this.records.get(id);
    },
  };
  const events: any[] = [];
  const del = new ChatDeletion({ store, remove: { codex: remove, claude: remove, acp: remove }, broadcast: (r: any) => events.push(r) });
  return { del, events };
}

test('ChatDeletion tells its onDeleted hooks once a chat is deleted, and a failing hook does not fail the deletion', async () => {
  const { del, events } = deletion();
  const told: any[] = [];
  addHook(del, 'onDeleted', (r: any) => told.push(['first', r.chatId]));
  addHook(del, 'onDeleted', () => {
    throw new Error('hook bug');
  });
  addHook(del, 'onDeleted', (r: any) => told.push(['third', r.chatId]));
  const receipt = await del.delete('root');
  assert.equal(receipt.chatId, 'root');
  assert.deepEqual(told, [
    ['first', 'root'],
    ['third', 'root'],
  ]);
  assert.equal(events.length, 1);
  // a retry returns the receipt without telling again
  await del.delete('root');
  assert.equal(told.length, 2);
});

test('a native deletion that fails tells no hook', async () => {
  const { del } = deletion(async () => {
    throw new Error('native refused');
  });
  let told = 0;
  del.onDeleted = () => told++;
  await assert.rejects(del.delete('root'), /native refused/);
  assert.equal(told, 0);
});
