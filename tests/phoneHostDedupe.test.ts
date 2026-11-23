// The phone's direct sessions with its Hosts (shared/remote/phoneHosts.mjs): the cards a Host lists replace the last list, an answer is
// sent once per tap and settled by the Host's own reply, and a card the Mac also delivered is one card (I1, A1, A5, B3 of package P3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { systemClock } from '../shared/remote/phoneHosts.mjs';
import { failureState, answeredState, cardId } from '../mobile/src/remote/hostCards';
import { waitFor } from './support/waitFor.ts';
import { CARD, HOST_KEY, rig } from './support/phone/host-rig.ts';
import { REPLACED } from '../shared/remote/phoneHost.mjs';

test('the Host lists its waiting cards and the latest list wins; a Mac copy of the same card is one card', async () => {
  const r = rig();
  await r.phones.load();
  assert.equal(r.phones.enrolled('ssh:box'), true);
  assert.equal(r.phones.hostKeyOf('ssh:box'), HOST_KEY);
  assert.equal(await r.settle(r.phones.refresh('ssh:box')), true);
  assert.deepEqual(
    r.cards.list(HOST_KEY).map((c) => c.card.requestId),
    ['r1'],
  );
  assert.equal(r.phones.supportsCards('ssh:box'), true);
  r.cards.addMac(HOST_KEY, CARD as any);
  assert.equal(r.cards.list().length, 1);
  assert.equal(await r.settle(r.phones.refresh('ssh:box')), true);
  assert.equal(r.seen.filter((m) => m.method === 'host.auth').length, 1, 'the open session is used again');
});

test('a read already on its way is the answer to a second one, and the next read starts afresh', async () => {
  const r = rig();
  await r.phones.load();
  const first = r.phones.refresh('ssh:box');
  const second = r.phones.refresh('ssh:box');
  assert.equal(first, second, 'one read for both');
  assert.equal(await r.settle(first), true);
  assert.equal(r.seen.filter((m) => m.method === 'host.pending').length, 1);
  assert.equal(await r.settle(r.phones.refresh('ssh:box')), true);
  assert.equal(r.seen.filter((m) => m.method === 'host.pending').length, 2, 'a read after it asks again');
});

test('a Host that is not enrolled, cannot be read or lacks approvals2 leaves the cards as they were', async () => {
  const none = rig();
  await none.phones.load();
  assert.equal(await none.phones.refresh('nope'), false);
  assert.equal(none.phones.hostKeyOf('nope'), null);
  assert.equal(none.phones.supportsCards('nope'), false);
  const old = rig({ features: ['epoch', 'dedupe'] });
  await old.phones.load();
  assert.equal(await old.settle(old.phones.refresh('ssh:box')), false);
  assert.equal(old.cards.list().length, 0);
  const bad = rig({ pending: () => ({ result: null }) });
  await bad.phones.load();
  bad.cards.setPending(HOST_KEY, [CARD as any]);
  assert.equal(await bad.settle(bad.phones.refresh('ssh:box')), true);
  assert.equal(bad.cards.list()[0].state.kind, 'waiting', 'a reply with no list says nothing: the card stays as it was');
  const failing = rig({ pending: () => ({ error: 'no', code: 'boom' }) });
  await failing.phones.load();
  assert.equal(await failing.settle(failing.phones.refresh('ssh:box')), false);
});

test('one tap sends one answer; the Host’s reply closes the card as answered here', async () => {
  const r = rig();
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  const id = cardId(HOST_KEY, 'c1', 'r1');
  await r.settle(r.phones.answer('ssh:box', 'build-box', id, 'a', failureState as any, (k: any) => answeredState(k, null)));
  assert.deepEqual(r.cards.list()[0].state, { kind: 'closed', line: 'Allowed' });
  const sent = r.seen.filter((m) => m.method === 'chat.answer');
  assert.equal(sent.length, 1);
  assert.deepEqual([sent[0].params.chatId, sent[0].params.epoch, sent[0].params.requestId, sent[0].params.optionId], ['c1', 2, 'r1', 'a']);
  assert.match(sent[0].params.key, /^phone-/);
  // a question's answer goes as the form, with no option (#4860)
  const asked = rig();
  await asked.phones.load();
  await asked.settle(asked.phones.refresh('ssh:box'));
  await asked.settle(
    asked.phones.answer('ssh:box', 'build-box', id, 'submit', failureState as any, (k: any) => answeredState(k, null), {
      action: 'accept',
      content: { lang: 'ts' },
    }),
  );
  const form = asked.seen.find((m) => m.method === 'chat.answer')!.params;
  assert.deepEqual([form.form, 'optionId' in form], [{ action: 'accept', content: { lang: 'ts' } }, false]);
  // an unknown card, or one of a machine with no enrollment, sends nothing
  await r.phones.answer('ssh:box', 'build-box', 'nope', 'a', failureState as any, (k: any) => answeredState(k, null));
  await r.phones.answer('other', 'x', id, 'a', failureState as any, (k: any) => answeredState(k, null));
  assert.equal(r.seen.filter((m) => m.method === 'chat.answer').length, 1);
});

test('a refusal is shown as the Host gave it, and a retry after an unreachable Host reuses the tap’s key', async () => {
  const r = rig({
    answer: (_m, n) => (n === 1 ? { error: 'x', code: 'card_answered', details: { by: { name: 'Work MacBook Pro' } } } : { result: {} }),
  });
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  const id = cardId(HOST_KEY, 'c1', 'r1');
  const failure = (e: any, m: string) => failureState({ code: e.code, details: e.details }, m);
  await r.settle(r.phones.answer('ssh:box', 'build-box', id, 'd', failure as any, (k: any) => answeredState(k, null)));
  assert.deepEqual(r.cards.list()[0].state, { kind: 'closed', line: 'Already answered on Work MacBook Pro.' });
  // an unreachable Host leaves the card to try again, and the retry is the same request
  let first = true;
  const t = rig({ answer: () => (first ? ('silent' as any) : { result: {} }) });
  await t.phones.load();
  await t.settle(t.phones.refresh('ssh:box'));
  const tap = t.phones.answer('ssh:box', 'build-box', id, 'a', failureState as any, (k: any) => answeredState(k, null));
  await waitFor(() => (t.pump(), t.seen.some((m) => m.method === 'chat.answer')), 'the answer to reach the Host');
  t.phones.background();
  await tap;
  assert.deepEqual(t.cards.list()[0].state, { kind: 'unreachable', optionId: 'a' });
  first = false;
  await t.settle(t.phones.answer('ssh:box', 'build-box', id, 'a', failureState as any, (k: any) => answeredState(k, null)));
  const keys = t.seen.filter((m) => m.method === 'chat.answer').map((m) => m.params.key);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.deepEqual(t.cards.list()[0].state, { kind: 'closed', line: 'Allowed' });
});

test('the app going to the background, a Host leaving the relay and a frame for no one end sessions quietly', async () => {
  const r = rig();
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  r.phones.handleFrame({ pair: 'p_unknown000', dir: 'p2m', ctr: 1, nonce: '', box: '' });
  r.phones.handleEvent({ ev: 'peer', pair: 'p_pair00001', online: true });
  r.phones.handleEvent({ ev: 'other' });
  r.phones.handleEvent({ ev: 'peer', pair: 'p_nobody0000', online: false });
  assert.equal(r.phones.supportsCards('ssh:box'), true);
  r.phones.handleEvent({ ev: 'peer', pair: 'p_pair00001', online: false });
  assert.equal(r.phones.supportsCards('ssh:box'), false);
  await r.settle(r.phones.refresh('ssh:box'));
  r.phones.background();
  assert.equal(r.connected(), false);
  assert.equal(r.phones.supportsCards('ssh:box'), false);
});

test('a session that ends tells the chats followed through it, and a new connect replacing it does not (#4858)', async () => {
  const r = rig();
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  assert.deepEqual(r.ended, []);
  // the Host leaves the relay, and the app goes to the background
  r.phones.handleEvent({ ev: 'peer', pair: 'p_pair00001', online: false });
  assert.deepEqual(r.ended, ['ssh:box']);
  await r.settle(r.phones.refresh('ssh:box'));
  r.phones.background();
  assert.deepEqual(r.ended, ['ssh:box', 'ssh:box']);
  // a connect that finds the session open replaces it: the chats followed on it were not left behind by that
  const session = await r.settle(r.phones.session('ssh:box'));
  session.close(REPLACED);
  assert.deepEqual(r.ended, ['ssh:box', 'ssh:box']);
});

test('direct access is set up through the Mac, kept, and given up again', async () => {
  const r = rig();
  r.stored(); // starts with one enrollment; set up another machine
  await r.phones.load();
  await r.settle(r.phones.setUp('ssh:other'));
  assert.equal(r.phones.setupState('ssh:other'), 'idle');
  assert.equal(r.phones.enrolled('ssh:other'), true);
  assert.deepEqual(
    r.requests.map((m) => m.t),
    ['host.register'],
  );
  assert.ok('ssh:other' in r.stored());
  assert.deepEqual(r.macCalls, [['enroll', 'ssh:other']]);
  await r.phones.forget('ssh:other');
  assert.equal(r.phones.enrolled('ssh:other'), false);
  assert.ok(!('ssh:other' in r.stored()));
  assert.deepEqual(
    r.requests.map((m) => m.t),
    ['host.register', 'host.revoke'],
  );
  assert.deepEqual(r.macCalls.at(-1), ['forget', 'ssh:other']);
  // forgetting what was never enrolled still ends cleanly
  await r.phones.forget('ssh:never');
  assert.ok(r.changes.length > 0);
});

test('a tap on an option the card does not list answers as other, and the Host’s events with no listener are ignored', async () => {
  const r = rig();
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  const id = cardId(HOST_KEY, 'c1', 'r1');
  let seenKind = '';
  await r.settle(
    r.phones.answer('ssh:box', 'build-box', id, 'zzz', failureState as any, (k: any) => ((seenKind = k), answeredState(k, null))),
  );
  assert.equal(seenKind, 'other');
  assert.deepEqual(r.cards.list()[0].state, { kind: 'closed', line: 'Answered' });
});

test('setting up twice at once is one set-up, and giving up while it runs discards its late reply on both ends', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const r = rig({ gate });
  await r.phones.load();
  const first = r.phones.setUp('ssh:new');
  await waitFor(() => r.macCalls.some((c) => c[0] === 'enroll'), 'the Mac to be asked');
  const second = r.phones.setUp('ssh:new');
  assert.equal(r.phones.setupState('ssh:new'), 'working');
  await r.phones.forget('ssh:new');
  release();
  await Promise.all([first, second]);
  assert.equal(r.phones.setupState('ssh:new'), 'idle', 'giving up leaves no failure to show');
  assert.equal(r.phones.enrolled('ssh:new'), false);
  assert.deepEqual(
    r.macCalls.filter((c) => c[0] === 'forget').map((c) => c[1]),
    ['ssh:new'],
  );
  assert.deepEqual(r.reachableOf('ssh:box'), null);
});

test('a set-up that cannot reach the relay says it failed, and giving up a machine with a live session ends the session', async () => {
  const down = rig({ laneFails: true });
  await down.phones.load();
  await down.phones.setUp('ssh:new');
  assert.equal(down.phones.setupState('ssh:new'), 'failed');
  const r = rig();
  await r.phones.load();
  await r.settle(r.phones.refresh('ssh:box'));
  assert.equal(r.phones.supportsCards('ssh:box'), true);
  await r.settle(r.phones.forget('ssh:box'));
  assert.equal(r.phones.supportsCards('ssh:box'), false);
  assert.equal(r.phones.enrolled('ssh:box'), false);
});

test('giving a path up says whether the relay and the Mac both took it, and the record goes either way', async () => {
  const ok = rig();
  await ok.phones.load();
  assert.deepEqual(await ok.phones.forget('ssh:box'), { complete: true });
  for (const o of [{ revokeFails: true }, { macForgetFails: true }]) {
    const r = rig(o);
    await r.phones.load();
    assert.deepEqual(await r.phones.forget('ssh:box'), { complete: false });
    assert.equal(r.phones.enrolled('ssh:box'), false);
  }
});

test('the open session of a machine is there for a chat to use, and a line the Host sends that is no answer reaches the listener with the machine', async () => {
  const r = rig();
  await r.phones.load();
  const session = await r.settle(r.phones.session('ssh:box'));
  assert.equal(session.state, 'open');
  r.hostWrite({ event: 'frame', chatId: 'c1', frame: { t: 'delta' } });
  await waitFor(() => (r.pump(), r.events.length === 1), 'the Host line');
  assert.deepEqual(r.events[0], ['ssh:box', { event: 'frame', chatId: 'c1', frame: { t: 'delta' } }]);
});

/** A clock a test turns by hand: the interval it was given runs when `tick` says so. */
function clock() {
  const t: any = { fn: null as null | (() => void), ms: 0, time: 0, started: 0, stopped: 0 };
  t.setInterval = (fn: () => void, ms: number) => ((t.fn = fn), (t.ms = ms), t.started++, 'id');
  t.clearInterval = () => ((t.fn = null), t.stopped++);
  t.now = () => t.time;
  t.tick = (by = 1000) => ((t.time += by), t.fn?.());
  return t;
}

test('a card another client answered turns to the line that says so within one tick of the watch, with the device that answered', async () => {
  const t = clock();
  let host: any = { result: { cards: [CARD], attention: [], closed: [] } };
  const r = rig({ timers: t, pending: () => host });
  await r.phones.load();
  const stop = r.phones.watch(1000);
  assert.equal(t.ms, 1000);
  await r.settle(r.phones.refresh('ssh:box'));
  assert.equal(r.cards.list()[0].state.kind, 'waiting');
  // another client answers it; the Host's list is now empty and says who
  host = { result: { cards: [], attention: [], closed: [{ chatId: 'c1', requestId: 'r1', by: { name: 'DUs-MacBook-Pro' } }] } };
  t.tick();
  await waitFor(() => (r.pump(), r.cards.list()[0].state.kind === 'closed'), 'the card to close');
  assert.deepEqual(r.cards.list()[0].state, { kind: 'closed', line: 'Already answered on DUs-MacBook-Pro.' });
  stop();
  assert.equal(t.fn, null);
});

test('the shortest wish of the screens that watch rules, and the clock stops with the last of them', async () => {
  const t = clock();
  const r = rig({ timers: t });
  await r.phones.load();
  assert.equal(t.fn, null, 'nothing runs while no screen watches');
  const slow = r.phones.watch(4000);
  const fast = r.phones.watch(1000);
  assert.equal(t.ms, 1000);
  fast();
  assert.equal(t.ms, 4000);
  slow();
  assert.equal(t.fn, null);
});

test('a read still on its way is not doubled, and a Host found down is tried again only after a pause', async () => {
  const t = clock();
  const r = rig({ timers: t, pending: () => ({ error: 'no', code: 'boom' }) });
  await r.phones.load();
  // found down before the watch began
  await r.settle(r.phones.refresh('ssh:box'));
  assert.equal(r.reachableOf('ssh:box'), false);
  // the watch's own reads, observed
  const tries: number[] = [];
  let finish: (() => void) | null = null;
  r.phones.refresh = (async () => {
    tries.push(t.time);
    await new Promise<void>((resolve) => (finish = resolve));
    return false;
  }) as any;
  const stop = r.phones.watch(1000);
  t.tick();
  assert.deepEqual(tries, [1000], 'its first tick tries a Host found down before it began');
  t.tick(1000);
  t.tick(1000);
  assert.deepEqual(tries, [1000], 'a read on its way is not doubled');
  finish!();
  await new Promise((resolve) => setTimeout(resolve, 10));
  t.tick(1000);
  t.tick(1000);
  assert.deepEqual(tries, [1000], 'and a Host that did not answer waits out the pause');
  t.tick(5000);
  assert.deepEqual(tries, [1000, 10_000]);
  finish!();
  stop();
});

test('with the real clock the watch reads the Host on its own, and its stop ends it', async () => {
  const r = rig();
  await r.phones.load();
  const stop = r.phones.watch(5);
  await waitFor(() => (r.pump(), r.cards.list().length === 1), 'the Host to be read by the watch itself');
  stop();
});

test("the system clock lets go of a Node timer and leaves a number alone (the phone's timers)", () => {
  const unrefs: string[] = [];
  const node = systemClock(() => ({ unref: () => void unrefs.push('node') }));
  assert.equal(typeof node.setInterval(() => undefined, 10), 'object');
  assert.deepEqual(unrefs, ['node']);
  assert.equal(
    systemClock(() => 7).setInterval(() => undefined, 10),
    7,
  );
  assert.equal(typeof systemClock().now(), 'number');
  const real = systemClock().setInterval(() => undefined, 1_000_000);
  systemClock().clearInterval(real);
});
