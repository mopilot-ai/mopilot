// The home's data in the view contract's shape (shared/momoHomeView.mjs, shared/momoOutbox.mjs): what the clients draw for the pill, the machine list, a move and a message's delivery, and the device's outbox rules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { homeView, machineView, recommendedMachine, agentProblem, moveView, deliveryOf, canResend } from '../shared/momoHomeView.mjs';
// @ts-ignore
import { createMomoOutbox, OUTBOX_MAX_AGE_MS } from '../shared/momoOutbox.mjs';
// @ts-ignore
import { createStampSink } from '../shared/momoStamp.mjs';

const agent = (name: string, installed = true, signedIn = true) => ({ id: name.split(' ')[0].toLowerCase(), name, installed, signedIn });
const machine = (id: string, over: object = {}): any => ({
  id,
  name: id,
  isThisDevice: false,
  reachable: true,
  current: true,
  stays: 'on',
  setUp: true,
  agents: [agent('Claude Code')],
  ...over,
});
const kept = (over: object = {}): any => ({ homeId: 'studio', state: 'running', stateSince: 10, lastSeenAt: 20, name: 'Studio', ...over });
const NOW = 1_000_000;

test('the machine list: status from set-up, reach and build; the plain cost; the recommendation is a machine that stays on, never this device', () => {
  const studio = machine('studio', { agents: [agent('Claude Code'), agent('Codex', true, false)] });
  const laptop = machine('laptop', { isThisDevice: true, stays: 'sleeps' });
  const mini = machine('mini', { current: false });
  const cloud = machine('cloud', { setUp: false, stays: 'cloud' });
  const down = machine('down', { reachable: false });
  assert.equal(recommendedMachine([laptop, mini, cloud, down, studio]), 'studio');
  assert.equal(recommendedMachine([laptop, mini, cloud, down]), null);
  assert.equal(recommendedMachine([machine('s', { agents: [agent('Codex', true, false)] })]), null, 'none signed in');
  const rows = [studio, laptop, mini, cloud, down].map((m) => machineView(m, 'studio', 'studio'));
  assert.deepEqual(
    rows.map((r: any) => [r.machineId, r.status, r.note, r.isHome, r.isThisDevice]),
    [
      ['studio', 'online', null, true, false],
      ['laptop', 'online', 'Stops when the lid closes', false, true],
      ['mini', 'needs-update', null, false, false],
      ['cloud', 'not-set-up', 'Wakes when MoMo has work, stops when idle', false, false],
      ['down', 'offline', null, false, false],
    ],
  );
  assert.deepEqual(rows[0].agentsSignedIn, ['Claude Code']);
  assert.equal(rows[0].recommended, true);
  assert.equal(rows[1].recommended, false);
});

test('the agent problem: none installed, none signed in, or nothing wrong', () => {
  assert.equal(agentProblem(undefined), null);
  assert.deepEqual(agentProblem(machine('s', { agents: [agent('Claude Code', false, false), agent('Codex', false, false)] })), {
    kind: 'not-installed',
    agent: 'Claude Code',
    fix: { id: 'install-agent:s:claude', label: 'Install on s' },
  });
  assert.deepEqual(
    agentProblem(machine('s', { agents: [] })),
    { kind: 'not-installed', agent: '', fix: { id: 'install-agent:s:', label: 'Install on s' } },
    'no agent is named when the machine reports none',
  );
  assert.deepEqual(agentProblem(machine('s', { agents: [agent('Claude Code', false, false), agent('Codex', true, false)] })), {
    kind: 'signed-out',
    agent: 'Codex',
    fix: { id: 'sign-in-agent:s:codex', label: 'Sign in on s' },
  });
  assert.equal(agentProblem(machine('s')), null);
});

test('the home view: no home yet recommends a machine; each state of a home; a machine that is no longer home says where MoMo went', () => {
  const ms = [machine('studio'), machine('mac', { isThisDevice: true, stays: 'sleeps' })];
  const first = homeView({ status: { home: null }, heardAt: null, now: NOW, machines: ms });
  assert.deepEqual([first.state, first.machineName, first.movedAway, first.stateSince], [null, null, null, null]);
  assert.equal(first.machines.find((m: any) => m.recommended)?.machineId, 'studio');
  const running = homeView({ status: { home: kept() }, heardAt: NOW - 1000, now: NOW, machines: ms });
  assert.deepEqual(
    [running.state, running.machineName, running.stateSince, running.lastSeenAt, running.agentProblem],
    ['running', 'Studio', 10, 20, null],
  );
  assert.equal(
    running.machines.some((m: any) => m.recommended),
    false,
    'a home is not recommended against',
  );
  assert.equal(homeView({ status: { home: kept({ state: 'moving' }) }, heardAt: NOW, now: NOW, machines: ms }).state, 'moving');
  assert.equal(homeView({ status: { home: kept() }, heardAt: NOW - 10 * 60_000, now: NOW, machines: ms }).state, 'asleep');
  assert.equal(
    homeView({ status: null, heardAt: NOW, now: NOW, machines: ms }).state,
    null,
    'a Host that could not be asked says nothing of a home it is not shown to have',
  );
  assert.equal(
    homeView({ status: { home: kept() }, heardAt: NOW, now: NOW, machines: [machine('studio', { reachable: false })] }).state,
    'asleep',
  );
  assert.equal(
    homeView({ status: { home: kept() }, heardAt: NOW, now: NOW, machines: [machine('studio', { current: false })] }).state,
    'needs-update',
  );
  const signedOut = homeView({
    status: { home: kept() },
    heardAt: NOW,
    now: NOW,
    machines: [machine('studio', { agents: [agent('Claude Code', true, false)] })],
  });
  assert.deepEqual(
    [signedOut.state, signedOut.agentProblem],
    ['needs-sign-in', { kind: 'signed-out', agent: 'Claude Code', fix: { id: 'sign-in-agent:studio:claude', label: 'Sign in on studio' } }],
  );
  // the home's machine is not in the list (removed): named by the Host, asleep
  const gone = homeView({ status: { home: kept() }, heardAt: NOW, now: NOW, machines: [machine('other')] });
  assert.deepEqual([gone.state, gone.machineName], ['asleep', 'Studio']);
  // a former home
  const former = homeView({
    status: { home: kept({ homeId: null, state: 'none', name: '', movedTo: { name: 'Mac mini', homeId: 'mini', at: 5 } }) },
    heardAt: NOW,
    now: NOW,
    machines: ms,
  });
  assert.deepEqual([former.state, former.movedAway], [null, { machine: { machineId: 'mini', name: 'Mac mini' }, at: 5 }]);
  // the home's name when the machine list has none of that id
  assert.equal(
    homeView({ status: { home: kept({ name: '' }) }, heardAt: NOW, now: NOW, machines: [machine('studio')] }).machineName,
    'studio',
  );
  assert.equal(homeView({ status: { home: kept({ name: '' }) }, heardAt: NOW, now: NOW, machines: [] }).machineName, null);
});

test('a move view: the step, the real cause with where it failed, and an old machine that is offline', () => {
  const base = { moveId: 'move-0001', from: { machineId: 'studio', name: 'Studio' }, to: { machineId: 'mini', name: 'Mac mini' } };
  const running = { outcome: 'running', finishedAt: null };
  assert.deepEqual(moveView({ ...base, step: 'sealed' }), {
    ...base,
    ...running,
    step: 'sealed',
    failure: null,
    oldMachineOffline: false,
    reclaim: null,
  });
  assert.deepEqual(
    moveView({
      ...base,
      step: 'copied',
      result: { ok: false, step: 'copied', code: 'x', message: 'Mac mini stopped answering.', rolledBack: true },
    }),
    {
      ...base,
      outcome: 'failed',
      finishedAt: null,
      step: 'copied',
      failure: { cause: 'Mac mini stopped answering.', failedAt: 'copied' },
      oldMachineOffline: false,
      reclaim: null,
    },
  );
  // a failure that left the old home paused offers the owner's Reclaim, with the words shown before the tap
  assert.deepEqual(
    moveView({
      ...base,
      step: 'switching',
      result: { ok: false, step: 'switching', code: 'x', message: 'No answer.', rolledBack: false, uncertain: true },
    }).reclaim,
    {
      title: 'Run MoMo on Studio again?',
      body: 'The copy on Mac mini will be refused if it ever comes back. Anything it did there since the move began is not kept.',
      confirm: 'Run on Studio',
    },
  );
  assert.equal(
    moveView({ ...base, step: 'cleaning-up', result: { ok: true, oldHome: 'offline', leaseEpoch: 2, receipt: 'r', homeId: 'mini' } })
      .oldMachineOffline,
    true,
  );
  assert.equal(
    moveView({ ...base, step: 'cleaning-up', result: { ok: true, oldHome: 'cleared', leaseEpoch: 2, receipt: 'r', homeId: 'mini' } })
      .oldMachineOffline,
    false,
  );
  assert.equal(moveView({ ...base, step: 'nonsense' }).step, 'paused', 'an unknown step reads as the first');
  // how it ended, and when
  const ended = (result: any) => moveView({ ...base, step: 'cleaning-up', result, finishedAt: 99 });
  assert.deepEqual(
    [
      ended({ ok: true, oldHome: 'cleared', leaseEpoch: 2, receipt: 'r', homeId: 'mini' }).outcome,
      ended({ ok: true, oldHome: 'cleared', leaseEpoch: 2, receipt: 'r', homeId: 'mini' }).finishedAt,
    ],
    ['moved', 99],
  );
  assert.equal(
    ended({ ok: false, step: 'sealed', code: 'cancelled', message: 'You cancelled the move.', rolledBack: true }).outcome,
    'cancelled',
  );
  assert.equal(ended({ ok: false, step: 'sealed', code: 'x', message: 'no', rolledBack: true }).outcome, 'failed');
  assert.equal(
    moveView({ ...base, step: 'x', result: { ok: false, step: 'zzz', code: 'c', message: 'm', rolledBack: false } }).failure?.failedAt,
    'paused',
  );
});

test('delivery: what the home kept decides it; a doubt that cannot be asked stays a doubt; only a message never sent, or never got, may be offered again', () => {
  for (const l of ['accepted', 'completed', 'failed', 'cancelled', 'interrupted'] as const)
    for (const o of ['not-sent', 'sent-uncertain'] as const)
      assert.equal(deliveryOf({ outbox: o, ledger: l }), l, 'what the home kept is told as it is');
  assert.equal(deliveryOf({ outbox: 'not-sent', ledger: null }), 'queued');
  assert.equal(deliveryOf({ outbox: 'not-sent', ledger: 'unknown' }), 'queued');
  assert.equal(deliveryOf({ outbox: 'sent-uncertain', ledger: 'unknown' }), 'never-got-it');
  assert.equal(deliveryOf({ outbox: 'sent-uncertain', ledger: null }), 'not-sure');
  assert.deepEqual((['queued', 'accepted', 'never-got-it', 'not-sure'] as const).map(canResend), [true, false, true, false]);
});

test('the outbox: saved before it is sent, one send per chat at a time, never resent after a doubt, old ones dropped, in order', () => {
  let at = 1000;
  let kept: any[] = [];
  const box = createMomoOutbox({ store: { read: () => kept, write: (e: any[]) => (kept = e) }, now: () => at });
  box.save({ turnId: 'key-00000001', chatId: 'c1', text: 'one' });
  box.save({ turnId: 'key-00000001', chatId: 'c1', text: 'again' });
  at += 1;
  box.save({ turnId: 'key-00000002', chatId: 'c1', text: 'two' });
  box.save({ turnId: 'key-00000003', chatId: 'c2', text: 'three' });
  assert.equal(box.all().length, 3, 'the same turn id is saved once');
  assert.deepEqual(
    box.due().map((e: any) => e.turnId),
    ['key-00000001', 'key-00000003'],
    'one per chat, oldest first',
  );
  box.sending('key-00000001');
  assert.deepEqual(
    box.due().map((e: any) => e.turnId),
    ['key-00000003'],
    'a chat with a send in doubt sends nothing more',
  );
  box.settle('key-00000003');
  box.neverArrived('key-00000001');
  assert.deepEqual(
    box.due().map((e: any) => e.turnId),
    ['key-00000001'],
    'sent again under the same id: the home accepts one copy',
  );
  box.sending('key-00000001');
  box.settle('key-00000001');
  assert.deepEqual(
    box.due().map((e: any) => e.turnId),
    ['key-00000002'],
  );
  at += OUTBOX_MAX_AGE_MS;
  assert.deepEqual(
    box.due().map((e: any) => e.turnId),
    ['key-00000002'],
    'exactly a day old is still sent',
  );
  // a message sent and not confirmed is never dropped, however old: it stays until the person decides (S4)
  box.sending('key-00000002');
  at += 10 * OUTBOX_MAX_AGE_MS;
  assert.deepEqual(box.due(), []);
  assert.deepEqual(
    box.all().map((e: any) => [e.turnId, e.delivery]),
    [['key-00000002', 'sent-uncertain']],
  );
  // one never sent that is over a day old is not sent late, and it is not dropped: it stays until the person decides
  box.save({ turnId: 'key-00000020', chatId: 'c9', text: 'old' });
  at += OUTBOX_MAX_AGE_MS + 1;
  assert.deepEqual(box.due(), []);
  assert.deepEqual(
    box.all().map((e: any) => e.turnId),
    ['key-00000002', 'key-00000020'],
  );
});

test('a receiver refuses a stamp older than the newest lease it has seen, a second claimant of one lease, and anything that is not a stamp (S1)', () => {
  let kept: any = null;
  const sink = createStampSink({ read: () => kept, write: (n: any) => (kept = n) });
  assert.equal(sink.newest(), null);
  assert.deepEqual(sink.accept({ homeId: 'studio', leaseEpoch: 1 }), { ok: true });
  assert.deepEqual(sink.accept({ homeId: 'studio', leaseEpoch: 1 }), { ok: true }, 'the same lease again');
  // the move: the new home's stamp is taken and remembered, and the old home's late push is refused after it
  assert.deepEqual(sink.accept({ homeId: 'mini', leaseEpoch: 2 }), { ok: true });
  assert.deepEqual(kept, { homeId: 'mini', leaseEpoch: 2 });
  assert.deepEqual(sink.accept({ homeId: 'studio', leaseEpoch: 1 }), {
    ok: false,
    reason: 'stale',
    newest: { homeId: 'mini', leaseEpoch: 2 },
  });
  assert.deepEqual(sink.accept({ homeId: 'studio', leaseEpoch: 2 }), {
    ok: false,
    reason: 'two-homes',
    newest: { homeId: 'mini', leaseEpoch: 2 },
  });
  for (const bad of [
    null,
    undefined,
    5,
    {},
    { homeId: '', leaseEpoch: 3 },
    { homeId: 'mini', leaseEpoch: 0 },
    { homeId: 'mini', leaseEpoch: 1.5 },
    { homeId: 7, leaseEpoch: 3 },
  ])
    assert.equal((sink.accept(bad) as any).reason, 'not-a-stamp', JSON.stringify(bad));
  assert.deepEqual(kept, { homeId: 'mini', leaseEpoch: 2 }, 'refused stamps change nothing');
});

test('the home view does not believe a Host that claims to be the home at an older lease than the newest seen (S1)', () => {
  let kept: any = null;
  const sink = createStampSink({ read: () => kept, write: (n: any) => (kept = n) });
  const ms = [machine('studio'), machine('mini')];
  const at = (homeId: string, leaseEpoch: number) =>
    homeView({ status: { home: kept_(homeId, leaseEpoch) }, heardAt: NOW, now: NOW, machines: ms, sink });
  const kept_ = (homeId: string, leaseEpoch: number): any => ({
    homeId,
    leaseEpoch,
    state: 'running',
    stateSince: 1,
    lastSeenAt: 2,
    name: homeId,
  });
  assert.equal(at('studio', 1).state, 'running');
  assert.equal(at('mini', 2).state, 'running');
  // the old home answers late, still sure it is the home: not believed
  assert.equal(at('studio', 1).state, 'asleep');
  // no sink, or a status with no lease, is as before
  assert.equal(homeView({ status: { home: kept_('studio', 1) }, heardAt: NOW, now: NOW, machines: ms }).state, 'running');
  assert.equal(
    homeView({ status: { home: { ...kept_('studio', 1), leaseEpoch: undefined } }, heardAt: NOW, now: NOW, machines: ms, sink }).state,
    'running',
  );
});
