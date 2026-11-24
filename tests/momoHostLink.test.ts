// MoMo's home as a client of another Host (host/src/momoTasks/homeKey.mjs, homeMachines.mjs, homeClient.mjs, remoteMachine.mjs, router.mjs, sessionEvents.mjs), against a FAKE transport: the key and the machines kept sealed, the proof and the lease on every request, the words of each failure, the events of a remote session and the routing beside this Host's own machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
// @ts-ignore: plain ESM without declarations
import { createHomeKey } from '../host/src/momoTasks/homeKey.mjs';
// @ts-ignore
import { createHomeClient } from '../host/src/momoTasks/homeClient.mjs';
import { AUTH, coded, fakeHost, HOST_B, LEASE, MACHINE, nextTick, sealed, tmp } from './support/hostLinkKit.ts';

// ----- the key and the machines -----------------------------------------------------------------

// ----- the home client ---------------------------------------------------------------------------

async function clientWorld(
  t: any,
  answers: Record<string, any> = AUTH,
  over: { stamp?: any; dial?: any; now?: () => number; openMs?: number; requestMs?: number } = {},
) {
  const key = createHomeKey({ ...sealed(tmp(t)), homeId: () => 'home-a' });
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const client = createHomeClient({
    identity: () => key.identity(),
    stamp: over.stamp ?? (() => LEASE),
    ...(over.now ? { now: over.now } : {}),
    ...(over.openMs ? { openMs: over.openMs } : {}),
    ...(over.requestMs ? { requestMs: over.requestMs } : {}),
    dial:
      over.dial ??
      (async () => {
        const h = fakeHost(answers);
        hosts.push(h);
        return h.transport;
      }),
  });
  return { client, hosts, key };
}

test('the home proves its key to a Host, says hello with its lease and stamps every request; one connection is reused', async (t) => {
  const { client, hosts, key } = await clientWorld(t, { ...AUTH, 'host.status': { harnesses: [] } });
  assert.deepEqual(await client.call(MACHINE, 'host.status', {}), { harnesses: [] });
  await client.call(MACHINE, 'host.status', {});
  assert.equal(hosts.length, 1);
  const calls = hosts[0].calls;
  assert.deepEqual(
    calls.map((c) => c.method),
    ['host.challenge', 'host.challenge', 'host.auth', 'host.hello', 'host.status', 'host.status'],
  );
  const auth = calls[2].params;
  assert.equal(auth.publicKey, await key.publicKey());
  assert.ok(
    crypto.verify(
      null,
      Buffer.from(`auth\n${HOST_B}\nn1`),
      crypto.createPublicKey({ key: Buffer.from(auth.publicKey, 'base64'), format: 'der', type: 'spki' }),
      Buffer.from(auth.signature, 'base64'),
    ),
  );
  assert.deepEqual(calls[3].params.home, LEASE);
  assert.deepEqual(calls[4].params.home, LEASE);
  // nothing of the private key is in what was sent
  assert.equal(JSON.stringify(calls).includes('privateKey'), false);
  assert.ok(key);
});

test('a machine that cannot be dialled is offline and is dialled again next time; a lost connection too', async (t) => {
  let n = 0;
  const hosts: ReturnType<typeof fakeHost>[] = [];
  const clock = { at: 1000 };
  const { client } = await clientWorld(t, AUTH, {
    now: () => clock.at,
    dial: async () => {
      if (++n === 1) throw new Error('no route');
      const h = fakeHost({ ...AUTH, 'host.status': { ok: 1 } });
      hosts.push(h);
      return h.transport;
    },
  });
  await assert.rejects(
    client.call(MACHINE, 'host.status'),
    (e: any) => e.code === 'machine_offline' && /Studio is offline/.test(e.message),
  );
  clock.at += 30_000;
  assert.deepEqual(await client.call(MACHINE, 'host.status'), { ok: 1 });
  hosts[0].drop();
  assert.deepEqual(await client.call(MACHINE, 'host.status'), { ok: 1 });
  assert.equal(hosts.length, 2);
  // a close that arrives after a newer connection replaced it does not drop the newer one
  hosts[0].drop();
  await client.call(MACHINE, 'host.status');
  assert.equal(hosts.length, 2);
  await assert.rejects(
    (async () => {
      const w = await clientWorld(t, AUTH, { dial: async () => Promise.reject('plain') });
      await w.client.call(MACHINE, 'host.status');
    })(),
    (e: any) => e.code === 'machine_offline',
  );
});

test('a Host that does not serve this key says MoMo is not allowed there; any other refusal keeps its code', async (t) => {
  for (const code of ['unknown_client', 'home_not_allowed']) {
    const w = await clientWorld(t, { ...AUTH, 'host.auth': coded(code) });
    await assert.rejects(
      w.client.call(MACHINE, 'host.status'),
      (e: any) => e.code === 'machine_not_allowed' && /isn't allowed to use Studio/.test(e.message),
    );
    assert.equal(w.hosts[0].closed(), 1, 'the connection is closed');
  }
  const stale = await clientWorld(t, { ...AUTH, 'host.hello': coded('home_lease_stale') });
  await assert.rejects(stale.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'home_lease_stale');
  const odd = await clientWorld(t, { ...AUTH, 'host.hello': new Error('socket closed') });
  await assert.rejects(odd.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'machine_offline');
  const removed = await clientWorld(t, { ...AUTH, 'chat.stop': coded('unknown_client') });
  await assert.rejects(removed.client.call(MACHINE, 'chat.stop', {}), (e: any) => e.code === 'machine_not_allowed');
  const refused = await clientWorld(t, { ...AUTH, 'chat.start': coded('home_mode_refused', 'no') });
  await assert.rejects(refused.client.call(MACHINE, 'chat.start', {}), (e: any) => e.code === 'home_mode_refused');
  const dead = await clientWorld(t, { ...AUTH, 'chat.start': new Error('closed') });
  // a connection lost after the request went may have started it; one that never opened plainly did not
  await assert.rejects(
    dead.client.call(MACHINE, 'chat.start', {}),
    (e: any) => e.code === 'machine_lost' && /may have started/.test(e.message),
  );
  const never = await clientWorld(t, AUTH, { dial: async () => Promise.reject(new Error('no route')) });
  await assert.rejects(never.client.call(MACHINE, 'chat.start', {}), (e: any) => e.code === 'machine_offline');
  // another reason a Host answers 'invalid' (a challenge it cannot make) is its own cause, not a changed machine
  const broken = await clientWorld(t, { ...AUTH, 'host.challenge': { hostId: HOST_B } });
  await assert.rejects(broken.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'invalid');
});

test('a connection closed while it was being dialled is closed when it lands, and nothing is signed or handed out for it', async (t) => {
  const key = createHomeKey({ ...sealed(tmp(t)), homeId: () => 'home-a' });
  let land: (h: ReturnType<typeof fakeHost>) => void = () => undefined;
  const dialled = new Promise<ReturnType<typeof fakeHost>>((r) => (land = r));
  const host = fakeHost({ ...AUTH, 'host.status': {} });
  const client = createHomeClient({ identity: () => key.identity(), stamp: () => LEASE, dial: async () => (await dialled).transport });
  const call = client.call(MACHINE, 'host.status');
  const refused = assert.rejects(call, (e: any) => e.code === 'machine_offline');
  await nextTick();
  await client.close();
  land(host);
  await refused;
  assert.equal(host.closed(), 1, 'the late connection was closed');
  assert.equal(
    host.calls.some((c) => c.method === 'host.auth'),
    false,
    'no proof was signed for it',
  );
});

test('a Host that is not the running home dials nothing', async (t) => {
  let dialled = 0;
  const w = await clientWorld(t, AUTH, { stamp: () => null, dial: async () => void dialled++ });
  await assert.rejects(w.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'momo_home_away');
  // the lease went away while the connection was being made
  let on = true;
  const late = await clientWorld(t, { ...AUTH, 'host.status': {} }, { stamp: () => (on ? LEASE : null) });
  await late.client.call(MACHINE, 'host.status');
  on = false;
  await assert.rejects(late.client.call(MACHINE, 'host.status'), (e: any) => e.code === 'momo_home_away');
  assert.equal(dialled, 0);
});

test('events of one chat reach its listener only; close ends every connection', async (t) => {
  const w = await clientWorld(t, { ...AUTH, 'host.status': {} });
  const got: any[] = [];
  await w.client.listen(MACHINE, 'claude:t1', (e) => got.push(e));
  w.hosts[0].push({ event: 'frame', chatId: 'claude:t1', n: 1 });
  w.hosts[0].push({ event: 'frame', chatId: 'claude:other', n: 2 });
  w.hosts[0].push(null);
  assert.deepEqual(
    got.map((e) => e.n),
    [1],
  );
  await w.client.unlisten(MACHINE.id, 'claude:t1');
  w.hosts[0].push({ event: 'frame', chatId: 'claude:t1', n: 3 });
  assert.equal(got.length, 1);
  await w.client.unlisten('unknown', 'x');
  // a failed attempt is closed over too
  const bad = await clientWorld(t, { ...AUTH, 'host.auth': coded('unknown_client') });
  await bad.client.call(MACHINE, 'x').catch(() => undefined);
  await bad.client.close();
  await w.client.close();
  assert.equal(w.hosts[0].closed(), 1);
});
