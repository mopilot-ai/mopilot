// The remote Host proxy proves this install's key on every connection (electron/host/remote.cjs `identity`): auth before hello, again after a reconnect, a Host that does not know this app refuses chat requests with its code, an unreadable key says so, a drop in the middle of auth is a drop, and a proxy without an identity sends no auth (A5, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';
// @ts-ignore: plain ESM without declarations
import { createPairing } from '../host/src/pairing.mjs';
import { keySafe } from './support/hostKeySafe.ts';
const require = createRequire(import.meta.url);
const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');

/** What each connection of the proxy sent (the tunnel's own probe sockets say only ping). */
const conns = (w: any) =>
  w.net.sockets
    .filter((s: any) => s.written.some((m: any) => m.method === 'host.hello'))
    .map((s: any) => s.written.map((m: any) => m.method));

/** A Host that pairs and verifies by the real pairing module, and a world whose network answers for it. */
function paired(t: any, { pair = true }: { pair?: boolean } = {}) {
  const w = hostWorld(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-auth-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pairing = createPairing({ configDir: path.join(dir, 'host') });
  const identity = loadIdentity(path.join(dir, 'app.json'), keySafe);
  if (pair)
    void pairWith(
      async (m: string, p: any) => (m === 'host.challenge' ? { nonce: pairing.challenge(), hostId: pairing.hostId() } : pairing.claim(p)),
      identity,
      pairing.issueCode(),
    );
  w.net.handlers['host.challenge'] = () => ({ nonce: pairing.challenge(), hostId: pairing.hostId() });
  w.net.handlers['host.auth'] = (p: any) => pairing.verify(p);
  return { w, identity, pairing, dir };
}

test('a paired app proves its key before hello, and again on every new connection', async (t) => {
  const { w, identity } = paired(t);
  await tick();
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  assert.deepEqual(conns(w), [['ping', 'host.challenge', 'host.auth', 'host.hello']]);
  assert.deepEqual(await host.chats(), ['a', 'b']);
  await host.send('a', { text: 'hi' }, { key: 'k-0000001' });
  // the tunnel drops and comes back: the new connection is a new standing, so it proves the key again
  w.children[0].die(255, 'Network is unreachable');
  w.clock.advance(1000);
  await tick();
  await tick();
  assert.equal(host.state(), 'online');
  assert.equal(conns(w).length, 2);
  assert.deepEqual(conns(w)[1], ['ping', 'host.challenge', 'host.auth', 'host.hello']);
  assert.deepEqual(await host.chats(), ['a', 'b']);
});

test('a Host that does not know this app answers with its code; chat requests carry it, the connection and other calls stay up', async (t) => {
  const { w, identity } = paired(t, { pair: false });
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  assert.equal(host.state(), 'online');
  await assert.rejects(
    host.send('a', { text: 'hi' }, { key: 'k-0000001' }),
    (e: any) => e.code === 'unknown_client' && /not paired/.test(e.message),
  );
  await assert.rejects(host.stop('a', 't1'), (e: any) => e.code === 'unknown_client');
  assert.deepEqual(await host.chats(), ['a', 'b'], 'a call that needs no trust is not blocked by the proxy');
});

test('a key that cannot be read is said as that, and read again by the next request, not remembered for the life of the connection', async (t) => {
  const { w, identity } = paired(t);
  let locked = true;
  const { host } = await onlineRemote(
    w,
    {},
    {
      identity: () => {
        if (locked) throw new Error('This app’s Host key cannot be read.');
        return identity;
      },
    },
  );
  await assert.rejects(
    host.send('a', { text: 'hi' }, { key: 'k-0000001' }),
    (e: any) => e.code === 'key_unreadable' && /cannot be read/.test(e.message),
  );
  // the keychain is unlocked: Retry, or a new send, proves the key on the same connection and is accepted
  locked = false;
  assert.equal(await host.send('a', { text: 'hi' }, { key: 'k-0000002' }), 'ok');
  assert.equal(conns(w).length, 1, 'no new connection was made');
});

test('a drop in the middle of auth is a drop: the proxy never comes up on that connection and a call is refused as unreachable (B2)', async (t) => {
  const { w, identity } = paired(t);
  w.net.hold.add('host.auth');
  const tun = w.tunnel();
  const host = w.remote(tun, { identity: () => identity });
  void host.connect().catch(() => undefined);
  await tick();
  w.children[0].die(255, 'Network is unreachable');
  await tick();
  assert.notEqual(host.state(), 'online');
  await assert.rejects(host.chats(), (e: any) => e.code === 'host_unreachable');
  assert.deepEqual(conns(w), [], 'hello was never reached');
});

test('a proxy without an identity sends no auth, as for a Host that has no pairing', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  assert.deepEqual(conns(w), [['ping', 'host.hello']]);
  await host.send('a', { text: 'hi' }, { key: 'k-0000001' });
});

test('#5744: the refused proof is readable and told on every agreement: refused while the Host keeps the app out, cleared when a later proof is accepted, and nobody is told after dispose', async (t) => {
  const { w, identity } = paired(t);
  let open = false;
  w.net.handlers['host.auth'] = () => {
    if (!open) throw Object.assign(new Error('Connections are off on this Mac.'), { code: 'connections_off' });
    return { fingerprint: 'f', name: '', kind: 'desktop' };
  };
  const tun = w.tunnel();
  const host = w.remote(tun, { identity: () => identity });
  const told: (string | null)[] = [];
  host.onRefused((e: any) => told.push(e?.code ?? null));
  await host.connect();
  assert.equal(host.refused()?.code, 'connections_off');
  assert.deepEqual(told, ['connections_off']);
  // a request that needs trust asks again: still refused, told again (the reader decides what changed)
  await assert.rejects(host.send('a', { text: 'hi' }, { key: 'k-0000001' }), (e: any) => e.code === 'connections_off');
  assert.deepEqual(told, ['connections_off', 'connections_off']);
  open = true;
  assert.equal(await host.send('a', { text: 'hi' }, { key: 'k-0000002' }), 'ok');
  assert.equal(host.refused(), null);
  assert.deepEqual(told, ['connections_off', 'connections_off', null]);
  const off = host.onRefused(() => assert.fail('an unsubscribed listener is not told'));
  off();
  host.dispose();
  assert.equal(told.length, 3);
});
