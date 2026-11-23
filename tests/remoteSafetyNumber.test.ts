// The pairing safety number (version 3): a twenty-digit hash of the whole pairing transcript. The shared vector pins the construction for the Mac and the phone; here every field is shown to matter, roles and field boundaries cannot be confused, and a key swapped on the way to either end gives the two screens different numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from '../shared/remote/envelope.mjs';
import { groupSafety, speakSafety } from '../shared/remote/safetyNumber.mjs';
import { rig } from './support/remotePairingRig.ts';
import { crypto, helloFor, makePhone, phoneSafetyNumber } from './support/remotePhone.ts';
import { toBase64 } from '../shared/remote/envelope.mjs';
import { setup } from './support/phonePairingFixture.ts';

const V = JSON.parse(readFileSync(new URL('../shared/remote/vectors.json', import.meta.url), 'utf8'));
const h = E.fromHex;
const k = V.keys;
const fields = () => ({
  macId: k.macId,
  phoneId: k.phoneId,
  pairId: V.pair.id,
  macPub: h(k.macPk),
  phonePub: h(k.phonePk),
  macEdPub: h(k.macEdPk),
  phoneEdPub: h(k.phoneEdPk),
  macEphPub: h(k.macEphPk),
  phoneEphPub: h(k.phoneEphPk),
});
const numberOf = (t: ReturnType<typeof fields>) => crypto.safetyNumber(crypto.pairTranscript(t));
const flip = (b: Uint8Array) => b.map((x, i) => (i === 7 ? x ^ 1 : x));

test('every field of the transcript changes the number', () => {
  const base = numberOf(fields());
  assert.equal(base, V.pair.safetyNumber);
  const changed: Array<Partial<ReturnType<typeof fields>>> = [
    { macId: 'mac-tesu' },
    { phoneId: 'phone-tesu' },
    { pairId: 'p_AZn2t5oNKHPSfl_NCK1qPB' },
    { macPub: flip(h(k.macPk)) },
    { phonePub: flip(h(k.phonePk)) },
    { macEdPub: flip(h(k.macEdPk)) },
    { phoneEdPub: flip(h(k.phoneEdPk)) },
    { macEphPub: flip(h(k.macEphPk)) },
    { phoneEphPub: flip(h(k.phoneEphPk)) },
  ];
  for (const change of changed) assert.notEqual(numberOf({ ...fields(), ...change }), base, Object.keys(change)[0]);
});

test('roles and field boundaries are part of the transcript', () => {
  const f = fields();
  assert.notEqual(numberOf({ ...f, macPub: f.phonePub, phonePub: f.macPub }), numberOf(f), 'the Mac’s key is not the phone’s');
  assert.notEqual(numberOf({ ...f, macEphPub: f.phoneEphPub, phoneEphPub: f.macEphPub }), numberOf(f));
  // the ids are length-prefixed: moving a character from one to the other is another transcript
  assert.notEqual(numberOf({ ...f, macId: 'ab', phoneId: 'c-phone' }), numberOf({ ...f, macId: 'a', phoneId: 'bc-phone' }));
});

test('the number is twenty digits and neither the transcript nor a plain hash of it', () => {
  const t = crypto.pairTranscript(fields());
  const number = crypto.safetyNumber(t);
  assert.match(number, /^\d{20}$/);
  assert.notEqual(number, crypto.safetyNumber(crypto.prim.sha256(t)), 'a hash of the transcript is another number');
  assert.equal(t.length, 32);
});

test('a key that is not 32 bytes is refused', () => {
  for (const key of ['macPub', 'phonePub', 'macEdPub', 'phoneEdPub', 'macEphPub', 'phoneEphPub'] as const) {
    assert.throws(() => crypto.pairTranscript({ ...fields(), [key]: new Uint8Array(31) }), { code: 'state' }, key);
  }
});

test('groupSafety shows twenty digits in groups of four and keeps the older shapes', () => {
  assert.equal(groupSafety('83498621119646569664'), '8349 8621 1196 4656 9664');
  assert.equal(groupSafety('123456'), '123 456');
  assert.equal(groupSafety('1234'), '123 4', 'only twenty digits are grouped in fours');
  assert.equal(groupSafety('12 34'), '12 34', 'text that is not a run of digits is shown as it came');
  assert.equal(groupSafety(null), '');
  assert.equal(speakSafety('1234'), '1 2 3 4');
});

test('the Mac and the phone show one number computed from the same transcript', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'paired');
  assert.equal(r.state.confirms[0].safetyNumber, phoneSafetyNumber(phone, payload));
  assert.match(r.state.confirms[0].safetyNumber, /^\d{20}$/);
});

test('the real phone coordinator and the real Mac service show one number', async () => {
  const s = setup();
  const { payload } = await s.desktop.begin();
  const shown = await s.phone.begin(JSON.stringify(payload), 'Test phone');
  assert.equal(await s.desktop.handleHello(E.decodeFrame(s.hello)), 'paired');
  assert.equal(shown.safetyNumber, s.observed);
});

test('a phone key swapped on the way to the Mac gives the two screens different numbers', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const attacker = makePhone('phone-1', phone.name);
  // the Mac pairs with a hello the attacker built; the phone shows the number of its own keys
  assert.equal(await r.svc.handleHello(helloFor(attacker, payload)), 'paired');
  assert.notEqual(r.state.confirms[0].safetyNumber, phoneSafetyNumber(phone, payload));
});

test('a QR whose Mac ephemeral key was swapped gives the two screens different numbers', async () => {
  const r = rig();
  const { payload } = await r.svc.begin();
  const phone = makePhone();
  const forged = { ...payload, macEphPub: E.toBase64(makePhone().eph.pk) };
  assert.equal(await r.svc.handleHello(helloFor(phone, payload)), 'paired');
  assert.notEqual(r.state.confirms[0].safetyNumber, phoneSafetyNumber(phone, forged));
});

test('the phone refuses a QR of another version or without the Mac\u2019s Ed25519 or ephemeral key', async () => {
  const s = setup();
  const { payload } = await s.desktop.begin();
  for (const bad of [
    { ...payload, v: 2 },
    { ...payload, macEdPub: undefined },
    { ...payload, macEdPub: toBase64(new Uint8Array(31)) },
    { ...payload, macEphPub: undefined },
    { ...payload, macEphPub: toBase64(new Uint8Array(33)) },
  ])
    await assert.rejects(s.phone.begin(bad, 'phone'), /invalid pairing data|invalid QR|older QR|expired QR/);
});

test('the phone refuses an answer of another version, and a QR whose Mac ephemeral key has low order before showing a number', async () => {
  const old = setup();
  const first = (await old.desktop.begin()).payload;
  await old.phone.begin(first, 'phone');
  assert.equal(await old.desktop.handleHello(E.decodeFrame(old.hello)), 'paired');
  const key = crypto.helloKey(old.identity.x.sk, E.fromBase64(first.macPub), E.fromBase64(first.code));
  const pairId = crypto.pairId(E.fromBase64(first.code));
  const v2 = E.toWire(crypto.replyFrame(pairId, key, E.utf8(JSON.stringify({ v: 2, ok: true, pairId }))));
  await assert.rejects(old.phone.finish(v2), /invalid pairing data/);

  const low = setup();
  const second = (await low.desktop.begin()).payload;
  await assert.rejects(low.phone.begin({ ...second, macEphPub: toBase64(new Uint8Array(32)) }, 'phone'), /invalid pairing data/);
  assert.equal(low.phone.status(), 'idle', 'nothing was sent or kept');
  assert.equal(low.hello, undefined);
});

const wiped = (b: Uint8Array) => b.every((x) => x === 0);

test('the Mac wipes its ephemeral secret on every way out: cancel, a late hello, a refused hello', async () => {
  const r = rig();
  await r.svc.begin();
  const cancelled = r.svc.pending.ephSk;
  assert.equal(wiped(cancelled), false);
  r.svc.cancel();
  assert.equal(wiped(cancelled), true, 'cancel');

  const { payload } = await r.svc.begin();
  const expired = r.svc.pending.ephSk;
  r.state.t = payload.exp + 1;
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), 'expired');
  assert.equal(wiped(expired), true, 'a hello after the code died');
  r.state.t = 1_000_000;

  const refused = (await r.svc.begin()).payload;
  const held = r.svc.pending.ephSk;
  assert.equal(await r.svc.handleHello(helloFor(makePhone(), refused, { proof: new Uint8Array(32) })), 'rejected');
  assert.equal(wiped(held), true, 'a hello with a bad proof spends the code');
});

test('the Mac wipes its ephemeral secret once a hello has spent the code: paired, declined, a confirmation that fails', async () => {
  const outcomes: Array<[string, any, string]> = [
    ['paired', undefined, 'paired'],
    ['declined', async () => 'deny', 'declined'],
    ['failing confirmation', async () => Promise.reject(new Error('card broke')), 'declined'],
  ];
  for (const [name, confirm, expected] of outcomes) {
    const r = rig(confirm ? { confirm } : {});
    const { payload } = await r.svc.begin();
    const secret = r.svc.pending.ephSk;
    assert.equal(wiped(secret), false);
    assert.equal(await r.svc.handleHello(helloFor(makePhone(), payload)), expected, name);
    assert.equal(wiped(secret), true, name);
  }
});

test('a second hello while the first waits for the user is ignored and the first still pairs', async () => {
  let answer!: (v: 'allow') => void;
  const r = rig({ confirm: () => new Promise((resolve) => (answer = resolve)) });
  const { payload } = await r.svc.begin();
  const first = r.svc.handleHello(helloFor(makePhone(), payload));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await r.svc.handleHello(helloFor(makePhone('phone-2'), payload)), 'ignored');
  answer('allow');
  assert.equal(await first, 'paired');
  assert.equal(r.devices.list().length, 1);
});
