// MoMo's home composed on the phone, over real in-process Hosts (their own handlers), beside the Mac's composition on the same Hosts: the phone alone reads and acts on the home; it remembers across a restart; and the Mac and the phone both fencing at once, in every order, leave one live home.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { A, B, world } from './support/momoHomeRealWorld.ts';
import { waitFor } from './support/waitFor.ts';
import {
  createPhoneHome,
  openPhoneHomeMemory,
  VIEW_METHOD,
  INTENT_METHOD,
  CHANGED_EVENT,
  crypto,
  sealedStore,
  phoneOn,
} from './support/phone/phoneHomeRig.ts';

test('the phone alone reads the home on a Host and acts on it, and what changed reaches its listener', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const p = await phoneOn(w);
  const heard: any[] = [];
  const stop = p.home.channel.onEvent((e: any) => heard.push(e));
  const read = (await p.home.channel.request(VIEW_METHOD, {})) as any;
  assert.equal(read.view.home.machineName, 'Studio');
  assert.equal(read.view.home.state, 'running');
  // the phone told every Host the account may see MoMo, and kept the lease it saw
  await waitFor(() => p.sent.some((x) => x.method === 'host.momoGrant'), 'the grant');
  await p.memory.settled();
  assert.ok(p.memory.seen.read() >= 1);
  const done = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'fix', id: 'check-again' } })) as any;
  assert.equal(done.ok, true);
  assert.ok(heard.some((e) => e.ev === CHANGED_EVENT && e.view));
  stop();
  await assert.rejects(p.home.channel.request('momo.nope', {}), /Unknown request: momo\.nope/);
  p.home.dispose();
});

test('Google steps go to the home’s Host as the Mac relays them', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  w.overrides.set('studio', (method) => (method === 'host.momoGoogle' ? { done: true } : undefined));
  const p = await phoneOn(w);
  assert.deepEqual(await p.home.channel.request('momo.home.google', { op: 'iosRedirect' }), { done: true });
  assert.ok(p.sent.some((x) => x.id === 'studio' && x.method === 'host.momoGoogle'));
  p.home.dispose();
});

test('after a restart with every Host out of reach the home is still known, asleep, and no second one is started', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const store = sealedStore();
  const first = await phoneOn(w, store);
  await first.home.channel.request(VIEW_METHOD, {});
  await first.memory.settled();
  first.home.dispose();
  const away = await phoneOn(w, store, () => false);
  const v = ((await away.home.channel.request(VIEW_METHOD, {})) as any).view;
  assert.equal(v.home.state, 'asleep');
  assert.equal(v.home.machineName, 'Studio');
  assert.notEqual(v.setup.step, 'where');
  assert.equal(
    away.sent.some((x) => x.method === 'host.momoHomeStart'),
    false,
  );
  away.home.dispose();
});

test('the Mac and the phone both fencing the same two live homes, in every order, leave one', async (t) => {
  const orders: [string, (w: any, p: any) => Promise<unknown>][] = [
    ['phone first', async (w, p) => (await p.home.refresh(), await w.real.refresh())],
    ['Mac first', async (w, p) => (await w.real.refresh(), await p.home.refresh())],
    ['at once', (w, p) => Promise.all([w.real.refresh(), p.home.refresh()])],
    ['at once, twice', (w, p) => Promise.all([w.real.refresh(), p.home.refresh(), p.home.refresh(), w.real.refresh()])],
  ];
  for (const [label, go] of orders) {
    const w = await world(t, { second: true });
    // two Hosts each running a home (a home that was started on a machine that was out of reach, then another one): the higher lease wins
    await w.a.home.start(A);
    await w.b!.home.start({ name: B.name, floor: 3 });
    const p = await phoneOn(w);
    await go(w, p);
    await go(w, p);
    const live = () => [w.a.home.status().home.state, w.b!.home.status().home.state].filter((s) => s === 'running' || s === 'moving');
    // the fencing steps run after the look answered: wait for them
    await waitFor(() => live().length === 1, `${label}: one live home`);
    const states = [w.a.home.status().home.state, w.b!.home.status().home.state];
    assert.equal(states.filter((s) => s === 'running' || s === 'moving').length, 1, `${label}: ${states.join(' / ')}`);
    // the one that lost kept its data: it is retired, never deleted
    assert.equal(w.a.home.status().home.state === 'running' ? w.b!.home.look().holds : w.a.home.look().holds, 'retired', label);
    p.home.dispose();
  }
});

test('with two live homes the phone fences nothing: no stand-down is sent, both homes stay as they are, and the owner is told it is the Mac’s to do', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  await w.b!.home.start({ name: B.name, floor: 3 });
  const p = await phoneOn(w);
  await p.home.refresh();
  const view = ((await p.home.channel.request(VIEW_METHOD, {})) as any).view;
  // a stand-down and a start are the Mac's: a phone-named lease is not something a Host can verify
  assert.equal(
    p.sent.some((x) => ['host.momoStandDown', 'host.momoHomeStart', 'host.momoMove', 'host.momoReset'].includes(x.method)),
    false,
  );
  assert.equal(w.a.home.status().home.state, 'running');
  assert.equal(w.b!.home.status().home.state, 'running');
  assert.match(JSON.stringify(view.problems), /Do this on your Mac\./);
  p.home.dispose();
});

/** A phone whose client re-reads the view on every event it hears, as the screens do: how many Host reads it makes while it sits there. */
async function sitsOn(w: any) {
  const p = await phoneOn(w);
  p.home.channel.onEvent(() => void p.home.channel.request(VIEW_METHOD, {}));
  await p.home.channel.request(VIEW_METHOD, {});
  const reads = () => p.sent.filter((x) => x.method === 'host.momoHomeLook').length;
  // it settles: the same steps are asked for once, said once, and the reads stop growing while the screen stays open
  await waitFor(async () => (await p.home.channel.request(VIEW_METHOD, {})) !== undefined && reads() > 0, 'the first reads');
  const quiet = async () => {
    const before = reads();
    await new Promise((r) => setTimeout(r, 120));
    return reads() === before;
  };
  await waitFor(quiet, 'the reads to stop growing');
  return { p, reads };
}

test('a phone that hands the rules’ steps to the Mac does not loop: with two live homes, and with no home, it settles once and its Host reads stop growing while the screen stays open', async (t) => {
  const two = await world(t, { second: true });
  await two.a.home.start(A);
  await two.b!.home.start({ name: B.name, floor: 3 });
  const live = await sitsOn(two);
  const stable = live.reads();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(live.reads(), stable, 'two live homes: no more reads');
  live.p.home.dispose();
  const none = await world(t, { second: true });
  const empty = await sitsOn(none);
  const steady = empty.reads();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(empty.reads(), steady, 'no home: no more reads');
  empty.p.home.dispose();
});

test('picking where MoMo lives is the Mac’s: a phone that has never heard, and one that knows where it lives, both say so and start nothing; the lease it learned is kept', async (t) => {
  const w = await world(t, { second: true });
  const only = await phoneOn(w, sealedStore(), () => true, ['mini']);
  const refused = (await only.home.channel.request(INTENT_METHOD, { intent: { kind: 'choose-home', machineId: 'mini' } })) as any;
  assert.deepEqual([refused.ok, refused.cause], [false, 'Do this on your Mac.']);
  assert.equal(
    only.sent.some((x) => x.method === 'host.momoHomeStart'),
    false,
  );
  assert.equal(w.b!.home.status().home?.state === 'running', false);
  only.home.dispose();
  const p = await phoneOn(w, sealedStore(), () => true, ['mini']);
  p.memory.learn({ machineId: 'macbook', homeId: 'home-macbook-0001', name: 'MacBook', leaseEpoch: 7 });
  assert.equal(p.memory.known(), true);
  const view = ((await p.home.channel.request(VIEW_METHOD, {})) as any).view;
  // the home it remembers is on a machine it cannot see: asleep, not a first run
  assert.equal(view.home.state, 'asleep');
  const picked = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'choose-home', machineId: 'mini' } })) as any;
  assert.equal(picked.ok, false);
  assert.equal(
    p.sent.some((x) => x.method === 'host.momoHomeStart'),
    false,
  );
  assert.equal(p.memory.seen.read(), 7);
  p.home.dispose();
});

test('what the phone kept and cannot read is said, nothing new is taken meanwhile, and deleting it makes the phone keep again', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  w.overrides.set('studio', (method) =>
    method === 'host.momoChat' ? { chatId: 'claude:c1', epoch: 7 } : method === 'chat.send' ? { sent: true } : undefined,
  );
  const store = sealedStore();
  store.s.value = 'damaged';
  const p = await phoneOn(w, store);
  assert.equal(p.memory.unreadable, true);
  const heard: any[] = [];
  p.home.channel.onEvent((e: any) => heard.push(e));
  const codes = async () => (((await p.home.channel.request(VIEW_METHOD, {})) as any).view.problems as any[]).map((x) => x.code);
  assert.ok((await codes()).includes('phone_memory_unreadable'));
  // a message is not taken: it would be lost on the next launch, and the cause is said with the one tap that fixes it
  const refused = (await p.home.channel.request(INTENT_METHOD, {
    intent: { kind: 'send', turnId: 'turn-bbbb-0001', text: 'hello' },
  })) as any;
  assert.equal(refused.ok, false);
  assert.match(refused.cause, /Can’t read what this phone kept\. Waiting messages are lost; new ones can’t be kept/);
  assert.deepEqual([refused.fix, refused.fixLabel], [{ kind: 'fix', id: 'discard-phone-memory' }, 'Delete it']);
  assert.deepEqual(p.memory.outbox.read(), []);
  // a change that the home tells carries the problem too, and the other intents' answers
  const check = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'fix', id: 'check-again' } })) as any;
  assert.ok(check.view.problems.some((x: any) => x.code === 'phone_memory_unreadable'));
  assert.ok(heard.every((e) => e.view.problems.some((x: any) => x.code === 'phone_memory_unreadable')));
  // the owner deletes it: the container is cleared, the problem is gone, and the phone keeps again
  const done = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'fix', id: 'discard-phone-memory' } })) as any;
  assert.equal(done.ok, true);
  assert.equal(
    done.view.problems.some((x: any) => x.code === 'phone_memory_unreadable'),
    false,
  );
  assert.equal(p.memory.unreadable, false);
  assert.equal(store.s.value, null);
  assert.equal(
    ((await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'send', turnId: 'turn-bbbb-0002', text: 'hello' } })) as any).ok,
    true,
  );
  await p.memory.settled();
  assert.deepEqual(
    p.memory.sent.read().map((e: { id: string }) => e.id),
    ['turn-bbbb-0002'],
  );
  assert.ok(store.s.value !== null);
  p.home.dispose();
});

test('the phone’s own view says so, claims no agent it has not read, and offers no fix of an agent problem', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const p = await phoneOn(w);
  const read = (await p.home.channel.request(VIEW_METHOD, {})) as any;
  assert.equal(read.phoneOwn, true);
  // agents not read yet (the fake sessions know none): no agent is named as signed in, and the home is not called signed out
  assert.deepEqual(
    read.view.home.machines.map((m: any) => m.agentsSignedIn),
    [[], []],
  );
  assert.equal(read.view.home.state, 'running');
  // once they are read, the names come back
  const sessions = { agents: (id: string) => (id === 'studio' ? [{ id: 'claude', label: 'Claude Code', state: 'ready' }] : null) };
  const q = await phoneOn(w, sealedStore(), () => true, undefined, sessions);
  const named = (((await q.home.channel.request(VIEW_METHOD, {})) as any).view.home.machines as any[]).map((m) => [
    m.machineId,
    m.agentsSignedIn,
  ]);
  assert.deepEqual(named, [
    ['studio', ['Claude Code']],
    ['mini', []],
  ]);
  p.home.dispose();
  q.home.dispose();
});

test('an agent problem read on the home keeps its words and loses the fix that is the Mac’s to run', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const signedOut = { agents: (id: string) => (id === 'studio' ? [{ id: 'claude', label: 'Claude Code', state: 'signin' }] : null) };
  const p = await phoneOn(w, sealedStore(), () => true, undefined, signedOut);
  const home = (((await p.home.channel.request(VIEW_METHOD, {})) as any).view as any).home;
  assert.equal(home.state, 'needs-sign-in');
  assert.equal(home.agentProblem.kind, 'signed-out');
  assert.equal(home.agentProblem.fix, null);
  p.home.dispose();
});

test('a machine that refuses the grant is said in the view with the one way on, and the view is clean again once it takes it', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const memory = await openPhoneHomeMemory({ store: sealedStore(), crypto, user: 'u1' });
  let allow = false;
  let tick: () => void = () => undefined;
  const home = createPhoneHome({
    sessions: {
      records: () => [{ machineId: 'studio', name: 'Studio' }],
      reachable: () => true,
      agents: () => null,
      session: async (id: string) => ({
        request: async (method: string, params: object = {}) => {
          if (method === 'host.momoGrant' && !allow) throw new Error('Unknown request: host.momoGrant');
          return w.asHost(id, method, params);
        },
      }),
    },
    account: () => 'a1',
    onChange: () => () => undefined,
    memory,
    newId: () => 'turn-0001-aaaa',
    now: () => w.clock.at,
    every: (fn: () => void) => ((tick = fn), () => undefined),
    report: () => undefined,
  });
  home.start();
  const refused = async () =>
    (((await home.channel.request(VIEW_METHOD, {})) as any).view.problems as any[]).find((x) => x.code === 'grant_refused');
  await waitFor(refused, 'the refusal to be said');
  const problem = await refused();
  assert.equal(problem.cause, 'Studio didn’t accept MoMo from this phone. Check again, or open MoPilot on your Mac.');
  assert.deepEqual(problem.fix, { id: 'check-again', label: 'Check again' });
  // it takes the grant at the next try (after its wait): the problem is gone
  allow = true;
  w.clock.at += 61_000;
  tick();
  await waitFor(async () => (await refused()) === undefined, 'the problem to go');
  home.dispose();
});

test('a message typed while the home is out of reach waits in the phone’s own sealed outbox, and goes once the home is back', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const accepted: object[] = [];
  w.overrides.set('studio', (method, params) => {
    if (method === 'host.momoChat') return { chatId: 'claude:c1', epoch: 7 };
    if (method === 'chat.send') return accepted.push(params), { sent: true };
    return undefined;
  });
  const store = sealedStore();
  let up = true;
  const first = await phoneOn(w, store, () => up);
  await first.home.channel.request(VIEW_METHOD, {});
  await first.memory.settled();
  first.home.dispose();
  // the Host is out of reach: the phone is opened again and knows only what it kept
  up = false;
  const p = await phoneOn(w, store, () => up);
  const asleep = (await p.home.channel.request(VIEW_METHOD, {})) as any;
  assert.equal(asleep.view.home.state, 'asleep');
  const turnId = 'turn-aaaa-0001';
  const queued = (await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'send', turnId, text: 'Remind me to call Dana' } })) as any;
  assert.equal(queued.ok, true);
  await p.memory.settled();
  assert.deepEqual(
    p.memory.outbox.read().map((e: any) => [e.turnId, e.text, e.delivery]),
    [[turnId, 'Remind me to call Dana', 'not-sent']],
  );
  assert.deepEqual(accepted, []);
  // what the phone kept is still there after it is killed and opened again
  p.home.dispose();
  const again = await phoneOn(w, store, () => up);
  assert.equal(again.memory.outbox.read().length, 1);
  // the home is back: the message goes, once, under its own id
  up = true;
  await again.home.refresh();
  await waitFor(() => accepted.length === 1, 'the message to be sent');
  assert.equal((accepted[0] as any).key, turnId);
  await waitFor(() => again.memory.outbox.read().length === 0, 'the outbox to be emptied');
  await again.home.refresh();
  assert.equal(accepted.length, 1, 'never sent twice');
  again.home.dispose();
});

test('with no clock given the home keeps its own grant timer and stops it when let go', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const memory = await openPhoneHomeMemory({ store: sealedStore(), crypto, user: 'u1' });
  const home = createPhoneHome({
    sessions: { records: () => [], reachable: () => true, agents: () => null, session: async () => ({ request: async () => ({}) }) },
    account: () => 'a1',
    onChange: () => () => undefined,
    memory,
    newId: () => 'turn-0001-aaaa',
  });
  assert.equal(typeof home.channel.request, 'function');
  await home.forget();
  home.dispose();
});

test('a composition that is made and not started listens to nothing, tells no Host and runs no timer; it starts once and stops for good', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const memory = await openPhoneHomeMemory({ store: sealedStore(), crypto, user: 'u1' });
  const calls: string[] = [];
  const listeners = new Set<() => void>();
  const timers: number[] = [];
  const stopped: number[] = [];
  const home = createPhoneHome({
    sessions: {
      records: () => [{ machineId: 'studio', name: 'Studio' }],
      reachable: () => true,
      agents: () => null,
      session: async (id: string) => ({
        request: async (method: string, params: object = {}) => (calls.push(method), w.asHost(id, method, params)),
      }),
    },
    account: () => 'a1',
    onChange: (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn)),
    memory,
    newId: () => 'turn-0001-aaaa',
    every: (_fn: () => void, ms: number) => (timers.push(ms), () => void stopped.push(ms)),
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual([calls, listeners.size, timers], [[], 0, []], 'nothing happens before start');
  home.start();
  home.start();
  await waitFor(() => calls.includes('host.momoGrant'), 'the grant to be sent');
  assert.deepEqual(timers.length, 1, 'one timer, however often it is started');
  assert.ok(listeners.size >= 1);
  home.dispose();
  home.dispose();
  assert.deepEqual([listeners.size, stopped.length], [0, 1]);
  // a home that was disposed does not run the steps it has still to run
  const asked = calls.length;
  await home.refresh().catch(() => undefined);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(calls.length >= asked);
});

test('a send and a stop carry the chat and the epoch host.momoChat answered, and a stop carries a key of its own', async (t) => {
  const w = await world(t, { second: true });
  await w.a.home.start(A);
  const seen: { method: string; params: any }[] = [];
  w.overrides.set('studio', (method, params) => {
    if (method === 'host.momoChat') return { chatId: 'claude:c9', epoch: 41 };
    if (method === 'chat.send' || method === 'chat.stop') return seen.push({ method, params }), { sent: true };
    return undefined;
  });
  const p = await phoneOn(w);
  assert.equal(
    ((await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'send', turnId: 'turn-epoch-0001', text: 'hello' } })) as any).ok,
    true,
  );
  assert.equal(
    ((await p.home.channel.request(INTENT_METHOD, { intent: { kind: 'stop-turn', turnId: 'turn-epoch-0001' } })) as any).ok,
    true,
  );
  const [send, stop] = seen;
  assert.deepEqual(
    [send.method, send.params.chatId, send.params.epoch, send.params.key],
    ['chat.send', 'claude:c9', 41, 'turn-epoch-0001'],
  );
  assert.deepEqual(
    [stop.method, stop.params.chatId, stop.params.epoch, stop.params.turnId],
    ['chat.stop', 'claude:c9', 41, 'turn-epoch-0001'],
  );
  assert.match(stop.params.key, /^stop-/);
  // the phone's Host session has said hello before any of it (the session negotiates the protocol when it opens), so neither call is refused for lacking one
  p.home.dispose();
});
