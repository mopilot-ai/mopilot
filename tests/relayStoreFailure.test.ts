// A frame the relay fails to store (the database times out) is tried again in place, so a transient failure costs a delay and no frame; one that keeps failing is not acknowledged and ends the connection before anything queued behind it can be stored ahead of it, and the sender's resend in order after reconnecting delivers every frame.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { handleFrame, RETRY_PAUSES_MS, STORE_FAILED_CLOSE } from '../relay/src/frameRetry.mjs';
import { frame, makeDb, paired, settle } from './support/relayKit.ts';

async function setup(o: any = {}) {
  const { db } = await makeDb();
  await migrateDurable(db);
  const pauses: number[] = [];
  const r = (await paired(db, { durable: true, sleep: async (ms: number) => void pauses.push(ms), ...o })) as any;
  return Object.assign(r, { pauses });
}
const ctrs = (socket: any, t: string) => socket.sent.filter((m: any) => m.t === t).map((m: any) => m.ctr);
const acks = (socket: any) => socket.sent.filter((m: any) => m.t === 'ack').map((m: any) => `${m.ctr}:${m.via}`);
const errors = (socket: any) => socket.sent.filter((m: any) => m.t === 'error').map((m: any) => `${m.code}:${m.ctr}`);
const burst = (r: any, ...list: number[]) => list.forEach((ctr) => r.mac.h.message(JSON.stringify(frame('m2p', ctr))));

test('a store that fails once is tried again in place: every frame is stored in order, the sender hears nothing about it', async () => {
  const r = await setup();
  const durable = r.hub.mailbox.durable;
  const real = durable.enqueue.bind(durable);
  let failures = 0;
  durable.enqueue = async (f: any) => {
    if (f.ctr === 1 && failures++ === 0) throw new Error('timeout exceeded when trying to connect');
    return real(f);
  };
  const pace = r.hub.pace.bind(r.hub);
  let paced = 0;
  r.hub.pace = (...args: any[]) => (paced++, pace(...args));
  burst(r, 1, 2, 3);
  await settle(r.hub);
  assert.deepEqual(acks(r.mac.socket), ['1:mailbox', '2:mailbox', '3:mailbox']);
  assert.deepEqual(ctrs(r.phone.socket, 'frame'), [1, 2, 3], 'in order, nothing skipped');
  assert.equal(paced, 6, 'two rate-limit checks per frame; the retry of frame 1 did not pay again');
  assert.deepEqual(errors(r.mac.socket), []);
  assert.equal(r.mac.socket.closedWith, null);
  assert.deepEqual(r.pauses, [RETRY_PAUSES_MS[0]]);
  assert.deepEqual(
    r.logs.filter(([e]: any) => e === 'frame_retry').map(([, d]: any) => `${d.attempt}:${d.message}`),
    ['1:timeout exceeded when trying to connect'],
  );
});

test('a store that keeps failing ends the connection with the sender told; nothing behind the frame is stored, and resending in order after reconnecting delivers every frame', async () => {
  const r = await setup();
  const durable = r.hub.mailbox.durable;
  const real = durable.enqueue.bind(durable);
  let down = true;
  durable.enqueue = async (f: any) => {
    if (down && f.ctr === 1) throw new Error('timeout exceeded when trying to connect');
    return real(f);
  };
  burst(r, 1, 2, 3);
  await settle(r.hub);
  assert.deepEqual(r.pauses, RETRY_PAUSES_MS, 'it was tried again after each pause before giving up');
  assert.deepEqual(errors(r.mac.socket), ['unavailable:1'], 'the sender is told which frame was not stored');
  assert.deepEqual(r.mac.socket.closedWith, { code: STORE_FAILED_CLOSE, reason: 'storing failed' });
  assert.deepEqual(acks(r.mac.socket), [], 'nothing was acknowledged, and the frames behind the failed one were never handled');
  assert.deepEqual(ctrs(r.phone.socket, 'frame'), []);
  assert.equal(r.logs.filter(([e]: any) => e === 'error').length, 1, 'the final failure is logged once');
  // the relay ending a connection is not the Mac vanishing, and the close is counted under its own code
  r.mac.h.close(STORE_FAILED_CLOSE);
  await settle(r.hub);
  assert.equal(r.pushed.filter((p: any) => p.kind === 'machineOffline').length, 0);
  assert.match(r.hub.metrics.render(), /relay_closes_total\{code="4500"\} 1/);

  down = false;
  const again = await r.join('u1', 'mac1', 'desktop');
  for (const ctr of [1, 2, 3]) await again.say(frame('m2p', ctr));
  await settle(r.hub);
  assert.deepEqual(acks(again.socket), ['1:mailbox', '2:mailbox', '3:mailbox']);
  assert.deepEqual(ctrs(r.phone.socket, 'frame'), [1, 2, 3], 'the phone received every frame, in order');
});

test('a lookup that fails before the store is reached is handled the same way', async () => {
  const r = await setup();
  const real = r.store.getPair.bind(r.store);
  r.store.getPair = async () => {
    throw new Error('db down');
  };
  r.hub.cache.clear();
  burst(r, 1, 2);
  await settle(r.hub);
  assert.deepEqual(errors(r.mac.socket), ['unavailable:1']);
  assert.equal(r.mac.socket.closedWith?.code, STORE_FAILED_CLOSE);
  r.store.getPair = real;
  const again = await r.join('u1', 'mac1', 'desktop');
  await again.say(frame('m2p', 1));
  assert.deepEqual(acks(again.socket), ['1:mailbox']);
});

test('refusing a frame because the mailbox is full is not a failure: the connection stays and its sender is told', async () => {
  const r = await setup({ mailbox: { ttlMs: 7 * 24 * 3600_000, maxFrames: 1, maxBytes: 1024 * 1024 } });
  await r.mac.say(frame('m2p', 1));
  await r.mac.say(frame('m2p', 2));
  assert.deepEqual(errors(r.mac.socket), ['mailbox_full:2']);
  assert.equal(r.mac.socket.closedWith, null);
  assert.deepEqual(r.pauses, []);
});

test('the retry loop leaves a connection that ended or a relay that is shutting down to its own handling, and stops waiting when either happens during a pause', async () => {
  const calls: string[] = [];
  const hubWith = (o: any) => ({
    frame: async (_c: any, _m: any, _f: any, again: boolean) => {
      calls.push(`frame:${again}`);
      throw new Error('boom');
    },
    drop: (_c: any, code: number, reason: string) => calls.push(`drop:${code}:${reason}`),
    log: () => undefined,
    sleep: async () => void calls.push('sleep'),
    draining: false,
    ...o,
  });
  const conn = (o: any = {}) => ({ identity: { deviceId: 'd' }, closed: false, ...o }) as any;
  const fail = async (code: string, extra: any) => (calls.push(`fail:${code}:${extra.ctr}`), true);

  // already gone or shutting down: no answer, no close of its own, the error is for the log
  await assert.rejects(handleFrame(hubWith({ draining: true }) as any, conn(), { pair: 'p', ctr: 4 }, fail), /boom/);
  await assert.rejects(handleFrame(hubWith({}) as any, conn({ closed: true }), { pair: 'p', ctr: 5 }, fail), /boom/);
  assert.deepEqual(calls.splice(0), ['frame:false', 'frame:false']);

  // each new attempt says it is one (so it does not pay the rate limits again), and the last failure is answered and ends the connection
  await assert.rejects(handleFrame(hubWith({}) as any, conn(), { pair: 'p', ctr: 7 }, fail), /boom/);
  assert.deepEqual(calls.splice(0), [
    'frame:false',
    'sleep',
    'frame:true',
    'sleep',
    'frame:true',
    'sleep',
    'frame:true',
    'fail:unavailable:7',
    `drop:${STORE_FAILED_CLOSE}:storing failed`,
  ]);

  // the connection ends, or the relay starts shutting down, while the frame waits: it is abandoned, not answered
  const c = conn();
  await handleFrame(hubWith({ sleep: async () => void ((c.closed = true), calls.push('sleep')) }) as any, c, { pair: 'p', ctr: 6 }, fail);
  assert.deepEqual(calls.splice(0), ['frame:false', 'sleep']);
  const h = hubWith({});
  h.sleep = async () => void ((h.draining = true), calls.push('sleep'));
  await handleFrame(h as any, conn(), { pair: 'p', ctr: 8 }, fail);
  assert.deepEqual(calls.splice(0), ['frame:false', 'sleep']);
});
