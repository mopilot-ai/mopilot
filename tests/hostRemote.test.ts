// The remote Host proxy (electron/host/remote.cjs) over a real tunnel object with a fake ssh, network and clock: calls, host_unreachable on a drop, no queueing, catch-up by rev, malformed replies (B1), truncated and silent connections (B2, B5), dispose while connecting (A3), two windows (A1).
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';
const require = createRequire(import.meta.url);
const { HOST_METHODS, assertHost } = require('../electron/host/interface.cjs');
const { HostUnreachableError } = require('../electron/host/remote.cjs');
const frames = require('../shared/host/frames.mjs');
const unreachable = (e: any) => e.code === 'host_unreachable';
const patch = (chatId: string, rev: number) => ({ event: 'frame', chatId, frame: { t: 'durable', seq: rev, rev, item: { n: rev } } });

test('every interface method goes over the wire and the replies come back', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  for (const m of HOST_METHODS) assert.equal(typeof host[m], 'function');
  assertHost(host);
  assert.deepEqual(host.hostInfo(), {
    id: 'build-box',
    kind: 'ssh',
    state: 'online',
    capabilities: { iab: false, cu: false, desktop: false, bu: false, shell: false },
  });
  w.net.handlers['chat.send'] = (p) => ({ replayed: false, result: { sent: p.chatId, text: p.text, epoch: p.epoch, key: p.key } });
  w.net.handlers['chat.stop'] = (p) => ({ replayed: false, result: `stopped ${p.chatId} ${p.turnId}` });
  w.net.handlers['chat.permit'] = (p) => ({ replayed: false, result: { chat: p.chatId, value: p.value } });
  assert.deepEqual(await host.chats(), ['a', 'b']);
  assert.deepEqual(await host.send('a', { text: 'hi' }, { key: 'retry-key-0001' }), {
    sent: 'a',
    text: 'hi',
    epoch: 0,
    key: 'retry-key-0001',
  });
  assert.equal(await host.stop('a', 't1'), 'stopped a t1');
  assert.deepEqual(await host.permit({ chatId: 'a', value: 'plan' }), { chat: 'a', value: 'plan' });
  assert.equal(await host.connect(), undefined);
});

test('a drop rejects every pending request at once with host_unreachable, and a call while reconnecting is refused, never queued', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.hold.add('chat.send');
  const states: string[] = [];
  host.onState((s: string) => states.push(s));
  const a = assert.rejects(host.send('a', { text: 'x' }), unreachable);
  const b = assert.rejects(host.send('b', { text: 'x' }), unreachable);
  await tick();
  const writes = w.net.last.written.length;
  w.children[0].die(255, 'Network is unreachable');
  await Promise.all([a, b]);
  assert.equal(host.state(), 'offline');
  await assert.rejects(host.chats(), (e: any) => unreachable(e) && e instanceof HostUnreachableError && e.hostId === 'build-box');
  await assert.rejects(host.subscribe('a'), unreachable);
  assert.equal(w.net.last.written.length, writes, 'nothing was queued or sent');
  // the tunnel comes back after its backoff; the same Host object serves calls again
  w.net.hold.clear();
  w.clock.advance(1000);
  await tick();
  await tick();
  assert.equal(host.state(), 'online');
  assert.deepEqual(await host.chats(), ['a', 'b']);
  assert.deepEqual(states, ['offline', 'connecting', 'online']);
});

test('while the tunnel is up but the Host has not answered yet, calls say connecting', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  // the tunnel's own probe is answered; the proxy's first ping is not
  tun.onState((s: string) => s === 'online' && w.net.hold.add('ping'));
  const host = w.remote(tun);
  const up = host.connect();
  await tick();
  await tick();
  assert.equal(host.state(), 'connecting');
  await assert.rejects(host.chats(), (e: any) => unreachable(e) && /connecting/.test(e.reason));
  host.dispose();
  await assert.rejects(up, unreachable);
});

test('subscribe returns the snapshot and patches since fromRev; live patches arrive in order, a duplicate is dropped', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = (p) => ({
    snapshot: { rev: 5 },
    patches:
      p.fromRev === 3
        ? [
            { chatId: 'a', rev: 4, patch: { item: {} } },
            { chatId: 'a', rev: 5, patch: { item: {} } },
          ]
        : null,
  });
  assert.deepEqual(await host.subscribe('a', 3), {
    snapshot: { rev: 5 },
    patches: [
      { chatId: 'a', rev: 4, patch: { item: {} } },
      { chatId: 'a', rev: 5, patch: { item: {} } },
    ],
    generation: '',
    inflight: [],
  });
  assert.deepEqual(await host.subscribe('a'), { snapshot: { rev: 5 }, patches: null, generation: '', inflight: [] });
  const got: number[] = [];
  const off = host.events.onPatch((p: any) => got.push(p.rev));
  const s = w.net.last;
  s.feed(patch('a', 5));
  s.feed(patch('a', 6));
  s.feed(patch('a', 6));
  s.feed(patch('other', 99));
  s.feed({ event: 'patch', chatId: 7, rev: 1, patch: { item: {} } });
  s.feed({ event: 'patch', chatId: 'a', rev: 'x', patch: { item: {} } });
  s.feed({ event: 'patch', chatId: 'a', rev: 7, patch: null });
  s.feed({ event: 'future-thing', x: 1 });
  assert.deepEqual(got, [6, 99]);
  off();
  s.feed(patch('a', 7));
  assert.deepEqual(got, [6, 99]);
});

test('a skipped patch is caught up from the last rev seen, not delivered out of order', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const asked: any[] = [];
  w.net.handlers.subscribe = (p) => (
    asked.push(p),
    p.fromRev === undefined
      ? { snapshot: { rev: 2 }, patches: null }
      : { snapshot: { rev: 5 }, patches: [3, 4, 5].map((rev) => ({ chatId: 'a', rev, patch: { item: {} } })) }
  );
  await host.subscribe('a');
  const got: number[] = [];
  host.events.onPatch((p: any) => got.push(p.rev));
  w.net.last.feed(patch('a', 5));
  w.net.last.feed(patch('a', 5));
  await tick();
  assert.deepEqual(
    asked.map((p) => p.fromRev),
    [undefined, 2],
  );
  assert.deepEqual(got, [3, 4, 5]);
});

test('reconnect catches up by rev: the missed patches, or the snapshot alone when the Host lost some', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: null });
  await host.subscribe('a');
  await host.subscribe('b');
  const got: any[] = [];
  host.events.onPatch((p: any) => got.push(['patch', p.chatId, p.rev]));
  host.events.onResync((p: any) => got.push(['resync', p.chatId, p.snapshot.rev]));
  const asked: any[] = [];
  w.net.handlers.subscribe = (p) => (
    asked.push(p),
    p.chatId === 'a'
      ? {
          snapshot: { rev: 4 },
          patches: [
            { rev: 3, patch: { item: {} } },
            { rev: 4, patch: { item: {} } },
          ],
        }
      : { snapshot: { rev: 9 }, patches: null }
  );
  w.children[0].die();
  w.clock.advance(1000);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(asked, [
    { chatId: 'a', epoch: 0, fromRev: 2 },
    { chatId: 'b', epoch: 0, fromRev: 2 },
  ]);
  assert.deepEqual(got, [
    ['patch', 'a', 3],
    ['patch', 'a', 4],
    ['resync', 'b', 9],
  ]);
  // the snapshot's rev is the new baseline
  w.net.last.feed(patch('b', 10));
  assert.deepEqual(got.at(-1), ['patch', 'b', 10]);
});

test('a catch-up the Host refuses drops the chat from the follow list; one cut off by a drop is retried on return', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1 }, patches: [] });
  await host.subscribe('a');
  w.net.handlers.subscribe = () => {
    throw Object.assign(new Error('gone'), { code: 'not-owned' });
  };
  w.net.last.feed(patch('a', 3));
  await tick();
  const got: number[] = [];
  host.events.onPatch((p: any) => got.push(p.rev));
  w.net.last.feed(patch('a', 3));
  assert.deepEqual(got, [3], 'no longer followed: delivered as is');
  // cut off: the connection drops while the catch-up waits
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 1 }, patches: [] });
  await host.subscribe('c');
  w.net.hold.add('chat.subscribe');
  w.net.last.feed(patch('c', 5));
  await tick();
  w.children[0].die();
  await tick();
  w.net.hold.clear();
  const asked: any[] = [];
  w.net.handlers.subscribe = (p) => (asked.push(p), { snapshot: { rev: 5 }, patches: [{ rev: 5, patch: { item: {} } }] });
  w.clock.advance(1000);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(asked, [{ chatId: 'c', epoch: 0, fromRev: 1 }]);
});

test('B1: a reply without a result, with a stray id, or with an error in either shape never becomes success', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.raw['chat.stop'] = (id) => ({ id });
  await assert.rejects(host.stop('a'), (e: any) => e.code === 'invalid');
  delete w.net.raw['chat.stop'];
  w.net.handlers['chat.stop'] = () => {
    throw Object.assign(new Error('not yours'), { code: 'not-owned' });
  };
  await assert.rejects(host.stop('a'), (e: any) => e.code === 'not-owned' && e.message === 'not yours');
  w.net.raw['chat.stop'] = (id) => ({ id, error: 'older host: plain text' });
  await assert.rejects(host.stop('a'), (e: any) => e.code === 'host_error' && /plain text/.test(e.message));
  w.net.raw['chat.stop'] = (id) => ({ id, error: {} });
  await assert.rejects(host.stop('a'), (e: any) => e.code === 'host_error' && e.message === 'The Host failed.');
  w.net.last.feed({ id: 9999, result: 1 });
  w.net.last.feed({ id: null, error: 'x' });
  for (const bad of [[1], 'x', null]) {
    w.net.handlers.chats = () => bad;
    await assert.rejects(host.chats(), (e: any) => e.code === 'invalid');
  }
  for (const bad of [{ snapshot: {} }, { snapshot: { rev: -1 } }, null]) {
    w.net.handlers.subscribe = () => bad;
    await assert.rejects(host.subscribe('a'), (e: any) => e.code === 'invalid');
  }
  await assert.rejects(host.subscribe(''), (e: any) => e.code === 'invalid');
  assert.equal(host.state(), 'online');
});

test('B2: a connection that ends mid-frame, or sends a bad frame, drops it at once and takes the tunnel down to reconnect', async (t) => {
  const w = hostWorld(t);
  const { host, tun } = await onlineRemote(w);
  // the backoff grows after each quick drop: step the clock a second at a time, letting the probe run between steps
  const settle = async () => {
    await waitFor(() => host.state() === 'online', 'the host to come online', {
      step: async () => {
        w.clock.advance(1000);
        await tick();
      },
    });
    await tick();
  };
  w.net.hold.add('chats');
  const p = assert.rejects(host.chats(), unreachable);
  await tick();
  const frame = frames.encodeControl({ id: 1, result: [] });
  w.net.last.feed(frame.subarray(0, 5));
  w.net.last.emit('close');
  await p;
  assert.equal(host.state(), 'offline');
  assert.equal(tun.state, 'offline');
  assert.match(tun.reason, /middle of a frame/);
  await settle();
  assert.equal(host.state(), 'online');
  const q = assert.rejects((w.net.hold.add('chats'), host.chats()), unreachable);
  await tick();
  w.net.last.feed('}{ not json\n');
  await q;
  assert.match(tun.reason, /bad frame/);
  // a close with nothing half-sent, and a socket error
  await settle();
  w.net.last.emit('close');
  assert.match(tun.reason, /connection closed/);
  await settle();
  w.net.last.emit('error', new Error('read ECONNRESET'));
  assert.match(tun.reason, /ECONNRESET/);
});

test('B5: a connection that never answers its first ping, or goes silent later, is declared dead and the tunnel reconnects', async (t) => {
  const w = hostWorld(t);
  const { host, tun } = await onlineRemote(w, { helloMs: 1000 }, { helloMs: 500, heartbeatMs: 1000 });
  // silent after being up: the heartbeat's ping gets no frame back
  w.net.hold.add('ping');
  w.net.hold.add('chats');
  const p = assert.rejects(host.chats(), unreachable);
  w.clock.advance(1000);
  assert.equal(host.state(), 'online', 'one quiet beat is not yet silence');
  w.clock.advance(1000);
  w.clock.advance(1000);
  await p;
  assert.equal(host.state(), 'offline');
  assert.match(tun.reason, /stopped answering/);
});

test('B5: a connection whose first ping goes unanswered is dropped at the hello deadline and the tunnel reconnects', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  // the tunnel's own probe is answered; the proxy's connection, made right after, is not
  tun.onState((s: string) => s === 'online' && w.net.hold.add('ping'));
  const host = w.remote(tun, { helloMs: 500 });
  const up = assert.rejects(host.connect(), unreachable);
  await tick();
  assert.equal(host.state(), 'connecting');
  w.clock.advance(500);
  assert.match(tun.reason, /did not answer/);
  assert.equal(w.net.last.destroyed, true);
  host.dispose();
  await up;
});

test('B5: a Host that answers pings keeps a long request pending (no timeout of its own)', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w, {}, { heartbeatMs: 1000 });
  w.net.hold.add('chat.send');
  let settled = false;
  const p = host.send('a', { text: 'x' }).finally(() => (settled = true));
  for (let i = 0; i < 10; i++) {
    w.clock.advance(1000);
    await tick();
  }
  assert.equal(settled, false);
  w.net.last.feed({ id: 3, result: { replayed: false, result: 'late' } });
  assert.equal(await p, 'late');
});

test('A3: dispose while connecting rejects connect, releases the tunnel and starts no reconnect', async (t) => {
  const w = hostWorld(t);
  w.net.mode = 'refuse';
  const tun = w.tunnel();
  const host = w.remote(tun);
  const up = host.connect();
  await tick();
  host.dispose();
  await assert.rejects(up, unreachable);
  assert.equal(tun.leases, 0);
  assert.equal(tun.state, 'offline');
  w.clock.advance(120_000);
  assert.equal(w.children.length, 1);
  assert.equal(w.clock.pending, 0);
});

test('dispose rejects what is pending, refuses later calls, and is safe twice; connect after dispose is refused', async (t) => {
  const w = hostWorld(t);
  const { host, tun } = await onlineRemote(w);
  w.net.hold.add('chat.send');
  const p = assert.rejects(host.send('a', { text: 'x' }), unreachable);
  await tick();
  let states = 0;
  host.onState(() => states++);
  host.dispose();
  host.dispose();
  await p;
  assert.equal(states, 1);
  assert.equal(host.state(), 'offline');
  assert.equal(tun.leases, 0);
  await assert.rejects(host.chats(), (e: any) => e.code === 'disposed');
  await assert.rejects(host.subscribe('a'), (e: any) => e.code === 'disposed');
  assert.throws(
    () => host.events.onPatch(() => {}),
    (e: any) => e.code === 'disposed',
  );
  assert.throws(
    () => host.events.onResync(() => {}),
    (e: any) => e.code === 'disposed',
  );
  assert.throws(
    () => host.connect(),
    (e: any) => e.code === 'disposed',
  );
  // the tunnel's state changing afterwards does not touch the disposed Host
  tun.fail('x');
});

test('A1: two windows on one Host share one tunnel; one disposing keeps the other online', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const one = w.remote(tun);
  const two = w.remote(tun);
  await Promise.all([one.connect(), two.connect(), tick()]);
  await tick();
  await Promise.all([one.connect(), two.connect()]);
  assert.equal(w.children.length, 1);
  assert.equal(tun.leases, 2);
  one.dispose();
  assert.equal(tun.state, 'online');
  assert.deepEqual(await two.chats(), ['a', 'b']);
  two.dispose();
  assert.equal(tun.state, 'offline');
});

test('connect called twice takes one lease; connect while already online resolves at once', async (t) => {
  const w = hostWorld(t);
  const tun = w.tunnel();
  const host = w.remote(tun);
  const a = host.connect();
  const b = host.connect();
  await tick();
  await Promise.all([a, b]);
  assert.equal(tun.leases, 1);
  await host.connect();
  assert.equal(tun.leases, 1);
});

test('bytes from a connection that was dropped are ignored; a catch-up list with garbage in it delivers only what is newer', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: [] });
  await host.subscribe('a');
  const got: number[] = [];
  host.events.onPatch((p: any) => got.push(p.rev));
  const old = w.net.last;
  w.children[0].die();
  old.feed(patch('a', 3));
  assert.deepEqual(got, []);
  w.net.handlers.subscribe = () => ({
    snapshot: { rev: 4 },
    patches: [null, { rev: 'x' }, { rev: 1, patch: { item: {} } }, { rev: 3, patch: { item: {} } }, { rev: 4, patch: { item: {} } }],
  });
  w.clock.advance(1000);
  await tick();
  await tick();
  await tick();
  assert.deepEqual(got, [3, 4]);
});

test("without an injected connect, the proxy and the tunnel dial the tunnel's unix socket with node:net", async (t) => {
  const w = hostWorld(t);
  // a real tunnel object whose probe really dials a socket that does not exist
  const tun = w.tunnel({ connect: undefined });
  const lease = tun.acquire();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(tun.state, 'connecting');
  lease.release();
  // a tunnel that claims to be online on a path nobody listens on: the proxy's connection fails and it takes the tunnel down
  const failed: string[] = [];
  const stub = {
    state: 'online',
    acquire: () => ({ socketPath: `${w.dir}/none.sock`, release() {} }),
    onState: () => () => {},
    fail: (why: string) => failed.push(why),
  };
  const host = w.remote(stub, { connect: undefined });
  host.connect().catch(() => {});
  await new Promise((r) => setTimeout(r, 50));
  assert.match(failed[0], /ENOENT/);
  host.dispose();
});

test('a request too large for the wire is refused by the schema at once and leaves nothing pending', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  await assert.rejects(host.send('a', { text: 'x'.repeat(9 * 1024 * 1024) }), (e: any) => e.code === 'invalid');
  assert.equal(w.net.last.written.length, writes);
  w.net.handlers['chat.send'] = () => ({ replayed: false, result: 'fine' });
  assert.equal(await host.send('a', { text: 'x' }), 'fine');
});

test('patches that arrive before a subscribe reply are held: older ones are dropped, a newer one triggers a catch-up after the reply', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const got: number[] = [];
  host.events.onPatch((p: any) => got.push(p.rev));
  const asked: any[] = [];
  w.net.hold.add('chat.subscribe');
  const sub = host.subscribe('a');
  await tick();
  w.net.last.feed(patch('a', 5));
  w.net.last.feed(patch('a', 7));
  w.net.last.feed(patch('a', 6));
  w.net.hold.clear();
  w.net.handlers.subscribe = (p) => (
    asked.push(p),
    { snapshot: { rev: 5 }, patches: p.fromRev === 5 ? [6, 7].map((rev) => ({ chatId: 'a', rev, patch: { item: {} } })) : [] }
  );
  const id = w.net.last.written.at(-1).id;
  w.net.last.feed({
    event: 'frame',
    chatId: 'a',
    frame: { t: 'hello', seq: 0, rev: 5, epoch: 0, snapshot: { rev: 5 }, inFlightEphemeral: [] },
  });
  w.net.last.feed({ id, result: { subscribed: true } });
  assert.deepEqual(await sub, { snapshot: { rev: 5 }, patches: null, generation: '', inflight: [] });
  await tick();
  await tick();
  assert.deepEqual(asked, [{ chatId: 'a', epoch: 0, fromRev: 5 }]);
  assert.deepEqual(got, [6, 7], 'delivered once each, after the snapshot');
  // a subscribe that fails releases the hold
  w.net.handlers.subscribe = () => {
    throw new Error('no');
  };
  await assert.rejects(host.subscribe('b'));
  w.net.last.feed(patch('b', 1));
  assert.deepEqual(got.at(-1), 1);
});
