// Mobile Remote pairing (electron/remote/pairing.cjs, pairApproval.cjs) with a simulated phone over the real identity, device list and libsodium: the QR payload and its two-minute one-time code, the proof, the safety number both ends compute, the user's confirmation through the real ApprovalBroker, and every way out: expired, wrong proof, noise, declined, cancelled, replaced, a second phone, failed storage, re-pair and unpair.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../shared/remote/envelope.mjs';
import { prim } from './support/remoteKit.ts';
import { crypto, helloFor, helloWithText, makePhone, openReply, phoneEnds, phoneSafetyNumber } from './support/remotePhone.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { rig, states } from './support/remotePairingRig.ts';

const require = createRequire(import.meta.url);
const { PairingService, CODE_TTL_MS, CONFIRM_TTL_MS } = require('../electron/remote/pairing.cjs');

test('begin: the payload carries the relay, the Mac, its public key, a 32-byte code and a two-minute expiry', async () => {
  const r = rig();
  const { payload, qr, expiresAt } = await r.svc.begin();
  const id = await r.identity.get();
  assert.deepEqual(Object.keys(payload), ['v', 'relay', 'macId', 'macPub', 'macEdPub', 'macEphPub', 'code', 'exp']);
  assert.deepEqual([payload.v, payload.relay, payload.macId], [3, 'wss://relay.example/ws', id.macId]);
  assert.deepEqual(E.fromBase64(payload.macPub), id.x.pk);
  assert.equal(E.fromBase64(payload.code).length, 32);
  assert.equal(payload.exp, r.state.t + CODE_TTL_MS);
  assert.equal(expiresAt, payload.exp);
  assert.deepEqual(JSON.parse(qr), payload);
  assert.deepEqual(r.state.registered, [crypto.pairId(E.fromBase64(payload.code))]);
  assert.ok(!JSON.stringify(r.state.registered).includes(payload.code), 'the relay never gets the code');
  assert.deepEqual(states(r), ['waiting']);
  r.svc.cancel();
});

test('begin: a signed-in account adds a non-secret hint to the QR, and an old phone still pairs with it (#5320)', async () => {
  const r = rig({ account: () => ({ id: 'user-1', email: 'jane@gmail.com' }) });
  const { payload } = await r.svc.begin();
  assert.deepEqual(Object.keys(payload).slice(-2), ['acct', 'who']);
  assert.equal(payload.who, 'j***@gmail.com');
  assert.match(payload.acct, /^[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(payload).includes('user-1'), 'the user id itself is not in the QR');
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'paired', 'the hint is outside the pairing proof');
});

test('pairing: a phone that scanned the QR pairs, both ends show one safety number, and traffic flows in both directions', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const outcome = await r.svc.handleHello(helloFor(phone, payload));
  assert.equal(outcome, 'paired');
  assert.deepEqual(states(r), ['waiting', 'confirming', 'paired']);
  const shown = r.state.confirms[0];
  assert.equal(shown.safetyNumber, phoneSafetyNumber(phone, payload));
  assert.deepEqual(shown.device, { id: phone.id, name: phone.name });
  const reply = openReply(phone, payload, r.state.replies[0]);
  const ends = phoneEnds(phone, payload, reply);
  assert.deepEqual(reply, { v: 3, ok: true, pairId: ends.pair });
  assert.deepEqual(E.fromBase64(payload.macEdPub), (await r.identity.get()).ed.pk, 'the QR carries the Mac\u2019s Ed25519 key');
  assert.equal(E.fromBase64(payload.macEphPub).length, 32);
  const dev = r.devices.get(phone.id);
  assert.deepEqual([dev.name, dev.pairId, dev.pub, dev.edPub], [phone.name, ends.pair, E.toBase64(phone.pk), E.toBase64(phone.ed.pk)]);
  // the stored chains are the ones the phone derived: a frame from the phone opens with the Mac's rx chain
  const rx = crypto.createReceiver({ pair: dev.pairId, dir: 'p2m', chain: E.fromHex(dev.rx.chain) });
  assert.equal(E.fromUtf8(rx.open(ends.tx.seal(E.utf8('hi mac')))), 'hi mac');
  const tx = crypto.createSender({ pair: dev.pairId, dir: 'm2p', chain: E.fromHex(dev.tx.chain) });
  assert.equal(E.fromUtf8(ends.rx.open(tx.seal(E.utf8('hi phone')))), 'hi phone');
  assert.deepEqual(r.state.cancelled, [], 'a paired phone keeps its pair at the relay');
});

test('pairing: the code is spent by the first valid hello, so a replay or a second phone is ignored', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const first = helloFor(makePhone('phone-1'), payload);
  assert.equal(await r.svc.handleHello(first), 'paired');
  assert.equal(await r.svc.handleHello(first), 'ignored');
  assert.equal(await r.svc.handleHello(helloFor(makePhone('phone-2'), payload)), 'ignored');
  assert.equal(r.devices.list().length, 1);
});

test('pairing: a second hello while the user is still confirming is ignored and changes nothing', async () => {
  const gate = deferred<'allow'>();
  const r = rig({ confirm: () => gate.promise });
  const { payload } = await r.svc.begin();
  const one = r.svc.handleHello(helloFor(makePhone('phone-1'), payload));
  await tick();
  assert.equal(await r.svc.handleHello(helloFor(makePhone('phone-2'), payload)), 'ignored');
  await assert.rejects(r.svc.begin(), { code: 'busy' });
  gate.resolve('allow');
  assert.equal(await one, 'paired');
  assert.deepEqual(
    r.devices.list().map((d: any) => d.id),
    ['phone-1'],
  );
});

test('pairing: a wrong proof is rejected, answered, and spends the code', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, payload, { proof: new Uint8Array(32) })), 'rejected');
  assert.deepEqual(openReply(phone, payload, r.state.replies[0]), { ok: false, error: 'proof' });
  assert.deepEqual(states(r), ['waiting', 'rejected']);
  assert.equal(r.state.confirms.length, 0, 'the user is never asked');
  assert.equal(r.devices.list().length, 0);
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'ignored');
});

test('pairing: a malformed request inside a valid box is rejected', async () => {
  for (const request of [{ phoneId: 'x' }, { phoneId: 'has space!!' }, { edPub: 'AA==' }, { proof: 'AA==' }, { phoneId: 5 }]) {
    const r = rig();
    const { payload } = await r.svc.begin();
    assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload, { request })), 'rejected', JSON.stringify(request));
  }
  for (const text of ['not json', '{}']) {
    const r2 = rig();
    const p2 = (await r2.svc.begin()).payload;
    assert.equal(await r2.svc.handleHello(helloWithText(makePhone(), p2, text)), 'rejected');
  }
});

test('pairing: noise that was not sealed with the code is ignored and the pairing stays open', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const stranger = helloFor(phone, payload, { code: new Uint8Array(32).fill(7) });
  assert.equal(await r.svc.handleHello(stranger), 'ignored');
  assert.deepEqual(states(r), ['waiting']);
  assert.equal(r.state.replies.length, 0, 'a stranger gets no answer');
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'paired');
});

test('pairing: frames that are not a hello for the pending pair are ignored', async () => {
  const r = rig();
  const phone = makePhone();
  const ghost = { macId: 'mac_x', macPub: E.toBase64(phone.pk), code: E.toBase64(new Uint8Array(32)) };
  assert.equal(await r.svc.handleHello(helloFor(phone, ghost)), 'ignored', 'no pairing is pending');
  const { payload } = await r.svc.begin();
  const good = helloFor(phone, payload);
  for (const bad of [
    helloFor(phone, payload, { pair: 'p_anotherpair1' }),
    { ...good, dir: 'm2p' },
    { ...good, ctr: 1 },
    { ...good, box: good.box.slice(0, 32) },
    { ...good, box: new Uint8Array(0) },
  ])
    assert.equal(await r.svc.handleHello(bad), 'ignored');
  assert.equal(await r.svc.handleHello(good), 'paired');
});

test('pairing: a hello after the two minutes is answered "expired" and the code is gone', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  r.state.t += CODE_TTL_MS;
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'expired');
  assert.deepEqual(openReply(phone, payload, r.state.replies[0]), { ok: false, error: 'expired' });
  assert.deepEqual(states(r), ['waiting', 'expired']);
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'ignored');
  assert.equal(r.devices.list().length, 0);
});

test('pairing: the code expires on its own after two minutes and is withdrawn at the relay', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const r = rig();
    const { payload } = await r.svc.begin();
    mock.timers.tick(CODE_TTL_MS - 1);
    assert.deepEqual(states(r), ['waiting']);
    mock.timers.tick(1);
    assert.deepEqual(states(r), ['waiting', 'expired']);
    assert.equal(r.state.cancelled.length, 1);
    assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'ignored');
  } finally {
    mock.timers.reset();
  }
});

test('pairing: declining, no answer and a failing card all end as declined, with the phone told', async () => {
  for (const confirm of [async () => 'deny', async () => null, async () => Promise.reject(new Error('card broke'))]) {
    const r = rig({ confirm });
    const { payload } = await r.svc.begin();
    const phone = makePhone();
    assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'declined');
    assert.deepEqual(openReply(phone, payload, r.state.replies[0]), { ok: false, error: 'declined' });
    assert.deepEqual(states(r), ['waiting', 'confirming', 'declined']);
    assert.equal(r.devices.list().length, 0);
    assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'ignored', 'a declined pairing needs a new QR');
  }
});

test('pairing: closing the QR while the user is deciding withdraws the card and declines', async () => {
  let signal!: AbortSignal;
  const r = rig({
    confirm: (req: any) => {
      signal = req.signal;
      // a card withdrawn by the signal answers nothing
      return new Promise((resolve) => req.signal.addEventListener('abort', () => resolve(null)));
    },
  });
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const done = r.svc.handleHello(helloFor(phone, payload));
  await tick();
  r.svc.cancel();
  assert.equal(signal.aborted, true);
  assert.equal(await done, 'declined');
  assert.deepEqual(openReply(phone, payload, r.state.replies[0]), { ok: false, error: 'declined' });
});

test('pairing: an allow that comes after the signal aborted does not pair', async () => {
  const gate = deferred<'allow'>();
  let signal!: AbortSignal;
  const r = rig({
    confirm: (req: any) => {
      signal = req.signal;
      return gate.promise;
    },
  });
  const { payload } = await r.svc.begin();
  const done = r.svc.handleHello(helloFor(makePhone(), payload));
  await tick();
  r.svc.cancel();
  gate.resolve('allow');
  assert.equal(await done, 'declined');
  assert.equal(r.devices.list().length, 0);
  assert.equal(signal.aborted, true);
});

test('pairing: the user has five minutes to confirm, then the card is withdrawn and the phone declined', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gate = deferred<'allow'>();
    let signal!: AbortSignal;
    const r = rig({
      confirm: (req: any) => {
        signal = req.signal;
        return gate.promise;
      },
    });
    const { payload } = await r.svc.begin();
    const done = r.svc.handleHello(helloFor(makePhone(), payload));
    await tick();
    mock.timers.tick(CONFIRM_TTL_MS);
    assert.equal(signal.aborted, true);
    gate.resolve('allow');
    assert.equal(await done, 'declined');
  } finally {
    mock.timers.reset();
  }
});

test('begin: a new QR replaces one still waiting, and the old code no longer pairs', async () => {
  const r = rig();
  const first = (await r.svc.begin()).payload;
  const second = (await r.svc.begin()).payload;
  assert.notEqual(first.code, second.code);
  assert.deepEqual(states(r), ['waiting', 'cancelled', 'waiting']);
  assert.equal(r.state.cancelled.length, 1);
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, first)), 'ignored');
  assert.equal(await r.svc.handleHello(helloFor(phone, second)), 'paired');
});

test('begin: two QRs asked for at once leave the newer one, and the older caller is told', async () => {
  const gate = deferred<void>();
  let calls = 0;
  const r = rig({ registerPair: () => (++calls === 1 ? gate.promise : Promise.resolve()) });
  const older = r.svc.begin();
  await tick();
  const newer = await r.svc.begin();
  gate.resolve();
  await assert.rejects(older, { code: 'busy' });
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), newer.payload)), 'paired');
});

test('begin: a relay that can not be reached leaves nothing pending', async () => {
  let fail = true;
  const r = rig({ registerPair: async () => (fail ? Promise.reject(new Error('offline')) : undefined) });
  await assert.rejects(r.svc.begin(), { code: 'relay' });
  assert.deepEqual(states(r), []);
  fail = false;
  const { payload } = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'paired');
});

test('begin: a cancel while the relay answers leaves no pairing and tells the caller', async () => {
  const gate = deferred<void>();
  const reached = deferred<void>();
  const r = rig({ registerPair: () => (reached.resolve(), gate.promise) });
  const begun = r.svc.begin();
  await reached.promise;
  r.svc.cancel();
  gate.resolve();
  await assert.rejects(begun, { code: 'busy' });
});

test('begin: a relay failure after a cancel does not disturb a newer pairing', async () => {
  const gate = deferred<void>();
  let calls = 0;
  const r = rig({ registerPair: () => (++calls === 1 ? gate.promise : Promise.resolve()) });
  const older = r.svc.begin();
  await tick();
  const newer = await r.svc.begin();
  gate.reject(new Error('late failure'));
  await assert.rejects(older, { code: 'relay' });
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), newer.payload)), 'paired');
});

test('begin: without encryption there is no identity, so no QR', async () => {
  const r = rig();
  r.safe.available = false;
  await assert.rejects(r.svc.begin(), { code: 'unavailable' });
});

test('cancel: closing a waiting QR ends it; closing nothing does nothing', async () => {
  const r = rig();
  r.svc.cancel();
  const { payload } = await r.svc.begin();
  r.svc.cancel();
  assert.deepEqual(states(r), ['waiting', 'cancelled']);
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'ignored');
});

test('begin: a phone that starts confirming while a second QR is being made keeps the confirmation', async () => {
  const gate = deferred<'allow'>();
  const r = rig({ confirm: () => gate.promise });
  const { payload } = await r.svc.begin();
  const hello = r.svc.handleHello(helloFor(makePhone(), payload));
  const second = r.svc.begin();
  await assert.rejects(second, { code: 'busy' });
  gate.resolve('allow');
  assert.equal(await hello, 'paired');
});

test('pairing: a cancel while the Mac reads its identity leaves the hello ignored', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const hello = helloFor(makePhone(), payload);
  const pending = r.svc.handleHello(hello);
  r.svc.cancel();
  assert.equal(await pending, 'ignored');
});

test('pairing: failed storage ends as failed, the phone is told, and no device is kept', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const hello = helloFor(phone, payload);
  const real = r.devices.addGuarded.bind(r.devices);
  r.safe.broken = true;
  r.devices.addGuarded = async (...a: any[]) => real(...a);
  r.safe.broken = false;
  r.safe.available = false;
  assert.equal(await r.svc.handleHello(hello), 'failed');
  assert.deepEqual(openReply(phone, payload, r.state.replies[0]), { ok: false, error: 'storage' });
  assert.equal(r.state.events.at(-1).error, 'unavailable');
  assert.equal(r.devices.list().length, 0);
});

test('pairing: a failure other than a store error is still reported as storage', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  r.devices.addGuarded = async () => {
    throw new Error('disk gone');
  };
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'failed');
  assert.equal(r.state.events.at(-1).error, 'storage');
});

test('re-pair: the same phone pairing again replaces its entry with new keys and fresh counters', async () => {
  const r = rig();
  const first = (await r.svc.begin()).payload;
  const oldPhone = makePhone('phone-1');
  await r.svc.handleHello(helloFor(oldPhone, first));
  const oldPair = r.devices.get('phone-1').pairId;
  const second = (await r.svc.begin()).payload;
  const newPhone = makePhone('phone-1', 'Renamed');
  assert.equal(await r.svc.handleHello(helloFor(newPhone, second)), 'paired');
  assert.equal(r.devices.list().length, 1);
  const d = r.devices.get('phone-1');
  assert.notEqual(d.pairId, oldPair);
  assert.equal(d.name, 'Renamed');
  assert.deepEqual([d.tx.ctr, d.rx.ctr], [0, 0]);
});

test('pairing: a missing name becomes "Phone" and a long one is cut', async () => {
  for (const [name, want] of [
    ['   ', 'Phone'],
    ['n'.repeat(100), 'n'.repeat(60)],
    [undefined, 'Phone'],
  ] as const) {
    const r = rig();
    const { payload } = await r.svc.begin();
    await r.svc.handleHello(helloFor(makePhone(), payload, { request: { name } }));
    assert.equal(r.devices.list()[0].name, want);
  }
});

test('pairing: a reply the relay can not take is noted and the outcome stands', async () => {
  const r = rig({ sendReply: async () => Promise.reject(new Error('socket closed')) });
  const { payload } = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'paired');
});

test('pairing: a removePair that fails, a missing one, and a throwing listener do not stop anything', async () => {
  const r = rig({ removePair: async () => Promise.reject(new Error('relay down')) });
  const off = r.svc.onEvent(() => {
    throw new Error('listener broke');
  });
  const { payload } = await r.svc.begin();
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'paired');
  off();
  const bare = new PairingService({
    identity: r.identity,
    devices: r.devices,
    prim,
    relayUrl: () => 'wss://x',
    registerPair: async () => {},
    sendReply: async () => {},
    confirm: async () => 'allow',
  });
  const p2 = (await bare.begin()).payload;
  assert.equal(await bare.handleHello(helloFor(makePhone('phone-9'), p2)), 'paired');
  assert.equal(await bare.unpair('phone-9', r.devices.get('phone-9').pairId), true);
});

test('unpair: the phone is forgotten, the channel is told once, and an unknown phone is false', async () => {
  const told: any[] = [];
  const r = rig({ onUnpaired: (d: any) => void told.push(d.id) });
  const { payload } = await r.svc.begin();
  await r.svc.handleHello(helloFor(makePhone('phone-1'), payload));
  const pair = r.devices.get('phone-1').pairId;
  assert.equal(await r.svc.unpair('nobody', pair), false);
  assert.equal(await r.svc.unpair('phone-1', pair), true);
  assert.equal(await r.svc.unpair('phone-1', pair), false);
  assert.deepEqual(told, ['phone-1']);
  assert.equal(r.devices.list().length, 0);
});

test('unpair: a phone removed by someone else in the meantime is false and not announced', async () => {
  const told: any[] = [];
  const r = rig({ onUnpaired: (d: any) => void told.push(d) });
  const { payload } = await r.svc.begin();
  await r.svc.handleHello(helloFor(makePhone('phone-1'), payload));
  const gate = deferred<void>();
  const real = r.devices.remove.bind(r.devices);
  const removePair = r.devices.removePair.bind(r.devices);
  const expectedPair = r.devices.get('phone-1').pairId;
  r.devices.removePair = async (id: string, pair: string) => {
    assert.equal(pair, expectedPair);
    await gate.promise;
    return removePair(id, pair);
  };
  const first = r.svc.unpair('phone-1', expectedPair);
  const second = real('phone-1');
  gate.resolve();
  await second;
  assert.equal(await first, false);
  assert.deepEqual(told, []);
});

test('unpair: a channel that fails to hear about it does not undo the unpairing', async () => {
  const r = rig({ onUnpaired: async () => Promise.reject(new Error('channel closed')) });
  const { payload } = await r.svc.begin();
  await r.svc.handleHello(helloFor(makePhone('phone-1'), payload));
  assert.equal(await r.svc.unpair('phone-1', r.devices.get('phone-1').pairId), true);
  assert.equal(r.devices.list().length, 0);
});
