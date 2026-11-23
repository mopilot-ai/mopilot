// Multi-level linked families as Claude Desktop runs them (electron/session/orchestration/reportRoute.cjs, family.cjs
// liveParentOf, service.cjs noteTurn/maybeWake): a turn no person took part in wakes the session it reports to however
// deep the family is; a report skips an archived parent for the nearest live ancestor; a deleted parent's sessions say
// who started them; a finished turn that left the user something to answer says so; and a fresh request to the user
// holds the parent's wake for SETTLE_MS.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { liveParentOf, liveSelfOrAbove, resolveMember, MAX_DEPTH } = require('../electron/session/orchestration/family.cjs');
const { noteDriven, unsettled, SETTLE_MS } = require('../electron/session/orchestration/reportRoute.cjs');
const { forget } = require('../electron/session/orchestration/forget.cjs');
const { offerRestart } = require('../electron/session/orchestration/autoHarness.cjs');

const link = (parentId: string, name: string, driven: string[] = [], extra: any = {}) => ({
  parentId,
  name,
  title: name.toUpperCase(),
  createdAt: 1,
  driven,
  lastReport: null,
  ...extra,
});

/** top → mid → leaf, top → sib, each a record main knows. */
function family(over: any = {}) {
  const h = orchestration(over);
  h.journal.change((d: any) => {
    d.children = {
      mid: link('top', 'mid', ['b-mid']),
      leaf: link('mid', 'leaf', ['b-leaf']),
      sib: link('top', 'sib', ['b-sib']),
    };
  });
  for (const id of ['mid', 'leaf', 'sib']) h.records.set(id, { meta: {} });
  return h;
}
const sends = (h: any, to: string) => h.log.filter((l: any) => l[0] === 'send' && l[1] === to).map((l: any) => l[2]);
const archive = (h: any, id: string) => (h.records.get(id).meta.archived = 1);

test('a wake travels up a three-level family: the middle session’s woken turn wakes the top', () => {
  const h = family();
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'leaf done', completed: true, person: false });
  h.flush();
  const [wake] = sends(h, 'mid');
  assert.ok(wake?.text.includes('leaf done'), 'mid is woken with the leaf’s note');
  assert.equal(sends(h, 'top').length, 0);
  // the wake reaches mid as main's own input: its turn is one main drove
  h.orch.dispatching({ chatId: 'mid', kind: 'turn', item: wake });
  assert.ok(h.journal.child('mid').driven.includes(wake.id));
  h.orch.finished({ chatId: 'mid', inputToken: `pending-${wake.id}`, text: 'mid merged it', completed: true });
  h.flush();
  const [top] = sends(h, 'top');
  assert.ok(top?.text.includes('mid merged it'), 'top is woken with mid’s report');
  assert.equal(h.journal.parent('top').notes.length, 0, 'the wake carried the note');
});

test('a turn the user joined, or one the user started, leaves a note that wakes nobody', () => {
  const h = family();
  h.orch.finished({ chatId: 'mid', inputToken: 'pending-b-mid', text: 'with the user', completed: true, person: true });
  h.orch.finished({ chatId: 'sib', inputToken: 'pending-user-typed', text: 'user turn', completed: true });
  h.flush();
  assert.deepEqual(
    h.journal.parent('top').notes.map((n: any) => n.wakes),
    [false, false],
  );
  assert.equal(sends(h, 'top').length, 0);
  assert.equal(h.journal.child('mid').lastReport.driven, false);
});

test('noteDriven records only main’s inputs that start a linked session’s turn, once', () => {
  const h = family();
  h.journal.change((d: any) => (d.children.gone = link('top', 'gone', [], { detached: true })));
  const item = { id: 'peer-1' };
  noteDriven(h.orch, { chatId: 'leaf', kind: 'turn', item }, true);
  noteDriven(h.orch, { chatId: 'leaf', kind: 'steer', item }, false);
  noteDriven(h.orch, { chatId: 'leaf', kind: 'turn', item: {} }, false);
  noteDriven(h.orch, { chatId: 'leaf', kind: 'turn', item: { id: '' } }, false);
  noteDriven(h.orch, { chatId: 'top', kind: 'turn', item }, false);
  noteDriven(h.orch, { chatId: 'gone', kind: 'turn', item }, false);
  assert.deepEqual(h.journal.child('leaf').driven, ['b-leaf']);
  assert.deepEqual(h.journal.child('gone').driven, []);
  noteDriven(h.orch, { chatId: 'leaf', kind: 'turn', item }, false);
  let writes = 0;
  const change = h.journal.change.bind(h.journal);
  h.journal.change = (fn: any) => (writes++, change(fn));
  noteDriven(h.orch, { chatId: 'leaf', kind: 'turn', item }, false);
  assert.deepEqual(h.journal.child('leaf').driven, ['b-leaf', 'peer-1']);
  assert.equal(writes, 0, 'an input already recorded writes nothing');
});

test('a peer message that starts a linked session’s turn wakes its parent like a brief', () => {
  const h = family();
  const item = { id: 'peer-2', text: 'from another chat', opts: { human: false }, peer: { messageId: 'p' } };
  h.orch.dispatching({ chatId: 'sib', kind: 'turn', item });
  h.orch.finished({ chatId: 'sib', inputToken: 'pending-peer-2', text: 'answered the peer', completed: true });
  h.flush();
  assert.ok(sends(h, 'top')[0]?.text.includes('answered the peer'));
});

test('with its parent archived, a report goes to the nearest live ancestor and wakes it', () => {
  const h = family();
  archive(h, 'mid');
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'leaf done', completed: true });
  assert.equal(h.journal.parent('mid'), null, 'nothing waits in the archived parent');
  const [note] = h.journal.parent('top').notes;
  assert.match(note.body, /^The session "LEAF" \(leaf, leaf\), started by an archived session of yours, finished a turn\./);
  assert.equal(note.wakes, true);
  // the top hears from leaf now: while leaf works, top is not woken
  h.states.set('leaf', { turn: 'running' });
  h.flush();
  assert.equal(sends(h, 'top').length, 0);
  h.states.delete('leaf');
  assert.equal(h.orch.maybeWake('top'), true);
});

test('with every ancestor archived, the report stays with its own parent and wakes no one', () => {
  const h = family();
  archive(h, 'mid');
  h.records.get('top').meta.archived = 1;
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'leaf done', completed: true });
  h.flush();
  assert.match(h.journal.parent('mid').notes[0].body, /^The session "LEAF" you started/);
  assert.equal(h.log.filter((l: any) => l[0] === 'send').length, 0);
});

test('"parent" names the live ancestor while the parent is archived: messages, roster and list agree', async () => {
  const h = family();
  archive(h, 'mid');
  h.journal.change((d: any) => (d.parents.top = { wakes: 0, held: false, cutShort: false, notes: [] }));
  const sent = await h.orch.message('leaf', { to: 'parent', message: 'need a decision' });
  assert.equal(sent.to, 'top');
  assert.equal(h.journal.parent('top').wakes, 1, 'a message up counts with the wakes, as a parent’s would');
  assert.equal(resolveMember(h.journal, 'leaf', 'parent'), 'mid', 'without the archive test it is the stored parent');
  const listed = h.orch.list('leaf').sessions;
  assert.equal(listed.find((s: any) => s.id === 'top').relation, 'parent');
  assert.equal(listed.find((s: any) => s.id === 'mid').state, 'archived');
});

test('a session whose parent was deleted reports to the one above it, naming the deleted one', () => {
  const h = family();
  h.deleted.add('mid');
  h.orch.chatDeleted('mid');
  assert.equal(h.journal.child('leaf').parentId, 'top');
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'leaf done', completed: true });
  h.flush();
  const [wake] = sends(h, 'top');
  assert.ok(wake?.text.includes('The session "LEAF" (leaf, leaf), started by "MID", a session of yours since deleted, finished a turn.'));
});

test('a finished turn that left the user a question or an open request says it waits on the user', () => {
  const h = family();
  h.journal.change(
    (d: any) => (d.wrapUps.leaf = { turn: 'pending-b-leaf', recap: 'Picked two options', ask: 'Which one?', actions: [], at: 1 }),
  );
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'x', completed: true });
  const body = h.journal.parent('mid').notes[0].body;
  assert.match(body, /finished a turn and then reported that it was waiting on the user\./);
  assert.ok(body.endsWith('if it still waits, tell the user so in one line.'));
  assert.ok(!body.includes('send_message'), 'no follow-up hint while it waits on the user');
  // an earlier turn's question is not this turn's
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-later', text: 'y', completed: true });
  assert.ok(!h.journal.parent('mid').notes[1].body.includes('waiting on the user'));
  // a request still open after the turn
  h.states.set('sib', { approvals: [{ id: 'a1' }] });
  h.orch.finished({ chatId: 'sib', inputToken: 'pending-b-sib', text: 'z', completed: true });
  assert.ok(h.journal.parent('top').notes[0].body.includes('waiting on the user'));
  // a failed turn never claims to wait on the user
  h.orch.finished({ chatId: 'sib', inputToken: 'pending-b-sib', text: 'z', completed: false });
  assert.ok(!h.journal.parent('top').notes[1].body.includes('waiting on the user'));
});

test('a fresh request to the user holds the parent’s wake until it has waited SETTLE_MS', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let now = 1000;
    const h = family({ now: () => now });
    h.orch.finished({ chatId: 'sib', inputToken: 'pending-b-sib', text: 'sib done', completed: true });
    h.states.set('mid', { turn: 'awaitingUser' });
    h.orch.awaitingUser('mid');
    h.flush();
    assert.equal(sends(h, 'top').length, 0, 'mid’s new request counts as work');
    assert.equal(unsettled(h.orch, 'mid'), true);
    // a second request restarts the wait
    now += SETTLE_MS - 1;
    h.orch.awaitingUser('mid');
    mock.timers.tick(SETTLE_MS - 1);
    h.flush();
    assert.equal(sends(h, 'top').length, 0);
    // the timer fires with the clock still 1 ms short: it waits out the rest instead of giving up
    const since = h.orch.awaitingSince.get('mid');
    now = since + SETTLE_MS - 1;
    mock.timers.tick(1);
    assert.equal(sends(h, 'top').length, 0);
    assert.equal(h.orch.settleTimers.size, 1);
    now = since + SETTLE_MS;
    mock.timers.tick(1);
    assert.equal(unsettled(h.orch, 'mid'), false);
    const [wake] = sends(h, 'top');
    assert.ok(wake?.text.includes('mid is waiting for the user'), 'the wake names the session waiting on the user');
    assert.equal(h.orch.settleTimers.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test('the settle wait ignores chats with no live parent and ends with a deleted chat', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let now = 1000;
    const h = family({ now: () => now });
    h.journal.change((d: any) => (d.children.gone = link('top', 'gone', [], { detached: true })));
    for (const id of ['top', 'gone']) h.orch.awaitingUser(id);
    assert.equal(h.orch.settleTimers.size, 0);
    h.orch.awaitingUser('leaf');
    h.orch.awaitingUser('sib');
    h.deleted.add('leaf');
    h.orch.chatDeleted('leaf');
    assert.deepEqual([...h.orch.settleTimers.keys()], ['sib']);
    // detached before its request settled: the timer has nobody to wake
    h.orch.detach('sib');
    let checked = 0;
    h.orch.maybeWake = () => (checked++, false);
    now += SETTLE_MS;
    mock.timers.tick(SETTLE_MS);
    assert.equal(checked, 0);
    h.journal.startupError = 'journal_unavailable';
    h.orch.awaitingUser('mid');
    assert.equal(h.orch.settleTimers.size, 0);
  } finally {
    mock.timers.reset();
  }
});

test('detaching a session drops its notes wherever they wait', () => {
  const h = family();
  archive(h, 'mid');
  h.orch.finished({ chatId: 'leaf', inputToken: 'pending-b-leaf', text: 'leaf done', completed: true, person: true });
  assert.equal(h.journal.parent('top').notes.length, 1);
  h.orch.detach('leaf');
  assert.equal(h.journal.parent('top').notes.length, 0);
});

test('liveParentOf: none for a top chat; the stored parent when nothing above is live, a loop, or too deep', () => {
  const h = family();
  const archived = new Set<string>();
  const is = (id: string) => archived.has(id);
  assert.equal(liveParentOf(h.journal, 'top', is), null);
  assert.deepEqual(liveParentOf(h.journal, 'leaf', is), { parentId: 'mid', viaArchived: false });
  archived.add('mid');
  assert.deepEqual(liveParentOf(h.journal, 'leaf', is), { parentId: 'top', viaArchived: true });
  assert.deepEqual(
    ['leaf', 'mid'].map((id) => liveSelfOrAbove(h.journal, id, is)),
    ['leaf', 'top'],
  );
  archived.add('top');
  assert.deepEqual(liveParentOf(h.journal, 'leaf', is), { parentId: 'mid', viaArchived: false });
  // nobody live above: notes stay where they were meant to go
  assert.deepEqual(
    ['mid', 'top'].map((id) => liveSelfOrAbove(h.journal, id, is)),
    ['mid', 'top'],
  );
  // a damaged loop: a ↔ b, both archived
  h.journal.change((d: any) => {
    d.children.a = link('b', 'a');
    d.children.b = link('a', 'b');
  });
  archived.add('b');
  assert.deepEqual(liveParentOf(h.journal, 'a', is), { parentId: 'b', viaArchived: false });
  // a chain deeper than MAX_DEPTH, all archived
  h.journal.change((d: any) => {
    for (let i = 0; i <= MAX_DEPTH + 1; i++) d.children[`c${i}`] = link(`c${i + 1}`, `c${i}`);
  });
  for (let i = 1; i <= MAX_DEPTH + 2; i++) archived.add(`c${i}`);
  assert.deepEqual(liveParentOf(h.journal, 'c0', is), { parentId: 'c1', viaArchived: false });
});

test('forget relinks past several deleted ancestors, keeps a waiting brief with its new parent, and stops at a detached link', () => {
  const base = () => ({
    children: {
      p1: link('top', 'p1'),
      p2: link('p1', 'p2'),
      leaf: link('p2', 'leaf'),
      off: link('top', 'off', [], { detached: true }),
      under: link('off', 'under'),
    },
    parents: {},
    proposals: {},
    plans: {},
    wrapUps: {},
    deliveries: {},
    queue: [],
    dependants: { leaf: { parentId: 'p2', title: 'leaf', briefId: 'b', after: ['x'], brief: { prompt: 'p' }, held: null } },
  });
  const d: any = base();
  // leaf's report that p2 never read goes up with it
  d.parents.p2 = { wakes: 0, held: false, cutShort: false, notes: [{ childId: 'leaf', body: 'leaf done', at: 1, wakes: true }] };
  const out = forget(d, new Set(['p1', 'p2', 'off']), 5);
  assert.deepEqual([d.children.leaf.parentId, d.children.leaf.deletedParent], ['top', { id: 'p2', title: 'P2' }]);
  assert.equal(d.dependants.leaf.parentId, 'top');
  assert.equal(d.children.under, undefined, 'a detached deleted chat’s sessions are top-level');
  assert.deepEqual(out.relinked, ['leaf']);
  assert.deepEqual(
    d.parents.top.notes.slice(2).map((n: any) => [n.body, n.wakes]),
    [
      ['leaf done', true],
      ['Sessions started by a session of yours since deleted now report to you: leaf (leaf).', false],
    ],
  );
  assert.ok(out.told.includes('top'));
  // a chain of deleted chats deeper than MAX_DEPTH leaves its session top-level
  const deep: any = { ...base(), children: { leaf: link('d0', 'leaf') }, dependants: {} };
  const ids = new Set<string>();
  for (let i = 0; i <= MAX_DEPTH + 1; i++) {
    deep.children[`d${i}`] = link(`d${i + 1}`, `d${i}`);
    ids.add(`d${i}`);
  }
  assert.deepEqual(forget(deep, ids, 5).relinked, []);
  assert.equal(deep.children.leaf, undefined);
});

test('notes about a session go to the live ancestor while its parent is archived: held, dropped, failed and restart notes', async () => {
  const h = family({ send: async (id: string, item: any) => (h.log.push(['send', id, item]), { started: false, error: 'harness gone' }) });
  archive(h, 'mid');
  h.records.set('wait', { meta: {} });
  h.journal.change((d: any) => {
    d.children.wait = link('mid', 'wait');
    d.children.leaf.lastReport = { how: 'failed', report: null, chars: 0, at: 1, driven: true };
    d.dependants.wait = { parentId: 'mid', title: 'wait', briefId: 'bw', after: ['leaf'], brief: { prompt: 'p' }, held: null };
  });
  h.orch.pump();
  const bodies = () => (h.journal.parent('top')?.notes ?? []).map((n: any) => n.body);
  assert.ok(
    bodies().some((b: string) => /so the sessions waiting for it are held: wait/.test(b)),
    'held',
  );
  // a message for leaf that its harness refuses
  h.journal.change((d: any) => (d.queue = [{ id: 'q-leaf', chatId: 'leaf', item: { id: 'q-leaf', text: 'x' }, at: 1 }]));
  h.orch.pump();
  await new Promise((r) => setImmediate(r));
  assert.ok(
    bodies().some((b: string) => /A message for leaf \(leaf\) did not start: harness gone/.test(b)),
    'failed delivery',
  );
  // a message waiting for an archived session is dropped, and the live ancestor is told
  archive(h, 'leaf');
  h.journal.change((d: any) => (d.queue = [{ id: 'q2', chatId: 'leaf', item: { id: 'q2', text: 'y' }, at: 1 }]));
  h.orch.pump();
  assert.ok(bodies().some((b: string) => /A message waiting for the session leaf \(leaf\) was not sent/.test(b)));
  assert.equal(h.journal.parent('mid'), null, 'nothing waits in the archived parent');
  // a usage-limit restart offer: the proposal and its note belong to the live ancestor
  h.journal.change((d: any) => (d.children.leaf.harness = 'codex'));
  const id = await offerRestart(h.orch, 'leaf');
  assert.ok(bodies().some((b: string) => b.includes('is at its usage limit')));
  if (id) assert.equal(h.journal.proposal(id).parentId, 'top');
});

test('a chat the user steers from claude.ai is not woken by its sessions; its notes wait for the link to come down', () => {
  let driven = true;
  const h = family({ remotelyDriven: (id: string) => id === 'top' && driven });
  h.orch.finished({ chatId: 'sib', inputToken: 'pending-b-sib', text: 'sib done', completed: true, person: false });
  h.flush();
  assert.equal(sends(h, 'top').length, 0);
  assert.equal(h.orch.maybeWake('top'), false);
  // the note is kept: once the link is down the same check wakes it
  driven = false;
  assert.equal(h.orch.maybeWake('top'), true);
});
