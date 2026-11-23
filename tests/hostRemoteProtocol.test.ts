// The remote Host proxy on the versioned protocol (electron/host/remote.cjs): hello and the feature gates, chat requests with the side map's epoch and a key, stale-epoch refusals, and the session stream (Hello, durable, ephemeral, closed, overflow) over a fake network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostWorld, onlineRemote, tick } from './support/host-wire-kit.ts';
import { SIDE_CHAT_FEATURE, SIDE_CHAT_MARKER } from '../shared/host/sideChats.mjs';

const hello =
  (features: string[], protocol = { minor: 1, floor: 1 }) =>
  () => ({ protocol, features });
const frame = (chatId: string, f: object) => ({ event: 'frame', chatId, frame: f });

test('a machine without side chats gets no start, and a compatible Host receives the parent and its epoch', async (t) => {
  const w = hostWorld(t);
  const features = ['epoch', 'dedupe', 'isolation', 'lanes', 'journalLifecycle'];
  w.net.handlers['host.hello'] = hello(features);
  const { host } = await onlineRemote(w);
  const child = `acp:kimi:${SIDE_CHAT_MARKER}${crypto.randomUUID()}`;
  const item = { harness: 'acp:kimi', text: 'question', sideChat: { sourceId: 'acp:kimi:parent', epoch: 3 } };
  await assert.rejects(host.start(child, item), { code: 'feature_missing' });
  assert.equal(
    w.net.last.written.some((r) => r.method === 'chat.start'),
    false,
  );

  const next = hostWorld(t);
  next.net.handlers['host.hello'] = hello([...features, SIDE_CHAT_FEATURE]);
  next.net.handlers['chat.start'] = () => ({ result: { turnId: 'side-turn' } });
  const { host: upgraded } = await onlineRemote(next);
  await upgraded.start(child, item);
  const start = next.net.last.written.find((r) => r.method === 'chat.start');
  assert.deepEqual(start.params.sideChat, item.sideChat);
});

test('chat requests carry the epoch from the side map and a key; a retry passes its own key and the Host runs it once', async (t) => {
  const w = hostWorld(t);
  const epochs = new Map([['a', 4]]);
  let n = 0;
  const { host } = await onlineRemote(w, {}, { epochOf: (id: string) => epochs.get(id) ?? 0, mintKey: () => `minted-key-${++n}0` });
  const seen: any[] = [];
  w.net.handlers['chat.send'] = (p) => (seen.push(p), { replayed: seen.length > 1, result: { turnId: 't1' } });
  assert.deepEqual(await host.send('a', { text: 'hi', model: 'm', future: 1 }), { turnId: 't1' });
  await host.send('a', { text: 'hi' }, { key: 'retry-key-0001' });
  await host.send('a', { text: 'hi' }, { key: 'retry-key-0001' });
  assert.deepEqual([seen[0].epoch, seen[0].key, seen[0].model, 'future' in seen[0]], [4, 'minted-key-10', 'm', false]);
  assert.deepEqual([seen[1].key, seen[2].key], ['retry-key-0001', 'retry-key-0001']);
  const stops: any[] = [];
  w.net.handlers['chat.stop'] = (p) => (stops.push(p), { replayed: false, result: 'stopped' });
  assert.equal(await host.stop('a', 't1'), 'stopped');
  assert.equal(await host.stop('a', undefined, { key: 'stop-key-0001' }), 'stopped');
  assert.deepEqual([stops[0].epoch, stops[0].turnId, stops[1].key], [4, 't1', 'stop-key-0001']);
  const permits: any[] = [];
  w.net.handlers['chat.permit'] = (p) => (permits.push(p), { replayed: false, result: 'set' });
  assert.equal(await host.permit({ chatId: 'a', value: 'plan', key: 'perm-key-0001' }), 'set');
  assert.equal(permits[0].key, 'perm-key-0001');
});

test('B1: a request the schema refuses never reaches the wire', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  await assert.rejects(host.send('a', { text: '' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.send('a', undefined), (e: any) => e.code === 'invalid');
  await assert.rejects(host.permit({ value: 'plan' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.permit(undefined as any), (e: any) => e.code === 'invalid');
  assert.equal(w.net.last.written.length, writes);
});

test('A2: a refusal for an old epoch carries the current one and is not retried', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  w.net.raw['chat.send'] = (id) => ({ id, error: 'That chat is at epoch 7.', code: 'stale_epoch', current: 7 });
  const before = w.net.last.written.length;
  await assert.rejects(host.send('a', { text: 'x' }), (e: any) => e.code === 'stale_epoch' && e.current === 7);
  assert.equal(w.net.last.written.length, before + 1, 'one request, no retry');
  w.net.raw['chat.send'] = (id) => ({ id, error: 'lacks', code: 'feature_missing', missing: ['epoch'] });
  await assert.rejects(host.send('a', { text: 'x' }), (e: any) => e.missing.join() === 'epoch');
});

test('a Host missing a safety feature is refused for chat requests, not served degraded; reads still work', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = hello(['dedupe', 'lanes', 'isolation']);
  const { host } = await onlineRemote(w);
  const before = w.net.last.written.length;
  for (const call of [
    () => host.send('a', { text: 'x' }),
    () => host.stop('a'),
    () => host.permit({ chatId: 'a', value: 'p' }),
    () => host.subscribe('a'),
  ])
    await assert.rejects(call(), (e: any) => e.code === 'feature_missing' && e.missing.includes('epoch'));
  assert.equal(w.net.last.written.length, before, 'nothing was sent');
  assert.deepEqual(await host.chats(), ['a', 'b']);
});

test('an older Host that does not know host.hello, one whose versions are too far apart, and one that answers garbage all refuse chat requests', async (t) => {
  for (const reply of [
    (id: number) => ({ id, error: 'Unknown method host.hello.' }),
    (id: number) => ({ id, result: { protocol: { minor: 0, floor: 0 }, features: [] } }),
    (id: number) => ({ id, result: 'hello' }),
  ]) {
    const w = hostWorld(t);
    w.net.raw['host.hello'] = reply;
    const { host } = await onlineRemote(w);
    assert.equal(host.state(), 'online');
    await assert.rejects(host.send('a', { text: 'x' }), (e: any) =>
      ['feature_missing', 'host_error', 'version_refused', 'invalid'].includes(e.code),
    );
    assert.deepEqual(await host.chats(), ['a', 'b']);
  }
  const w = hostWorld(t);
  w.net.raw['host.hello'] = (id) => ({ id, error: 'nope' });
  const { host } = await onlineRemote(w);
  await assert.rejects(host.subscribe('a'), (e: any) => e.code === 'host_error');
});

test('a hello the Host never answers drops the connection at the deadline and the tunnel reconnects', async (t) => {
  const w = hostWorld(t);
  w.net.hold.add('host.hello');
  const tun = w.tunnel();
  const host = w.remote(tun);
  const up = host.connect();
  await tick();
  w.clock.advance(6000);
  await tick();
  assert.equal(host.state() === 'online', false);
  host.dispose();
  await assert.rejects(up);
});

test('the stream: ephemeral frames are shown live, a closed stream is reported, and an overflow resubscribes from the last rev', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const asked: any[] = [];
  w.net.handlers.subscribe = (p) => (
    asked.push(p), { snapshot: { rev: 2 }, patches: p.fromRev === undefined ? null : [{ chatId: 'a', rev: 3, patch: {} }] }
  );
  const live: any[] = [];
  const closed: any[] = [];
  const got: number[] = [];
  host.events.onPatch((p: any) => got.push(p.rev));
  host.events.onFrame((p: any) => live.push(p));
  host.events.onClosed((p: any) => closed.push(p));
  await host.subscribe('a');
  w.net.last.feed(frame('a', { t: 'delta', seq: 5, key: 'k', delta: 'he' }));
  w.net.last.feed(frame('a', { t: 'retract', seq: 6, key: 'k' }));
  w.net.last.feed(frame('a', { t: 'hello', seq: 7, rev: 2, epoch: 0, snapshot: null }));
  w.net.last.feed({ event: 'frame', frame: { t: 'delta', seq: 8, key: 'k', delta: 'x' } });
  assert.deepEqual(
    live.map((l) => l.frame.t),
    ['delta', 'retract'],
  );
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'overflow' });
  await tick();
  await tick();
  assert.deepEqual(asked.at(-1), { chatId: 'a', epoch: 0, fromRev: 2 });
  assert.deepEqual(got, [3]);
  w.net.last.feed({ event: 'closed', reason: 'moved' });
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'moved' });
  assert.deepEqual(closed, [{ chatId: 'a', reason: 'moved' }]);
  // no longer followed: a later overflow asks nothing
  const asks = asked.length;
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'overflow' });
  await tick();
  assert.equal(asked.length, asks);
});

test('a frame the app cannot read starts the stream again from the last rev; one that arrives while subscribing leaves that to the subscribe', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const asked: any[] = [];
  w.net.handlers.subscribe = (p) => (asked.push(p), { snapshot: { rev: 1 }, patches: null });
  await host.subscribe('a');
  w.net.last.feed(frame('a', { t: 'durable', seq: 2, rev: 'x', item: {} }));
  await tick();
  await tick();
  assert.equal(asked.length, 2);
  w.net.hold.add('chat.subscribe');
  const sub = host.subscribe('b');
  await tick();
  w.net.last.feed(frame('b', { t: 'durable', seq: 'bad' }));
  w.net.hold.clear();
  w.net.last.feed({ id: w.net.last.written.at(-1).id, result: { subscribed: true } });
  await assert.rejects(sub, (e: any) => e.code === 'invalid');
  assert.equal(asked.length, 2);
});

test('events after dispose are gone, and registering on a disposed Host is refused', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const live: any[] = [];
  host.events.onFrame((p: any) => live.push(p));
  host.dispose();
  assert.throws(
    () => host.events.onFrame(() => undefined),
    (e: any) => e.code === 'disposed',
  );
  assert.throws(
    () => host.events.onClosed(() => undefined),
    (e: any) => e.code === 'disposed',
  );
  assert.deepEqual(live, []);
});

test('a call while the connection is down says unreachable, not that the protocol was refused; a live durable that promotes a key says so', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const got: any[] = [];
  host.events.onPatch((p: any) => got.push(p));
  w.net.last.feed(frame('a', { t: 'durable', seq: 1, rev: 1, item: { t: 'assistant' }, promotes: 'reply:t1' }));
  assert.deepEqual(got[0].patch, { item: { t: 'assistant' }, promotes: 'reply:t1' });
  w.children[0].die(255, 'Network is unreachable');
  for (const call of [() => host.send('a', { text: 'x' }), () => host.stop('a'), () => host.subscribe('a')])
    await assert.rejects(call(), (e: any) => e.code === 'host_unreachable');
  host.dispose();
  await assert.rejects(host.send('a', { text: 'x' }), (e: any) => e.code === 'disposed');
});

test('hostInfo reports what the Host declared in its hello, and nothing again once the connection drops', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => ({
    protocol: { minor: 1, floor: 1 },
    features: ['epoch', 'dedupe', 'isolation', 'lanes'],
    capabilities: { iab: true, cu: false, bu: false, shell: true },
  });
  const { host } = await onlineRemote(w);
  assert.deepEqual(host.hostInfo().capabilities, { iab: true, cu: false, desktop: false, bu: false, shell: true });
  w.children[0].die(255, 'Network is unreachable');
  await tick();
  assert.deepEqual(host.hostInfo().capabilities, { iab: false, cu: false, desktop: false, bu: false, shell: false });
});

test('a subscribe names the numbering its rev was counted in, and tells the app the numbering the Host answered in', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const asked: any[] = [];
  let numbering = 'gen-1';
  w.net.handlers.subscribe = (p) => (asked.push(p), { snapshot: { rev: 2 }, patches: null, generation: numbering });
  const resynced: any[] = [];
  host.events.onResync((p: any) => resynced.push(p));
  const first = await host.subscribe('a');
  assert.equal(first.generation, 'gen-1');
  // the Host restarted: its connection drops, and the catch-up on return names the old numbering and is answered in the new one
  numbering = 'gen-2';
  await host.subscribe('a', 2, 'gen-1');
  assert.deepEqual(asked.at(-1), { chatId: 'a', epoch: 0, fromRev: 2, generation: 'gen-1' });
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'overflow' });
  await tick();
  await tick();
  assert.deepEqual(asked.at(-1), { chatId: 'a', epoch: 0, fromRev: 2, generation: 'gen-2' });
  assert.equal(resynced.at(-1).generation, 'gen-2');
});

test('after a catch-up the app is told the text of the unfinished items the Host holds, and a Host that sends none says so', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const inflight = [{ key: 'k', deltas: [{ text: 'he' }], truncated: false }];
  w.net.handlers.subscribe = () => ({ snapshot: { rev: 2 }, patches: [], generation: 'gen-1' });
  const told: any[] = [];
  const off = host.events.onInflight((p: any) => told.push(p));
  assert.deepEqual((await host.subscribe('a')).inflight, []);
  // the Host's Hello lists what is unfinished; the catch-up after an overflow hands it on
  const send = w.net.onRequest.bind(w.net);
  w.net.onRequest = (socket: any, req: any) => {
    if (req.method === 'chat.subscribe') {
      socket.feed(frame('a', { t: 'hello', seq: 9, rev: 2, epoch: 0, generation: 'gen-1', snapshot: null, inFlightEphemeral: inflight }));
      return socket.feed({ id: req.id, result: { subscribed: true } });
    }
    return send(socket, req);
  };
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'overflow' });
  await tick();
  await tick();
  assert.deepEqual(told, [{ chatId: 'a', inflight: [{ key: 'k', deltas: [{ text: 'he' }], truncated: false }] }]);
  off();
  w.net.last.feed({ event: 'closed', chatId: 'a', reason: 'overflow' });
  await tick();
  await tick();
  assert.equal(told.length, 1);
});

test('the first message of a chat is a start with its harness and folder; a send carries the folder; an answer carries the card; all under the side map epoch and a key', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w, {}, { epochOf: () => 2 });
  const seen: Record<string, any> = {};
  for (const m of ['chat.start', 'chat.send', 'chat.answer'])
    w.net.handlers[m] = (p) => ((seen[m] = p), { replayed: false, result: { m } });
  assert.deepEqual(
    await host.start(
      'acp:kimi:c',
      { harness: 'acp:kimi', text: 'go', cwd: '/srv/app', projectId: null, model: 'k2' },
      { key: 'start-key-0001' },
    ),
    { m: 'chat.start' },
  );
  assert.deepEqual(
    [seen['chat.start'].epoch, seen['chat.start'].key, seen['chat.start'].harness, seen['chat.start'].cwd, seen['chat.start'].model],
    [2, 'start-key-0001', 'acp:kimi', '/srv/app', 'k2'],
  );
  await host.start('acp:kimi:c', { harness: 'acp:kimi', text: 'go' });
  assert.match(seen['chat.start'].key, /^[\w-]{8,}$/);
  await host.send('acp:kimi:c', { text: 'more', cwd: '/srv/app' });
  assert.equal(seen['chat.send'].cwd, '/srv/app');
  assert.deepEqual(await host.answer({ chatId: 'acp:kimi:c', requestId: 'p1', optionId: 'allow', key: 'answer-key-001' }), {
    m: 'chat.answer',
  });
  assert.deepEqual([seen['chat.answer'].epoch, seen['chat.answer'].requestId, seen['chat.answer'].optionId], [2, 'p1', 'allow']);
  await host.answer({ chatId: 'acp:kimi:c', requestId: 'p2' });
  assert.equal(seen['chat.answer'].optionId, undefined);
  assert.ok(seen['chat.answer'].key.length >= 8);
  // a request the schema refuses never leaves
  await assert.rejects(host.start('acp:kimi:c', { harness: 'acp:kimi', text: '' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.answer({ chatId: 'acp:kimi:c', requestId: '' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.answer(undefined as any), (e: any) => e.code === 'invalid');
});

test('a Host that does not keep chats apart (no isolation) is refused a chat start, but still takes messages and answers', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = hello(['epoch', 'dedupe', 'lanes']);
  const { host } = await onlineRemote(w);
  await assert.rejects(
    host.start('acp:kimi:c', { harness: 'acp:kimi', text: 'go' }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('isolation'),
  );
  assert.deepEqual(await host.send('acp:kimi:c', { text: 'go' }), 'ok');
  w.net.handlers['chat.answer'] = () => ({ replayed: false, result: { answered: true } });
  assert.deepEqual(await host.answer({ chatId: 'acp:kimi:c', requestId: 'p1' }), { answered: true });
});
