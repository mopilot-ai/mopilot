// electron/session/orchestration/proposals.cjs and the Orchestrator's routing: an offer needs the user's turn, the
// agent's own suggestions come from any turn (3 at most, none twice), a proposal starts once (by the user's click or
// their word in a later turn), and the agent can withdraw only its own; hand-off forks the chat into a linked session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { orchestration } from './support/orchestration-harness.ts';
import { SESSION_BACKGROUND as BACKGROUND } from './support/orchestration-harness.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { proposalStatus, PROPOSAL_DAYS, SUGGESTIONS_PER_TURN } = require('../electron/session/orchestration/proposals.cjs');
const { OrchestrationJournal, PROPOSALS_KEPT } = require('../electron/session/orchestration/journal.cjs');

const task = (over: any = {}) => ({
  background: BACKGROUND,
  title: 'Fix login',
  prompt: 'Fix the login bug',
  use_worktree: false,
  ...over,
});
/** An offer whose call the harness cancelled (a Stop) before the user answered: it comes back unanswered, still open. */
const unanswered = () => {
  const ac = new AbortController();
  ac.abort();
  return { signal: ac.signal };
};
const code = (c: string) => (e: any) => e.code === c;

test('an offer needs the user’s turn; a suggestion comes from any turn, at most 3 per turn and none twice', async () => {
  const h = orchestration();
  await assert.rejects(h.orch.start('top', task({ initiation: 'offer' })), code('not_user_turn'));
  const first = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  assert.equal(first.status, 'proposed');
  assert.match(first.task_id, /^task_[0-9a-f]{12}$/);
  assert.match(first.next, /expires in 7 days/);
  const p = h.journal.proposal(first.task_id);
  assert.deepEqual(
    { ...p, args: p.args.title },
    {
      parentId: 'top',
      kind: 'own_initiative',
      args: 'Fix login',
      harnessChecked: true,
      turn: 'pending-turn1',
      status: 'open',
      createdAt: 1000,
      expiresAt: 1000 + PROPOSAL_DAYS * 86400000,
      chatId: null,
    },
  );
  const again = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  assert.deepEqual(again, { status: 'proposed', task_id: first.task_id, kind: 'own_initiative', title: 'Fix login', repeated: true });
  for (let i = 1; i < SUGGESTIONS_PER_TURN; i++) await h.orch.start('top', task({ initiation: 'own_initiative', title: `T${i}` }));
  await assert.rejects(h.orch.start('top', task({ initiation: 'own_initiative', title: 'one more' })), code('proposal_limit'));
  // a new turn may suggest again
  h.rts.set('top', { inputToken: 'pending-turn2' });
  assert.equal((await h.orch.start('top', task({ initiation: 'own_initiative', title: 'one more' }))).status, 'proposed');
  h.userTurn();
  const offer = await h.orch.start('top', task({ initiation: 'offer' }), unanswered());
  assert.equal(offer.kind, 'offer');
  assert.equal(offer.still_open, true);
  assert.match(offer.next, /did not answer the card: end your turn now/);
  assert.equal(h.log.length, 0, 'proposing makes no chat');
});

test('a suggestion still open is reused by a later turn that suggests it again; a settled or expired one is not', async () => {
  const h = orchestration();
  const first = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  h.rts.set('top', { inputToken: 'pending-turn2' });
  const again = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  assert.deepEqual(again, { status: 'proposed', task_id: first.task_id, kind: 'own_initiative', title: 'Fix login', repeated: true });
  assert.equal(Object.keys(h.journal.data.proposals).length, 1, 'one card, not one per turn');
  // one the user's click is starting (or waiting for its brief) is still that card
  h.journal.change((d) => (d.proposals[first.task_id].status = 'briefing'));
  h.rts.set('top', { inputToken: 'pending-turn2b' });
  assert.equal((await h.orch.start('top', task({ initiation: 'own_initiative' }))).task_id, first.task_id);
  h.journal.change((d) => (d.proposals[first.task_id].status = 'open'));
  // another chat's proposal of the same title is its own
  assert.notEqual((await h.orch.start('other', task({ initiation: 'own_initiative' }))).task_id, first.task_id);
  // the user dismissed it: a later turn may suggest it anew
  await h.orch.act(first.task_id, 'dismiss');
  h.rts.set('top', { inputToken: 'pending-turn3' });
  const fresh = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  assert.notEqual(fresh.task_id, first.task_id);
  assert.equal(fresh.repeated, undefined);
  // one open past its week has expired: it is not reused either
  h.journal.change((d) => (d.proposals[fresh.task_id].expiresAt = 0));
  h.rts.set('top', { inputToken: 'pending-turn4' });
  assert.notEqual((await h.orch.start('top', task({ initiation: 'own_initiative' }))).task_id, fresh.task_id);
});

test('a click starts a proposal once, leaves the parent a note that does not wake it, and another click is refused', async () => {
  const h = orchestration();
  const { task_id: id } = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  const clicks = [h.orch.act(id, 'start'), h.orch.act(id, 'start')];
  const [first, second] = await Promise.allSettled(clicks);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal((second as any).reason.code, 'not_open');
  const r = (first as any).value;
  assert.equal(r.task_id, id);
  assert.equal(h.journal.proposal(id).status, 'started');
  assert.equal(h.journal.proposal(id).chatId, r.chat_id);
  assert.equal(h.journal.child(r.chat_id).initiation, 'own_initiative');
  const note = h.journal.parent('top').notes.at(-1);
  assert.equal(note.wakes, false);
  assert.match(
    note.body,
    new RegExp(`The user started your proposed task ${id} \\("Fix login"\\) as a separate session \\(fix-login, ${r.chat_id}\\)`),
  );
  h.flush();
  assert.ok(!h.log.some((l) => l[0] === 'send' && l[1] === 'top'), 'the note alone wakes nothing');
});

test('Start all: clicked proposals start side by side, each counted in flight, each with its own name', async () => {
  const opened: (() => void)[] = [];
  // each start holds at its folder lookup (where a worktree would be made) until the test lets it go
  const h = orchestration({ projectOf: () => new Promise((resolve) => opened.push(() => resolve('/repo'))) });
  const ids: string[] = [];
  for (const title of ['Fix login', 'Fix logout', 'Fix signup'])
    ids.push((await h.orch.start('top', task({ initiation: 'own_initiative', title }))).task_id);
  const clicks = ids.map((id) => h.orch.act(id, 'start'));
  await waitFor(() => opened.length >= 3, 'three sessions opening');
  assert.equal(opened.length, 3, 'all three are making their sessions at once, none waits for another');
  assert.deepEqual(
    ids.map((id) => h.journal.proposal(id).status),
    ['starting', 'starting', 'starting'],
  );
  assert.equal(h.orch.starting.get('top'), 3, 'the parent’s wake waits for every one of them');
  assert.equal(h.orch.serial.has('top'), false, 'a click holds up no start_session after it');
  for (const go of opened) go();
  const started = await Promise.all(clicks);
  assert.deepEqual(
    started.map((r) => r.status),
    ['started', 'started', 'started'],
  );
  assert.deepEqual(started.map((r) => r.name).sort(), ['fix-login', 'fix-logout', 'fix-signup']);
  assert.equal(h.orch.starting.has('top'), false);
  // a start_session the agent makes is still queued behind the ones before it
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  let order = '';
  const first = h.orch.serialized('top', null, async () => {
    await held;
    order += 'a';
  });
  const second = h.orch.serialized('top', null, async () => void (order += 'b'));
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  assert.equal(order, '', 'the second waits for the first');
  release();
  await Promise.all([first, second]);
  assert.equal(order, 'ab');
});

test('a start that fails opens the proposal again; one whose reopening fails is noted', async () => {
  let projects: string | null = null;
  const h = orchestration({ projectOf: async () => projects });
  const { task_id: id } = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  await assert.rejects(h.orch.act(id, 'start'), code('no_folder'));
  assert.equal(h.journal.proposal(id).status, 'open');
  projects = '/repo';
  assert.equal((await h.orch.act(id, 'start')).status, 'started');
  const failing = orchestration({ projectOf: async () => null });
  const { task_id: other } = await failing.orch.start('top', task({ initiation: 'own_initiative' }));
  const commit = failing.journal.commit.bind(failing.journal);
  let writes = 0;
  failing.journal.commit = (d: any) => {
    if (++writes === 3) throw new Error('disk full');
    return commit(d);
  };
  await assert.rejects(failing.orch.act(other, 'start'), code('no_folder'));
  assert.equal(failing.journal.proposal(other).status, 'starting', 'the reopening failed and was noted');
});

test('the user’s word in a later turn starts a proposal by its id, only this chat’s own and only in their turn', async () => {
  const h = orchestration();
  const { task_id: id } = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  assert.throws(() => h.orch.start('top', { proposal_id: id }), code('not_user_turn'));
  h.userTurn();
  await assert.rejects(h.orch.start('top', { proposal_id: 'task_missing' }), code('not_found'));
  h.records.set('other', { meta: {} });
  h.userTurn('other');
  await assert.rejects(h.orch.start('other', { proposal_id: id }), code('not_found'));
  const r = await h.orch.start('top', { proposal_id: id });
  assert.equal(r.status, 'started');
  assert.equal(h.journal.parent('top').notes.length, 0, 'the agent started it itself: no note');
});

test('a proposal set aside: dismissed by its agent or the user, declined by "Do it here", or expired', async () => {
  const h = orchestration();
  h.userTurn();
  const { task_id: suggestion } = await h.orch.start('top', task({ initiation: 'own_initiative' }));
  const { task_id: offer } = await h.orch.start('top', task({ initiation: 'offer', title: 'Offer' }), unanswered());
  assert.throws(() => h.orch.dismiss('other', { task_id: suggestion }), code('not_found'));
  assert.deepEqual(h.orch.dismiss('top', { task_id: suggestion }), { task_id: suggestion, status: 'dismissed' });
  assert.throws(
    () => h.orch.dismiss('top', { task_id: suggestion }),
    (e: any) => e.code === 'not_open' && /dismissed/.test(e.message),
  );
  const { task_id: s2 } = await h.orch.start('top', task({ initiation: 'own_initiative', title: 'Second' }));
  await assert.rejects(h.orch.act(s2, 'here'), code('not_offer'));
  assert.deepEqual(await h.orch.act(s2, 'dismiss'), { task_id: s2, status: 'dismissed', answered: false });
  assert.deepEqual(await h.orch.act(offer, 'here'), { task_id: offer, status: 'declined', answered: false });
  // the card took the offer before its "Do it here." went out; a message the chat refused gives the offer back, and
  // only a declined one (#1988)
  await assert.rejects(h.orch.act(offer, 'here'), code('not_open'));
  assert.deepEqual(await h.orch.act(offer, 'reopen'), { task_id: offer, status: 'open' });
  assert.equal(h.journal.proposal(offer).status, 'open');
  await assert.rejects(h.orch.act(offer, 'reopen'), (e: any) => e.code === 'not_declined' && /open/.test(e.message));
  await assert.rejects(h.orch.act('task_missing', 'reopen'), code('not_found'));
  assert.deepEqual(await h.orch.act(offer, 'here'), { task_id: offer, status: 'declined', answered: false });
  assert.throws(() => h.orch.act('task_missing', 'start'), code('not_found'));
  assert.throws(() => h.orch.act(offer, 'explode'), code('invalid_action'));
  const { task_id: late } = await h.orch.start('top', task({ initiation: 'own_initiative', title: 'Late' }));
  const p = h.journal.proposal(late);
  assert.equal(proposalStatus(p, p.expiresAt), 'open');
  assert.equal(proposalStatus(p, p.expiresAt + 1), 'expired');
  h.journal.change((d: any) => (d.proposals[late].expiresAt = 0));
  await assert.rejects(h.orch.act(late, 'start'), (e: any) => e.code === 'not_open' && /expired/.test(e.message));
  assert.equal(proposalStatus({ status: 'started', expiresAt: 0 }, 5), 'started');
});

test('hand_off_to_session forks the chat into a linked session with the plan that is left, in the user’s turn only', async () => {
  const h = orchestration();
  assert.throws(
    () => h.orch.handOff('top', { background: BACKGROUND, title: 'Move it', remaining_plan: 'steps left' }),
    code('not_user_turn'),
  );
  h.userTurn();
  const r = await h.orch.handOff('top', { background: BACKGROUND, title: 'Move it', remaining_plan: 'steps left' });
  assert.equal(r.context, 'fork');
  assert.equal(r.worktree, false, 'it goes on in this folder by default');
  const wt = await h.orch.handOff('top', { background: BACKGROUND, title: 'In a worktree', remaining_plan: 'steps', use_worktree: true });
  assert.equal(wt.worktree, true);
  assert.equal(h.journal.child(r.chat_id).initiation, 'hand_off');
  assert.match(h.log.find((l) => l[0] === 'send')[2].text, /Task \(from the session that started this one\):\nsteps left/);
  assert.equal(
    await h.orch.handOff('top', { background: BACKGROUND, title: 'Move it', remaining_plan: 'steps left' }),
    await h.orch.handOff('top', { background: BACKGROUND, title: 'Move it', remaining_plan: 'steps left' }),
  );
  assert.throws(() => h.orch.handOff('top', { background: BACKGROUND, title: 'No plan' }), code('invalid_prompt'));
});

test('a proposal whose start the app quit during can be started again after a restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-proposals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'orchestration.json');
  const before = new OrchestrationJournal({ file });
  before.change((d: any) => {
    d.proposals.mid = {
      parentId: 'p',
      kind: 'own_initiative',
      args: { background: BACKGROUND, title: 'T' },
      status: 'starting',
      createdAt: 1,
      expiresAt: 9e15,
    };
    d.proposals.done = {
      parentId: 'p',
      kind: 'own_initiative',
      args: { background: BACKGROUND, title: 'T' },
      status: 'started',
      createdAt: 1,
      expiresAt: 9e15,
    };
  });
  const after = new OrchestrationJournal({ file });
  assert.equal(after.proposal('mid').status, 'open');
  assert.equal(after.proposal('done').status, 'started');
  // a journal from before proposals reads with none
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, children: {}, parents: {}, deliveries: {} }));
  assert.deepEqual(new OrchestrationJournal({ file }).data.proposals, {});
});

test('the journal keeps open proposals and the newest settled ones, and reads a journal from before proposals', (t) => {
  const j = new OrchestrationJournal({ file: '/nonexistent/x.json', write: () => {} });
  j.change((d: any) => {
    for (let i = 0; i < PROPOSALS_KEPT + 5; i++)
      d.proposals[`s${i}`] = { parentId: 'p', kind: 'own_initiative', args: {}, status: 'dismissed', createdAt: i, expiresAt: 1 };
    d.proposals.open = { parentId: 'p', kind: 'offer', args: {}, status: 'open', createdAt: -1, expiresAt: 9e15 };
    d.proposals.starting = { parentId: 'p', kind: 'offer', args: {}, status: 'starting', createdAt: -3, expiresAt: 1 };
    // expired: open in the record, past its time, so it goes like a settled one
    d.proposals.expired = { parentId: 'p', kind: 'offer', args: {}, status: 'open', createdAt: -2, expiresAt: 1 };
  });
  assert.equal(Object.keys(j.data.proposals).length, PROPOSALS_KEPT + 2);
  assert.ok(
    j.proposal('open') && j.proposal('starting') && !j.proposal('expired') && !j.proposal('s0') && j.proposal(`s${PROPOSALS_KEPT + 4}`),
  );
  assert.equal(j.proposal('none'), null);
  void t;
});

/** The task id of the proposal titled `title`, once its call has made it. */
const idOf = async (h: any, title: string) => {
  await waitFor(() => Object.values<any>(h.journal.data.proposals).some((p) => p.args.title === title), `the proposal titled ${title}`);
  return Object.entries<any>(h.journal.data.proposals).find(([, p]) => p.args.title === title)![0];
};

test("an offer's call waits for the user's answer on its card: New session, Do it here, a dismissal, or neither", async () => {
  const { HERE_NEXT, OFFER_WAIT_MS } = require('../electron/session/orchestration/proposals.cjs');
  assert.ok(OFFER_WAIT_MS < 15 * 60_000, "under Codex's limit on MoPilot's tools");
  const h = orchestration();
  h.userTurn();
  // New session: the call comes back with the started session, and the parent gets no note (the call told it)
  const a = h.orch.start('top', task({ initiation: 'offer', title: 'A' }));
  const idA = await idOf(h, 'A');
  assert.equal(h.journal.proposal(idA).waiting, true);
  const clicked = await h.orch.act(idA, 'start');
  assert.equal(clicked.answered, true);
  const started = await a;
  assert.equal(started.status, 'started');
  assert.equal(started.answer, 'new_session');
  assert.match(started.next, /chose "New session"/);
  assert.equal(h.journal.proposal(idA).waiting, undefined);
  assert.equal(h.journal.parent('top')?.notes.length ?? 0, 0, 'the call told the agent: no note');
  // Do it here: the agent carries on in the same turn
  const b = h.orch.start('top', task({ initiation: 'offer', title: 'B' }));
  const idB = await idOf(h, 'B');
  assert.deepEqual(await h.orch.act(idB, 'here'), { task_id: idB, status: 'declined', answered: true });
  assert.deepEqual(await b, { status: 'declined', task_id: idB, kind: 'offer', title: 'B', answer: 'here', next: HERE_NEXT });
  // a dismissal answers the call too
  const c = h.orch.start('top', task({ initiation: 'offer', title: 'C' }));
  const idC = await idOf(h, 'C');
  await h.orch.act(idC, 'dismiss');
  assert.equal((await c).status, 'dismissed');
  // the same offer again while the first waits answers at once; the first still waits for the card
  const d = h.orch.start('top', task({ initiation: 'offer', title: 'D' }));
  const idD = await idOf(h, 'D');
  assert.equal((await h.orch.start('top', task({ initiation: 'offer', title: 'D' }))).repeated, true);
  await h.orch.act(idD, 'here');
  assert.equal((await d).answer, 'here');
  // neither before the cap: the agent ends its turn and the card stays open for a later answer
  (h.orch as any).offerWaitMs = 5;
  const e = await h.orch.start('top', task({ initiation: 'offer', title: 'E' }));
  assert.equal(e.still_open, true);
  assert.equal(h.journal.proposal(e.task_id).status, 'open');
  assert.equal(h.journal.proposal(e.task_id).waiting, undefined);
  // a later click is the late path: a note that does not wake the parent, and the window sends "Do it here" itself
  assert.equal((await h.orch.act(e.task_id, 'start')).answered, false);
  assert.equal(h.journal.parent('top').notes.length, 1);
  // a Stop while it waits (the call's cancel) comes back unanswered too
  (h.orch as any).offerWaitMs = 60_000;
  const ac = new AbortController();
  const f = h.orch.start('top', task({ initiation: 'offer', title: 'F' }), { signal: ac.signal });
  await idOf(h, 'F');
  ac.abort();
  assert.equal((await f).still_open, true);
});

test('the setting answers an offer for the user: always here, or always a new session; only in their turn', async () => {
  const { HERE_NEXT } = require('../electron/session/orchestration/proposals.cjs');
  let choice = 'here';
  const h = orchestration({ prefs: () => ({ maxParallelChildren: 3, newTaskPrompt: choice }) });
  await assert.rejects(h.orch.start('top', task({ initiation: 'offer' })), code('not_user_turn'));
  h.userTurn();
  assert.deepEqual(await h.orch.start('top', task({ initiation: 'offer' })), {
    status: 'declined',
    kind: 'offer',
    title: 'Fix login',
    answer: 'here',
    next: HERE_NEXT,
  });
  assert.deepEqual(h.journal.data.proposals, {}, 'no card');
  choice = 'new';
  const started = await h.orch.start('top', task({ initiation: 'offer', title: 'New one' }));
  assert.equal(started.status, 'started');
  assert.equal(started.answer, 'new_session');
  assert.equal(h.journal.child(started.chat_id).initiation, 'offer');
});

test('no offer waits across a restart: the journal reads every proposal as not waiting', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-wait-'));
  const file = path.join(dir, 'orchestration.json');
  fs.writeFileSync(
    file,
    JSON.stringify({
      schemaVersion: 1,
      children: {},
      parents: {},
      deliveries: {},
      proposals: { t: { parentId: 'p', kind: 'offer', args: {}, status: 'open', createdAt: 1, expiresAt: 9e15, waiting: true } },
    }),
  );
  assert.equal(new OrchestrationJournal({ file }).data.proposals.t.waiting, undefined);
});

test('the card may change where a proposal starts and on which harness; anything else in its options is refused', async () => {
  const h = orchestration();
  let turn = 0;
  // each in a turn of its own: a turn suggests at most 3
  const id = async (title: string) => {
    h.rts.set('top', { inputToken: `pending-turn-${++turn}` });
    return (await h.orch.start('top', task({ initiation: 'own_initiative', title, use_worktree: true }))).task_id;
  };
  // proposed in a worktree on this chat's harness; started in this folder on Claude Code
  const a = await id('A');
  const started = await h.orch.act(a, 'start', { harness: 'claude', useWorktree: false });
  assert.equal(h.journal.child(started.chat_id).harness, 'claude');
  assert.equal(h.journal.child(started.chat_id).useWorktree, false);
  assert.ok(!h.log.some((l) => l[0] === 'newWorktree'), 'no worktree was made');
  assert.ok(h.log.some((l) => l[0] === 'startClaude'));
  // nothing picked: as proposed
  const b = await id('B');
  const asProposed = await h.orch.act(b, 'start', null);
  assert.equal(h.journal.child(asProposed.chat_id).useWorktree, true);
  for (const [options, code] of [
    ['claude', 'invalid_options'],
    [{ harness: 'gpt' }, 'invalid_harness'],
    [{ harness: 5 }, 'invalid_harness'],
    [{ useWorktree: 'yes' }, 'invalid_options'],
    [{ prompt: 'do something else' }, 'invalid_options'],
  ] as const) {
    const c = await id(`C-${code}-${JSON.stringify(options)}`);
    await assert.rejects(h.orch.act(c, 'start', options), (e: any) => e.code === code, JSON.stringify(options));
    assert.equal(h.journal.proposal(c).status, 'open', 'a refused option starts nothing');
  }
});

test("where the folder can't hold a worktree, a start the user asked for runs in it; the agent's own is refused", async () => {
  const plain = { worktree: { unsupported: "This folder isn't a git repository" } };
  const inFolder = (r: any, h: any) => {
    assert.deepEqual([r.status, r.worktree, r.folder], ['started', false, '/repo']);
    assert.equal(h.journal.child(r.chat_id).useWorktree, false);
    assert.ok(
      h.log.some((l: any[]) => l[0] === 'newWorktree'),
      'a worktree was tried first',
    );
  };
  const own = (title: string, over: any = {}) => task({ initiation: 'own_initiative', title, use_worktree: true, ...over });
  // the user's click on the card
  const click = orchestration(plain);
  const { task_id: a } = await click.orch.start('top', own('Click'));
  inFolder(await click.orch.act(a, 'start'), click);
  // the user's word in a later turn: the agent passes only the task id
  const turn = orchestration(plain);
  const { task_id: b } = await turn.orch.start('top', own('Turn'));
  turn.userTurn();
  inFolder(await turn.orch.start('top', { proposal_id: b }), turn);
  // "Always start a new session" answers an offer with no card
  const always = orchestration({ ...plain, prefs: () => ({ maxParallelChildren: 3, newTaskPrompt: 'new' }) });
  always.userTurn();
  inFolder(await always.orch.start('top', task({ initiation: 'offer', title: 'Always', use_worktree: true })), always);
  // a fork, which gets a worktree unless told otherwise, stays a native fork in the folder
  const fork = orchestration(plain);
  const { task_id: f } = await fork.orch.start('top', own('Fork', { context: 'fork' }));
  const forked = await fork.orch.act(f, 'start');
  inFolder(forked, fork);
  assert.equal(forked.context, 'fork', 'no fallback to a fresh chat');
  // the agent's own start is told, so it can choose to share the folder
  const asked = orchestration(plain);
  asked.userTurn();
  await assert.rejects(
    asked.orch.start('top', task({ background: BACKGROUND, title: 'Asked', use_worktree: true })),
    code('worktree_failed'),
  );
  // a second session in the folder while the first works there is refused as any shared-folder start is
  const first = click.journal.proposal(a).chatId;
  click.records.set(first, { meta: {} });
  click.states.set(first, { turn: 'running' });
  const { task_id: c } = await click.orch.start('top', own('Second'));
  await assert.rejects(click.orch.act(c, 'start'), code('paths_required'));
  assert.equal(click.journal.proposal(c).status, 'open', 'it can be started once the first is done');
});

test('a worktree that fails in a repo is refused, never swapped for the folder, and the proposal opens again', async () => {
  const h = orchestration({ worktree: null });
  const { task_id: id } = await h.orch.start('top', task({ initiation: 'own_initiative', use_worktree: true }));
  await assert.rejects(h.orch.act(id, 'start'), code('worktree_failed'));
  assert.equal(h.journal.proposal(id).status, 'open');
  assert.ok(!h.log.some((l) => /^start|fork/.test(l[0])), 'no chat was made');
});
