// The Mac's channel when a session fails locally (a failed save, a full queue): it pauses instead of ending, holds what arrives unacknowledged, asks the relay to send it again with a wait that grows, and reads from what was saved when the relay is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { MAX_SKIP } from '../shared/remote/crypto.mjs';
import { deferred } from './support/async-scenarios.ts';
import { msg, pairing, request, wireOf, drain, rig, openOut, until } from './support/remoteChannelRig.ts';
const require = createRequire(import.meta.url);
const { RECEIVE_MAX_FRAMES, RESYNC_EVENT } = require('../electron/remote/channel.cjs');

const ctrs = (acks: any[]) => acks.map((a) => a.ctr);
async function ackRig(o: Parameters<typeof rig>[0] = {}) {
  const r = await rig({ reconnectMs: 5, ...o });
  const acks: any[] = [];
  Object.assign(r.relay, {
    acks: true,
    sendAck: (m: any) => {
      acks.push(m);
      return true;
    },
  });
  return { ...r, acks };
}

test('a failed save pauses the session: the frame and the ones after it are held unacknowledged, replies still go, and the relay is asked again', async () => {
  const r = await ackRig();
  const closed: string[] = [];
  r.channel.onPairClosed((e: any) => closed.push(e.code));
  const update = r.devices.update.bind(r.devices);
  let fail = true;
  r.devices.update = async (...args: any[]) => {
    if (fail && args[1].rx) throw new Error('disk full');
    return update(...args);
  };
  const one = wireOf(r.phone, request('one'));
  const two = wireOf(r.phone, request('two'));
  r.relay.emit('frame', one);
  await drain(r);
  assert.deepEqual(closed, ['storage']);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage');
  r.relay.emit('frame', two);
  assert.deepEqual(ctrs(r.acks), [], 'neither is acknowledged: the relay keeps both');
  assert.equal(r.channel.stats.held, 1);
  // answering what was already being handled is not blocked by the pause
  await r.channel.send(r.phone.pairId, { id: 'm_reply', t: 1, kind: 'reply', inReplyTo: 'earlier', ok: true, result: {} });
  assert.equal(openOut(r.phone, r.relay.sent.at(-1)).id, 'm_reply');
  await until(() => r.relay.reconnects >= 1);
  assert.deepEqual(r.channel.stats.pauses, { overload: 0, storage: 1 });
  assert.equal(r.channel.stats.paused, 1);
  // the relay is back and sends both again, in order, from what was saved
  fail = false;
  const reopened: string[] = [];
  r.channel.onPairReopened((e: any) => reopened.push(e.code));
  r.relay.emit('open', { pairs: [] });
  assert.deepEqual(reopened, ['storage']);
  r.relay.emit('frame', one);
  r.relay.emit('frame', two);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['one', 'two'],
    'each once, in order',
  );
  assert.deepEqual(ctrs(r.acks), [1, 2]);
  assert.equal(r.channel.stats.reopens, 1);
  assert.equal(r.channel.stats.paused, 0);
});

test('the wait before asking the relay again doubles while pauses keep coming, a quiet minute starts it over, and the asking stops with the session back or the channel stopped', async (context) => {
  let t = 5_000_000;
  const r = await ackRig({ reconnectMs: 20, now: () => t });
  context.after(() => r.channel.stop());
  context.mock.timers.enable({ apis: ['setTimeout'] });
  r.devices.update = async () => {
    throw new Error('disk full');
  };
  r.relay.emit('frame', wireOf(r.phone, request('one')));
  await drain(r);
  assert.equal(r.channel.pauser.wait(), 20);
  let asks = 0;
  for (const wait of [20, 40, 80, 160]) {
    context.mock.timers.tick(wait - 1);
    assert.equal(r.relay.reconnects, asks, 'no reconnect before its boundary');
    context.mock.timers.tick(1);
    assert.equal(r.relay.reconnects, ++asks, 'one reconnect at its boundary');
  }
  assert.equal(r.channel.pauser.wait(), 320);
  // pauses a quiet minute apart are not one run
  r.relay.emit('open', { pairs: [] });
  t += 61_000;
  r.relay.emit('frame', wireOf(r.phone, request('two')));
  await drain(r);
  assert.equal(r.channel.pauser.streak, 0, 'the wait starts over');
  // the session comes back and the asking stops
  r.relay.emit('open', { pairs: [] });
  const asked = r.relay.reconnects;
  context.mock.timers.tick(150);
  assert.equal(r.relay.reconnects, asked);
  // paused again, then stopped: no timer outlives the channel
  r.relay.emit('frame', wireOf(r.phone, request('three')));
  await drain(r);
  r.channel.stop();
  const stopped = r.relay.reconnects;
  context.mock.timers.tick(150);
  assert.equal(r.relay.reconnects, stopped);
});

test('a new relay socket reopens the paused session before its first frame, so a backlog sent ahead of the hello is read', async () => {
  const r = await ackRig();
  const update = r.devices.update.bind(r.devices);
  let fail = true;
  r.devices.update = async (...args: any[]) => {
    if (fail && args[1].rx) throw new Error('disk full');
    return update(...args);
  };
  const one = wireOf(r.phone, request('one'));
  const two = wireOf(r.phone, request('two'));
  r.relay.emit('frame', one);
  await drain(r);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage');
  assert.equal(r.channel.sessions.get(r.phone.pairId).rx.state().ctr, 0, 'the counters went back to what was saved at once');
  fail = false;
  // the connecting event of the new socket, then frames, then the hello: the relay may send a backlog before the hello
  r.relay.emit('state', 'backoff');
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage', 'not before a socket is being made');
  r.relay.emit('state', 'connecting');
  r.relay.emit('frame', one);
  r.relay.emit('frame', two);
  r.relay.emit('open', { pairs: [] });
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['one', 'two'],
  );
  assert.equal(r.channel.stats.reopens, 1, 'reopened once, not again by the hello');
});

test('a phone that floods frames with counters just inside the limit is slowed, not cut off: each frame waits for the budget, in order, and a real frame behind them is delivered', async (context) => {
  let mono = 0;
  const r = await ackRig({ mono: () => mono, budget: { steps: 60, perSecond: 20_000 } });
  const waits: { ms: number; wake: () => void }[] = [];
  r.channel.pauser.sleep = (ms: number) => new Promise<void>((wake) => waits.push({ ms, wake }));
  let reading: Promise<void> | undefined;
  context.after(async () => {
    r.channel.stop();
    for (const wait of waits) wait.wake();
    await reading;
  });
  const ahead = (n: number) => ({ ...wireOf(r.phone, msg(`f${n}`)), ctr: 50 });
  for (let i = 0; i < 4; i++) r.relay.emit('frame', ahead(i));
  r.relay.emit('frame', wireOf(r.phone, msg('real')));
  reading = drain(r);
  for (let i = 0; i < 3; i++) {
    await until(() => waits.length === i + 1);
    assert.equal(waits[i].ms, 2);
    assert.equal(r.channel.statsOf(r.phone.pairId).dropped, i + 1, 'only frames before this wait were read');
    assert.equal(r.channel.stats.throttled, i + 1);
    assert.deepEqual(r.delivered, [], 'later frames cannot overtake the waiting frame');
    // A wake after three milliseconds earns the full sixty steps, independently of real crypto and I/O time.
    mono += 3;
    waits[i].wake();
  }
  await reading;
  const flood = r.channel.statsOf(r.phone.pairId)!;
  assert.deepEqual(
    [flood.dropped, flood.throttled, flood.paused],
    [4, 3, false],
    'every forged frame was read in turn; three of them had to wait',
  );
  assert.equal(r.channel.stats.throttled, 3);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['real'],
    'nothing was read past a waiting frame and nothing real was lost',
  );
  assert.equal(r.channel.closedReason(r.phone.pairId), null, 'forged frames never pause the pair');
});

test('minimum budget sleeps include the valid frame after the forged flood without borrowing real elapsed time', async (context) => {
  let mono = 0;
  const r = await ackRig({ mono: () => mono, budget: { steps: 60, perSecond: 20_000 } });
  context.after(() => r.channel.stop());
  const slept: number[] = [];
  r.channel.pauser.sleep = async (ms: number) => {
    slept.push(ms);
    mono += ms;
  };
  const ahead = (n: number) => ({ ...wireOf(r.phone, msg(`f${n}`)), ctr: 50 });
  for (let i = 0; i < 4; i++) r.relay.emit('frame', ahead(i));
  r.relay.emit('frame', wireOf(r.phone, msg('real')));
  await drain(r);
  const flood = r.channel.statsOf(r.phone.pairId)!;
  assert.deepEqual([flood.dropped, flood.throttled, flood.paused], [4, 4, false]);
  assert.equal(r.channel.stats.throttled, 4);
  assert.deepEqual(slept, [2, 3, 2, 1], 'each frame earns only what its minimum sleep refills');
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['real'],
  );
  assert.equal(r.channel.closedReason(r.phone.pairId), null);
});

test('frames that are replayed, rewound or beyond the limit cost one step each, so they cannot empty the budget', async () => {
  // catch-up is off here (cap = MAX_SKIP): this is the plain refusal path
  const r = await ackRig({ budget: { steps: 10, perSecond: 1 }, catchUpSkip: MAX_SKIP });
  const far = { ...wireOf(r.phone, msg('far')), ctr: MAX_SKIP + 5 };
  for (let i = 0; i < 8; i++) r.relay.emit('frame', far);
  r.relay.emit('frame', wireOf(r.phone, msg('real')));
  await drain(r);
  assert.deepEqual([r.channel.stats.gaps, r.channel.stats.throttled], [8, 0]);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['real'],
  );
});

test('the budget is earned on a clock that never goes back: a wall clock set back, or a fake one, does not empty it', async () => {
  let now = 1_000_000;
  let mono = 5_000;
  const r = await ackRig({ now: () => now, mono: () => mono, budget: { steps: 100, perSecond: 10 } });
  const s = r.channel.sessions.get(r.phone.pairId);
  now -= 3_600_000;
  assert.equal(r.channel.pauser.afford(s, 100), true);
  mono -= 4_000;
  assert.equal(r.channel.pauser.afford(s, 1), false, 'a clock that went back earns nothing and takes nothing away');
  mono += 4_000 + 10_000;
  assert.equal(r.channel.pauser.afford(s, 100), true, 'ten seconds earn the whole budget back');
});

test('a frame waiting for budget is given up when the channel stops or the pair ends, and leaves no timer', async () => {
  const stopped = await ackRig({ mono: () => 0, budget: { steps: 60, perSecond: 1 } });
  const ahead = { ...wireOf(stopped.phone, msg('f')), ctr: 50 };
  stopped.relay.emit('frame', ahead);
  stopped.relay.emit('frame', ahead);
  const draining = drain(stopped);
  await until(() => stopped.channel.stats.throttled === 1);
  assert.equal(stopped.channel.pauser.sleepers.size, 1);
  stopped.channel.stop();
  await draining;
  assert.equal(stopped.channel.pauser.sleepers.size, 0);
  assert.deepEqual(ctrs(stopped.acks), [50], 'only the frame that was read is acknowledged: the one that waited stays with the relay');

  const ended = await ackRig({ mono: () => 0, budget: { steps: 60, perSecond: 1 } });
  ended.relay.emit('frame', { ...wireOf(ended.phone, msg('f')), ctr: 50 });
  ended.relay.emit('frame', { ...wireOf(ended.phone, msg('g')), ctr: 50 });
  const waiting = drain(ended);
  await until(() => ended.channel.stats.throttled === 1);
  ended.channel.sessions.get(ended.phone.pairId)!.closed = 'retired';
  ended.channel.pauser.shutdown();
  await waiting;
  assert.deepEqual(ctrs(ended.acks), [50]);
});

test('a relay that connects at once from inside reconnect() leaves no timer behind and the next pause waits from the start', async (context) => {
  const r = await ackRig({ reconnectMs: 5 });
  context.after(() => r.channel.stop());
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let fail = true;
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    if (fail && args[1].rx) throw new Error('disk full');
    return update(...args);
  };
  r.relay.reconnect = () => r.relay.emit('open', { pairs: [] });
  r.relay.emit('frame', wireOf(r.phone, request('one')));
  await drain(r);
  context.mock.timers.tick(4);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage');
  context.mock.timers.tick(1);
  assert.equal(r.channel.closedReason(r.phone.pairId), null);
  assert.equal(r.channel.pauser.timer, null, 'the sessions are open and nothing is waiting to ask again');
  fail = false;
  const asked = r.channel.stats.reconnects;
  context.mock.timers.tick(60);
  assert.equal(r.channel.stats.reconnects, asked);
});

test('a notice about a gap that could not be sent is tried again with the next gap, not a minute later', async () => {
  let t = 9_000_000;
  const r = await ackRig({ now: () => t, catchUpSkip: MAX_SKIP });
  const send = r.relay.sendFrame.bind(r.relay);
  let failing = true;
  r.relay.sendFrame = (w: any) => (failing ? 'dropped' : send(w));
  const far = (n: number) => ({ ...wireOf(r.phone, msg('m')), ctr: MAX_SKIP + n });
  r.relay.emit('frame', far(1));
  await drain(r);
  await until(() => r.channel.sessions.get(r.phone.pairId).noticedAt === undefined);
  failing = false;
  t += 1_000;
  r.relay.emit('frame', far(2));
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  assert.equal(openOut(r.phone, r.relay.sent[0]).patch.reason, 'gap');
});

test('reopening reads from what was saved, and leaves an open session and a device that is gone alone', async () => {
  const r = await ackRig();
  const ok = wireOf(r.phone, msg('a'));
  r.relay.emit('frame', ok);
  await until(() => r.delivered.length === 1);
  const before = r.channel.sessions.get(r.phone.pairId).rx;
  r.relay.emit('open', { pairs: [] });
  assert.equal(r.channel.sessions.get(r.phone.pairId).rx, before, 'an open session is not touched by a new relay connection');
  assert.equal(r.channel.stats.reopens, 0);
  // a session paused for a failed save whose device record is gone keeps what it has
  const update = r.devices.update.bind(r.devices);
  r.devices.update = async (...args: any[]) => {
    if (args[1].rx) throw new Error('disk full');
    return update(...args);
  };
  r.relay.emit('frame', wireOf(r.phone, request('two')));
  await drain(r);
  const kept = r.channel.sessions.get(r.phone.pairId).rx;
  const get = r.devices.get.bind(r.devices);
  r.devices.get = () => null;
  r.relay.emit('open', { pairs: [] });
  r.devices.get = get;
  assert.equal(r.channel.sessions.get(r.phone.pairId).rx, kept);
  assert.equal(r.channel.closedReason(r.phone.pairId), null);
});

test('frames past the limit are held and the queued ones are read first; a failed save while waiting still rolls the counters back', async () => {
  const r = await ackRig({ reconnectMs: 5 });
  const gate = deferred<void>();
  const entered = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  let calls = 0;
  r.devices.update = async (...args: any[]) => {
    if (args[1].rx) {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await gate.promise;
      } else if (calls === 2) throw new Error('disk full');
    }
    return update(...args);
  };
  const frames = Array.from({ length: RECEIVE_MAX_FRAMES + 3 }, (_, i) => wireOf(r.phone, request(`m_${i}`)));
  r.relay.emit('frame', frames[0]);
  await entered.promise;
  for (const f of frames.slice(1)) r.relay.emit('frame', f);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'overload');
  assert.equal(r.channel.stats.pauses.overload, 1, 'one pause however many frames are over');
  assert.equal(r.channel.stats.held, 3, 'the one that did not fit and the two after it');
  gate.resolve();
  await drain(r);
  // the second queued frame hit a failed save: the session went back to what was saved, and the rest of the queue was let go
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage');
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['m_0'],
  );
  assert.deepEqual(ctrs(r.acks), [1]);
  r.relay.emit('open', { pairs: [] });
  for (const f of frames.slice(1, 31)) r.relay.emit('frame', f);
  await drain(r);
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    Array.from({ length: 31 }, (_, i) => `m_${i}`),
    'the frames the relay sends again are read once, in order, after the one that was saved',
  );
});

test('a frame the relay refuses gives its counter back, so refusals in a row cannot put the phone out of reach of the next frame', async () => {
  const r = await ackRig();
  const ctrOf = (w: any) => w.ctr;
  await r.channel.send(r.phone.pairId, msg('first'));
  r.relay.outcome = 'dropped';
  for (let i = 0; i < 5; i++) await assert.rejects(r.channel.send(r.phone.pairId, msg(`lost${i}`)), /not accepting/);
  r.relay.outcome = 'sent';
  await r.channel.send(r.phone.pairId, msg('second'));
  assert.deepEqual(r.relay.sent.map(ctrOf), [1, 2, 2, 2, 2, 2, 2], 'every refused frame used counter 2 and gave it back');
  // the phone, opening only what was sent, sees counters 1 and 2 with nothing missing
  assert.equal(openOut(r.phone, r.relay.sent[0]).id, 'first');
  assert.equal(openOut(r.phone, r.relay.sent.at(-1)).id, 'second');
});

test('a retired pair stays closed: its frames are dropped and counted, the phone is told once, and the stats say it is not paused', async () => {
  const r = await ackRig();
  assert.equal(r.channel.statsOf('p_nobody0000'), null);
  const lease = r.devices.lease.bind(r.devices);
  let lost = false;
  // the lease is lost once, at the first frame; the notice to the phone then gets its own
  r.devices.lease = (...args: any[]) => (lost ? lease(...args) : ((lost = true), null));
  r.relay.emit('frame', wireOf(r.phone, request('one')));
  await until(() => r.relay.sent.length === 1);
  const notice = openOut(r.phone, r.relay.sent[0]);
  assert.deepEqual([notice.ev, notice.patch], [RESYNC_EVENT, { reason: 'retired' }]);
  r.relay.emit('frame', wireOf(r.phone, request('two')));
  assert.equal(r.channel.closedReason(r.phone.pairId), 'retired');
  assert.deepEqual(ctrs(r.acks), [1, 2], 'both frames are acknowledged as dropped, not held');
  assert.equal(r.channel.statsOf(r.phone.pairId).dropped, 1);
  assert.equal(r.channel.statsOf(r.phone.pairId).paused, false);
});

test('a send whose save is still in flight when the pair is retired fails instead of using a counter on a closed session', async () => {
  const r = await ackRig();
  const gate = deferred<void>();
  const entered = deferred<void>();
  const update = r.devices.update.bind(r.devices);
  let held = false;
  r.devices.update = async (...args: any[]) => {
    if (args[1].tx && !held) {
      held = true;
      entered.resolve();
      await gate.promise;
    }
    return update(...args);
  };
  const sending = r.channel.send(r.phone.pairId, msg('m_1'));
  const failed = assert.rejects(sending, /session is closed/);
  await entered.promise;
  r.devices.lease = () => null;
  r.relay.emit('frame', wireOf(r.phone, request('one')));
  assert.equal(r.channel.closedReason(r.phone.pairId), 'retired');
  gate.resolve();
  await failed;
});

test('a close listener that throws does not stop the pause or the other listeners', async () => {
  const r = await ackRig();
  const heard: string[] = [];
  r.channel.onPairClosed(() => {
    throw new Error('listener broke');
  });
  r.channel.onPairClosed((e: any) => heard.push(e.code));
  r.devices.update = async () => {
    throw new Error('disk full');
  };
  r.relay.emit('frame', wireOf(r.phone, request('one')));
  await drain(r);
  assert.deepEqual(heard, ['storage']);
  assert.equal(r.channel.closedReason(r.phone.pairId), 'storage');
});

test('asking the relay again ends when the paused pair is gone, and a relay that cannot reconnect is still counted as asked', async (context) => {
  const gone = await ackRig({ reconnectMs: 10 });
  const bare = await ackRig({ reconnectMs: 5 });
  context.after(() => {
    gone.channel.stop();
    bare.channel.stop();
  });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  gone.devices.update = async () => {
    throw new Error('disk full');
  };
  // the pair goes (its device is removed) in the same moment its session pauses, before the timer is set
  gone.channel.onPairClosed(() => gone.channel.sessions.delete(gone.phone.pairId));
  const session = gone.channel.sessions.get(gone.phone.pairId);
  gone.relay.emit('frame', wireOf(gone.phone, request('one')));
  await session.receiving;
  assert.equal(gone.channel.stats.pauses.storage, 1);
  const before = gone.relay.reconnects;
  context.mock.timers.tick(100);
  assert.equal(gone.relay.reconnects, before, 'nothing is asked for a pair that no longer exists');
  gone.channel.stop();

  (bare.relay as any).reconnect = undefined;
  bare.devices.update = async () => {
    throw new Error('disk full');
  };
  bare.relay.emit('frame', wireOf(bare.phone, request('one')));
  await drain(bare);
  context.mock.timers.tick(4);
  assert.equal(bare.channel.stats.reconnects, 0);
  context.mock.timers.tick(1);
  assert.equal(bare.channel.stats.reconnects, 1);
  bare.channel.stop();
});

test('two phones that pause together share one wait before the relay is asked again, and one new connection reopens both', async (context) => {
  const a = pairing('phone-1', 'p_pairedphone1');
  const b = pairing('phone-2', 'p_pairedphone2');
  const r = await ackRig({ phones: [a, b], reconnectMs: 5 });
  context.after(() => r.channel.stop());
  context.mock.timers.enable({ apis: ['setTimeout'] });
  r.devices.update = async () => {
    throw new Error('disk full');
  };
  r.relay.emit('frame', wireOf(a, request('one')));
  r.relay.emit('frame', wireOf(b, request('two')));
  await drain(r, a);
  await drain(r, b);
  assert.deepEqual([r.channel.closedReason(a.pairId), r.channel.closedReason(b.pairId)], ['storage', 'storage']);
  context.mock.timers.tick(4);
  assert.equal(r.channel.stats.reconnects, 0);
  context.mock.timers.tick(1);
  assert.equal(r.channel.stats.reconnects, 1, 'both paused phones share one reconnect');
  r.relay.emit('open', { pairs: [] });
  assert.deepEqual([r.channel.closedReason(a.pairId), r.channel.closedReason(b.pairId)], [null, null]);
  assert.equal(r.channel.pauser.timer, null);
  context.mock.timers.tick(10);
  assert.equal(r.channel.stats.reconnects, 1, 'reopening both retires their shared timer');
});
