// The phone's reconnector and presence rules: one attempt at a time, doubling waits to a cap, a kick that never doubles an attempt, and what a computer's presence line says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReconnector, isTransient, Unreachable } from '../mobile/src/reconnect.ts';
import {
  isMacPresence,
  joinedPeer,
  presenceAcrossConnect,
  presenceFromEvent,
  presenceFromHello,
  presenceLine,
} from '../mobile/src/presence.ts';

const timing = { baseMs: 100, capMs: 400, jitter: 0, minGapMs: 50 };

function rig(t: any, outcomes: Array<'connected' | 'retry' | 'stop' | 'throw'>, gate?: () => Promise<void>) {
  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const attempts: Array<[string, number]> = [];
  const states: any[] = [];
  const reconnector = createReconnector({
    attempt: async (pair) => {
      attempts.push([pair, Date.now()]);
      if (gate) await gate();
      const next = outcomes.shift() ?? 'retry';
      if (next === 'throw') throw new Error('boom');
      return next;
    },
    timing,
    onChange: (s) => states.push(s),
  });
  return { reconnector, attempts, states, tick: (ms: number) => t.mock.timers.tick(ms) };
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('waits double from the base to the cap, and a thrown attempt counts as a retry', async (t) => {
  const { reconnector, attempts, states, tick } = rig(t, ['retry', 'throw', 'retry', 'retry', 'connected']);
  reconnector.start('p');
  assert.deepEqual(states.at(-1), { pairId: 'p', attempt: 0, nextAt: Date.now() + 100 });
  for (const wait of [100, 200, 400, 400, 400]) {
    tick(wait);
    await flush();
  }
  assert.deepEqual(
    attempts.map(([, at]) => at - attempts[0][1]),
    [0, 200, 600, 1000, 1400],
    'the first after the base wait, then 200, 400, 400 and 400 ms later',
  );
  assert.equal(states.at(-1), null, 'a connection ends the wait');
  tick(5000);
  await flush();
  assert.equal(attempts.length, 5, 'nothing after it connected');
});

test('jitter stays inside its band', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let value = 0;
  const waits: number[] = [];
  const reconnector = createReconnector({
    attempt: async () => 'retry',
    timing: { ...timing, jitter: 0.5 },
    onChange: (s) => s?.nextAt && waits.push(s.nextAt - Date.now()),
    random: () => value,
  });
  reconnector.start('p');
  assert.equal(waits[0], 100, 'the first wait is the base');
  t.mock.timers.tick(100);
  await flush();
  assert.equal(waits.at(-1), 100, 'the lowest draw takes half of the doubled 200 ms');
  value = 1;
  t.mock.timers.tick(100);
  await flush();
  assert.equal(waits.at(-1), 600, 'the highest draw takes one and a half of the doubled-again 400 ms');
  reconnector.stop();
});

test('stop ends the wait and an attempt finishing later changes nothing; a stop outcome ends the loop', async (t) => {
  let release!: () => void;
  const { reconnector, attempts, states, tick } = rig(t, ['connected'], () => new Promise<void>((r) => (release = r)));
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(states.at(-1).nextAt, null, 'an attempt is running');
  reconnector.stop();
  assert.equal(states.at(-1), null);
  release();
  await flush();
  assert.equal(reconnector.pair(), null);
  tick(10000);
  await flush();
  assert.equal(attempts.length, 1);
  reconnector.stop();
  const again = rig(t, ['stop']);
  again.reconnector.start('p');
  again.tick(100);
  await flush();
  assert.equal(again.reconnector.pair(), null, 'a refused pair is not waited for');
});

test('kick tries now, once, and starting the same pair again changes nothing', async (t) => {
  const { reconnector, attempts, tick } = rig(t, ['retry', 'retry', 'retry']);
  reconnector.kick();
  assert.equal(attempts.length, 0, 'nothing to kick without a wait');
  reconnector.start('p');
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(attempts.length, 1);
  reconnector.kick();
  assert.equal(attempts.length, 1, 'minGap holds the kick back');
  tick(50);
  await flush();
  assert.equal(attempts.length, 2);
  reconnector.kick();
  reconnector.kick();
  tick(50);
  await flush();
  assert.equal(attempts.length, 3, 'kicks in a row make one attempt');
  reconnector.stop();
});

test('a kick while an attempt runs is ignored, and another pair asked for meanwhile goes right after', async (t) => {
  let release!: () => void;
  const { reconnector, attempts, tick } = rig(t, ['retry', 'retry'], () => new Promise<void>((r) => (release = r)));
  reconnector.start('p');
  tick(100);
  await flush();
  reconnector.kick();
  assert.equal(attempts.length, 1);
  reconnector.start('q');
  tick(100);
  await flush();
  assert.equal(attempts.length, 1, 'never two attempts at once');
  release();
  await flush();
  assert.deepEqual(
    attempts.map(([pair]) => pair),
    ['p', 'q'],
    'the new pair goes as soon as the old attempt ends',
  );
  release();
  reconnector.stop();
});

test('what is worth waiting for: an absent computer, a lost network, an account service that is down', () => {
  assert.equal(isTransient(new Unreachable('Computer is offline')), true);
  assert.equal(isTransient(new TypeError('Network request failed')), true);
  assert.equal(isTransient(new Error('relay connection failed')), true);
  assert.equal(isTransient(new Error('relay disconnected')), true);
  assert.equal(isTransient(new Error('Account service returned HTTP 503')), true);
  assert.equal(isTransient(new Error('Account service returned HTTP 401')), false);
  assert.equal(isTransient(new Error('Unknown pair')), false);
  assert.equal(isTransient('text'), false);
});

test('the phone being offline is worth waiting out, however the platform words it (a plain Error from the native fetch, not only a TypeError)', () => {
  for (const message of [
    'fetch failed: The Internet connection appears to be offline.',
    'fetch failed: The network connection was lost.',
    'fetch failed: The request timed out.',
    'fetch failed: A server with the specified hostname could not be found.',
    'fetch failed: Could not connect to the server.',
    'Network request failed',
  ])
    assert.equal(isTransient(new Error(message)), true, message);
  assert.equal(isTransient(new Error('fetch failed: The certificate for this server is invalid.')), false, 'a refusal is not a wait');
  assert.equal(isTransient(new Error('fetch failed')), true, 'a bare failure to reach the service');
});

test('presence follows the relay hello and events, and last seen is the last moment the computer was there', () => {
  const hello = {
    pairs: [
      { pair: 'a', joined: true, peerOnline: true, presence: 'online' },
      { pair: 'b', joined: true, peerOnline: false },
      { pair: 'c', joined: false },
      null,
      { pair: 7 },
    ],
  };
  const first = presenceFromHello({}, hello, 1000);
  assert.deepEqual(first, { a: { state: 'online', lastSeen: 1000 }, b: { state: 'gone', lastSeen: null } });
  assert.equal(presenceFromHello(first, { pairs: 'x' }, 5), first, 'a hello without pairs changes nothing');
  assert.equal(presenceFromHello(first, undefined, 5), first);
  const asleep = presenceFromEvent(first, 'a', 'sleeping', 2000, 3000);
  assert.deepEqual(asleep.a, { state: 'sleeping', lastSeen: 2000 }, 'the relay says when it went away');
  assert.deepEqual(presenceFromEvent(asleep, 'a', 'gone', undefined, 4000).a, { state: 'gone', lastSeen: 2000 }, 'keeps the earlier time');
  assert.deepEqual(presenceFromEvent({}, 'z', 'gone', 'bad', 4000).z, { state: 'gone', lastSeen: null });
  assert.deepEqual(presenceFromEvent(asleep, 'a', 'online', 1, 9000).a, { state: 'online', lastSeen: 9000 });
  assert.equal(presenceFromEvent(first, 'a', 'napping', 1, 1), first, 'an unknown state is ignored');
  assert.deepEqual(presenceFromHello(asleep, { pairs: [{ pair: 'a', joined: true, presence: 'gone' }] }, 9).a, {
    state: 'gone',
    lastSeen: 2000,
  });
  assert.equal(isMacPresence('online') && !isMacPresence('x'), true);
});

test('an event heard during a connect wins over its hello; without begin, or once applied, the hello decides (#3248)', () => {
  const hello = {
    pairs: [
      { pair: 'a', joined: true, peerOnline: true, presence: 'online' },
      { pair: 'b', joined: true, presence: 'online' },
    ],
  };
  const across = presenceAcrossConnect();
  assert.deepEqual(across.hello({}, hello, 10).a, { state: 'online', lastSeen: 10 }, 'no begin: nothing was heard');
  across.begin();
  let map = across.event({}, 'a', 'gone', 7, 20);
  map = across.event(map, 'b', 'napping', 7, 20);
  map = across.hello(map, hello, 30);
  assert.deepEqual(map.a, { state: 'gone', lastSeen: 7 });
  assert.deepEqual(map.b, { state: 'online', lastSeen: 30 }, 'an unknown state was not heard');
  // applied once: a later hello with no begin is the relay's word again
  assert.deepEqual(across.hello(map, hello, 40).a, { state: 'online', lastSeen: 40 });
  assert.equal(across.event(map, 'a', 'gone', 1, 1).a.state, 'gone', 'an event outside a connect still applies');
  assert.deepEqual(joinedPeer(hello, 'a'), hello.pairs[0]);
  assert.equal(joinedPeer({ pairs: [{ pair: 'a', joined: false }] }, 'a'), undefined);
  assert.equal(joinedPeer(null, 'a'), undefined);
  assert.equal(joinedPeer({ pairs: 'x' }, 'a'), undefined);
});

test('the presence line says what the computer is doing and when it was last there', () => {
  const now = 10 * 3600_000;
  assert.equal(presenceLine(undefined, now), null);
  assert.equal(presenceLine({ state: 'online', lastSeen: now }, now), 'Online');
  assert.equal(presenceLine({ state: 'sleeping', lastSeen: null }, now), 'Asleep');
  assert.equal(presenceLine({ state: 'gone', lastSeen: now - 5000 }, now), 'Not reachable · last seen just now');
  assert.equal(presenceLine({ state: 'gone', lastSeen: now - 5 * 60000 }, now), 'Not reachable · last seen 5 min ago');
  assert.equal(presenceLine({ state: 'sleeping', lastSeen: now - 3 * 3600_000 }, now), 'Asleep · last seen 3 h ago');
  assert.equal(presenceLine({ state: 'gone', lastSeen: now - 50 * 3600_000 }, now), 'Not reachable · last seen 2 d ago');
  assert.equal(
    presenceLine({ state: 'gone', lastSeen: now + 9999 }, now),
    'Not reachable · last seen just now',
    'a clock ahead is not negative',
  );
});

test('a tap holds the pair: nothing is scheduled, the attempt in flight is ignored, and start or stop ends the hold', async (t) => {
  let release!: () => void;
  const { reconnector, attempts, states, tick } = rig(t, ['retry', 'retry', 'retry'], () => new Promise<void>((r) => (release = r)));
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(attempts.length, 1, 'an attempt is running');
  reconnector.hold('p');
  assert.deepEqual(states.at(-1), { pairId: 'p', attempt: 0, nextAt: null }, 'the pair still shows as being brought back');
  release();
  await flush();
  tick(10000);
  await flush();
  assert.equal(attempts.length, 1, 'the ignored attempt scheduled nothing and nothing else is scheduled');
  reconnector.kick();
  tick(10000);
  await flush();
  assert.equal(attempts.length, 1, 'a kick does not start an attempt beside the tap');
  reconnector.start('p');
  assert.equal(states.at(-1)!.nextAt, Date.now() + 100, 'a failed tap resumes the wait from the base');
  reconnector.hold('p');
  reconnector.stop();
  assert.equal(states.at(-1), null);
  reconnector.hold('q');
  assert.equal(states.at(-1)!.pairId, 'q', 'a tap on a computer nobody was waiting for');
  reconnector.hold('r');
  assert.equal(states.at(-1)!.pairId, 'r');
  reconnector.stop();
});

test('the account service being slow or briefly down is worth waiting out', () => {
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.equal(isTransient(abort), true);
  assert.equal(isTransient(new Error('Aborted')), true);
  assert.equal(isTransient(new SyntaxError('Unexpected end of JSON input')), true);
  assert.equal(isTransient(new Error('relay acknowledgement timed out')), true);
  for (const status of [408, 425, 429, 502]) assert.equal(isTransient(new Error(`Account service returned HTTP ${status}`)), true);
  assert.equal(isTransient(new Error('Account service returned HTTP 403')), false);
});

test('nudge (the computer is back) tries now within the minimum gap, ignoring a long wait, without restarting the backoff', async (t) => {
  const { reconnector, attempts, states, tick } = rig(t, ['retry', 'retry', 'retry', 'retry', 'retry']);
  reconnector.nudge();
  assert.equal(attempts.length, 0, 'nothing to nudge without a wait');
  reconnector.start('p');
  tick(100);
  await flush();
  tick(200);
  await flush();
  tick(400);
  await flush();
  assert.equal(attempts.length, 3);
  const attemptsSoFar = (states.at(-1) as any).attempt;
  assert.equal(attemptsSoFar, 3);
  // the wait is now at the 400 ms cap; the computer announces itself 10 ms into it
  tick(10);
  reconnector.nudge();
  tick(39);
  await flush();
  assert.equal(attempts.length, 3, 'the minimum gap since the last try still holds');
  tick(1);
  await flush();
  assert.equal(attempts.length, 4, 'tried at the gap, not after the 400 ms wait');
  assert.equal((states.at(-1) as any).attempt, 4, 'a failed try after a nudge keeps counting: the backoff is not reset');
  reconnector.nudge();
  reconnector.nudge();
  tick(50);
  await flush();
  assert.equal(attempts.length, 5, 'nudges in a row make one attempt');
  reconnector.stop();
});

test('a nudge during an attempt is remembered: the attempt fails, and the next one goes at once instead of after the wait', async (t) => {
  let release!: () => void;
  const { reconnector, attempts, states, tick } = rig(t, ['retry', 'retry', 'retry'], () => new Promise<void>((r) => (release = r)));
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(attempts.length, 1);
  tick(1000);
  reconnector.nudge();
  release();
  await flush();
  assert.equal(attempts.length, 2, 'the remembered nudge made the retry immediate (the gap had passed), not 200 ms later');
  assert.equal((states.at(-1) as any).attempt, 1, 'and the failure still counted');
  // the memory is used once: the next failure waits the full backoff (the 400 ms cap)
  release();
  await flush();
  tick(399);
  await flush();
  assert.equal(attempts.length, 2);
  tick(1);
  await flush();
  assert.equal(attempts.length, 3);
  reconnector.stop();
});

test('a nudge while a tap holds the pair, or after the wait ended, does nothing and leaves nothing behind', async (t) => {
  const { reconnector, attempts, tick } = rig(t, ['retry', 'retry', 'retry']);
  reconnector.start('p');
  reconnector.hold('p');
  reconnector.nudge();
  tick(1000);
  await flush();
  assert.equal(attempts.length, 0, 'a held pair is the tap\u2019s');
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(attempts.length, 1);
  reconnector.stop();
  reconnector.nudge();
  reconnector.start('p');
  tick(100);
  await flush();
  assert.equal(attempts.length, 2, 'the new wait begins with the base, no stale nudge');
  reconnector.stop();
});
