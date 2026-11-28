// electron/session/orchestration/proposals.cjs: an offer's card counts down a minute, then goes ahead as "New session"
// for a user who did not answer. An answer, a dismissal, a new message, a Stop, the card taken in hand (hold) or a restart
// ends the countdown, and it never answers after any of them; windows read its deadline from main (orchestrationView).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration, SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';
import { useFakeClock } from './support/ports/clock.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const {
  OFFER_COUNTDOWN_MS,
  OFFER_WAIT_MS,
  HERE_NEXT,
  NEW_SESSION_BY,
  OPEN_NEXT,
  QUEUED_NEXT,
  PROPOSAL_DAYS,
  countdownsOf,
  queuedOverOffers,
  releaseOffers,
} = require('../electron/session/orchestration/proposals.cjs');
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');
const { orchestrationView } = require('../electron/app/orchestration.cjs');

const offer = (title = 'Fix login') => ({
  background: BACKGROUND,
  title,
  prompt: 'Fix the login bug',
  use_worktree: false,
  initiation: 'offer',
});
const code = (c: string) => (e: any) => e.code === c;
/** The task id of the proposal titled `title` (an offer's call makes it before it waits). */
const idOf = (h: any, title = 'Fix login') => Object.entries<any>(h.journal.data.proposals).find(([, p]) => p.args.title === title)![0];
/** A call's result, or "pending" when it has not settled yet. */
const settled = (call: Promise<any>) => Promise.race([call, new Promise((r) => setImmediate(() => r('pending')))]);
/** A new message the user sent to the chat. */
const human = (h: any) =>
  h.orch.dispatching({
    chatId: 'top',
    kind: 'turn',
    ref: h.controller.ref('top'),
    item: { id: 'turn2', text: 'Actually, wait', opts: { human: true } },
  });

test('an offer nobody answers goes ahead as "New session" when its countdown runs out, and the agent is told so', async (t) => {
  assert.equal(OFFER_COUNTDOWN_MS, 60_000);
  assert.ok(OFFER_COUNTDOWN_MS < OFFER_WAIT_MS, 'the countdown answers before the call gives up');
  assert.equal(NEW_SESSION_BY.auto, 'Nobody answered the card within 60 seconds, so it went ahead as "New session"');
  const clock = useFakeClock(t);
  const h = orchestration();
  h.userTurn();
  const call = h.orch.start('top', offer());
  const id = idOf(h);
  // the deadline is main's, on the record every window reads
  assert.deepEqual(h.journal.proposal(id).countdown, { from: 1000, at: 1000 + OFFER_COUNTDOWN_MS });
  clock.advance(OFFER_COUNTDOWN_MS - 1);
  assert.equal(await settled(call), 'pending', 'not a moment early');
  assert.equal(h.journal.proposal(id).status, 'open');
  clock.advance(1);
  const r = await call;
  assert.deepEqual(pick(r, 'status', 'task_id', 'answer', 'auto'), { status: 'started', task_id: id, answer: 'new_session', auto: true });
  assert.ok(r.chat_id, 'a session started');
  assert.equal(
    r.next,
    'Nobody answered the card within 60 seconds, so it went ahead as "New session": it runs on its own and its notes reach you. Do not do the task here. Say so, link it and end your turn.',
  );
  const p = h.journal.proposal(id);
  assert.deepEqual([p.status, p.chatId, p.waiting, p.countdown], ['started', r.chat_id, undefined, undefined]);
  assert.deepEqual([h.orch.answers.size, countdownsOf(h.orch).size], [0, 0]);
  assert.equal(h.journal.parent('top')?.notes?.length ?? 0, 0, 'the call told the agent: no note');
  // the card answered for the user: a click that comes after is refused, and nothing else changes
  const late = (e: any) => e.code === 'not_open' && e.message === 'That proposal is started';
  await assert.rejects(h.orch.act(id, 'here'), late);
  await assert.rejects(h.orch.act(id, 'start'), late);
  // a title-only offer reserves its session, and the agent is asked for the brief, not to do the task here
  const next = h.orch.start('top', { initiation: 'offer', title: 'Docs' });
  const docs = idOf(h, 'Docs');
  assert.deepEqual(h.journal.proposal(docs).countdown, { from: 1000, at: 1000 + OFFER_COUNTDOWN_MS }, 'counting from its own start');
  clock.advance(OFFER_COUNTDOWN_MS);
  const brief = await next;
  assert.deepEqual(pick(brief, 'status', 'answer', 'auto'), { status: 'briefing', answer: 'new_session', auto: true });
  assert.equal(
    brief.next,
    `Nobody answered the card within 60 seconds, so it went ahead as "New session" for "Docs" (task_id: ${docs}). Write its brief now: call start_session with exactly proposal_id "${docs}", prompt and background. No other arguments; the settings were chosen on the card. Do not do the task here. When it returns, say it is running, link it and end your turn.`,
  );
  assert.equal(h.journal.proposal(docs).status, 'briefing');
});

test('the countdown starts on the turn’s own authority, not a click’s: past ten starts the user is asked first', async (t) => {
  const clock = useFakeClock(t);
  const asked: any[] = [];
  let allow = true;
  const h = orchestration({ approveStart: async (_id: string, q: any) => (asked.push(q.count), allow) });
  h.userTurn();
  h.journal.change((d: any) => (d.parents.top = { wakes: 0, held: false, cutShort: false, notes: [], starts: 10 }));
  const call = h.orch.start('top', offer());
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal((await call).answer, 'new_session');
  assert.deepEqual(asked, [10]);
  // declined: nothing starts, and the card waits for the user's own answer with no countdown
  allow = false;
  const held = h.orch.start('top', offer('Docs'));
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(held), 'pending');
  assert.deepEqual(asked, [10, 11]);
  const p = h.journal.proposal(idOf(h, 'Docs'));
  assert.deepEqual([p.status, p.waiting, p.countdown], ['open', true, undefined]);
  await h.orch.act(idOf(h, 'Docs'), 'here');
  assert.equal((await held).next, HERE_NEXT);
});

test('a countdown start that outlives its call (the cap while approval is asked) leaves the agent a note', async (t) => {
  const clock = useFakeClock(t);
  let approve: (ok: boolean) => void = () => {};
  const h = orchestration({ approveStart: () => new Promise<boolean>((r) => (approve = r)) });
  h.userTurn();
  h.journal.change((d: any) => (d.parents.top = { wakes: 0, held: false, cutShort: false, notes: [], starts: 10 }));
  const call = h.orch.start('top', offer());
  const id = idOf(h);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(call), 'pending');
  assert.equal(h.journal.proposal(id).status, 'starting', 'waiting for the approval');
  clock.advance(OFFER_WAIT_MS);
  assert.equal((await call).still_open, true);
  approve(true);
  await waitFor(() => h.journal.proposal(id).status === 'started', 'the approved start');
  const p = h.journal.proposal(id);
  assert.equal(p.status, 'started');
  const notes = h.journal.parent('top').notes;
  assert.equal(notes.length, 1);
  assert.equal(notes[0].childId, p.chatId);
  assert.match(
    notes[0].body,
    new RegExp(`^Nobody answered the card for your offered task ${id} \\("Fix login"\\), so it started as a separate session \\(`),
  );
  assert.match(notes[0].body, /\. It runs on its own; you get a note when it ends a turn\.$/);
  // a title-only offer's reserved session waits for its brief, and the note asks the agent for it
  const reserved = h.orch.start('top', { initiation: 'offer', title: 'Docs' });
  const docs = idOf(h, 'Docs');
  clock.advance(OFFER_COUNTDOWN_MS);
  clock.advance(OFFER_WAIT_MS);
  assert.equal((await reserved).still_open, true);
  approve(true);
  await waitFor(() => h.journal.proposal(docs).status === 'briefing', 'the approved reservation');
  assert.equal(h.journal.proposal(docs).status, 'briefing');
  assert.match(
    h.journal.parent('top').notes.at(-1).body,
    new RegExp(
      `It waits for its brief: call start_session with exactly proposal_id "${docs}", prompt and background, and do not do the task here\\.$`,
    ),
  );
});

test('an answer, a dismissal or a new message before the countdown ends it, and the countdown never answers after', async (t) => {
  const clock = useFakeClock(t);
  const h = orchestration();
  h.userTurn();
  (h.orch as any).offerCountdownMs = 30_000;
  // Do it here: the user's own answer, not the countdown's
  const here = h.orch.start('top', offer('A'));
  assert.equal(h.journal.proposal(idOf(h, 'A')).countdown.at, 1000 + 30_000, 'a countdown of another length');
  clock.advance(29_999);
  assert.deepEqual(await h.orch.act(idOf(h, 'A'), 'here'), { task_id: idOf(h, 'A'), status: 'declined', answered: true });
  assert.deepEqual(await here, { status: 'declined', task_id: idOf(h, 'A'), kind: 'offer', title: 'A', answer: 'here', next: HERE_NEXT });
  clock.advance(OFFER_WAIT_MS);
  assert.equal(h.journal.proposal(idOf(h, 'A')).status, 'declined', 'no start after the user kept it here');
  // a dismissal
  const dismissed = h.orch.start('top', offer('B'));
  await h.orch.act(idOf(h, 'B'), 'dismiss');
  assert.equal((await dismissed).status, 'dismissed');
  clock.advance(OFFER_WAIT_MS);
  assert.equal(h.journal.proposal(idOf(h, 'B')).status, 'dismissed');
  // New session
  const started = h.orch.start('top', offer('C'));
  assert.equal((await h.orch.act(idOf(h, 'C'), 'start')).answered, true);
  assert.equal((await started).answer, 'new_session');
  clock.advance(OFFER_WAIT_MS);
  assert.equal(h.journal.proposal(idOf(h, 'C')).status, 'started');
  // New session on a title-only offer: the user's own choice, and the brief is asked for
  const reserved = h.orch.start('top', { initiation: 'offer', title: 'C2' });
  await h.orch.act(idOf(h, 'C2'), 'start');
  const asked = await reserved;
  assert.deepEqual([asked.status, asked.answer, asked.auto], ['briefing', 'new_session', undefined]);
  assert.match(asked.next, /^The user chose "New session" for "C2" \(task_id: task_\w+\)\. Write its brief now: /);
  // the user's new message takes precedence over the card
  const superseded = h.orch.start('top', offer('D'));
  human(h);
  assert.equal((await superseded).answer, 'superseded');
  clock.advance(OFFER_WAIT_MS);
  const d = h.journal.proposal(idOf(h, 'D'));
  assert.deepEqual([d.status, d.chatId, d.countdown], ['dismissed', null, undefined]);
  assert.deepEqual([h.orch.answers.size, countdownsOf(h.orch).size], [0, 0]);
  // one the user answered themselves is refused with its status, as before
  await assert.rejects(h.orch.act(idOf(h, 'A'), 'here'), (e: any) => e.message === 'That proposal is declined');
});

test('a click on New session stops the countdown, so a start that fails leaves the card waiting for the user', async (t) => {
  const clock = useFakeClock(t);
  let usable = false;
  const h = orchestration({ usable: async () => usable });
  h.userTurn();
  const call = h.orch.start('top', offer());
  const id = idOf(h);
  await assert.rejects(h.orch.act(id, 'start'));
  const p = h.journal.proposal(id);
  assert.deepEqual([p.status, p.waiting, p.countdown], ['open', true, undefined], 'open again, waiting, and counting no more');
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(call), 'pending', 'the countdown does not answer for a user who answered');
  // their retry still works
  usable = true;
  assert.equal((await h.orch.act(id, 'start')).answered, true);
  assert.equal((await call).answer, 'new_session');
});

test('taking the card in hand holds the countdown for good; the call then waits for the answer until its cap', async (t) => {
  const clock = useFakeClock(t);
  const h = orchestration();
  h.userTurn();
  const call = h.orch.start('top', offer());
  const id = idOf(h);
  assert.deepEqual(await h.orch.act(id, 'hold'), { task_id: id, held: true });
  assert.equal(h.journal.proposal(id).countdown, undefined, 'every window stops showing it');
  assert.equal(h.journal.proposal(id).waiting, true);
  // a second window holding it too changes nothing
  assert.deepEqual(await h.orch.act(id, 'hold'), { task_id: id, held: false });
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(call), 'pending');
  // the answer still comes from the user, or the call gives up at its cap with the card left open
  clock.advance(OFFER_WAIT_MS);
  const late = await call;
  assert.equal(late.still_open, true);
  assert.equal(late.answer, undefined);
  assert.equal(h.journal.proposal(id).status, 'open');
  // a held answer that comes later is the user's own
  const again = h.orch.start('top', offer('Docs'));
  await h.orch.act(idOf(h, 'Docs'), 'hold');
  await h.orch.act(idOf(h, 'Docs'), 'here');
  assert.equal((await again).next, HERE_NEXT);
  // nothing to hold: an unknown proposal is refused, a suggestion has no countdown
  await assert.rejects(h.orch.act('task_nope', 'hold'), code('not_found'));
  const suggested = await h.orch.start('top', { ...offer('Idea'), initiation: 'own_initiative' });
  assert.deepEqual(await h.orch.act(suggested.task_id, 'hold'), { task_id: suggested.task_id, held: false });
  await assert.rejects(
    Promise.resolve().then(() => h.orch.act('x', 'nonsense')),
    code('invalid_action'),
  );
});

test('a Stop while it counts settles the call once, and the card stays open with no countdown', async (t) => {
  const clock = useFakeClock(t);
  const h = orchestration();
  h.userTurn();
  const ac = new AbortController();
  const call = h.orch.start('top', offer(), { signal: ac.signal });
  const id = idOf(h);
  ac.abort();
  assert.equal((await call).still_open, true);
  clock.advance(OFFER_COUNTDOWN_MS);
  const p = h.journal.proposal(id);
  assert.deepEqual([p.status, p.waiting, p.countdown, p.chatId], ['open', undefined, undefined, null]);
  // a proposal gone from the record while its call waited is let go without a write
  const stop = new AbortController();
  const gone = h.orch.start('top', offer('Gone'), { signal: stop.signal });
  h.journal.change((d: any) => delete d.proposals[idOf(h, 'Gone')]);
  stop.abort();
  assert.equal((await gone).still_open, true);
});

test('a countdown the journal can’t record never runs, and one it can’t close leaves the card waiting', async (t) => {
  const clock = useFakeClock(t);
  /** the write that fails: one whose record of the offer titled `title` matches */
  let failing: ((p: any) => boolean) | null = null;
  const h = orchestration({
    write: (data: any) => {
      if (failing && Object.values<any>(data.proposals).some(failing)) throw new Error('disk full');
    },
  });
  h.userTurn();
  // the offer is written, its countdown is not: nothing answers for the user, the card waits for them
  failing = (p) => p.args.title === 'Unrecorded' && !!p.countdown;
  const unrecorded = h.orch.start('top', offer('Unrecorded'));
  failing = null;
  const id = idOf(h, 'Unrecorded');
  assert.equal(h.journal.proposal(id).countdown, undefined);
  assert.equal(countdownsOf(h.orch).size, 0);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(unrecorded), 'pending');
  await h.orch.act(id, 'here');
  assert.equal((await unrecorded).next, HERE_NEXT);
  // the countdown runs out but its start can't be written: the card keeps waiting for the user
  const unclosed = h.orch.start('top', offer('Unclosed'));
  failing = (p) => p.args.title === 'Unclosed' && p.status === 'starting';
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(unclosed), 'pending');
  failing = null;
  assert.deepEqual(pick(h.journal.proposal(idOf(h, 'Unclosed')), 'status', 'countdown'), { status: 'open' }, 'no countdown left on show');
  await h.orch.act(idOf(h, 'Unclosed'), 'here');
  assert.equal((await unclosed).auto, undefined);
  // a hold the journal can't write is refused, and the countdown still runs as every window shows it
  const unheld = h.orch.start('top', offer('Unheld'));
  failing = (p) => p.args.title === 'Unheld' && p.waiting && !p.countdown;
  await assert.rejects(h.orch.act(idOf(h, 'Unheld'), 'hold'), /disk full/);
  failing = null;
  assert.ok(h.journal.proposal(idOf(h, 'Unheld')).countdown);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal((await unheld).auto, true);
  // the countdown runs out but its hold can't be written: nothing escapes the timer, and the card waits for the user
  // with no countdown on show once the journal writes again
  const unstarted = h.orch.start('top', offer('Unstarted'));
  let refused = 0;
  failing = (p) => p.args.title === 'Unstarted' && p.status === 'open' && !p.countdown && refused++ === 0;
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(unstarted), 'pending');
  failing = null;
  assert.equal(refused, 2, 'the hold was refused, and the write after it went through');
  assert.deepEqual(pick(h.journal.proposal(idOf(h, 'Unstarted')), 'status', 'waiting', 'countdown'), { status: 'open', waiting: true });
  await h.orch.act(idOf(h, 'Unstarted'), 'here');
  assert.equal((await unstarted).next, HERE_NEXT);
});

test('a countdown that runs out after its offer was answered, gone or past its time does nothing', async (t) => {
  const clock = useFakeClock(t);
  let now = 1000;
  const h = orchestration({ now: () => now });
  h.userTurn();
  // its call let go some other way: the countdown has no one to answer
  const a = h.orch.start('top', offer('A'));
  const idA = idOf(h, 'A');
  const settleA = h.orch.answers.get(idA);
  h.orch.answers.delete(idA);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(h.journal.proposal(idA).status, 'open');
  settleA({ status: 'dismissed' });
  await a;
  // its countdown taken off the record (a hold that came first): nothing is chosen
  const b = h.orch.start('top', offer('B'));
  h.journal.change((d: any) => delete d.proposals[idOf(h, 'B')].countdown);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(h.journal.proposal(idOf(h, 'B')).status, 'open');
  await h.orch.act(idOf(h, 'B'), 'here');
  await b;
  // gone from the record
  const c = h.orch.start('top', offer('C'));
  const idC = idOf(h, 'C');
  const settleC = h.orch.answers.get(idC);
  h.journal.change((d: any) => delete d.proposals[idC]);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(h.journal.proposal(idC), null);
  settleC({ status: 'dismissed' });
  await c;
  // past the proposal's own time
  const e = h.orch.start('top', offer('E'));
  now += PROPOSAL_DAYS * 86_400_000 + 1;
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.deepEqual(pick(h.journal.proposal(idOf(h, 'E')), 'chatId', 'countdown'), { chatId: null });
  h.orch.answers.get(idOf(h, 'E'))({ status: 'dismissed' });
  await e;
  now = 1000;
  // being started when it runs out (the agent's own start of it): it waits for the user with no countdown, and a
  // start that fails leaves it open for their answer
  const f = h.orch.start('top', offer('F'));
  h.journal.change((d: any) => (d.proposals[idOf(h, 'F')].status = 'starting'));
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(await settled(f), 'pending');
  assert.equal(h.journal.proposal(idOf(h, 'F')).countdown, undefined);
  h.journal.change((d: any) => (d.proposals[idOf(h, 'F')].status = 'open'));
  await h.orch.act(idOf(h, 'F'), 'here');
  assert.equal((await f).next, HERE_NEXT);
});

test('the user’s message queued behind the turn closes its offer and ends the turn; a stopped or ended turn lets go', async (t) => {
  const clock = useFakeClock(t);
  const h = orchestration();
  h.userTurn();
  const waiting = () => Object.values<any>(h.journal.data.proposals).filter((p) => p.waiting).length;
  // MoPilot's own text or a peer's note is not the user's word: the offer keeps waiting
  const queued = h.orch.start('top', offer('Queued'));
  queuedOverOffers(h.orch, 'top', { text: 'handed off', opts: { human: true, prefix: '<handoff>' } });
  queuedOverOffers(h.orch, 'top', { text: 'a note', opts: {}, peer: { from: 'kid' } });
  queuedOverOffers(h.orch, 'other', { text: 'elsewhere', opts: { human: true } });
  assert.equal(waiting(), 1);
  queuedOverOffers(h.orch, 'top', { text: 'wait, do X first', opts: { human: true } });
  const r = await queued;
  assert.deepEqual([r.status, r.answer, r.next], ['dismissed', 'superseded', QUEUED_NEXT]);
  assert.match(QUEUED_NEXT, /do not start the task.*end your turn\.$/);
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(h.journal.proposal(idOf(h, 'Queued')).status, 'dismissed', 'the countdown answers nothing after it');
  // a turn that ended some way its harness did not cancel the call by: let go, the card stays open, counting no more
  const suggestion = await h.orch.start('top', { ...offer('Idea'), initiation: 'own_initiative' });
  const ended = h.orch.start('top', offer('Ended'));
  releaseOffers(h.orch, 'other');
  assert.equal(waiting(), 1, 'another chat’s turn lets go of nothing here');
  releaseOffers(h.orch, 'top');
  const e = await ended;
  assert.deepEqual([e.still_open, e.next], [true, OPEN_NEXT]);
  assert.deepEqual(pick(h.journal.proposal(idOf(h, 'Ended')), 'status', 'waiting', 'countdown'), { status: 'open' });
  assert.equal(h.journal.proposal(suggestion.task_id).status, 'open', 'a suggestion is no offer to let go');
  clock.advance(OFFER_COUNTDOWN_MS);
  assert.equal(h.journal.proposal(idOf(h, 'Ended')).status, 'open');
  // nothing waiting: nothing to let go
  releaseOffers(h.orch, 'top');
});
/** The named fields of a record, as present. */
const pick = (p: any, ...keys: string[]) => Object.fromEntries(keys.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]));

test('no countdown survives a restart: the journal reads every offer as neither waiting nor counting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offer-countdown-'));
  const file = path.join(dir, 'orchestration.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      children: {},
      parents: {},
      deliveries: {},
      proposals: {
        t1: {
          parentId: 'top',
          kind: 'offer',
          args: { title: 'Fix login' },
          status: 'open',
          createdAt: 1,
          expiresAt: 9e15,
          waiting: true,
          countdown: { from: 1, at: 60_001 },
        },
      },
    }),
  );
  const journal = new OrchestrationJournal({ file, write: () => {} });
  const p = journal.proposal('t1');
  assert.deepEqual([p.status, p.waiting, p.countdown], ['open', undefined, undefined]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('windows read the countdown from main only while its offer waits', () => {
  const base = { parentId: 'top', kind: 'offer', args: { title: 'T' }, status: 'open', createdAt: 1, expiresAt: 9e15 };
  const view = (p: any) => orchestrationView({ children: {}, deliveries: {}, proposals: { t: { ...base, ...p } } }, 2).proposals.t;
  assert.deepEqual(pickView(view({ waiting: true, countdown: { from: 1, at: 60_001, extra: 1 } })), { countdown: { from: 1, at: 60_001 } });
  // no longer waiting (its call ended), or a countdown that is not two times: nothing to draw
  assert.deepEqual(pickView(view({ countdown: { from: 1, at: 60_001 } })), {});
  assert.deepEqual(pickView(view({ waiting: true })), {});
  assert.deepEqual(pickView(view({ waiting: true, countdown: { from: 'x', at: 60_001 } })), {});
  assert.deepEqual(pickView(view({ waiting: true, countdown: { from: 1, at: null } })), {});
  // a record from before the countdown chose "New session" shows as its status alone
  assert.deepEqual(pickView(view({ status: 'declined', autoHere: true })), {});
});
/** The view's countdown fields, as present. */
const pickView = (p: any) => pick(p, 'countdown', 'autoHere');
