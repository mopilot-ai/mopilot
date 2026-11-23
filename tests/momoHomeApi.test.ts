// The method set both clients call for MoMo's home (shared/momoHomeApi.mjs), the move runner a screen drives (shared/momoMoveRunner.mjs) and the scripted home the clients check against (shared/momoHomeFake.mjs).
import { test } from 'node:test';
import { waitFor } from './support/waitFor.ts';
import type { MomoView } from '../shared/momoView.ts';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createHomeApi, IntentError, VIEW_METHOD, INTENT_METHOD, CHANGED_EVENT } from '../shared/momoHomeApi.mjs';
// @ts-ignore
import { createMoveRunner, cancellable } from '../shared/momoMoveRunner.mjs';
// @ts-ignore
import { createFakeHome, SCENARIOS } from '../shared/momoHomeFake.mjs';

const fakeHome = (o: object = {}): any => createFakeHome(o);
const homeApi = (o: any): any => createHomeApi(o);

const home = (over: object = {}): any => ({
  state: 'running',
  machineName: 'Studio',
  stateSince: 1,
  lastSeenAt: 2,
  move: null,
  agentProblem: null,
  machines: [],
  sources: [],
  movedAway: null,
  homeMachineId: 'studio',
  leaseEpoch: 1,
  update: null,
  ...over,
});
const until = async (fn: () => boolean) => void (await waitFor(fn, 'the condition'));

test('the names the clients agreed on are the ones served', () => {
  assert.deepEqual([VIEW_METHOD, INTENT_METHOD, CHANGED_EVENT], ['momo.home.view', 'momo.home.intent', 'momo.home.changed']);
  const api = homeApi({ compose: async () => ({ home: home() }) });
  assert.deepEqual(Object.keys(api.methods).sort(), ['momo.home.intent', 'momo.home.view']);
});

test('the view is the whole MomoView: the home part, the other lanes’ parts over defaults, the first-run choice when there is no home, and where MoMo went', async () => {
  const api = homeApi({ compose: async () => ({ home: home(), rest: { chat: [{ kind: 'user' }], settings: { dailyCap: 3 } } }) });
  const { view, movedAwayTo } = await api.methods['momo.home.view']({});
  assert.deepEqual(
    [view.home.state, view.home.machineName, view.chat.length, view.settings.dailyCap, movedAwayTo],
    ['running', 'Studio', 1, 3, undefined],
  );
  assert.deepEqual([view.setup.step, view.tasks, view.notes, view.rules, view.signals], ['done', [], [], [], []]);
  assert.equal(view.home.movedAway, null);
  assert.deepEqual([view.problems, view.home.homeMachineId, view.home.leaseEpoch], [[], 'studio', 1]);
  // no home yet: the choice is the setup's first step, and the state is a valid one for a client that reads it
  const first = await homeApi({ compose: async () => ({ home: home({ state: null, machineName: null }) }) }).view();
  assert.deepEqual([first.view.setup.step, first.view.home.state, first.view.home.machineName], ['where', 'asleep', null]);
  const withSetup = await homeApi({
    compose: async () => ({ home: home({ state: null }), rest: { setup: { google: 'waiting' } } }),
  }).view();
  assert.deepEqual([withSetup.view.setup.step, withSetup.view.setup.google], ['where', 'waiting']);
  // a machine that is no longer the home
  const gone = await homeApi({
    compose: async () => ({ home: home({ state: null, movedAway: { machine: { machineId: 'mini', name: 'Mac mini' }, at: 5 } }) }),
  }).view();
  assert.deepEqual(gone.movedAwayTo, { name: 'Mac mini', at: 5 });
});

test('an intent: unknown or missing kinds are refused in words, a handler’s refusal carries its fix, any other error reads as a person would, and success answers with the fresh view', async () => {
  let n = 0;
  const api = homeApi({
    compose: async () => ({ home: home({ stateSince: ++n }) }),
    intents: {
      wake: () => undefined,
      update: () => {
        throw new IntentError('MoPilot on Mac mini is out of date.', {
          fix: { kind: 'update-machine', machineId: 'mini' },
          fixLabel: 'Update Mac mini',
        });
      },
      bare: () => {
        throw new IntentError('No fix for this.');
      },
      broken: () => {
        throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.2:22'), { code: 'ECONNREFUSED' });
      },
    },
  });
  assert.deepEqual(await api.intent({ kind: 'nope' }), { ok: false, cause: 'MoMo can’t do that yet.' });
  assert.deepEqual(await api.intent({}), { ok: false, cause: 'That is not something MoMo can do.' });
  assert.deepEqual(await api.intent(null), { ok: false, cause: 'That is not something MoMo can do.' });
  assert.deepEqual(await api.intent({ kind: 'toString' }), { ok: false, cause: 'MoMo can’t do that yet.' }, 'only own handlers run');
  const ok: any = await api.methods['momo.home.intent']({ intent: { kind: 'wake' } });
  assert.deepEqual([ok.ok, ok.view.home.stateSince], [true, 1]);
  assert.deepEqual(await api.intent({ kind: 'update' }), {
    ok: false,
    cause: 'MoPilot on Mac mini is out of date.',
    fix: { kind: 'update-machine', machineId: 'mini' },
    fixLabel: 'Update Mac mini',
  });
  assert.deepEqual(await api.intent({ kind: 'bare' }), { ok: false, cause: 'No fix for this.' });
  // something the person should be told though it worked: a notice that is text passes through, any other thing does not
  const told = homeApi({
    compose: async () => ({ home: home({ stateSince: 1 }) }),
    intents: { said: () => ({ notice: 'Disconnected here.' }), odd: () => ({ notice: 7 }), plain: () => 'x' },
  });
  assert.equal(((await told.intent({ kind: 'said' })) as any).notice, 'Disconnected here.');
  assert.equal('notice' in ((await told.intent({ kind: 'odd' })) as any), false);
  assert.equal('notice' in ((await told.intent({ kind: 'plain' })) as any), false);
  const broken: any = await api.intent({ kind: 'broken' });
  assert.equal(broken.ok, false);
  assert.doesNotMatch(broken.cause, /ECONNREFUSED|10\.0\.0\.2/, 'no raw system text');
});

test('changed tells every listener with the view, costs nothing with none, and one listener that throws does not stop the rest', async () => {
  let composed = 0;
  const api = homeApi({ compose: async () => (composed++, { home: home() }) });
  await api.changed();
  assert.equal(composed, 0);
  const seen: string[] = [];
  const off = api.onChanged(() => {
    throw new Error('screen gone');
  });
  api.onChanged((p: any) => seen.push(`${p.ev}:${p.view.home.state}`));
  await api.changed();
  assert.deepEqual(seen, ['momo.home.changed:running']);
  off();
});

test('the move runner: one move at a time, Cancel only until the switch, Retry or Stay after a failure, Got it after a finish', async () => {
  const log: string[] = [];
  const side = { call: async () => ({}), status: async () => ({ home: null }) };
  const machines: any = { a: { id: 'a', name: 'Studio', side }, b: { id: 'b', name: 'Mini', side } };
  let release: (r: any) => void = () => undefined;
  let stepOf: (s: string) => void = () => undefined;
  let current = 'a';
  const runner = createMoveRunner({
    home: () => ({ id: current, name: machines[current].name }),
    machine: (id: string) => machines[id] ?? null,
    newId: () => `move-${log.length + 1}`.padEnd(12, '0'),
    changed: () => log.push('changed'),
    run: (o: any) =>
      new Promise((r) => ((release = r), (stepOf = o.step), log.push(`run:${o.target.name}:${o.fromName}`), void o.cancelled)),
  });
  assert.equal(runner.view(), null);
  assert.deepEqual([runner.result(), runner.target()], [null, null]);
  for (const f of [() => runner.cancel(), () => runner.stay(), () => runner.acknowledge()]) assert.throws(f, IntentError);
  await assert.rejects(runner.retry(), IntentError);
  await assert.rejects(runner.start('zzz'), /not available/);
  await assert.rejects(runner.start('a'), /already lives on Studio/);
  await runner.start('b');
  assert.equal(log.includes('run:Mini:Studio'), true);
  assert.equal(runner.view()!.step, 'paused');
  await assert.rejects(runner.start('b'), /Another move/);
  stepOf('sealed');
  assert.equal(runner.view()!.step, 'sealed');
  assert.doesNotThrow(() => runner.cancel());
  stepOf('switching');
  assert.throws(() => runner.cancel(), /too late/);
  assert.deepEqual(
    [cancellable('paused'), cancellable('copied'), cancellable('switching'), cancellable('cleaning-up')],
    [true, true, false, false],
  );
  // it fails: the view says where, Retry runs it again to the same machine, Stay puts it away
  release({ ok: false, step: 'copied', code: 'x', message: 'Mini stopped answering.', rolledBack: true });
  await until(() => runner.view()!.failure !== null);
  assert.deepEqual([runner.view()!.failure, runner.view()!.step], [{ cause: 'Mini stopped answering.', failedAt: 'copied' }, 'copied']);
  assert.throws(() => runner.cancel(), /no move to cancel/);
  await runner.retry();
  assert.equal(runner.view()!.failure, null);
  release({ ok: false, step: 'paused', code: 'x', message: 'no', rolledBack: true });
  await until(() => runner.view()!.failure !== null);
  runner.stay();
  assert.equal(runner.view(), null);
  // a finish: the result and target are told, Got it clears
  await runner.start('b');
  release({ ok: true, oldHome: 'offline', leaseEpoch: 2 });
  await until(() => runner.result() !== null);
  assert.deepEqual([runner.target(), runner.view()!.oldMachineOffline], ['b', true]);
  await assert.rejects(runner.retry(), IntentError);
  assert.throws(() => runner.stay(), IntentError);
  runner.acknowledge();
  assert.equal(runner.view(), null);
  // no home to move from
  const none = createMoveRunner({ home: () => null, machine: () => null, newId: () => 'x', changed: () => undefined });
  await assert.rejects(none.start('b'), /no home/);
  // the home's own machine is not known to the app
  const lost = createMoveRunner({
    home: () => ({ id: 'q', name: 'Q' }),
    machine: (id: string) => (id === 'b' ? machines.b : null),
    newId: () => 'x',
    changed: () => undefined,
  });
  await assert.rejects(lost.start('b'), /no home/);
});

test('the scripted home shows every scenario the design draws, from the same view the real home gives', async () => {
  const want: Record<string, [string, string | null]> = {
    'first-run': ['asleep', null],
    running: ['running', 'Studio'],
    asleep: ['asleep', 'Studio'],
    'needs-update': ['needs-update', 'Studio'],
    'needs-sign-in': ['needs-sign-in', 'Studio'],
    'move-failed': ['running', 'Studio'],
    'move-old-offline': ['running', 'Studio'],
    'move-stuck': ['running', 'Studio'],
    'moved-away': ['asleep', null],
    'lost-connection': ['running', 'Studio'],
  };
  for (const name of SCENARIOS.filter((s: string) => s !== 'moving')) {
    const fake = fakeHome({ scenario: name, stepMs: 0 });
    const { view, movedAwayTo } = await fake.api.view();
    assert.deepEqual([view.home.state, view.home.machineName], want[name], name);
    assert.equal(!!movedAwayTo, name === 'moved-away');
    assert.equal(view.setup.step, name === 'first-run' || name === 'moved-away' ? 'where' : 'done', name);
  }
  assert.deepEqual(
    (await fakeHome({ scenario: 'first-run' }).api.view()).view.home.machines.find((m: any) => m.recommended)?.machineId,
    'studio',
  );
  assert.equal((await fakeHome({ scenario: 'asleep' }).api.view()).view.chat.at(-1).kind, 'waiting');
  assert.equal((await fakeHome({ scenario: 'needs-sign-in' }).api.view()).view.home.agentProblem.kind, 'signed-out');
  assert.equal((await fakeHome({ scenario: 'lost-connection' }).api.view()).view.chat[0].delivery, 'not-sure');
  assert.equal(fakeHome({ scenario: 'nonsense' as any }).api !== undefined, true, 'an unknown scenario is the running one');
});

test('the scripted fixes work: choose a home, wake, update, sign in, install, send and check a turn', async () => {
  const first = fakeHome({ scenario: 'first-run', stepMs: 0 });
  assert.equal((await first.api.intent({ kind: 'choose-home', machineId: 'zzz' })).ok, false);
  const chosen: any = await first.api.intent({ kind: 'choose-home', machineId: 'studio' });
  assert.deepEqual([chosen.ok, chosen.view.home.state, chosen.view.setup.step], [true, 'running', 'done']);
  const asleep = fakeHome({ scenario: 'asleep', stepMs: 0 });
  const sent: any = await asleep.api.intent({ kind: 'send', turnId: 'key-00000001', text: 'hi' });
  assert.equal(sent.view.chat.find((r: any) => r.id === 'key-00000001').delivery, 'queued');
  assert.equal((await asleep.api.intent({ kind: 'wake' })).view.chat.find((r: any) => r.id === 'key-00000001').delivery, 'accepted');
  assert.equal((await asleep.api.intent({ kind: 'wake' })).ok, false, 'nothing is asleep now');
  const running = fakeHome({ scenario: 'running', stepMs: 0 });
  const live: any = await running.api.intent({ kind: 'send', turnId: 'key-00000002', text: 'hi' });
  assert.equal(live.view.chat.find((r: any) => r.id === 'key-00000002').delivery, 'accepted');
  const lost = fakeHome({ scenario: 'lost-connection', stepMs: 0 });
  assert.equal((await lost.api.intent({ kind: 'check-turn', turnId: 'key-lost0001' })).view.chat[0].delivery, 'accepted');
  const update = fakeHome({ scenario: 'needs-update', stepMs: 0 });
  assert.equal((await update.api.intent({ kind: 'update-machine', machineId: 'studio' })).view.home.state, 'running');
  const signin = fakeHome({ scenario: 'needs-sign-in', stepMs: 0 });
  assert.equal((await signin.api.intent({ kind: 'sign-in-agent', agent: 'claude', machineId: 'studio' })).view.home.state, 'running');
  const install = fakeHome({ scenario: 'running', stepMs: 0 });
  const added: any = await install.api.intent({ kind: 'install-agent', agent: 'codex', machineId: 'mini' });
  assert.equal(added.view.home.machines.find((m: any) => m.machineId === 'mini').agentsSignedIn.length, 2);
  await install.api.intent({ kind: 'install-agent', agent: 'claude', machineId: 'cloud' });
});

/** The home part of a scripted home's view once `done` holds for it. */
async function homeWhen(fake: any, done: (home: any) => boolean) {
  for (let i = 0; i < 400; i++) {
    const { view } = await fake.api.view();
    if (done(view.home)) return view.home;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail('the scripted home did not get there in time');
}

test('the scripted moves: one that finishes and is acknowledged, one held at Sealed and cancelled, one that fails and is retried, one whose old machine is offline', async () => {
  const steps: string[] = [];
  const fake = fakeHome({ scenario: 'running', stepMs: 0 });
  fake.api.onChanged((p: any) => steps.push(p.view.home.move?.step ?? 'none'));
  assert.equal((await fake.api.intent({ kind: 'move', toId: 'mini' })).ok, true);
  const done = await homeWhen(fake, (h) => h.machineName === 'Mac mini' && h.move?.step === 'cleaning-up');
  assert.deepEqual([done.move.oldMachineOffline, done.move.failure], [false, null]);
  assert.deepEqual(steps.filter((e, i) => e !== steps[i - 1]).slice(0, 6), [
    'paused',
    'sealed',
    'copied',
    'switching',
    'resuming',
    'cleaning-up',
  ]);
  assert.equal((await fake.api.intent({ kind: 'move-ack' })).view.home.move, null);

  const held = fakeHome({ scenario: 'moving', stepMs: 0 });
  await homeWhen(held, (h) => h.move?.step === 'sealed');
  assert.equal((await held.api.view()).view.home.state, 'moving');
  assert.equal((await held.api.intent({ kind: 'move-cancel' })).ok, true);
  held.release();
  const cancelled = await homeWhen(held, (h) => !!h.move?.failure);
  assert.deepEqual([cancelled.move.failure.cause, cancelled.state], ['You cancelled the move.', 'running']);
  assert.equal((await held.api.intent({ kind: 'move-stay' })).view.home.move, null);

  const failed = fakeHome({ scenario: 'move-failed', stepMs: 0 });
  await failed.api.intent({ kind: 'move', toId: 'mini' });
  const bad = await homeWhen(failed, (h) => !!h.move?.failure);
  assert.deepEqual([bad.move.failure, bad.machineName], [{ cause: 'Mac mini stopped answering.', failedAt: 'copied' }, 'Studio']);
  assert.equal((await failed.api.intent({ kind: 'move-retry' })).ok, true);
  assert.equal((await homeWhen(failed, (h) => h.machineName === 'Mac mini')).machineName, 'Mac mini');

  const offline = fakeHome({ scenario: 'move-old-offline', stepMs: 0 });
  await offline.api.intent({ kind: 'move', toId: 'mini' });
  const away = await homeWhen(offline, (h) => !!h.move?.oldMachineOffline);
  assert.equal(away.machineName, 'Mac mini');

  // the scenario can be flipped under a screen that stays subscribed
  const flips: string[] = [];
  const flip = fakeHome({ scenario: 'running', stepMs: 0 });
  flip.api.onChanged((p: any) => flips.push(p.view.home.state));
  flip.scenario('asleep');
  await until(() => flips.length > 0);
  assert.equal(flips[0], 'asleep');
  flip.scenario('moving');
  flip.release();
});

test('a fix the view offered is sent back as { kind: fix, id } and runs the intent it names; an id that names nothing is refused', async () => {
  const fake = fakeHome({ scenario: 'needs-update', stepMs: 0 });
  const first = (await fake.api.view()).view.home;
  assert.deepEqual(first.update, { have: '0.9.1', need: '1.0.0' });
  assert.equal(first.state, 'needs-update');
  assert.equal((await fake.api.intent({ kind: 'fix', id: 'update-machine:studio' })).view.home.state, 'running');
  const out = fakeHome({ scenario: 'needs-sign-in', stepMs: 0 });
  const problem = (await out.api.view()).view.home.agentProblem;
  assert.deepEqual(problem.fix, { id: 'sign-in-agent:studio:claude', label: 'Sign in on Studio' });
  assert.equal((await out.api.intent({ kind: 'fix', id: problem.fix.id })).view.home.state, 'running');
  const install = fakeHome({ scenario: 'running', stepMs: 0 });
  assert.equal((await install.api.intent({ kind: 'fix', id: 'install-agent:mini:codex' })).ok, true);
  assert.equal((await install.api.intent({ kind: 'fix', id: 'install-agent:mini' })).ok, true, 'an agent left out is the Host’s to choose');
  for (const id of ['', 'nonsense', 'update-machine:', 'sign-in-agent:', 'zzz:studio'])
    assert.equal((await install.api.intent({ kind: 'fix', id })).ok, false, id);
  assert.equal((await install.api.intent({ kind: 'fix' })).ok, false);
  assert.equal((await install.api.intent({ kind: 'fix', id: 5 })).ok, false);
});

test('the scripted home is a MomoView of the contract: where MoMo went reaches the phone at the top level too, and every scenario’s view fits the type', async () => {
  const away = await fakeHome({ scenario: 'moved-away' }).api.view();
  assert.deepEqual([away.movedAwayTo.name, away.view.home.movedAway.machine], ['Studio', { machineId: 'studio', name: 'Studio' }]);
  for (const name of SCENARIOS) {
    const { view } = await fakeHome({ scenario: name, stepMs: 0 }).api.view();
    const checked: MomoView = view;
    // the fields of the contract's MomoHomeView and MomoView, no more and no fewer
    assert.deepEqual(
      Object.keys(checked.home).sort(),
      [
        'agentProblem',
        'homeMachineId',
        'lastSeenAt',
        'leaseEpoch',
        'machineName',
        'machines',
        'move',
        'movedAway',
        'sources',
        'state',
        'stateSince',
        'update',
      ],
      name,
    );
    assert.deepEqual(
      Object.keys(checked).sort(),
      ['chat', 'home', 'notes', 'problems', 'rules', 'settings', 'setup', 'signals', 'tasks'],
      name,
    );
    assert.ok(checked.home.machines.every((m) => typeof m.machineId === 'string' && !('id' in m)));
  }
});

test('a journey makes the next intent of a kind fail with its cause and fix, once, and the one after runs as before', async () => {
  const fake = fakeHome({ scenario: 'asleep', stepMs: 0 });
  fake.refuse('wake', 'Studio did not wake.', { kind: 'move', toId: 'mini' }, 'Move MoMo');
  assert.deepEqual(await fake.api.intent({ kind: 'wake' }), {
    ok: false,
    cause: 'Studio did not wake.',
    fix: { kind: 'move', toId: 'mini' },
    fixLabel: 'Move MoMo',
  });
  assert.equal((await fake.api.view()).view.home.state, 'asleep', 'the refused intent changed nothing');
  assert.equal((await fake.api.intent({ kind: 'wake' })).view.home.state, 'running');
  // a refusal with no fix is a cause only
  fake.refuse('move', 'Another move is under way.');
  assert.deepEqual(await fake.api.intent({ kind: 'move', toId: 'mini' }), { ok: false, cause: 'Another move is under way.' });
});

test('check-turn answers has, missing or unknown beside the view, and a resend under the same id is one turn (the seam the phone reads)', async () => {
  const { turnAnswer } = await import('../shared/momoHomeView.mjs' as any);
  assert.deepEqual(
    [
      turnAnswer({ ledger: 'accepted', homeRunning: true }),
      turnAnswer({ ledger: 'cancelled', homeRunning: true }),
      turnAnswer({ ledger: 'unknown', homeRunning: true }),
      turnAnswer({ ledger: 'unknown', homeRunning: false }),
      turnAnswer({ ledger: 'accepted', homeRunning: false }),
      turnAnswer({ ledger: null, homeRunning: true }),
    ],
    ['has', 'has', 'missing', 'unknown', 'unknown', 'unknown'],
    'has for any id the home kept (a reset keeps them as settled), missing when it has none, unknown when it cannot say',
  );
  const fake = fakeHome({ scenario: 'lost-connection', stepMs: 0 });
  // derived: the row the home has reads has; an id it does not have reads missing
  assert.equal((await fake.api.intent({ kind: 'check-turn', turnId: 'key-lost0001' })).turn, 'has');
  assert.equal((await fake.api.intent({ kind: 'check-turn', turnId: 'key-never001' })).turn, 'missing');
  // scripted: a journey makes the home answer each of the three
  for (const answer of ['has', 'missing', 'unknown'] as const) {
    fake.turnAnswer('key-lost0001', answer);
    const r: any = await fake.api.intent({ kind: 'check-turn', turnId: 'key-lost0001' });
    assert.deepEqual([r.ok, r.turn], [true, answer]);
    assert.equal(
      r.view.chat.find((x: any) => x.id === 'key-lost0001').delivery,
      { has: 'accepted', missing: 'never-got-it', unknown: 'not-sure' }[answer],
    );
  }
  // while the home sleeps it cannot say
  const asleep = fakeHome({ scenario: 'asleep', stepMs: 0 });
  assert.equal((await asleep.api.intent({ kind: 'check-turn', turnId: 'key-00000001' })).turn, 'unknown');
  // the same id sent again is one row
  const live = fakeHome({ scenario: 'running', stepMs: 0 });
  await live.api.intent({ kind: 'send', turnId: 'key-00000005', text: 'hi' });
  const again: any = await live.api.intent({ kind: 'send', turnId: 'key-00000005', text: 'hi' });
  assert.equal(again.view.chat.filter((x: any) => x.id === 'key-00000005').length, 1);
  // a result with no answer of its own carries no `turn`
  assert.equal('turn' in (await live.api.intent({ kind: 'send', turnId: 'key-00000006', text: 'x' })), false);
});

test('the owner’s Reclaim is one intent over one driver: the view offers the words, the target is asked first, and a switched target finishes the move instead', async () => {
  // [what the target says while the move fails, what it says when the owner taps Reclaim, the machine MoMo runs on after]
  for (const [during, at, machine] of [
    ['lost', 'lost', 'Studio'],
    ['unreachable', 'unreachable', 'Studio'],
    ['unreachable', 'switched', 'Mac mini'],
  ] as const) {
    const fake = fakeHome({ scenario: 'move-stuck', stepMs: 0 });
    fake.targetAnswer(during);
    assert.equal((await fake.api.intent({ kind: 'move', toId: 'mini' })).ok, true);
    const stuck = await homeWhen(fake, (h) => h.move?.outcome === 'failed');
    assert.deepEqual(stuck.move.reclaim, {
      title: 'Run MoMo on Studio again?',
      body: 'The copy on Mac mini will be refused if it ever comes back. Anything it did there since the move began is not kept.',
      confirm: 'Run on Studio',
    });
    fake.targetAnswer(at); // the target is asked first, and what it says now decides
    const done = await fake.api.intent({ kind: 'reclaim' });
    assert.equal(done.ok, true, `${during}/${at}: ${JSON.stringify(done)}`);
    assert.equal((await fake.api.view()).view.home.machineName, machine, `${during}/${at}`);
  }
  // nothing is stuck here and no move is named: refused in words
  const fake = fakeHome({ scenario: 'running', stepMs: 0 });
  const refused = await fake.api.intent({ kind: 'reclaim' });
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /name the move/);
});

test('an intent that succeeds tells every listener the fresh view (a second window, the phone), one that fails tells none, and a listener that throws changes nothing', async () => {
  let state = 'asleep';
  const api = createHomeApi({
    compose: async () => ({ home: { state } }),
    intents: {
      wake: () => void (state = 'running'),
      boom: () => {
        throw new Error('no');
      },
    },
  });
  const a: string[] = [];
  const b: string[] = [];
  api.onChanged((p: any) => a.push(`${p.ev}:${p.view.home.state}`));
  api.onChanged(() => {
    throw new Error('a screen failed');
  });
  api.onChanged((p: any) => b.push(p.view.home.state));
  const answer: any = await api.intent({ kind: 'wake' });
  assert.equal(answer.ok, true);
  assert.equal(answer.view.home.state, 'running');
  assert.deepEqual([a, b], [['momo.home.changed:running'], ['running']]);
  await api.intent({ kind: 'boom' });
  await api.intent({ kind: 'nothing-like-it' });
  assert.deepEqual([a.length, b.length], [1, 1]);
});

test('one rule reads whether the home is offered: a Mac hello’s capability, a Host hello’s feature, and nothing else', async () => {
  const { homeOffered, HOME_FEATURE } = await import('../shared/momoHomeHello.mjs');
  assert.equal(HOME_FEATURE, 'momoHome');
  assert.equal(homeOffered({ capabilities: { momoHome: true } }), true);
  assert.equal(homeOffered({ features: ['momo', 'momoHome'] }), true);
  for (const no of [
    null,
    undefined,
    {},
    { capabilities: {} },
    { capabilities: { momoHome: false } },
    { capabilities: { momoHome: 'yes' } },
    { features: ['momo'] },
    { features: { momoHome: true } },
    { features: 'momoHome' },
  ])
    assert.equal(homeOffered(no as any), false, JSON.stringify(no));
});
