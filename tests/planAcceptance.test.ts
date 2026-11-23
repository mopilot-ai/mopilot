// Main plan-button verification and native plan approvals cannot grant a retired or nonhuman turn more suggestions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { orchestration } from './support/orchestration-harness.ts';
const require = createRequire(import.meta.url);
const { preparePlanInput, beforePlanDispatch, planTurnFinished, nativePlanEvent, suggestionLimit } =
  require('../electron/session/orchestration/planAcceptance.cjs');

const plan = { id: 'plan1', type: 'plan', text: 'Independent changes in a plan.' };
const input = () => ({
  text: 'Implement the plan.',
  attachments: [],
  opts: { human: true, plan: false, acceptedPlan: { itemId: plan.id, text: plan.text } },
});
function fixture() {
  const h = orchestration();
  let writer = {};
  let trusted = true;
  h.records.set('top', { id: 'top', segments: [], meta: {} });
  const c: any = h.controller;
  c.state.localWriterToken = () => writer;
  c.chatOf = (key: string) => (key === 'other' ? 'other' : 'top');
  let page: any = { turns: [{ id: 't1', status: 'completed', items: [plan] }] };
  const live: any = { controller: c, chats: h.orch.o.chats, orchestrator: h.orch, peerRuntime: { readHistory: async () => page } };
  return {
    ...h,
    live,
    trusted: () => trusted,
    retire: () => {
      writer = {};
    },
    hide: () => {
      trusted = false;
    },
    page: (value: any) => {
      page = value;
    },
  };
}

test('a current trusted plan button is verified on every harness, including the plain-message fallback after restart', async () => {
  for (const kind of ['codex', 'claude', 'acp:qwen'])
    for (const type of ['plan', 'agentMessage']) {
      const f = fixture();
      f.refs.set('top', { key: `native-${kind}`, kind });
      f.page({ turns: [{ status: 'completed', items: [null, { id: 'empty', type, text: '' }, { ...plan, type }] }] });
      const result = await preparePlanInput(f.live, 'top', input(), f.trusted);
      assert.deepEqual(result.planApproval, { native: `native-${kind}`, itemId: 'plan1' });
      assert.equal(result.opts.acceptedPlan, undefined);
      f.userTurn();
      beforePlanDispatch(f.orch, { chatId: 'top', kind: 'turn', item: result });
      assert.equal(suggestionLimit(f.orch, 'top'), 4);
    }
});

test('ordinary input strips forged main proofs without delaying its receipt or changing its text', () => {
  for (const item of [null, undefined, 'text', 0])
    assert.equal(
      preparePlanInput({}, 'top', item, () => false),
      item,
    );
  assert.deepEqual(
    preparePlanInput({}, 'top', { text: 'hello', planApproval: { native: 'top' }, opts: { planApproval: true, human: true } }, () => false),
    { text: 'hello', opts: { human: true } },
  );
  assert.deepEqual(
    preparePlanInput({}, 'top', { text: 'hello', opts: null }, () => false),
    { text: 'hello', opts: null },
  );
});

test('malformed intent, untrusted windows, peer input and nonhuman sends cannot claim a plan button', async () => {
  const invalid: any[] = [
    { opts: { acceptedPlan: null } },
    { opts: { acceptedPlan: {} } },
    { opts: { acceptedPlan: { itemId: '', text: plan.text } } },
    { opts: { acceptedPlan: { itemId: 1, text: plan.text } } },
    { opts: { acceptedPlan: { itemId: plan.id, text: 1 } } },
    { opts: { acceptedPlan: { itemId: plan.id, text: ' ' } } },
    { text: 'Implement something' },
    { opts: { human: false } },
    { opts: { plan: true } },
    { peer: { id: 'peer' } },
    { opts: { prefix: 'handoff' } },
    { attachments: [{}] },
  ];
  for (const change of invalid) {
    const f = fixture();
    const base = input();
    await assert.rejects(() => preparePlanInput(f.live, 'top', { ...base, ...change, opts: { ...base.opts, ...change.opts } }, f.trusted), {
      code: 'plan_changed',
    });
  }
  const f = fixture();
  f.hide();
  await assert.rejects(() => preparePlanInput(f.live, 'top', input(), f.trusted), { code: 'plan_changed' });
});

test('the native read rechecks window, record, segment, writer and pending turn ownership after its await', async () => {
  const mutations = [
    (f: any) => f.hide(),
    (f: any) => f.retire(),
    (f: any) => f.records.delete('top'),
    (f: any) => f.records.set('top', { ...f.records.get('top'), segments: [] }),
    (f: any) => f.refs.set('top', { kind: 'claude', key: 'different' }),
    (f: any) => f.deleted.add('top'),
    (f: any) => {
      f.records.get('top').meta.archived = 2;
    },
    (f: any) => f.states.set('top', { turn: 'running' }),
    (f: any) => f.states.set('top', { pendingSwitch: {} }),
    (f: any) => f.orch.stopping.add('top'),
    (f: any) => f.orch.archiving.add('top'),
  ];
  for (const mutate of mutations) {
    const f = fixture();
    f.live.peerRuntime.readHistory = async () => {
      mutate(f);
      return { turns: [{ status: 'completed', items: [plan] }] };
    };
    await assert.rejects(() => preparePlanInput(f.live, 'top', input(), f.trusted), { code: 'plan_changed' });
  }
  const f = fixture();
  f.records.delete('top');
  await assert.rejects(() => preparePlanInput(f.live, 'top', input(), f.trusted), { code: 'plan_changed' });
  const good = fixture();
  good.live.peerRuntime.readHistory = async () => {
    good.records.set('top', { ...good.records.get('top'), meta: { title: 'Renamed' } });
    return { turns: [{ status: 'completed', items: [plan] }] };
  };
  assert.ok((await preparePlanInput(good.live, 'top', input(), good.trusted)).planApproval);
});

test('only the latest completed plan and its exact displayed id/text are accepted', async () => {
  const pages = [
    null,
    {},
    { turns: [] },
    { turns: [{ status: 'inProgress', items: [plan] }] },
    { turns: [{ status: 'completed', items: null }] },
    { turns: [{ status: 'completed', items: [] }] },
    { turns: [{ status: 'completed', items: [{ ...plan, approvedInTurn: true }] }] },
    { turns: [{ status: 'completed', items: [{ ...plan, id: 'other' }] }] },
    { turns: [{ status: 'completed', items: [{ ...plan, text: 'Changed plan' }] }] },
    {
      turns: [
        { status: 'completed', items: [plan] },
        { status: 'completed', items: [{ type: 'agentMessage', id: 'later', text: 'Another result' }] },
      ],
    },
    { turns: [{ status: 'completed', items: [{ ...plan, type: 'agentMessage', questions: [{}] }] }] },
  ];
  for (const page of pages) {
    const f = fixture();
    f.page(page);
    await assert.rejects(() => preparePlanInput(f.live, 'top', input(), f.trusted), { code: 'plan_changed' });
  }
  const f = fixture();
  f.page({ turns: [{ status: 'completed', items: [plan, { type: 'agentMessage', id: 'last', text: 'A reply' }] }] });
  assert.ok((await preparePlanInput(f.live, 'top', input(), f.trusted)).planApproval, 'a native plan wins over a plain reply');
  const noOrch = fixture();
  delete noOrch.live.orchestrator;
  assert.ok((await preparePlanInput(noOrch.live, 'top', input(), noOrch.trusted)).planApproval);
  const unavailable = fixture();
  unavailable.live.peerRuntime.readHistory = async () => {
    throw new Error('native history unavailable');
  };
  await assert.rejects(() => preparePlanInput(unavailable.live, 'top', input(), unavailable.trusted), { code: 'plan_changed' });
  unavailable.live.peerRuntime.readHistory = async () => ({ turns: [{ status: 'completed', items: [plan] }] });
  assert.ok(
    (await preparePlanInput(unavailable.live, 'top', input(), unavailable.trusted)).planApproval,
    'a failed read leaves a usable retry',
  );
});

const dispatch = (f: any, item: any, kind = 'turn', chatId = 'top') => beforePlanDispatch(f.orch, { chatId, kind, item });
const accepted = () => ({
  text: 'Implement the plan.',
  opts: { human: true, plan: false },
  planApproval: { native: 'top', itemId: 'plan1' },
});

test('accepted-plan authority survives a human steer but clears for new turns, peer input, Stop, archive and native replacement', () => {
  const f = fixture();
  f.userTurn();
  dispatch(f, accepted());
  assert.equal(suggestionLimit(f.orch, 'top'), 4);
  dispatch(f, { opts: { human: true } }, 'steer');
  assert.equal(suggestionLimit(f.orch, 'top'), 4);
  dispatch(f, { opts: { human: true } });
  assert.equal(suggestionLimit(f.orch, 'top'), 3);
  for (const item of [null, { opts: { human: false } }, { opts: { human: true }, peer: {} }, { opts: { human: true, prefix: 'own' } }]) {
    dispatch(f, accepted());
    dispatch(f, item, 'steer');
    assert.equal(suggestionLimit(f.orch, 'top'), 3);
  }
  for (const retire of [
    () => f.orch.stopping.add('top'),
    () => f.orch.archiving.add('top'),
    () => {
      f.records.get('top')!.meta.archived = 1;
    },
    () => f.refs.set('top', { key: 'changed', kind: 'codex' }),
    () => f.rts.set('top', { inputToken: 'next' }),
    () => f.states.set('top', { activeTurn: { human: false } }),
  ]) {
    f.orch.stopping.clear();
    f.orch.archiving.clear();
    delete f.records.get('top')!.meta.archived;
    f.refs.clear();
    f.rts.clear();
    f.userTurn();
    dispatch(f, accepted());
    retire();
    assert.equal(suggestionLimit(f.orch, 'top'), 3);
  }
  const bad = fixture();
  bad.userTurn();
  for (const proof of [undefined, {}, { native: 'top', itemId: '' }, { native: 'wrong', itemId: 'p' }]) {
    dispatch(bad, { ...accepted(), planApproval: proof });
    assert.equal(suggestionLimit(bad.orch, 'top'), 3);
  }
  dispatch(bad, { ...accepted(), text: 'Other words' });
  assert.equal(suggestionLimit(bad.orch, 'top'), 3);
  for (const deletion of [(g: any) => g.records.delete('top'), (g: any) => g.deleted.add('top')]) {
    const g = fixture();
    g.userTurn();
    dispatch(g, accepted());
    deletion(g);
    assert.equal(suggestionLimit(g.orch, 'top'), 3);
  }
  dispatch(bad, { ...accepted(), opts: { human: true, plan: true } });
  assert.equal(suggestionLimit(bad.orch, 'top'), 3);
});

const request = (id = 'r1', extra: any = {}) => ({ key: 'top', kind: 'permission', requestId: id, toolName: 'ExitPlanMode', ...extra });
const answer = (id = 'r1', extra: any = {}) => ({ key: 'top', kind: 'planAccepted', requestId: id, ...extra });

test('a root native approval is consumed once, before continuation, only for the request’s current human turn', () => {
  const f = fixture();
  f.userTurn();
  nativePlanEvent(f.orch, 'codex', request());
  nativePlanEvent(f.orch, 'claude', null);
  nativePlanEvent(f.orch, 'claude', { kind: 'permission' });
  nativePlanEvent(f.orch, 'claude', { key: 'top', kind: 'other' });
  nativePlanEvent(f.orch, 'claude', request());
  nativePlanEvent(f.orch, 'claude', answer());
  assert.equal(suggestionLimit(f.orch, 'top'), 4);
  dispatch(f, { opts: { human: true } });
  nativePlanEvent(f.orch, 'claude', answer());
  assert.equal(suggestionLimit(f.orch, 'top'), 3, 'a second answer cannot replay proof');
  for (const invalidate of [
    (g: any) => nativePlanEvent(g.orch, 'claude', { key: 'top', kind: 'permissionCancelled', requestId: 'r1' }),
    (g: any) => g.rts.set('top', { inputToken: 'next' }),
    (g: any) => g.refs.set('top', { key: 'new', kind: 'claude' }),
    (g: any) => g.states.set('top', { activeTurn: { human: true, nonHuman: true } }),
    (g: any) => planTurnFinished(g.orch, { chatId: 'top' }),
    (g: any) => dispatch(g, { opts: { human: true } }),
    (g: any) => g.orch.stopping.add('top'),
    (g: any) => g.records.delete('top'),
    (g: any) => g.deleted.add('top'),
  ]) {
    const g = fixture();
    g.userTurn();
    nativePlanEvent(g.orch, 'claude', request());
    invalidate(g);
    nativePlanEvent(g.orch, 'claude', answer());
    assert.equal(suggestionLimit(g.orch, 'top'), 3);
  }
  for (const extra of [{ agentID: 'worker' }, { toolName: 'OtherTool' }, { key: 'wrong' }]) {
    const g = fixture();
    g.userTurn();
    nativePlanEvent(g.orch, 'claude', request('r1', extra));
    nativePlanEvent(g.orch, 'claude', answer());
    assert.equal(suggestionLimit(g.orch, 'top'), 3);
  }
  const g = fixture();
  g.userTurn();
  nativePlanEvent(g.orch, 'claude', request());
  nativePlanEvent(g.orch, 'claude', answer('r1', { key: 'wrong' }));
  assert.equal(suggestionLimit(g.orch, 'top'), 3);
});

test('retiring one chat leaves another chat’s pending native approval independent', () => {
  const f = fixture();
  f.userTurn();
  f.userTurn('other');
  f.records.set('other', { segments: [], meta: {} });
  nativePlanEvent(f.orch, 'claude', request());
  nativePlanEvent(f.orch, 'claude', request('other-request', { key: 'other' }));
  planTurnFinished(f.orch, { chatId: 'top' });
  dispatch(f, { opts: { human: true } });
  nativePlanEvent(f.orch, 'claude', answer('other-request', { key: 'other' }));
  assert.equal(suggestionLimit(f.orch, 'other'), 4);
});

test('archive and restore retire a plan claim during its read and between validation and synchronous consume', async () => {
  const { takePlanInput } = require('../electron/session/orchestration/planAcceptance.cjs');
  for (const boundary of ['read', 'consume']) {
    const f = fixture();
    let epoch = 0;
    f.live.chats.archiveEpoch = () => epoch;
    if (boundary === 'read')
      f.live.peerRuntime.readHistory = async () => {
        epoch++;
        return { turns: [{ status: 'completed', items: [plan] }] };
      };
    const prepare = preparePlanInput(f.live, 'top', input(), f.trusted);
    if (boundary === 'read') await assert.rejects(prepare, { code: 'plan_changed' });
    else {
      const prepared = await prepare;
      epoch++;
      assert.throws(() => takePlanInput(prepared), { code: 'plan_changed' });
    }
  }
});

test('archive generations also retire an accepted budget and a native approval still awaiting its answer', () => {
  for (const phase of ['accepted', 'pending']) {
    const f = fixture();
    f.userTurn();
    let epoch = 0;
    f.live.chats.archiveEpoch = () => epoch;
    if (phase === 'accepted') {
      dispatch(f, { ...accepted(), planApproval: { ...accepted().planApproval, archiveEpoch: 0 } });
      assert.equal(suggestionLimit(f.orch, 'top'), 4);
    } else nativePlanEvent(f.orch, 'claude', { kind: 'permission', key: 'top', requestId: 'plan', toolName: 'ExitPlanMode' });
    epoch++;
    if (phase === 'pending') nativePlanEvent(f.orch, 'claude', { kind: 'planAccepted', key: 'top', requestId: 'plan' });
    assert.equal(suggestionLimit(f.orch, 'top'), 3, phase);
    dispatch(f, { opts: { human: true } }, 'steer');
    assert.equal(f.journal.parent('top')?.planApprovedFor, undefined);
  }
});

test('a verified plan item queued before archive/restore cannot grant the restored turn a fourth proposal', async () => {
  const f = fixture();
  let epoch = 0;
  f.live.chats.archiveEpoch = () => epoch;
  const prepared = await preparePlanInput(f.live, 'top', input(), f.trusted);
  assert.equal(prepared.planApproval.archiveEpoch, 0);
  epoch++;
  f.userTurn();
  dispatch(f, prepared);
  assert.equal(suggestionLimit(f.orch, 'top'), 3);
});

test('a plan clicked before main has its turn’s end waits for that end, and is refused if it never comes (#2479)', async () => {
  // Codex holds the turn's end until its final snapshot is taken: the window shows the plan first
  const ends = fixture();
  ends.states.set('top', { turn: 'running' });
  let reads = 0;
  ends.live.peerRuntime.readHistory = async () => {
    reads++;
    return { turns: [{ status: 'completed', items: [plan] }] };
  };
  const waiting = preparePlanInput(ends.live, 'top', input(), ends.trusted);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(reads, 0, 'nothing is read while the turn still runs here');
  ends.states.delete('top');
  assert.ok((await waiting).planApproval);
  assert.equal(reads, 1);
  // the end never comes within the wait: refused, as a plan whose turn runs always was
  const never = fixture();
  never.states.set('top', { turn: 'running' });
  never.live.turnEndWaitMs = 120;
  await assert.rejects(() => preparePlanInput(never.live, 'top', input(), never.trusted), { code: 'plan_changed' });
  // a turn waiting on the user is not over: no wait, refused at once
  const asks = fixture();
  asks.states.set('top', { turn: 'awaitingUser' });
  asks.live.turnEndWaitMs = 60_000;
  await assert.rejects(() => preparePlanInput(asks.live, 'top', input(), asks.trusted), { code: 'plan_changed' });
  // the window stops showing the chat while it waits: the wait ends there, and the click is refused
  const hidden = fixture();
  hidden.states.set('top', { turn: 'running' });
  hidden.live.turnEndWaitMs = 60_000;
  const gone = preparePlanInput(hidden.live, 'top', input(), hidden.trusted);
  await new Promise((r) => setTimeout(r, 60));
  hidden.hide();
  await assert.rejects(() => gone, { code: 'plan_changed' });
});
