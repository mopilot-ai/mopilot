// A slow push provider holds up nothing but the push: the Mac's next message is handled while the request is out, its answer follows, a push that breaks is answered and logged, and a shutdown waits for the request.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PushService } from '../relay/src/push.mjs';
import { Notifier, REPEAT_MS } from '../relay/src/notifier.mjs';
import { Store } from '../relay/src/store.mjs';
import { makeClock, makeDb, settle, P, frame, paired as pairedOn } from './support/relayKit.ts';
import { waitFor } from './support/waitFor.ts';

const { db, reset } = await makeDb();
beforeEach(reset);
const until = async (done: () => boolean) => {
  await waitFor(done, 'condition');
  assert.ok(done(), 'condition not reached');
};

async function slowProvider() {
  let release: ((r: { ok: boolean }) => void) | undefined;
  const send = () => new Promise<{ ok: boolean }>((resolve) => (release = resolve));
  const r = await pairedOn(db, { send });
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  return { r, admitted: () => release !== undefined, finish: (ok = true) => release!({ ok }) };
}

test("the Mac's next frame is stored and acknowledged while its push request is still out, and the push answer follows with the same request id", async () => {
  const { r, admitted, finish } = await slowProvider();
  r.mac.h.message(JSON.stringify({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat-1', rid: 'push-1' }));
  r.mac.h.message(JSON.stringify(frame('m2p', 0)));
  await until(() => r.mac.socket.sent.some((m) => m.t === 'ack'));
  await waitFor(admitted, 'the background push reaching its provider');
  assert.equal(r.mac.socket.of('push.result').length, 0, 'the provider has not answered');
  finish();
  await until(() => r.mac.socket.of('push.result').length === 1);
  assert.deepEqual(r.mac.socket.of('push.result')[0], { t: 'push.result', pair: P, status: 'sent', rid: 'push-1' });
  const order = r.mac.socket.sent.map((m) => m.t);
  assert.ok(order.indexOf('ack') < order.indexOf('push.result'), 'the frame was answered first');
});

test('a push request that breaks is answered push_failed with its request id and logged once, and the connection goes on', async () => {
  const r = await pairedOn(db, {});
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  r.store.pushTokenOf = async () => {
    throw new Error('connection reset');
  };
  await r.mac.say({ t: 'push', pair: P, kind: 'done', ref: 'chat-2', rid: 'push-2' });
  await settle(r.hub);
  assert.deepEqual(r.mac.socket.last(), { t: 'error', code: 'push_failed', rid: 'push-2', pair: P });
  assert.deepEqual(
    r.logs.filter(([e]) => e === 'error').map(([, d]) => d.message),
    ['connection reset'],
  );
  assert.equal(r.mac.socket.closedWith, null);
});

test('a shutdown waits for a push request that is out, and the answer is sent before the socket closes', async () => {
  const { r, admitted, finish } = await slowProvider();
  r.mac.h.message(JSON.stringify({ t: 'push', pair: P, kind: 'needsYou', ref: 'chat-3', rid: 'push-3' }));
  await waitFor(admitted, 'the shutdown push reaching its provider');
  let done = false;
  const down = r.hub.shutdown({ graceMs: 3000 }).then(() => (done = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(done, false);
  finish();
  await down;
  assert.deepEqual(r.mac.socket.of('push.result')[0], { t: 'push.result', pair: P, status: 'sent', rid: 'push-3' });
  assert.deepEqual(r.mac.socket.closedWith, { code: 1012, reason: 'restarting' });
});

function service(send: (m: any) => Promise<any>) {
  const store = new Store(db as any);
  const clock = makeClock();
  return { push: new PushService({ store, send, now: clock.now }), store, clock };
}
const pair = { pairId: 'p_pair00001', phoneDeviceId: 'ph1' };
const register = (push: PushService) => push.register({ deviceId: 'ph1', userId: 'u1', platform: 'apns', token: 'tok' });

test("one chat's pushes go out in the order they were asked for, and a retried one cannot overtake the one that followed it", async () => {
  const order: string[] = [];
  const gates: (() => void)[] = [];
  const { push } = service(async (m) => {
    order.push(`${m.kind}:start`);
    if (m.kind === 'done') await new Promise<void>((resolve) => gates.push(resolve));
    order.push(`${m.kind}:end`);
    return { ok: true };
  });
  await register(push);
  const first = push.request(pair, 'done', 'chat-1');
  const second = push.request(pair, 'needsYou', 'chat-1');
  const other = push.request(pair, 'done', 'chat-2');
  await waitFor(() => gates.length === 2, 'both independent chats reaching their providers');
  assert.deepEqual(order, ['done:start', 'done:start'], 'the other chat is not held up, the second push of chat-1 waits');
  gates.forEach((g) => g());
  assert.deepEqual(await Promise.all([first, second, other]), ['sent', 'sent', 'sent']);
  assert.deepEqual(
    order.filter((o) => o.startsWith('needsYou')),
    ['needsYou:start', 'needsYou:end'],
  );
  assert.ok(order.indexOf('done:end') < order.indexOf('needsYou:start'), 'needsYou started after the done for the same chat ended');
  assert.equal(push.chains.size, 0, 'nothing is kept for a chat with no push out');
});

test('a phone has at most four push requests out or waiting; the next is failed at once and the count comes back down', async () => {
  const gates: (() => void)[] = [];
  const { push } = service(() => new Promise((resolve) => gates.push(() => resolve({ ok: true }))));
  await register(push);
  const held = Array.from({ length: 4 }, (_, i) => push.request(pair, 'done', `chat-${i}`));
  await waitFor(() => gates.length === 4, 'all four held requests reaching their providers');
  assert.equal(await push.request(pair, 'done', 'chat-9'), 'failed');
  assert.equal(push.pending.get('ph1'), 4);
  gates.forEach((g) => g());
  await Promise.all(held);
  assert.equal(push.pending.size, 0);
  assert.equal(push.metrics.render().includes('relay_push_requests_total{kind="done",status="failed"} 1'), true);
});

test('a push that did not go out is not remembered as shown: the next one for that chat is sent, and a merged count leaves it out', async () => {
  let ok = false;
  const sent: any[] = [];
  const { push } = service(async (m) => (sent.push(m), { ok }));
  await register(push);
  assert.equal(await push.request(pair, 'needsYou', 'chat-1'), 'failed');
  ok = true;
  // a "done" would have been suppressed by the held "needs you"; the failed one is forgotten, so it is sent
  assert.equal(await push.request(pair, 'done', 'chat-1'), 'sent');
  assert.equal(sent.at(-1).title, 'A chat finished');
  const second = service(async (m) => (sent.push(m), { ok: m.ref !== 'chat-b' }));
  await register(second.push);
  assert.equal(await second.push.request(pair, 'done', 'chat-a'), 'sent');
  assert.equal(await second.push.request(pair, 'done', 'chat-b'), 'failed');
  assert.equal(await second.push.request(pair, 'done', 'chat-c'), 'sent');
  assert.equal(sent.at(-1).title, 'A chat finished (2)', 'chat-b never reached the phone, so it is not counted');
});

test('a notice taken back leaves what happened since alone', () => {
  const n = new Notifier();
  const t = 1_000_000;
  const a = n.push('done', 'p:a', t)!;
  const b = n.push('done', 'p:b', t + 1000)!;
  assert.equal(b.title, 'A chat finished (2)');
  // a newer notice for the same chat replaced b's entry: taking b back does not touch it
  // (after the repeat window: inside it the same chat is not pushed again at all)
  const again = t + 1000 + REPEAT_MS;
  const bAgain = n.push('done', 'p:b', again)!;
  b.undo();
  assert.equal(n.byRef.get('p:b')?.at, again);
  assert.equal(n.groups.get('done')?.refs.has('p:b'), true);
  bAgain.undo();
  assert.equal(n.byRef.has('p:b'), true, "the entry bAgain replaced was b's own, which comes back");
  a.undo();
  assert.equal(n.byRef.has('p:a'), false);
  const solo = new Notifier();
  const x = solo.push('needsYou', 'p:x', t)!;
  x.undo();
  assert.deepEqual([solo.byRef.size, solo.groups.size], [0, 0]);
  // a group that had run out (a minute old) is what comes back when the notice that replaced it is taken back
  const stale = new Notifier();
  stale.push('done', 'p:m', t);
  const fresh = stale.push('done', 'p:n', t + 120_000)!;
  assert.equal(stale.groups.get('done')?.refs.has('p:n'), true);
  fresh.undo();
  assert.deepEqual([...stale.groups.get('done')!.refs], ['p:m']);
  // a held "needs you" comes back after a "done" that replaced nothing is taken back
  const held = solo.push('needsYou', 'p:y', t)!;
  const done = solo.push('done', 'p:y', t + 10)!;
  assert.equal(done, null, 'outranked');
  assert.equal(solo.byRef.get('p:y')?.prio, 2);
  held.undo();
  assert.equal(solo.byRef.has('p:y'), false);
});
