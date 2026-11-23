// MoMo's home on the Mac↔phone channel: momo.home.view and momo.home.intent answer from the home API main holds and the momo.home.changed event reaches every paired phone with the fresh view; all of it is absent (an unknown request, no hello field) unless MoMo is allowed for the account and the `momo.home` flag is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';
import { waitFor } from './support/waitFor.ts';
import { createHomeApi } from '../shared/momoHomeApi.mjs';
import { createFakeHome } from '../shared/momoHomeFake.mjs';

const api = () => {
  let state = 'asleep';
  const home = createHomeApi({ compose: async () => ({ home: { state } }), intents: { wake: () => void (state = 'running') } });
  return home;
};
/** The service option the app gives (app/homeChannel.cjs): the API, the flag, and its changes. */
const channel = (home: any, on = true) => ({
  api: () => home,
  flagOn: () => on,
  on: (fn: (p: object) => void) => home?.onChanged?.(fn) ?? (() => undefined),
});
const hello = async (phone: any) => (await phone.ask('machine.hello')).result.capabilities;

test('with MoMo allowed and the flag on a phone reads the view, sends an intent and every phone hears the change', async () => {
  const home = api();
  const r = rig({ momo: true, momoHome: channel(home) });
  const a = r.phone('p1');
  const b = r.phone('p2');
  const caps = await hello(a);
  assert.equal(caps.momoHome, true);
  assert.ok(caps.methods.includes('momo.home.view') && caps.methods.includes('momo.home.intent'));
  const view = await a.ask('momo.home.view');
  assert.equal(view.ok, true);
  assert.equal(view.result.view.home.state, 'asleep');
  const done = await a.ask('momo.home.intent', { intent: { kind: 'wake' } });
  assert.equal(done.result.ok, true);
  assert.equal(done.result.view.home.state, 'running');
  for (const p of [a, b]) {
    const told = p.events('momo.home.changed');
    assert.equal(told.length, 1);
    assert.equal(told[0].view.home.state, 'running');
  }
  const refused = await a.ask('momo.home.intent', { intent: { kind: 'no-such' } });
  assert.equal(refused.result.ok, false);
});

test('a bad intent is refused before the home sees it', async () => {
  let called = 0;
  const r = rig({
    momo: true,
    momoHome: channel({ view: async () => ({}), intent: async () => void (called += 1) }),
  });
  const p = r.phone('p1');
  for (const intent of [null, 'wake', ['wake'], {}, { kind: 3 }, { kind: 'x', pad: 'y'.repeat(17_000) }]) {
    const answer = await p.ask('momo.home.intent', { intent });
    assert.equal(answer.ok, false, JSON.stringify(intent)?.slice(0, 30));
  }
  assert.equal(called, 0);
});

test('with the flag off, or MoMo not allowed, the methods are unknown, the hello has no field and no event is sent', async () => {
  for (const o of [
    { momo: true, momoHome: channel(api(), false) },
    { momo: false, momoHome: channel(api(), true) },
  ]) {
    const r = rig(o);
    const p = r.phone('p1');
    const caps = await hello(p);
    assert.equal('momoHome' in caps, false);
    assert.ok(!caps.methods.some((m: string) => m.startsWith('momo.home.')));
    for (const method of ['momo.home.view', 'momo.home.intent']) {
      const answer = await p.ask(method, method.endsWith('intent') ? { intent: { kind: 'wake' } } : {});
      assert.equal(answer.ok, false);
      assert.match(answer.error.message, /^Unknown request: momo\.home\./);
    }
    r.service.onMomoHomeChanged({ view: {} });
    assert.equal(p.events('momo.home.changed').length, 0);
  }
});

test('a home not made yet is answered as not available, never as a crash', async () => {
  const r = rig({ momo: true, momoHome: channel(null) });
  const answer = await r.phone('p1').ask('momo.home.view');
  assert.equal(answer.ok, false);
  assert.match(answer.error.message, /isn’t available here yet/);
});

test('a phone’s Google steps are relayed to the home’s Host as host.momoGoogle and nothing else, and only while the home is offered', async () => {
  const calls: any[] = [];
  const home: any = {
    view: async () => ({}),
    intent: async () => ({}),
    hostCall: async (method: string, params: object) => (calls.push([method, params]), { uri: 'com.x:/cb' }),
  };
  const on = rig({ momo: true, momoHome: channel(home) });
  const p = on.phone('p1');
  const answer = await p.ask('momo.home.google', { op: 'iosRedirect' });
  assert.deepEqual([answer.ok, answer.result], [true, { uri: 'com.x:/cb' }]);
  assert.deepEqual(calls, [['host.momoGoogle', { op: 'iosRedirect' }]]);
  // a chat the phone names is dropped before the Host sees the step
  await p.ask('momo.home.google', { op: 'status', chatId: 'c1', channelId: 'ch_1' } as any);
  assert.deepEqual(calls.at(-1), ['host.momoGoogle', { op: 'status' }]);
  calls.pop();
  for (const bad of [{}, { op: '' }, { op: 3 }, { op: 'x'.repeat(41) }, { op: 'status', pad: 'y'.repeat(65_000) }])
    assert.equal((await p.ask('momo.home.google', bad as any)).ok, false, JSON.stringify(bad).slice(0, 30));
  assert.equal(calls.length, 1, 'a bad step never reaches the Host');
  // the home refusing in words reaches the phone as those words, anything else as it is
  const refusing: any = {
    view: async () => ({}),
    intent: async () => ({}),
    hostCall: async () => Promise.reject(Object.assign(new Error('MoMo isn’t running anywhere right now.'), { name: 'IntentError' })),
  };
  const refused = await rig({ momo: true, momoHome: channel(refusing) })
    .phone('p1')
    .ask('momo.home.google', { op: 'status' });
  assert.deepEqual([refused.ok, refused.error.message], [false, 'MoMo isn’t running anywhere right now.']);
  const failing: any = {
    view: async () => ({}),
    intent: async () => ({}),
    hostCall: async () => Promise.reject(new Error('the Host went away')),
  };
  const failed = await rig({ momo: true, momoHome: channel(failing) })
    .phone('p1')
    .ask('momo.home.google', { op: 'status' });
  assert.equal(failed.ok, false, 'any other error is not turned into the home’s words');
  const noCall = rig({ momo: true, momoHome: channel({ view: async () => ({}), intent: async () => ({}) }) });
  assert.match((await noCall.phone('p1').ask('momo.home.google', { op: 'status' })).error.message, /isn’t available here yet/);
  const off = rig({ momo: true, momoHome: channel(home, false) });
  assert.match((await off.phone('p1').ask('momo.home.google', { op: 'status' })).error.message, /^Unknown request: momo\.home\./);
});

test('every state a move reaches is told to the phone: the cancel’s own answer, and the cancelled state when the move ends', async () => {
  const fake = createFakeHome({ scenario: 'moving', stepMs: 5 });
  const r = rig({ momo: true, momoHome: channel(fake.api) });
  const p = r.phone('p1');
  await p.ask('machine.hello');
  await waitFor(async () => ((await fake.api.view()) as any).view.home.move?.step === 'sealed', 'the move to be held at sealed');
  const answer = await p.ask('momo.home.intent', { intent: { kind: 'move-cancel' } });
  // the answer and its event are the view as it was when the cancel was taken: the held step has not ended yet
  assert.deepEqual([answer.result.ok, answer.result.view.home.move.outcome], [true, 'running']);
  fake.release();
  await waitFor(() => p.events('momo.home.changed').some((e: any) => e.view.home.move?.outcome === 'cancelled'), 'the cancelled event');
  const outcomes = p.events('momo.home.changed').map((e: any) => e.view.home.move?.outcome);
  assert.equal(outcomes.at(-1), 'cancelled', `the events ended at ${JSON.stringify(outcomes)}`);
  assert.ok(outcomes.includes('running'), 'and the earlier ones were told too');
});

test('a phone this Mac does not let read the view does not hear its changes', async () => {
  const fake = createFakeHome({ scenario: 'running', stepMs: 5 });
  const r = rig({
    momo: true,
    momoHome: channel(fake.api),
    policy: { allow: (pair: string, method: string) => !(pair === 'p2' && method.startsWith('momo.home.')) },
  });
  const a = r.phone('p1');
  const b = r.phone('p2');
  await a.ask('machine.hello');
  await b.ask('machine.hello');
  const answer = await b.ask('momo.home.view');
  assert.equal(answer.ok, false, 'the phone that may not read it is refused');
  await a.ask('momo.home.intent', { intent: { kind: 'move', toId: 'mac' } });
  await waitFor(() => a.events('momo.home.changed').length > 0, 'the allowed phone to hear the change');
  assert.equal(b.events('momo.home.changed').length, 0, 'the other heard nothing');
});

test('the app’s own home channel: the home API slot, the flag (off unless set) and the change hook; and a service detaches with or without a home', async () => {
  const { createRequire } = await import('node:module');
  const { homeChannel } = createRequire(import.meta.url)('../electron/app/homeChannel.cjs');
  const { momoHome } = homeChannel();
  assert.deepEqual(Object.keys(momoHome).sort(), ['api', 'flagOn', 'on']);
  assert.equal(typeof momoHome.api, 'function');
  assert.equal(momoHome.flagOn(), false, 'the flag is off until the owner turns it on');
  const withHome = rig({ momo: true, momoHome: channel(createFakeHome({ stepMs: 0 }).api) });
  withHome.service.detach();
  withHome.service.detach();
  const without = rig({});
  without.service.detach();
  assert.equal(without.service.stopHome, null);
});
