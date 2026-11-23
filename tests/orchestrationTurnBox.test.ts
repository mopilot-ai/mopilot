// electron/session/orchestration/turnBox.cjs: a chat's own task list (whole list, advance, done, start; steps finish in
// any order, as Claude Code's turn box applies them) and its wrap-up box (recap, one question, up to two answers); the recap is what a linked session's parent
// is told; a new turn clears the box; the user's message, a new turn or a word steered in, makes the list the plan from
// before it until the agent updates it, and a list already done goes; wrap_up refuses a stale list with steps left and
// checks off the last open step when it is the one in progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';

const require = createRequire(import.meta.url);
const { recapOf, boxed, MAX_STEPS, RECAP_CHARS } = require('../electron/session/orchestration/turnBox.cjs');
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');

const code = (c: string) => (e: any) => e.code === c;
const list = (h: any, id = 'top') => h.journal.data.plans[id].items.map((s: any) => `${s.content}:${s.status}`);
const pendingNext =
  'Continue the unfinished work and keep this list current. A list does not schedule execution: before ending a turn waiting for CI or a PR merge, save set_pr_monitor.continuation with the condition and already-authorized next steps. Never mark unperformed work completed.';
const doneNext = 'All listed steps are completed. Verify the outcome and close the turn.';

test('the whole list, then done, start and advance as Claude Code applies them, in any order', () => {
  const h = orchestration();
  h.userTurn();
  assert.throws(() => h.orch.taskList('top', { advance: true }), code('no_task_list'));
  const first = h.orch.taskList('top', {
    items: [
      { content: ' Read the code ', status: 'in_progress' },
      { content: 'Write it', status: 'pending' },
      { content: 'Test it', status: 'pending' },
      { content: 'Ship it', status: 'pending' },
    ],
  });
  assert.deepEqual(first, { steps: 4, completed: 0, in_progress: 'Read the code', next: pendingNext });
  assert.equal(h.journal.data.plans.top.turn, 'pending-turn1');
  h.orch.taskList('top', { advance: true });
  assert.deepEqual(list(h), ['Read the code:completed', 'Write it:in_progress', 'Test it:pending', 'Ship it:pending']);
  // jumping ahead leaves the open step in progress: only `done` or `advance` completes one
  h.orch.taskList('top', { done: [3], start: 4 });
  assert.deepEqual(list(h), ['Read the code:completed', 'Write it:in_progress', 'Test it:completed', 'Ship it:in_progress']);
  // advance completes the first step in progress; nothing pending is left to start
  assert.deepEqual(h.orch.taskList('top', { advance: true }), { steps: 4, completed: 3, in_progress: 'Ship it', next: pendingNext });
  assert.deepEqual(h.orch.taskList('top', { advance: true }), { steps: 4, completed: 4, in_progress: null, next: doneNext });
  assert.throws(() => h.orch.taskList('top', { done: [5] }), code('invalid_step'));
  assert.throws(() => h.orch.taskList('top', { start: 0 }), code('invalid_step'));
  assert.deepEqual(h.orch.taskList('top', { done: 'x' as any }).completed, 4);
});

test('advance starts the next pending step after the one it completes, else the first pending one', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.taskList('top', {
    items: [
      { content: 'a', status: 'pending' },
      { content: 'b', status: 'in_progress' },
      { content: 'c', status: 'pending' },
    ],
  });
  h.orch.taskList('top', { advance: true });
  assert.deepEqual(list(h), ['a:pending', 'b:completed', 'c:in_progress']);
  h.orch.taskList('top', { advance: true });
  assert.deepEqual(list(h), ['a:in_progress', 'b:completed', 'c:completed']);
  // with no step in progress, advance starts the first pending one
  h.orch.taskList('top', {
    items: [
      { content: 'x', status: 'pending' },
      { content: 'y', status: 'pending' },
    ],
  });
  h.orch.taskList('top', { advance: true });
  assert.deepEqual(list(h), ['x:in_progress', 'y:pending']);
});

test('a list is refused when empty, too long, or with a bad status or step; two steps may be in progress', () => {
  const h = orchestration();
  const step = (o: any = {}) => ({ content: 'step', status: 'pending', ...o });
  assert.throws(() => h.orch.taskList('top', { items: [] }), code('invalid_items'));
  assert.throws(() => h.orch.taskList('top', { items: 'x' as any }), code('invalid_items'));
  assert.throws(() => h.orch.taskList('top', { items: Array.from({ length: MAX_STEPS + 1 }, () => step()) }), code('invalid_items'));
  assert.throws(() => h.orch.taskList('top', { items: [step({ status: 'done' })] }), code('invalid_status'));
  assert.throws(() => h.orch.taskList('top', { items: [null as any] }), code('invalid_status'));
  assert.throws(() => h.orch.taskList('top', { items: [step({ content: ' ' })] }), code('invalid_content'));
  assert.throws(() => h.orch.taskList('top', { items: [step({ content: 'x'.repeat(201) })] }), code('invalid_content'));
  assert.throws(() => h.orch.taskList('top', { items: [step({ content: undefined })] }), code('invalid_content'));
  // as Claude Code's turn box: a step left for another stays in progress
  assert.deepEqual(
    h.orch.taskList('top', { items: [step({ status: 'in_progress' }), step({ status: 'in_progress', content: 'other' })] }),
    {
      steps: 2,
      completed: 0,
      in_progress: 'step',
      next: pendingNext,
    },
  );
});

test('wrap_up keeps a recap and answers without claiming unfinished task steps completed', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.taskList('top', {
    items: [
      { content: 'a', status: 'in_progress' },
      { content: 'b', status: 'pending' },
    ],
  });
  assert.deepEqual(
    h.orch.wrapUp('top', {
      recap: 'Done. Not pushed.',
      ask: 'Push it?',
      actions: [{ label: 'Push', message: 'Push the branch' }, { label: 'Not now' }],
    }),
    {
      shown: true,
      asked: 'Push it?',
      next: 'The box ends your turn: write no text after this call, since the recap and question already say what the user needs.',
      endsTurn: true,
    },
  );
  assert.deepEqual(h.journal.data.wrapUps.top, {
    turn: 'pending-turn1',
    recap: 'Done. Not pushed.',
    ask: 'Push it?',
    actions: [
      { label: 'Push', message: 'Push the branch' },
      { label: 'Not now', message: null },
    ],
    at: 1000,
  });
  assert.deepEqual(list(h), ['a:in_progress', 'b:pending']);
  // as in Claude Desktop, only a question with answers draws the box and ends the turn; otherwise the closing message
  // comes after the call and is the answer, so the reply never repeats the box or points at one that is not there
  const recapOnly = orchestration().orch.wrapUp('other', { recap: 'Only a recap' });
  assert.deepEqual([recapOnly.shown, 'endsTurn' in recapOnly], [false, false]);
  assert.match(recapOnly.next, /draws no box.*Your closing message is your answer to the user: write it now/);
  const noAnswers = orchestration().orch.wrapUp('other', { recap: 'r', ask: 'Push it?' });
  assert.deepEqual([noAnswers.shown, noAnswers.asked, 'endsTurn' in noAnswers], [false, 'Push it?', false]);
  assert.match(noAnswers.next, /no box.*put your question to the user there/);
  assert.deepEqual([{ ask: 'Go?', actions: [{}] }, { ask: 'Go?', actions: [] }, { ask: null, actions: [{}] }, { ask: 'Go?' }].map(boxed), [
    true,
    false,
    false,
    false,
  ]);
  const bad: [any, string][] = [
    [{}, 'invalid_recap'],
    [{ recap: 'x'.repeat(RECAP_CHARS + 1) }, 'invalid_recap'],
    [{ recap: 'r', ask: 5 }, 'invalid_ask'],
    [{ recap: 'r', actions: [{ label: 'Go' }] }, 'actions_need_ask'],
    [{ recap: 'r', ask: 'Go?', actions: [] }, 'invalid_actions'],
    [{ recap: 'r', ask: 'Go?', actions: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }, 'invalid_actions'],
    [{ recap: 'r', ask: 'Go?', actions: [{}] }, 'invalid_label'],
    [{ recap: 'r', ask: 'Go?', actions: [null] }, 'invalid_label'],
    [{ recap: 'r', ask: 'Go?', actions: [{ label: 'x'.repeat(25) }] }, 'invalid_label'],
  ];
  for (const [a, c] of bad) assert.throws(() => orchestration().orch.wrapUp('top', a), code(c), JSON.stringify(a));
});

test('a linked session’s recap from the turn that ended is its parent’s report; an older recap is not', async () => {
  const h = orchestration();
  h.userTurn();
  const { chat_id: kid } = await h.orch.start('top', { background: BACKGROUND, title: 'Kid', prompt: 'p', use_worktree: false });
  const brief = h.journal.child(kid).driven[0];
  h.rts.set(kid, { inputToken: `pending-${brief}` });
  h.orch.wrapUp(kid, { recap: 'Fixed the bug; tests pass.' });
  h.orch.finished({ chatId: kid, inputToken: `pending-${brief}`, text: 'a long final message', completed: true });
  assert.match(h.journal.parent('top').notes.at(-1).body, /"Fixed the bug; tests pass\."/);
  h.orch.finished({ chatId: kid, inputToken: 'pending-later', text: 'the final message', completed: true });
  assert.match(h.journal.parent('top').notes.at(-1).body, /"the final message"/);
  assert.equal(recapOf(h.journal, kid, null), null);
  assert.equal(recapOf(h.journal, 'nobody', 'x'), null);
});

test('wrap_up checks off the last open step when it is in progress, and only that one', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.taskList('top', {
    items: [
      { content: 'a', status: 'completed' },
      { content: 'b', status: 'in_progress' },
    ],
  });
  h.orch.wrapUp('top', { recap: 'Done.' });
  assert.deepEqual(list(h), ['a:completed', 'b:completed']);
  // a pending step left for later is not the closing advance: nothing is checked off
  h.orch.taskList('top', {
    items: [
      { content: 'a', status: 'completed' },
      { content: 'Merge after checks', status: 'pending' },
    ],
  });
  h.orch.wrapUp('top', { recap: 'Waiting for checks.' });
  assert.deepEqual(list(h), ['a:completed', 'Merge after checks:pending']);
  // a chat without a list wraps up as before
  assert.equal(orchestration().orch.wrapUp('none', { recap: 'r' }).shown, false);
});

test('wrap_up refuses a list from before the user’s latest message with steps left, until the agent sends it again', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.taskList('top', {
    items: [
      { content: 'Merge #1', status: 'in_progress' },
      { content: 'Screenshot', status: 'pending' },
    ],
  });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top.stale, true);
  assert.throws(
    () => h.orch.wrapUp('top', { recap: 'r', ask: 'Go?', actions: [{ label: 'Go' }] }),
    (e: any) => e.code === 'stale_task_list' && /Call update_task_list first with the whole list for this message/.test(e.message),
  );
  // nothing was written: no box, and the list is as it was
  assert.equal(h.journal.data.wrapUps.top, undefined);
  assert.deepEqual(list(h), ['Merge #1:in_progress', 'Screenshot:pending']);
  // once a turn: an agent keeping its harness's own plan is let through on its second call, the list left as it was
  assert.equal(h.orch.wrapUp('top', { recap: 'r' }).shown, false);
  assert.deepEqual(list(h), ['Merge #1:in_progress', 'Screenshot:pending']);
  // the next user turn refuses it again
  h.rts.set('top', { inputToken: 'turn2', token: 'turn2' });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.throws(() => h.orch.wrapUp('top', { recap: 'r' }), code('stale_task_list'));
  // the list for this message lifts it
  h.orch.taskList('top', {
    items: [
      { content: 'Merge #1', status: 'completed' },
      { content: 'Screenshot', status: 'in_progress' },
    ],
  });
  assert.equal(h.orch.wrapUp('top', { recap: 'Sent.' }).shown, false);
  assert.deepEqual(list(h), ['Merge #1:completed', 'Screenshot:completed']);
  // a stale list with every step done is no plan to refuse (the user's message drops it; a restored one is let through)
  h.journal.change((d: any) => (d.plans.top = { turn: 't', items: [{ content: 'x', status: 'completed' }], stale: true, at: 1 }));
  assert.equal(h.orch.wrapUp('top', { recap: 'r' }).shown, false);
});

test('every new turn clears the last box; the user’s message, steered in or a new turn, leaves the list stale', () => {
  const h = orchestration();
  h.userTurn();
  const stale = () => h.journal.data.plans.top?.stale;
  h.orch.taskList('top', { items: [{ content: 'a', status: 'in_progress' }] });
  h.orch.wrapUp('top', { recap: 'r' });
  h.journal.change((d: any) => (d.plans.top.items[0].status = 'in_progress'));
  // a word steered into the running turn keeps the box; the list is now the plan from before it
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { opts: { human: true } } });
  assert.ok(h.journal.data.wrapUps.top);
  assert.equal(stale(), true);
  // the agent's next update is its plan again
  h.orch.taskList('top', { advance: true });
  assert.equal(stale(), undefined);
  // a wake-up or a family message: a new turn, so its own box; it carries on with the list as it is
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: false } } });
  assert.equal(h.journal.data.wrapUps.top, undefined);
  assert.equal(stale(), undefined);
  h.orch.taskList('top', { items: [{ content: 'b', status: 'pending' }] });
  h.orch.wrapUp('top', { recap: 'r2', ask: 'Go?', actions: [{ label: 'Go' }] });
  h.journal.change((d: any) => (d.plans.top.items[0].status = 'pending'));
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.wrapUps.top, undefined);
  assert.deepEqual(list(h), ['b:pending']);
  assert.equal(stale(), true);
  // already stale: the next message writes nothing more
  const before = h.journal.data;
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { opts: { human: true } } });
  assert.equal(h.journal.data, before);
  // a list already done is no plan to follow: the user's message takes it away
  h.orch.taskList('top', { items: [{ content: 'c', status: 'completed' }] });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top, undefined);
  // nothing to note writes nothing; with the journal off, nothing happens
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: {} });
  h.journal.startupError = 'journal_unavailable';
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
});

test('the journal keeps lists and boxes across a restart and refuses malformed ones', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-turnbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  new OrchestrationJournal({ file }).change((d: any) => {
    d.plans.c = { turn: 't', items: [{ content: 'a', status: 'pending' }], at: 1 };
    d.wrapUps.c = { turn: 't', recap: 'r', ask: null, actions: [], at: 1 };
  });
  const again = new OrchestrationJournal({ file });
  assert.equal(again.data.plans.c.items[0].content, 'a');
  assert.equal(again.data.wrapUps.c.recap, 'r');
  const base = { schemaVersion: 1, children: {}, parents: {}, deliveries: {} };
  fs.writeFileSync(file, JSON.stringify(base));
  assert.deepEqual([new OrchestrationJournal({ file }).data.plans, new OrchestrationJournal({ file }).data.wrapUps], [{}, {}]);
  for (const bad of [{ plans: { c: { items: [{}] } } }, { plans: [] }, { wrapUps: { c: { recap: 1, actions: [] } } }, { wrapUps: 'x' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, ...bad }));
    assert.equal(new OrchestrationJournal({ file }).startupError, 'journal_unavailable', JSON.stringify(bad));
  }
});

test('a plan from before the user’s message is carried through one turn: a turn that ends without touching it drops it (#4927)', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.taskList('top', {
    items: [
      { content: 'old', status: 'in_progress' },
      { content: 'next', status: 'pending' },
    ],
  });
  // the turn it belongs to is stopped: the list stays, frozen, for the user to continue
  h.orch.finished({ chatId: 'top', inputToken: 'pending-a', text: '', completed: false });
  assert.deepEqual(list(h), ['old:in_progress', 'next:pending']);
  // the user moves on: the list is the plan from before it, carried through this turn
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top.stale, true);
  h.orch.finished({ chatId: 'top', inputToken: 'pending-b', text: 'hello', completed: true });
  assert.equal(h.journal.data.plans.top, undefined, 'untouched by the turn: gone, for every later turn and client');
  // a turn that updates it keeps it (not stale at the end)
  h.orch.taskList('top', { items: [{ content: 'new', status: 'in_progress' }] });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  h.orch.taskList('top', { advance: true });
  h.orch.finished({ chatId: 'top', inputToken: 'pending-c', text: '', completed: true });
  assert.deepEqual(list(h), ['new:completed']);
  // a harness that quits mid-turn drops an untouched stale list the same way; nothing stale, nothing written
  h.orch.taskList('top', { items: [{ content: 'q', status: 'pending' }] });
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { opts: { human: true } } });
  h.orch.crashed('top');
  assert.equal(h.journal.data.plans.top, undefined);
  const before = h.journal.data;
  h.orch.crashed('top');
  assert.equal(h.journal.data, before);
  // with the journal off nothing happens
  h.journal.startupError = 'journal_unavailable';
  h.orch.finished({ chatId: 'top', inputToken: 'pending-d', text: '', completed: true });
});

test('in MoMo’s chats an open plan is cleared as the next turn starts: the thread shows nothing of it (#4927)', () => {
  const h = orchestration();
  h.userTurn();
  h.orch.o.chats.records.get('top').meta.momo = 'main';
  h.orch.taskList('top', { items: [{ content: 'old', status: 'in_progress' }] });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top, undefined, 'not even carried through the turn');
  // a plan of an ordinary chat is carried through the one turn, as before
  h.orch.o.chats.records.get('top').meta.momo = undefined;
  h.orch.taskList('top', { items: [{ content: 'old', status: 'in_progress' }] });
  h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top.stale, true);
});

test('an ordinary chat’s five-step list that the agent never updated, aged by two steered messages, is gone when that turn ends normally (the owner’s second case, #4927)', () => {
  const h = orchestration();
  h.userTurn();
  const steps = ['a', 'b', 'c', 'd', 'e'];
  // the agent writes the list as its turn starts (one step in progress, the rest pending) and works on without updating it
  h.orch.taskList('top', { items: steps.map((content, i) => ({ content, status: i === 0 ? 'in_progress' : 'pending' })) });
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { opts: { human: true } } });
  assert.equal(h.journal.data.plans.top.stale, true, 'the first message steered in ages it');
  h.orch.dispatching({ chatId: 'top', kind: 'steer', item: { opts: { human: true } } });
  // the turn ends normally, no stop, no wrap-up: the list does not outlive it
  h.orch.finished({ chatId: 'top', inputToken: 'pending-x', text: 'done', completed: true });
  assert.equal(h.journal.data.plans.top, undefined);
  // and it is not drawn before any later turn
  for (let n = 0; n < 3; n++) {
    h.orch.dispatching({ chatId: 'top', kind: 'turn', item: { opts: { human: true } } });
    h.orch.finished({ chatId: 'top', inputToken: `pending-${n}`, text: '', completed: true });
    assert.equal(h.journal.data.plans.top, undefined);
  }
  // a record left stale by an earlier version (the bug’s shape on disk) is cleared by the next turn’s end
  h.journal.change(
    (d: any) => (d.plans.top = { turn: 't', items: steps.map((content) => ({ content, status: 'pending' })), stale: true, at: 1 }),
  );
  h.orch.finished({ chatId: 'top', inputToken: 'pending-y', text: '', completed: true });
  assert.equal(h.journal.data.plans.top, undefined);
});

test('at start every list still stale is dropped in one write, so a chat nobody opens again does not keep its record (#4927)', () => {
  const { Orchestrator } = require('../electron/session/orchestration/service.cjs');
  const h = orchestration();
  const open = (content: string) => [{ content, status: 'pending' }];
  h.journal.change((d: any) => {
    d.plans.quiet = { turn: 't', items: open('a'), stale: true, at: 1 };
    d.plans.live = { turn: 't', items: open('b'), at: 2 };
    d.plans.other = { turn: 't', items: open('c'), stale: true, at: 3 };
  });
  let writes = 0;
  const change = h.journal.change.bind(h.journal);
  h.journal.change = (fn: any) => (writes++, change(fn));
  // a new run of the app builds a new Orchestrator over the same journal
  new Orchestrator(h.orch.o);
  assert.deepEqual(Object.keys(h.journal.data.plans), ['live'], 'a list a turn is still working on stays');
  assert.equal(writes, 1);
  // nothing stale: nothing written; an unusable journal is left alone
  new Orchestrator(h.orch.o);
  assert.equal(writes, 1);
  h.journal.startupError = 'journal_unavailable';
  new Orchestrator(h.orch.o);
  assert.equal(writes, 1);
});
