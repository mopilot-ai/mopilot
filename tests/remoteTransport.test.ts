// The in-memory remote transport: delivery both ways, JSON copies, unsubscribe, pair changes and presence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryLink } from '../shared/remote/transport.mjs';

const msg = (id: string) => ({ id, t: 1, kind: 'request' as const, method: 'machine.hello', params: { a: 1 } });

test('messages cross in both directions as copies', async () => {
  const link = createMemoryLink();
  link.addPair('p1');
  const phone = link.phone('p1');
  const atMac: unknown[] = [];
  const atPhone: any[] = [];
  const off = link.mac.onMessage((pair, m) => atMac.push([pair, m]));
  phone.onMessage((m) => atPhone.push(m));
  const sent = msg('m1');
  await phone.send(sent);
  sent.params.a = 2;
  assert.deepEqual(atMac, [['p1', msg('m1')]]);
  const reply = { id: 'm2', t: 2, kind: 'reply' as const, inReplyTo: 'm1', ok: true, result: { x: [1] } };
  await link.mac.send('p1', reply);
  reply.result.x.push(2);
  assert.deepEqual(atPhone, [{ id: 'm2', t: 2, kind: 'reply', inReplyTo: 'm1', ok: true, result: { x: [1] } }]);
  off();
  await phone.send(msg('m3'));
  assert.equal(atMac.length, 1);
});

test('a phone only hears its own pair; unsubscribe stops delivery', async () => {
  const link = createMemoryLink();
  link.addPair('a');
  link.addPair('b');
  const heardA: string[] = [];
  const heardB: string[] = [];
  const offA = link.phone('a').onMessage((m) => heardA.push(m.id));
  link.phone('b').onMessage((m) => heardB.push(m.id));
  await link.mac.send('a', msg('1'));
  offA();
  await link.mac.send('a', msg('2'));
  assert.deepEqual(heardA, ['1']);
  assert.deepEqual(heardB, []);
});

test('pairs, pair changes and presence follow addPair, removePair and setPresence', async () => {
  const link = createMemoryLink();
  const seen: string[][] = [];
  const off = link.mac.onPairsChanged((p) => seen.push(p));
  link.addPair('a');
  link.addPair('b', 'sleeping');
  assert.deepEqual(link.mac.pairs(), ['a', 'b']);
  assert.equal(link.mac.presence('a'), 'online');
  assert.equal(link.mac.presence('b'), 'sleeping');
  link.setPresence('b', 'online');
  link.setPresence('nobody', 'online');
  assert.equal(link.mac.presence('b'), 'online');
  assert.equal(link.mac.presence('nobody'), 'gone');
  link.removePair('a');
  assert.deepEqual(seen, [['a'], ['a', 'b'], ['b']]);
  off();
  link.removePair('b');
  assert.equal(seen.length, 3);
  assert.equal(link.mac.presence('b'), 'gone');
});

test('sends to an unpaired pair reject on both ends', async () => {
  const link = createMemoryLink();
  link.addPair('a');
  const phone = link.phone('a');
  link.removePair('a');
  await assert.rejects(link.mac.send('a', msg('1')), /Unknown pair a/);
  await assert.rejects(phone.send(msg('1')), /Unknown pair a/);
});

test('a send to a pair whose phone is not listening is dropped without error', async () => {
  const link = createMemoryLink();
  link.addPair('a');
  await link.mac.send('a', msg('1'));
});
