// electron/session/orchestration/service.cjs: each ended turn of a child leaves its parent a note; the parent is
// woken once, only when none of its children is working and the parent is idle, unstopped and under the wake cap; a
// message from the user resets that; family messages and stops reach only linked chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

/** A parent "top" with linked children (fresh, sharing its folder), its user turn over. */
async function family(n = 2, over: any = {}) {
  const h = orchestration(over);
  h.userTurn();
  const ids: string[] = [];
  for (let i = 0; i < n; i++)
    ids.push((await h.orch.start('top', { background: BACKGROUND, title: `Task ${i}`, prompt: 'do it', use_worktree: false })).chat_id);
  h.states.set('top', { turn: 'idle' });
  h.flush();
  const brief = (id: string) => h.journal.child(id).driven[0];
  return { ...h, ids, brief };
}
/** the user presses Stop while `id` runs a turn */
const stop = (h: any, id: string) => {
  h.states.set(id, { ...(h.states.get(id) ?? {}), turn: 'running' });
  h.orch.stopped(id);
  h.states.set(id, { ...h.states.get(id), turn: 'idle' });
};
const wakes = (h: any) => h.log.filter((l: any) => l[0] === 'send' && l[1] === 'top');

test('start answers the same call in one turn once, runs starts one at a time, and lets a failed start be tried again', async () => {
  const h = orchestration();
  h.userTurn();
  const order: string[] = [];
  const slow = h.starter.startCodex;
  h.starter.startCodex = async (...a: any[]) => {
    order.push('start');
    await new Promise((r) => setTimeout(r, 5));
    order.push('made');
    return (slow as any)(...a);
  };
  const a = h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'p', use_worktree: false });
  const again = h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'p', use_worktree: false });
  const b = h.orch.start('top', { background: BACKGROUND, title: 'B', prompt: 'p', use_worktree: false });
  assert.equal(a, again);
  assert.equal(h.orch.starting.get('top'), 2);
  const [ra, rb] = await Promise.all([a, b]);
  assert.notEqual(ra.chat_id, rb.chat_id);
  assert.deepEqual(order, ['start', 'made', 'start', 'made']);
  assert.equal(h.orch.starting.has('top'), false);
  assert.equal(h.deferred.length, 2);
  // a refused start is forgotten, so the same call can be made again once the cause is fixed
  h.records.set('top', { meta: { archived: 1 } });
  await assert.rejects(h.orch.start('top', { background: BACKGROUND, title: 'C', prompt: 'p' }), (e: any) => e.code === 'parent_archived');
  await new Promise((r) => setImmediate(r));
  h.records.set('top', { meta: {} });
  assert.equal((await h.orch.start('top', { background: BACKGROUND, title: 'C', prompt: 'p', use_worktree: false })).status, 'started');
  // arguments are checked before anything starts
  assert.throws(
    () => h.orch.start('top', { prompt: 'p' }),
    (e: any) => e.code === 'invalid_title',
  );
});

test('a start in a turn the harness has not named yet is keyed by its token', async () => {
  const h = orchestration();
  h.userTurn();
  h.rts.set('top', { inputToken: null, token: 'pending-only-token' });
  const a = h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'p', use_worktree: false });
  assert.equal(h.orch.start('top', { background: BACKGROUND, title: 'A', prompt: 'p', use_worktree: false }), a);
  assert.ok([...h.orch.recent.keys()][0].includes('pending-only-token'));
  await a;
});

test('a child in a worktree whose branch is unknown is noted and listed without one', async () => {
  const h = orchestration({ worktreeInfo: () => null });
  h.userTurn();
  const { chat_id: id } = await h.orch.start('top', { background: BACKGROUND, title: 'W', prompt: 'p' });
  h.orch.finished({ chatId: id, inputToken: 'pending-user', text: 'done', completed: true });
  assert.match(h.journal.parent('top').notes[0].body, /finished a turn\. It reported/);
  assert.equal(h.orch.list('top').sessions[0].branch, null);
});

test('the remembered starts are bounded', async () => {
  const h = orchestration({ usable: async () => true, projectOf: async () => null });
  h.userTurn();
  const first = h.orch.start('top', { background: BACKGROUND, title: 'T0', prompt: 'p' });
  await first.catch(() => {});
  for (let i = 1; i <= 201; i++) {
    h.rts.set('top', { inputToken: `pending-${i}` });
    h.orch.recent.set(`k${i}`, Promise.resolve());
  }
  h.orch.start('top', { background: BACKGROUND, title: 'last', prompt: 'p' }).catch(() => {});
  assert.ok(h.orch.recent.size <= 201);
});

test('a child turn the parent drove leaves a note; once none is working the idle parent is woken once with all notes', async () => {
  const h = await family(2);
  const [a, b] = h.ids;
  h.states.set(b, { turn: 'running' });
  h.orch.finished({ chatId: a, inputToken: `pending-${h.brief(a)}`, text: 'A is done', completed: true });
  h.flush();
  assert.equal(wakes(h).length, 0, 'b still works');
  const note = h.journal.parent('top').notes[0];
  assert.equal(note.wakes, true);
  assert.match(note.body, /"Task 0" you started \(task-0, codex1\) finished a turn\. It reported .*"A is done"/);
  assert.deepEqual(h.journal.child(a).lastReport, { how: 'finished', report: 'A is done', chars: 9, at: 1000, driven: true });
  h.states.set(b, { turn: 'idle' });
  h.orch.finished({ chatId: b, inputToken: `pending-${h.brief(b)}`, text: 'B is done', completed: true });
  h.flush();
  const sent = wakes(h);
  assert.equal(sent.length, 1);
  const item = sent[0][2];
  assert.equal(item.sideSession.id, item.id);
  assert.deepEqual(item.opts, { human: false });
  assert.match(
    item.text,
    /A is done[\s\S]*B is done[\s\S]*Linked sessions now[\s\S]*<mopilot-side-sessions-event>None of the sessions you started is working now/,
  );
  assert.equal(h.journal.parent('top').notes.length, 0);
  assert.equal(h.journal.parent('top').wakes, 1);
  assert.deepEqual(
    h.journal.data.deliveries[item.id].notes.map((n: any) => n.childId),
    [a, b],
  );
  assert.equal(h.orch.waking.get('top'), item.id);
  // a second check while that wake is on its way sends nothing
  h.orch.finished({ chatId: a, inputToken: `pending-${h.brief(a)}`, text: 'again', completed: true });
  h.flush();
  assert.equal(wakes(h).length, 1);
  // the wake's own turn ends: the next notes wake it again
  h.orch.finished({ chatId: 'top', inputToken: `pending-${item.id}`, text: 'ok', completed: true });
  h.flush();
  assert.equal(wakes(h).length, 2);
});

test('notes of a turn the user drove, or that did not finish, wait instead of waking; a stop reads as stopped', async () => {
  const h = await family(1);
  const [a] = h.ids;
  h.orch.finished({ chatId: a, inputToken: 'pending-typed-by-user', text: 'user turn', completed: true });
  h.orch.finished({ chatId: a, inputToken: null, text: 'no token', completed: true });
  h.orch.finished({ chatId: a, inputToken: `pending-${h.brief(a)}`, text: 'broke', completed: false });
  stop(h, a);
  h.orch.finished({ chatId: a, inputToken: `pending-${h.brief(a)}`, text: '', completed: false });
  h.orch.crashed(a);
  h.flush();
  assert.equal(wakes(h).length, 0);
  const notes = h.journal.parent('top').notes;
  assert.deepEqual(
    notes.map((n: any) => n.wakes),
    [false, false, false, false, false],
  );
  assert.match(notes[2].body, /ended its turn with an error/);
  assert.match(notes[3].body, /was stopped before its turn finished\./);
  assert.match(notes[4].body, /did not finish its turn/);
  assert.equal(h.journal.child(a).lastReport.how, 'lost');
  // a later turn the parent drove wakes it with every waiting note
  h.orch.finished({ chatId: a, inputToken: `pending-${h.brief(a)}`, text: 'fixed', completed: true });
  h.flush();
  assert.equal(wakes(h).length, 1);
  assert.equal(h.journal.data.deliveries[wakes(h)[0][2].id].notes.length, 6);
});

test('notes are capped, and a branch is named for a child in its own worktree', async () => {
  const h = orchestration({ worktreeInfo: () => ({ branch: 'mopilot/1234' }) });
  h.userTurn();
  const { chat_id: id } = await h.orch.start('top', { background: BACKGROUND, title: 'W', prompt: 'p' });
  for (let i = 0; i < 40; i++) h.orch.finished({ chatId: id, inputToken: 'pending-user', text: `t${i}`, completed: true });
  const notes = h.journal.parent('top').notes;
  assert.equal(notes.length, 32);
  assert.match(notes.at(-1).body, /finished a turn \(branch "mopilot\/1234"\)\. It reported .*"t39"/);
});

test('the parent is not woken while busy, holding work, starting a child, archived, gone, stopped, cut short or at the cap', async () => {
  const check = async (setup: (h: any) => void, expect = 0) => {
    const h = await family(1);
    setup(h);
    h.orch.finished({ chatId: h.ids[0], inputToken: `pending-${h.brief(h.ids[0])}`, text: 'r', completed: true });
    h.flush();
    assert.equal(wakes(h).length, expect);
    return h;
  };
  await check((h) => h.states.set('top', { turn: 'running' }));
  await check((h) => h.states.set('top', { queue: [{}] }));
  await check((h) => h.states.set('top', { approvals: [{}] }));
  await check((h) => h.orch.starting.set('top', 1));
  await check((h) => h.records.set('top', { meta: { archived: 2 } }));
  await check((h) => h.records.delete('top'));
  await check((h) => h.states.set(h.ids[0], { queue: [{}] }));
  await check((h) => h.journal.change((d: any) => (d.parents.top.wakes = 10)));
  await check((h) => stop(h, 'top'));
  await check((h) => h.orch.finished({ chatId: 'top', inputToken: 'pending-x', text: '', completed: false }));
  await check((h) => h.orch.crashed('top'));
  const archivedChild = await check((h) => h.records.set(h.ids[0], { meta: { archived: 1 } }), 1);
  assert.ok(!wakes(archivedChild)[0][2].text.includes('task-0 ='));
  // a child waiting for the user does not hold the wake; it is named
  const waiting = await family(2);
  waiting.states.set(waiting.ids[1], { turn: 'awaitingUser' });
  waiting.orch.finished({ chatId: waiting.ids[0], inputToken: `pending-${waiting.brief(waiting.ids[0])}`, text: 'r', completed: true });
  waiting.flush();
  assert.match(wakes(waiting)[0][2].text, /task-1 is waiting for the user/);
});

test('a message from the user lifts a stop, a cut-short turn and the wake count; other input does not', async () => {
  const h = await family(1);
  // a Stop with no turn running stops nothing
  h.orch.stopped('top');
  assert.equal(h.journal.parent('top').held, false);
  assert.equal(h.orch.stopping.has('top'), false);
  stop(h, 'top');
  stop(h, 'top');
  h.orch.finished({ chatId: 'top', inputToken: 'x', text: '', completed: false });
  h.journal.change((d: any) => (d.parents.top.wakes = 10));
  h.orch.dispatching({ chatId: 'top', item: { opts: { human: false } } });
  h.orch.dispatching({ chatId: 'nobody', item: { opts: { human: true } } });
  assert.deepEqual(h.journal.parent('top'), { wakes: 10, held: true, cutShort: true, notes: [], starts: 1, continuable: false });
  h.orch.dispatching({ chatId: 'top', item: { opts: { human: true } } });
  assert.deepEqual(h.journal.parent('top'), {
    wakes: 0,
    held: false,
    cutShort: false,
    notes: [],
    starts: 0,
    continuedStarts: 0,
    continuable: true,
  });
  let writes = 0;
  const orig = h.journal.commit.bind(h.journal);
  h.journal.commit = (d: any) => (writes++, orig(d));
  h.orch.dispatching({ chatId: 'top', item: { opts: { human: true } } });
  h.orch.dispatching({ chatId: 'top' });
  assert.equal(writes, 0, 'nothing to reset writes nothing');
});

test('with the journal unavailable the hooks only track stops and nothing is written or woken', async () => {
  const h = await family(1);
  h.journal.startupError = 'journal_unavailable';
  assert.equal(h.orch.unavailable, 'journal_unavailable');
  stop(h, h.ids[0]);
  assert.ok(h.orch.stopping.has(h.ids[0]));
  h.orch.finished({ chatId: h.ids[0], inputToken: 'x', text: 't', completed: true });
  h.orch.crashed(h.ids[0]);
  h.orch.dispatching({ chatId: 'top', item: { opts: { human: true } } });
  assert.equal(h.orch.maybeWake('top'), false);
  assert.equal(h.orch.stopping.size, 0);
});

test('a journal write that fails is noted and never breaks the controller call; a wake that fails is not sent', async () => {
  let failing = false;
  const h = await family(1, {
    write: () => {
      if (failing) throw new Error('disk full');
    },
  });
  failing = true;
  stop(h, 'top');
  h.orch.finished({ chatId: h.ids[0], inputToken: `pending-${h.brief(h.ids[0])}`, text: 'r', completed: true });
  h.orch.dispatching({ chatId: 'top', item: { opts: { human: true } } });
  h.orch.crashed('top');
  failing = false;
  h.orch.finished({ chatId: h.ids[0], inputToken: `pending-${h.brief(h.ids[0])}`, text: 'r', completed: true });
  failing = true;
  assert.equal(h.orch.maybeWake('top'), false);
  assert.equal(wakes(h).length, 0);
  assert.equal(
    h.orch.safely('x', () => {}),
    true,
  );
});

test('a wake the harness refuses is noted, and stays first in line in the parent', async () => {
  const h = await family(1, {
    send: async (id: string, item: any) => (id === 'top' ? Promise.reject(new Error('refused')) : { started: true, item }),
  });
  h.orch.finished({ chatId: h.ids[0], inputToken: `pending-${h.brief(h.ids[0])}`, text: 'r', completed: true });
  h.flush();
  await new Promise((r) => setImmediate(r));
  assert.ok(h.orch.waking.has('top'));
});

test('send_message reaches a linked chat by id, name or "parent", within a budget, and counts toward the parent’s wakes', async () => {
  const h = await family(2, {
    controllerSend: (id: string) => (id === 'top' ? { action: 'started' } : id.endsWith('2') ? undefined : { action: 'queued' }),
  });
  const [a, b] = h.ids;
  const toChild = await h.orch.message('top', { to: 'task-0', message: 'also add tests' });
  // a follow-up to its own idle child goes through the scheduler at once (orchestrationScheduler covers the queue)
  assert.deepEqual(toChild, { status: 'delivered', message_id: toChild.message_id, to: a, name: 'task-0' });
  assert.ok(h.journal.child(a).driven.includes(toChild.message_id));
  const sentToChild = h.log.filter((l) => l[0] === 'send' && l[1] === a).at(-1)[2];
  assert.equal(sentToChild.sideSession.id, toChild.message_id);
  assert.match(sentToChild.text, /A message from your parent \("Top chat", id top\)[\s\S]*also add tests/);
  const toParent = await h.orch.message(a, { to: 'parent', message: 'blocked on X' });
  assert.equal(toParent.status, 'delivered');
  assert.equal(h.journal.parent('top').wakes, 1);
  assert.match(h.log.find((l) => l[0] === 'controller.send' && l[1] === 'top')[2].text, /A message from a session you started \("task-0"/);
  const sibling = await h.orch.message(a, { to: b, message: 'hi' });
  assert.equal(sibling.status, 'queued', 'a send that returns nothing reads as queued');
  assert.match(h.log.filter((l) => l[0] === 'controller.send' && l[1] === b).at(-1)[2].text, /a linked session/);
  assert.ok(!h.journal.child(b).driven.includes(sibling.message_id));
  assert.deepEqual(h.journal.data.deliveries[sibling.message_id], { kind: 'message', chatId: b, from: a, body: 'hi', at: 1000 });
  for (let i = 0; i < 4; i++) await h.orch.message('top', { to: a, message: `m${i}` });
  await assert.rejects(h.orch.message('top', { to: a, message: 'one too many' }), (e: any) => e.code === 'send_budget_exhausted');
  h.rts.set('top', { inputToken: null, token: 'pending-next' });
  assert.equal((await h.orch.message('top', { to: a, message: 'next turn' })).to, a);
});

test('send_message refuses an empty or huge message, a chat outside the family, itself, an archived one, and a parent at the cap', async () => {
  const h = await family(1);
  const [a] = h.ids;
  const code = (p: Promise<any>, c: string) => assert.rejects(p, (e: any) => e.code === c);
  await code(h.orch.message('top', { to: a, message: ' ' }), 'invalid_message');
  await code(h.orch.message('top', { to: a, message: 42 as any }), 'invalid_message');
  await code(h.orch.message('top', { to: a, message: 'x'.repeat(33000) }), 'invalid_message');
  await code(h.orch.message('top', { to: 'stranger', message: 'hi' }), 'not_linked');
  await code(h.orch.message('top', { to: 'top', message: 'hi' }), 'self_send');
  h.records.set(a, { meta: { archived: 1 } });
  await code(h.orch.message('top', { to: a, message: 'hi' }), 'chat_archived');
  h.records.set(a, { meta: {} });
  stop(h, 'top');
  await code(h.orch.message(a, { to: 'parent', message: 'hi' }), 'parent_held');
  assert.equal((await h.orch.message('top', { to: a, message: 'a parent may still write' })).to, a);
  h.journal.change((d: any) => (d.parents.top.wakes = 10));
  await code(h.orch.message(a, { to: 'parent', message: 'hi' }), 'wake_cap');
});

test('the per-turn message counts are bounded', async () => {
  const h = await family(1);
  for (let i = 0; i < 501; i++) h.orch.sent.set(`k${i}`, 1);
  await h.orch.message('top', { to: h.ids[0], message: 'hi' });
  assert.ok(h.orch.sent.size <= 501);
});

test('stop_session stops a running turn of a chat this one started, further down too, and nothing else', async () => {
  const h = await family(1);
  const [a] = h.ids;
  assert.deepEqual(await h.orch.stop('top', { id: a }), { stopped: false, state: 'idle' });
  h.states.set(a, { turn: 'running' });
  assert.deepEqual(await h.orch.stop('top', { id: 'task-0' }), { stopped: true, name: 'task-0' });
  h.states.set(a, { turn: 'awaitingUser' });
  assert.equal((await h.orch.stop('top', { id: a })).stopped, true);
  await assert.rejects(h.orch.stop(a, { id: 'parent' }), (e: any) => e.code === 'not_linked');
  await assert.rejects(h.orch.stop('top', { id: 'stranger' }), (e: any) => e.code === 'not_linked');
  assert.deepEqual(
    h.log.filter((l) => l[0] === 'stopChat'),
    [
      ['stopChat', a],
      ['stopChat', a],
    ],
  );
});

test('list_sessions shows the rest of the family with relation, state, folder, branch and latest report', async () => {
  const h = await family(2, { worktreeInfo: () => ({ branch: 'mopilot/b' }) });
  const [a, b] = h.ids;
  h.userTurn();
  const { chat_id: w } = await h.orch.start('top', { background: BACKGROUND, title: 'In a worktree', prompt: 'p' });
  h.states.set('top', { turn: 'idle' });
  h.orch.finished({ chatId: a, inputToken: 'pending-user', text: 'report A', completed: true });
  h.records.set(b, { meta: { archived: 3 } });
  const fromTop = h.orch.list('top');
  assert.equal(fromTop.waiting_notes, 1);
  assert.deepEqual(fromTop.sessions[0], {
    name: 'task-0',
    id: a,
    relation: 'child',
    title: 'Task 0',
    state: 'idle',
    harness: 'codex',
    folder: '/repo',
    latest_report: { how: 'finished', text: 'report A' },
  });
  assert.equal(fromTop.sessions[1].state, 'archived');
  assert.equal(fromTop.sessions[1].latest_report, null);
  assert.equal(fromTop.sessions[2].id, w);
  assert.equal(fromTop.sessions[2].branch, 'mopilot/b');
  const fromChild = h.orch.list(a);
  assert.deepEqual(
    fromChild.sessions.map((s: any) => [s.name, s.relation, s.title]),
    [
      ['top', 'parent', 'Top chat'],
      ['task-1', 'linked', 'Task 1'],
      ['in-a-worktree', 'linked', 'In a worktree'],
    ],
  );
  assert.equal(fromChild.waiting_notes, 0);
  const lonely = orchestration({ background: BACKGROUND, title: () => null });
  assert.deepEqual(lonely.orch.list('top'), { sessions: [], waiting_notes: 0 });
  const named = await family(1, { background: BACKGROUND, title: () => null });
  assert.equal(named.orch.list(named.ids[0]).sessions[0].title, null);
});
