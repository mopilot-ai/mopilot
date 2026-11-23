// Computer access (#1364): the handshake, the encrypted frames, the pairing offer and call freshness refuse every caller
// that did not prove a pinned key, and every frame or call that is replayed, reordered or tampered with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const hs = require('../electron/computerAccess/handshake.cjs');
const { SecureChannel, FrameError, FRAME_MAX } = require('../electron/computerAccess/frames.cjs');
const { parseOffer, offerText, PairingOffers, OFFER_MS } = require('../electron/computerAccess/offer.cjs');
const { CallWindow, CALL_SKEW_MS } = require('../electron/computerAccess/callWindow.cjs');

/** A key that is well formed but no valid peer key (all zeros: X25519 with it fails). */
const ZERO_KEY = Buffer.alloc(32).toString('base64url');

/** A full plain (already paired) connection: returns both sides' results. */
function connect(o: { client?: any; host?: any; known?: (x: string) => boolean; hostKey?: string } = {}) {
  const client = o.client ?? hs.newKeyPair();
  const host = o.host ?? hs.newKeyPair();
  const c1 = hs.clientHello({ identity: client });
  const h1 = hs.hostRespond({
    identity: host,
    hello: c1.message,
    known: o.known ?? ((x: string) => x === client.x),
    pairSecret: () => null,
  });
  const c2 = hs.clientFinish({ state: c1.state, welcome: h1.message, hostKey: o.hostKey ?? host.x });
  const h2 = hs.hostFinish({ state: h1.state, confirm: c2.message });
  return { client, host, c1, h1, c2, h2 };
}

test('a paired client and host derive the same keys, and frames go both ways', () => {
  const { client, c2, h2 } = connect();
  assert.equal(h2.client, client.x);
  assert.equal(h2.pair, false);
  assert.equal(h2.code, null);
  assert.equal(c2.code, null);
  const toHost = { c: new SecureChannel(c2.session), h: new SecureChannel(h2.session) };
  assert.deepEqual(toHost.h.open(toHost.c.seal({ t: 'call', n: 1 })), { t: 'call', n: 1 });
  assert.deepEqual(toHost.c.open(toHost.h.seal({ t: 'result', ok: true })), { t: 'result', ok: true });
});

test('two connections of the same pair get different keys (an old frame does not open in a new connection)', () => {
  const client = hs.newKeyPair();
  const host = hs.newKeyPair();
  const a = connect({ client, host });
  const b = connect({ client, host });
  const frame = new SecureChannel(a.c2.session).seal({ t: 'call' });
  assert.throws(
    () => new SecureChannel(b.h2.session).open(frame),
    (e: any) => e instanceof FrameError && e.code === 'unauthorized',
  );
});

test('the host refuses a device it did not pair, and a hello that is not one', () => {
  const host = hs.newKeyPair();
  const stranger = hs.clientHello({ identity: hs.newKeyPair() });
  const respond =
    (hello: any, known = () => false, pairSecret = () => null) =>
    () =>
      hs.hostRespond({ identity: host, hello, known, pairSecret });
  assert.throws(respond(stranger.message), { code: 'unknown_device' });
  assert.throws(respond(null), { code: 'protocol' });
  assert.throws(respond({ ...stranger.message, v: 2 }), { code: 'protocol' });
  assert.throws(respond({ ...stranger.message, t: 'welcome' }), { code: 'protocol' });
  assert.throws(respond({ ...stranger.message, s: 'short' }), /malformed hello/);
  assert.throws(respond({ ...stranger.message, e: 'x'.repeat(44) }), /malformed hello/);
  assert.throws(respond({ ...stranger.message, n: 'NOTHEX'.repeat(6) }), /malformed hello/);
  // a key that is well formed but no X25519 point a DH can use
  assert.throws(
    respond({ ...stranger.message, e: ZERO_KEY }, () => true),
    /not a valid X25519 key/,
  );
});

test('a client that only knows a paired key but not its private key cannot finish (it posed as the device)', (t) => {
  const createPrivateKey = crypto.createPrivateKey;
  // Some crypto providers reject an inconsistent JWK; exercise that contract on every supported runtime.
  t.mock.method(crypto, 'createPrivateKey', (options: any) => {
    const key = createPrivateKey(options);
    if (options.format === 'jwk') assert.equal(crypto.createPublicKey(key).export({ format: 'jwk' }).x, options.key.x);
    return key;
  });
  const client = hs.newKeyPair();
  const host = hs.newKeyPair();
  const impostor = hs.newKeyPair();
  // Forge the wire claim, not the local keypair: the impostor does not own the paired private key.
  const c1 = hs.clientHello({ identity: impostor });
  const h1 = hs.hostRespond({
    identity: host,
    hello: { ...c1.message, s: client.x },
    known: (x: string) => x === client.x,
    pairSecret: () => null,
  });
  assert.throws(() => hs.clientFinish({ state: c1.state, welcome: h1.message, hostKey: host.x }), { code: 'unauthorized' });
  // Even when it agrees on the public transcript, only the actual paired private key can confirm.
  const dh = (identity: { x: string; d: string }, x: string) =>
    crypto.diffieHellman({
      privateKey: crypto.createPrivateKey({ key: { kty: 'OKP', crv: 'X25519', ...identity }, format: 'jwk' }),
      publicKey: crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x }, format: 'jwk' }),
    });
  const confirmWith = (identity: { x: string; d: string }) => {
    const { s, e } = h1.message;
    const material = Buffer.concat([dh(c1.state.eph, e), dh(c1.state.eph, s), dh(identity, e), dh(identity, s)]);
    const keys = Buffer.from(crypto.hkdfSync('sha256', material, h1.state.transcript, 'mopilot-access/1 keys', 128));
    return { t: 'confirm', mac: crypto.createHmac('sha256', keys.subarray(96)).update(h1.state.transcript).digest('hex') };
  };
  assert.equal(hs.hostFinish({ state: h1.state, confirm: confirmWith(client) }).client, client.x);
  assert.throws(() => hs.hostFinish({ state: h1.state, confirm: confirmWith(impostor) }), { code: 'unauthorized' });
  // A made-up or absent confirmation does not pass either.
  assert.throws(() => hs.hostFinish({ state: h1.state, confirm: { t: 'confirm', mac: 'a'.repeat(64) } }), { code: 'unauthorized' });
  assert.throws(() => hs.hostFinish({ state: h1.state, confirm: null }), { code: 'unauthorized' });
});

test('the client refuses a computer that is not the one it paired, and a welcome that is not one', () => {
  const client = hs.newKeyPair();
  const host = hs.newKeyPair();
  const c1 = hs.clientHello({ identity: client });
  const h1 = hs.hostRespond({ identity: host, hello: c1.message, known: () => true, pairSecret: () => null });
  const finish =
    (welcome: any, o: any = { hostKey: host.x }) =>
    () =>
      hs.clientFinish({ state: c1.state, welcome, ...o });
  assert.throws(finish(h1.message, { hostKey: hs.newKeyPair().x }), { code: 'wrong_host' });
  assert.throws(finish(h1.message, {}), { code: 'wrong_host' });
  assert.throws(finish(null), { code: 'protocol' });
  assert.throws(finish({ ...h1.message, v: 0 }), { code: 'protocol' });
  assert.throws(finish({ ...h1.message, mac: 'nope' }), /malformed welcome/);
  assert.throws(finish({ ...h1.message, s: 1 }), /malformed welcome/);
  assert.throws(finish({ ...h1.message, e: '!' }), /malformed welcome/);
  assert.throws(finish({ ...h1.message, n: '' }), /malformed welcome/);
  assert.throws(finish({ ...h1.message, e: ZERO_KEY }), /not a valid X25519 key/);
  // a welcome from the right key whose proof is wrong (a replayed welcome of another connection)
  assert.throws(finish({ ...h1.message, mac: 'b'.repeat(64) }), { code: 'unauthorized' });
});

test('pairing: only a client with the offer finishes, both sides show the same code, and the offer names the host key', () => {
  const host = hs.newKeyPair();
  const offers = new PairingOffers();
  const offer = parseOffer(offers.start({ address: '127.0.0.1', port: 47616, fingerprint: hs.fingerprint(host.x) }).text);
  const device = hs.newKeyPair();
  const c1 = hs.clientHello({ identity: device, pair: { name: 'Pixel\n  of Du', secret: offer.secret } });
  assert.equal(c1.message.pair, true);
  assert.equal(c1.message.name, 'Pixel   of Du');
  const h1 = hs.hostRespond({ identity: host, hello: c1.message, known: () => false, pairSecret: () => offers.take() });
  const c2 = hs.clientFinish({ state: c1.state, welcome: h1.message, fingerprint: offer.fingerprint });
  const h2 = hs.hostFinish({ state: h1.state, confirm: c2.message });
  assert.equal(h2.pair, true);
  assert.equal(h2.name, 'Pixel   of Du');
  assert.equal(h2.client, device.x);
  assert.equal(c2.host, host.x);
  assert.match(h2.code, /^\d{3} \d{3}$/);
  assert.equal(c2.code, h2.code);
  // the offer was used up: a second pairing hello finds none
  const again = hs.clientHello({ identity: hs.newKeyPair(), pair: { name: 'x', secret: offer.secret } });
  assert.throws(() => hs.hostRespond({ identity: host, hello: again.message, known: () => false, pairSecret: () => offers.take() }), {
    code: 'no_pairing',
  });
});

test('pairing: a stolen offer with the wrong secret, or an answer from another computer, does not finish', () => {
  const host = hs.newKeyPair();
  const offers = new PairingOffers();
  const offer = parseOffer(offers.start({ address: 'mac.local', port: 47616, fingerprint: hs.fingerprint(host.x) }).text);
  const wrong = hs.clientHello({ identity: hs.newKeyPair(), pair: { name: 'x', secret: crypto.randomBytes(32).toString('base64url') } });
  const h1 = hs.hostRespond({ identity: host, hello: wrong.message, known: () => false, pairSecret: () => offers.take() });
  assert.throws(() => hs.clientFinish({ state: wrong.state, welcome: h1.message, fingerprint: offer.fingerprint }), {
    code: 'unauthorized',
  });
  // another computer answering the client's pairing hello: its key does not match the offer's fingerprint
  const other = hs.newKeyPair();
  const c1 = hs.clientHello({ identity: hs.newKeyPair(), pair: { name: 'x', secret: offer.secret } });
  const o1 = hs.hostRespond({ identity: other, hello: c1.message, known: () => false, pairSecret: () => offer.secret });
  assert.throws(() => hs.clientFinish({ state: c1.state, welcome: o1.message, fingerprint: offer.fingerprint }), { code: 'wrong_host' });
  assert.throws(() => hs.clientFinish({ state: c1.state, welcome: o1.message }), { code: 'wrong_host' });
});

test('pairing: a device name rewritten on the way does not finish (the name is part of the transcript)', () => {
  const host = hs.newKeyPair();
  const offers = new PairingOffers();
  const offer = parseOffer(offers.start({ address: '127.0.0.1', port: 47616, fingerprint: hs.fingerprint(host.x) }).text);
  const c1 = hs.clientHello({ identity: hs.newKeyPair(), pair: { name: 'Du’s MacBook', secret: offer.secret } });
  const forged = { ...c1.message, name: 'Studio iMac (office)' };
  const h1 = hs.hostRespond({ identity: host, hello: forged, known: () => false, pairSecret: () => offers.take() });
  assert.equal(h1.state.name, 'Studio iMac (office)');
  assert.throws(() => hs.clientFinish({ state: c1.state, welcome: h1.message, fingerprint: offer.fingerprint }), { code: 'unauthorized' });
});

test('a key spelled in a non-canonical base64url form is not a key (pinned keys are compared as text)', () => {
  const key = hs.newKeyPair().x;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  // the last of 43 characters carries 2 spare bits: the next letter decodes to the same 32 bytes
  const odd = key.slice(0, 42) + alphabet[alphabet.indexOf(key[42]) + 1];
  assert.deepEqual(Buffer.from(odd, 'base64url'), Buffer.from(key, 'base64url'));
  assert.equal(hs.isKey(key), true);
  assert.equal(hs.isKey(odd), false);
  assert.equal(hs.isKey(null), false);
  const hello = hs.clientHello({ identity: hs.newKeyPair() }).message;
  assert.throws(
    () => hs.hostRespond({ identity: hs.newKeyPair(), hello: { ...hello, s: odd }, known: () => true, pairSecret: () => null }),
    /malformed hello/,
  );
});

test('device names, keys and comparisons', () => {
  // bidi overrides, isolates and zero-width characters go; control characters become spaces
  assert.equal(hs.deviceName('enohPi\u202E s\u2019uD\u2066\u200B'), 'enohPi s’uD');
  assert.equal(hs.deviceName('a\tb'), 'a b');
  assert.equal(hs.deviceName(''), 'Unnamed device');
  assert.equal(hs.deviceName(42), 'Unnamed device');
  assert.equal(hs.deviceName('a'.repeat(100)).length, 64);
  assert.equal(hs.isKeyPair(hs.newKeyPair()), true);
  assert.equal(hs.isKeyPair(null), false);
  assert.equal(hs.isKeyPair({ x: 'a', d: 'b' }), false);
  assert.match(hs.fingerprint(hs.newKeyPair().x), /^[0-9a-f]{32}$/);
  assert.match(hs.verificationCode(Buffer.from('t')), /^\d{3} \d{3}$/);
});

test('frames: a replayed, skipped, reordered, tampered or malformed frame ends the connection', () => {
  const { c2, h2 } = connect();
  const send = new SecureChannel(c2.session);
  const recv = new SecureChannel(h2.session);
  const f0 = send.seal({ n: 0 });
  const f1 = send.seal({ n: 1 });
  const f2 = send.seal({ n: 2 });
  assert.throws(() => recv.open(f1), { code: 'replay' }); // reordered
  assert.deepEqual(recv.open(f0), { n: 0 });
  assert.throws(() => recv.open(f0), { code: 'replay' }); // repeated
  assert.throws(() => recv.open(f2), { code: 'replay' }); // skipped
  const raw = Buffer.from(f1, 'base64url');
  raw[raw.length - 20] ^= 1;
  assert.throws(() => recv.open(raw.toString('base64url')), { code: 'unauthorized' });
  assert.throws(() => recv.open(42), { code: 'malformed' });
  assert.throws(() => recv.open('!'.repeat(Math.ceil(((FRAME_MAX + 24) * 4) / 3) + 8)), { code: 'too_large' });
  assert.throws(() => recv.open('not a frame!'), { code: 'malformed' });
  assert.throws(() => recv.open(Buffer.alloc(10).toString('base64url')), { code: 'malformed' });
  assert.throws(() => recv.open('A'.repeat(Math.ceil(((FRAME_MAX + 24) * 4) / 3) + 8)), { code: 'too_large' });
  // a failed frame is not counted: the real next one still opens
  assert.deepEqual(recv.open(f1), { n: 1 });
});

test('frames: keys must be 32 bytes, a message too large is not sent, and a frame that is not JSON is refused', () => {
  assert.throws(() => new SecureChannel(null), { code: 'keys' });
  assert.throws(() => new SecureChannel({ send: Buffer.alloc(32), recv: Buffer.alloc(16) }), { code: 'keys' });
  assert.throws(() => new SecureChannel({ send: 'k', recv: Buffer.alloc(32) }), { code: 'keys' });
  const key = Buffer.alloc(32, 7);
  const ch = new SecureChannel({ send: key, recv: key });
  assert.throws(() => ch.seal('x'.repeat(FRAME_MAX)), { code: 'too_large' });
  // a frame sealed with the right key whose plaintext is not JSON
  const head = Buffer.alloc(8);
  const nonce = Buffer.alloc(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(head);
  const body = Buffer.concat([c.update(Buffer.from('{not json')), c.final()]);
  const frame = Buffer.concat([head, body, c.getAuthTag()]).toString('base64url');
  assert.throws(() => ch.open(frame), { code: 'malformed' });
});

test('pairing offers: read, single use, expiry and cancel', () => {
  const fp = 'a'.repeat(32);
  const secret = 'S'.repeat(43);
  for (const address of ['mac.local', '192.168.1.20', '[fe80::1]']) {
    assert.deepEqual(parseOffer(` ${offerText({ address, port: 47616, fingerprint: fp, secret })}\n`), {
      address,
      port: 47616,
      fingerprint: fp,
      secret,
    });
  }
  assert.equal(parseOffer(null), null);
  assert.equal(parseOffer('mopilot-chrome:1:1:2'), null);
  assert.equal(parseOffer(offerText({ address: 'h', port: 0, fingerprint: fp, secret })), null);
  assert.equal(parseOffer(offerText({ address: 'h', port: 70000, fingerprint: fp, secret })), null);
  assert.equal(parseOffer(offerText({ address: 'a b', port: 1, fingerprint: fp, secret })), null);

  let now = 1000;
  const offers = new PairingOffers({ now: () => now });
  assert.equal(offers.take(), null);
  const first = offers.start({ address: 'h', port: 1, fingerprint: fp });
  assert.equal(first.expiresAt, 1000 + OFFER_MS);
  const second = offers.start({ address: 'h', port: 1, fingerprint: fp });
  // only the newest offer works, once
  assert.equal(offers.take(), parseOffer(second.text)!.secret);
  assert.equal(offers.take(), null);
  offers.start({ address: 'h', port: 1, fingerprint: fp });
  offers.cancel();
  assert.equal(offers.take(), null);
  offers.start({ address: 'h', port: 1, fingerprint: fp });
  assert.ok(offers.current(), 'open until its time is up');
  now += OFFER_MS + 1;
  assert.equal(offers.current(), null, 'an expired offer is not shown');
  assert.equal(offers.take(), null);
  offers.cancel();
  assert.equal(offers.current(), null);
  assert.equal(new PairingOffers().ttlMs, OFFER_MS);
});

test('calls: fresh once, never replayed, never stale, and fresh ids are never dropped to make room', () => {
  let now = 1_000_000;
  const w = new CallWindow({ now: () => now, max: 2 });
  assert.equal(w.accept('call-0001', now), 'ok');
  assert.equal(w.accept('call-0001', now), 'replayed');
  assert.equal(w.accept('call-0002', now - CALL_SKEW_MS - 1), 'stale');
  assert.equal(w.accept('call-0002', now + CALL_SKEW_MS + 1), 'stale');
  assert.equal(w.accept('bad id', now), 'malformed');
  assert.equal(w.accept(7, now), 'malformed');
  assert.equal(w.accept('call-0002', '1'), 'malformed');
  assert.equal(w.accept('call-0002', Number.NaN), 'malformed');
  assert.equal(w.accept('call-0002', now), 'ok');
  assert.equal(w.accept('call-0003', now), 'busy');
  // once the old ids could only be stale, they are let go and room is made
  now += 2 * CALL_SKEW_MS + 1;
  assert.equal(w.accept('call-0003', now), 'ok');
  assert.equal(w.accept('call-0001', now), 'ok');
  assert.equal(new CallWindow().skewMs, CALL_SKEW_MS);
});
