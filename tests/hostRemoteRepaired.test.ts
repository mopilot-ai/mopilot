// A remote Host proxy that was told "unknown client" asks again once before it refuses a request that needs the Host's trust, so a pairing made after the connection came up (here, elsewhere) is never refused by the stale answer (#5103).
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

/** An unpaired Host and its world; `pairNow` pairs this app on the Host the way another window would. */
function unpaired(t: any) {
  const w = hostWorld(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-repaired-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const pairing = createPairing({ configDir: path.join(dir, 'host') });
  const identity = loadIdentity(path.join(dir, 'app.json'), keySafe);
  w.net.handlers['host.challenge'] = () => ({
    nonce: pairing.challenge(),
    hostId: pairing.hostId(),
  });
  w.net.handlers['host.auth'] = (p: any) => pairing.verify(p);
  const pairNow = () =>
    pairWith(
      async (m: string, p: any) => (m === 'host.challenge' ? { nonce: pairing.challenge(), hostId: pairing.hostId() } : pairing.claim(p)),
      identity,
      pairing.issueCode(),
    );
  /** How many times this app proved its key. */
  const auths = () => w.net.sockets.reduce((n: number, s: any) => n + s.written.filter((m: any) => m.method === 'host.auth').length, 0);
  return { w, identity, pairNow, auths };
}

test('a request after a pairing made elsewhere is accepted after one new agreement, not refused by the stale answer', async (t) => {
  const { w, identity, pairNow, auths } = unpaired(t);
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  assert.equal(auths(), 1);
  await pairNow();
  assert.deepEqual(await host.send('a', { text: 'hi' }, { key: 'k-0000001' }), 'ok');
  assert.equal(auths(), 2, 'one new proof, no new connection');
  assert.equal(w.net.sockets.filter((s: any) => s.written.some((m: any) => m.method === 'host.hello')).length, 1);
  // the answer is current now: the next request asks nothing
  await host.stop('a', 't1');
  assert.equal(auths(), 2);
});

test('a Mac the Host never knew is refused after exactly one new attempt per request, and never loops', async (t) => {
  const { w, identity, auths } = unpaired(t);
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  for (const n of [2, 3, 4]) {
    await assert.rejects(host.send('a', { text: 'hi' }, { key: `k-000000${n}` }), (e: any) => e.code === 'unknown_client');
    assert.equal(auths(), n, `request ${n - 1}: one new attempt`);
  }
  assert.deepEqual(await host.chats(), ['a', 'b'], 'a call that needs no trust asks nothing');
  assert.equal(auths(), 4);
});

test('requests that meet the stale answer together share one new agreement', async (t) => {
  const { w, identity, pairNow, auths } = unpaired(t);
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  await pairNow();
  const all = await Promise.all([
    host.send('a', { text: 'one' }, { key: 'k-0000001' }),
    host.send('b', { text: 'two' }, { key: 'k-0000002' }),
    host.stop('a', 't1'),
  ]);
  assert.deepEqual(all, ['ok', 'ok', 'ok']);
  assert.equal(auths(), 2);
});

test('a connection that drops while it asks again fails the request as unreachable', async (t) => {
  const { w, identity, pairNow } = unpaired(t);
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  await pairNow();
  w.net.hold.add('host.auth');
  const sent = host.send('a', { text: 'hi' }, { key: 'k-0000001' });
  await tick();
  w.children[0].die(255, 'Network is unreachable');
  await assert.rejects(sent, (e: any) => e.code === 'host_unreachable');
});

test('the other calls that need trust ask again too, a subscribe and a continue; the Host\u2019s answer about moved chats is acted on once', async (t) => {
  const { w, identity, pairNow, auths } = unpaired(t);
  const told: unknown[] = [];
  w.net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: ['epoch', 'dedupe', 'isolation', 'lanes'],
    continued: { poisoned: [] },
  });
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1 }, patches: [] });
  w.net.handlers['chat.commitContinue'] = () => 'done';
  const { host } = await onlineRemote(w, {}, { identity: () => identity, onHello: (r: unknown) => told.push(r) });
  await pairNow();
  assert.equal(host.speaks('origin'), false);
  await host.subscribe('a');
  assert.equal(auths(), 2);
  await host.subscribe('b');
  assert.equal(auths(), 2, 'a subscribe on a trusted connection asks nothing');
  assert.equal(
    await host.call('chat.commitContinue', { chatId: 'a', expectedEpoch: 1, targetHostId: 'b', preparedId: 'prepared-0001' }),
    'done',
  );
  assert.equal(auths(), 2, 'the answer is current: nothing is asked again');
  assert.equal(told.length, 1, 'asking again does not act on the moved chats a second time');
});

test('Retry of a refused message after the pairing is accepted, and the Host runs it once however often it is sent', async (t) => {
  const { w, identity, pairNow, auths } = unpaired(t);
  const ran = new Map<string, number>();
  w.net.handlers['chat.send'] = (p: any) => {
    const seen = ran.get(p.key) ?? 0;
    ran.set(p.key, seen + 1);
    return { replayed: seen > 0, result: 'ok' };
  };
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  // the first send is refused (the Host does not know this Mac yet); nothing reached the chat
  await assert.rejects(host.send('a', { text: 'hi' }, { key: 'k-0000001' }), (e: any) => e.code === 'unknown_client');
  assert.equal(ran.size, 0);
  await pairNow();
  // Retry sends the same message under the same key, on the same standing connection
  assert.equal(await host.send('a', { text: 'hi' }, { key: 'k-0000001' }), 'ok');
  assert.equal(await host.send('a', { text: 'hi' }, { key: 'k-0000001' }), 'ok');
  assert.deepEqual([...ran], [['k-0000001', 2]], 'the Host ran the first and answered the second as a replay');
  assert.equal(auths(), 3, 'one proof at attach, one for the refused send, one for the retry');
});

test('after the re-ask the call is still gated by what the Host agreed: a Host that lacks a safety feature is refused, and nothing is sent', async (t) => {
  const { w, identity, pairNow } = unpaired(t);
  let sent = 0;
  w.net.handlers['chat.start'] = () => (sent++, { replayed: false, result: 'ok' });
  const { host } = await onlineRemote(w, {}, { identity: () => identity });
  await pairNow();
  // this Host speaks no `logins` feature: needs() let the call through for the re-ask, so the gate runs after it
  await assert.rejects(
    host.start('a', { harness: 'codex', text: 'hi', cwd: '/w', credential: { source: 'own' } }, { key: 'k-0000001' }),
    (e: any) => Array.isArray(e.missing) && e.missing.includes('logins'),
  );
  assert.equal(sent, 0);
});
