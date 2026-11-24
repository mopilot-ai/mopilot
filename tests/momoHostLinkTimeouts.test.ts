// A machine that never answers does not hang MoMo's home, and one that could not be reached is not dialled again at once (host/src/momoTasks/homeClient.mjs), against a fake transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createHomeKey } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { BACKOFF_MAX_MS, BACKOFF_MS, createHomeClient } from '../host/src/momoTasks/homeClient.mjs';
import { AUTH, fakeHost, LEASE, MACHINE, sealed, tmp } from './support/hostLinkKit.ts';
import { waitFor } from './support/waitFor.ts';

const never = () => new Promise<never>(() => undefined);

function world(t: any, dial: () => Promise<any>) {
  const key = createHomeKey({ ...sealed(tmp(t)), homeId: () => 'home-a' });
  const clock = { at: 1000 };
  const client = createHomeClient({
    identity: () => key.identity(),
    stamp: () => LEASE,
    dial,
    openMs: 300,
    requestMs: 50,
    now: () => clock.at,
  });
  return { client, clock };
}

test('a dial that never answers is given up, the machine is offline, and it is not dialled again until the wait is over; the wait doubles to a cap and a success clears it', async (t) => {
  let dials = 0;
  let hang = true;
  const w = world(t, async () => {
    dials++;
    if (hang) return never();
    return fakeHost({ ...AUTH, 'host.status': { ok: 1 } }).transport;
  });
  const offline = (e: any) => e.code === 'machine_offline';
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, 1);
  // within the wait: refused at once, nothing dialled
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  w.clock.at += BACKOFF_MS - 1;
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, 1);
  // after it: one more try, and the next wait is twice as long
  w.clock.at += 1;
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, 2);
  w.clock.at += BACKOFF_MS * 2 - 1;
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, 2);
  w.clock.at += 1;
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, 3);
  // it stops growing at the cap
  for (let i = 0; i < 6; i++) {
    w.clock.at += BACKOFF_MAX_MS;
    await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  }
  const before = dials;
  w.clock.at += BACKOFF_MAX_MS - 1;
  await assert.rejects(w.client.call(MACHINE, 'host.status'), offline);
  assert.equal(dials, before);
  // reachable again: a success clears the wait, so the next failure starts from the first step
  hang = false;
  w.clock.at += 1;
  assert.deepEqual(await w.client.call(MACHINE, 'host.status'), { ok: 1 });
});

test('a handshake that never answers closes the connection and is told as offline', async (t) => {
  const host = fakeHost({ 'host.challenge': never });
  const w = world(t, async () => host.transport);
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_offline');
  assert.equal(host.closed(), 1);
});

test('a request that never answers is told as lost, closes the connection, and the next call makes a new one', async (t) => {
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const w = world(t, async () => {
    // the first connection hangs on its request and does not report that it closed
    const h = fakeHost({ ...AUTH, 'host.status': hosts.length === 0 ? never : { ok: 2 } });
    hosts.push(h);
    return h.transport;
  });
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_lost');
  assert.equal(hosts[0].closed(), 1);
  assert.deepEqual(await w.client.call(MACHINE, 'host.status'), { ok: 2 });
  assert.equal(hosts.length, 2);
});

test('a connection that lands after the attempt was given up is closed and never signs anything', async (t) => {
  const host = fakeHost(AUTH);
  let land: (v: any) => void = () => undefined;
  const w = world(t, () => new Promise((r) => (land = r)));
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_offline');
  land(host.transport);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(host.closed(), 1);
  assert.deepEqual(host.calls, [], 'nothing was asked of it');
});

test('a dial that fails with a message is reached again after the wait, and a closed client forgets the wait', async (t) => {
  let n = 0;
  const w = world(t, async () => {
    if (++n === 1) throw new Error('no route');
    return fakeHost({ ...AUTH, 'host.status': { ok: 3 } }).transport;
  });
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_offline');
  await w.client.close();
  assert.deepEqual(await w.client.call(MACHINE, 'host.status'), { ok: 3 });
});

test('a connection closed while the hello is being answered is not handed out', async (t) => {
  let answer: (v: any) => void = () => undefined;
  const host = fakeHost({ ...AUTH, 'host.hello': () => new Promise((r) => (answer = r)) });
  const w = world(t, async () => host.transport);
  const call = w.client.call(MACHINE, 'host.status');
  // the hello has been asked: wait until it is, then the client is closed (a move begins)
  await waitFor(() => host.calls.some((c) => c.method === 'host.hello'), 'the hello to be asked');
  await w.client.close();
  answer({});
  await assert.rejects(call, (e: any) => e.code === 'machine_offline');
  assert.equal(
    host.calls.some((c) => c.method === 'host.status'),
    false,
    'nothing was asked after the close',
  );
});
