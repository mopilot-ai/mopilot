// A phone the Mac wrongly takes for away (the relay's `peer online` is late): its first authenticated frame makes it present again and tells it, once, that live events were skipped; the relay's own return, a forged frame and a second frame send no marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drain, msg, openOut, rig, until, wireOf } from './support/remoteChannelRig.ts';

const require = createRequire(import.meta.url);
const { createPhonePresence } = require('../electron/remote/phonePresence.cjs');

const live = (id: string) => msg(id, { ev: 'items.delta', chatId: 'c1' });
const ctrOf = (r: any) => r.channel.sessions.get(r.phone.pairId).tx.state().ctr;
const opened = new WeakMap<object, any[]>();
/** Opens each sealed frame once (the phone's receiver is strict) and lists them in order. */
const evs = (r: any) => {
  const list = opened.get(r) ?? [];
  opened.set(r, list);
  for (const w of r.relay.sent.slice(list.length)) list.push(openOut(r.phone, w));
  return list;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** A channel wired as runtime.cjs wires it: presence from the relay's hello and `peer` events, any opened frame marks the phone present. */
const GRACE = 5_000;
/** The clocks of the rig: `clock` is the monotonic one (it moves a tick on every read, so "before" and "after" are never a tie; tests jump it past the grace), `wall` the wall clock the frames' own time is checked against. */
const clock = { at: 0 };
const wall = { at: 1_000_000 };
/** A message as the phone seals it: its own time is now. */
const heard = (id: string, extra: object = {}) => msg(id, { t: wall.at, ...extra });
const afterGrace = () => void (clock.at += GRACE + 1);

async function wired(o: { helloOnly?: boolean; onPhoneFrame?: (pair: string, receivedAt: number, sentAt: number) => void } = {}) {
  const holder: { presence?: ReturnType<typeof createPhonePresence> } = {};
  clock.at = 0;
  wall.at = 1_000_000;
  const mono = () => ++clock.at;
  const r = await rig({
    mono,
    now: () => wall.at,
    phoneAbsent: (pair) => holder.presence?.isAbsent(pair) === true,
    onPhoneFrame: (pair, receivedAt, sentAt) => (
      o.onPhoneFrame?.(pair, receivedAt, sentAt), holder.presence?.markPresent(pair, receivedAt, sentAt)
    ),
  });
  holder.presence = createPhonePresence(r.relay, mono, () => wall.at);
  const pair = r.phone.pairId;
  r.relay.emit('open', { pairs: [{ pair, role: 'mac', peerOnline: false }], peerEvents: true });
  if (!o.helloOnly) afterGrace(); // the relay's backlog flush is over: a frame now is news of now
  return { r, pair, presence: holder.presence! };
}

test('absent phone, a turn streams, a frame from the phone opens: present, one marker, the next live event takes the next counter with no gap', async () => {
  const { r, pair, presence } = await wired();
  for (let i = 0; i < 20; i++) await r.channel.send(pair, live(`d${i}`));
  assert.equal(r.relay.sent.length, 0);
  assert.equal(ctrOf(r), 0);
  assert.equal(presence.isAbsent(pair), true);
  r.relay.emit('frame', wireOf(r.phone, heard('hello-1')));
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  assert.equal(presence.isAbsent(pair), false, 'the frame made the phone present');
  const marker = evs(r)[0];
  assert.equal(marker.ev, 'live.missed');
  assert.deepEqual(marker.patch, { reason: 'late-presence' });
  await r.channel.send(pair, live('next'));
  assert.equal(r.relay.sent.length, 2);
  assert.equal(evs(r)[1].id, 'next', 'the phone opens it right after the marker');
  assert.equal(ctrOf(r), 2);
});

test('two frames in a row send one marker', async () => {
  const { r } = await wired();
  r.relay.emit('frame', wireOf(r.phone, heard('a')));
  r.relay.emit('frame', wireOf(r.phone, heard('b')));
  await drain(r);
  await until(() => r.relay.sent.length >= 1);
  await settle();
  assert.equal(r.relay.sent.length, 1);
  assert.equal(evs(r)[0].ev, 'live.missed');
});

test('a forged frame (its tag does not open) does not make the phone present and sends no marker', async () => {
  const { r, pair, presence } = await wired();
  const wire: any = wireOf(r.phone, msg('real'));
  const box = Uint8Array.from(wire.box);
  box[box.length - 1] ^= 1;
  r.relay.emit('frame', { ...wire, box });
  await drain(r);
  await settle();
  assert.equal(presence.isAbsent(pair), true);
  assert.equal(r.relay.sent.length, 0);
});

test("the relay's own `peer online` is the normal return: presence flips and no marker is sent", async () => {
  const { r, pair, presence } = await wired();
  r.relay.emit('event', { ev: 'peer', pair, online: true });
  assert.equal(presence.isAbsent(pair), false);
  r.relay.emit('frame', wireOf(r.phone, heard('a')));
  await drain(r);
  await settle();
  assert.equal(r.relay.sent.length, 0, 'the frame found the phone present already');
  await r.channel.send(pair, live('d'));
  assert.equal(evs(r).at(-1).id, 'd');
});

test("late `peer online` (5 s): a turn streams meanwhile; after the phone's first frame the chat events flow again with the marker, and the late relay event adds none", async () => {
  const { r, pair, presence } = await wired();
  for (let i = 0; i < 10; i++) await r.channel.send(pair, live(`early${i}`)); // the first 4 s: the relay has not said the phone is there
  assert.equal(r.relay.sent.length, 0);
  r.relay.emit('frame', wireOf(r.phone, { id: 'q', t: wall.at, kind: 'request', method: 'chat.follow', params: { chatId: 'c1' } }));
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  await r.channel.send(pair, live('after'));
  assert.deepEqual(
    evs(r).map((e: any) => e.ev),
    ['live.missed', 'items.delta'],
  );
  r.relay.emit('event', { ev: 'peer', pair, online: true }); // 5 s: the relay catches up
  assert.equal(presence.isAbsent(pair), false);
  await settle();
  assert.equal(r.relay.sent.length, 2, 'no second marker');
});

test('a backlog frame received before `peer offline` does not flip the phone to present; one received after does, with the marker', async () => {
  const { r, pair, presence } = await wired();
  r.relay.emit('event', { ev: 'peer', pair, online: true });
  r.relay.emit('frame', wireOf(r.phone, heard('queued'))); // sent before the phone left, read by the Mac only now
  r.relay.emit('event', { ev: 'peer', pair, online: false }); // the relay says it left, while the frame waits in the queue
  await drain(r);
  await settle();
  assert.equal(presence.isAbsent(pair), true, 'the stale frame proves nothing about now');
  assert.equal(r.relay.sent.length, 0, 'no marker for it');
  await r.channel.send(pair, live('skipped'));
  assert.equal(r.relay.sent.length, 0, 'live events are still skipped for the absent phone');
  afterGrace();
  r.relay.emit('frame', wireOf(r.phone, heard('fresh')));
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  assert.equal(presence.isAbsent(pair), false, 'a frame received after the relay said it left does');
  assert.equal(evs(r)[0].ev, 'live.missed');
});

test('a hello that lists the phone offline counts as the relay saying it is away: a frame read before it does not flip, one after does', async () => {
  const { r, pair, presence } = await wired();
  r.relay.emit('frame', wireOf(r.phone, heard('backlog')));
  r.relay.emit('open', { pairs: [{ pair, role: 'mac', peerOnline: false }], peerEvents: true });
  await drain(r);
  assert.equal(presence.isAbsent(pair), true);
  afterGrace();
  r.relay.emit('frame', wireOf(r.phone, heard('now')));
  await drain(r);
  assert.equal(presence.isAbsent(pair), false);
});

test('the marker is sent at most once a minute per pair, however often the phone is taken for away and returns', async () => {
  const { r, pair } = await wired();
  const cycle = async (id: string) => {
    r.relay.emit('event', { ev: 'peer', pair, online: false });
    afterGrace();
    r.relay.emit('frame', wireOf(r.phone, heard(id)));
    await drain(r);
    await r.channel.sessions.get(r.phone.pairId).sending; // the marker, if any, is sealed and handed to the relay
  };
  await cycle('a');
  assert.equal(r.relay.sent.length, 1, 'the first return is told');
  wall.at += 59_000;
  await cycle('b');
  assert.equal(r.relay.sent.length, 1, 'a second one inside a minute is not');
  wall.at += 2_000;
  await cycle('c');
  assert.equal(r.relay.sent.length, 2, 'a minute after the first marker it may be sent again');
  assert.deepEqual(
    evs(r).map((e: any) => e.ev),
    ['live.missed', 'live.missed'],
  );
});

test('A4: a backlog frame the relay flushes right after its hello does not flip an absent phone, and no marker is sealed', async () => {
  const { r, pair, presence } = await wired({ helloOnly: true });
  r.relay.emit('frame', wireOf(r.phone, heard('backlog-1'))); // authentic, and fresh by its own time, but read within seconds of the hello
  await drain(r);
  clock.at += GRACE - 100;
  r.relay.emit('frame', wireOf(r.phone, heard('backlog-2')));
  await drain(r);
  await settle();
  assert.equal(presence.isAbsent(pair), true, 'still absent');
  assert.equal(r.relay.sent.length, 0, 'no live.missed');
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['backlog-1', 'backlog-2'],
    'the frames themselves are delivered',
  );
  await r.channel.send(pair, live('skipped'));
  assert.equal(r.relay.sent.length, 0, 'live events are still skipped, so the counter does not grow');
  clock.at += 200; // 5 s and a little after the hello: the phone's own live frame now flips it
  r.relay.emit('frame', wireOf(r.phone, heard('live')));
  await drain(r);
  await until(() => r.relay.sent.length === 1);
  assert.equal(presence.isAbsent(pair), false);
  assert.equal(evs(r)[0].ev, 'live.missed');
});

test('A4: an authentic frame whose own time is old, or from a clock far ahead, does not flip an absent phone', async () => {
  const { r, pair, presence } = await wired();
  for (const [id, t] of [
    ['old', wall.at - 120_001],
    ['ahead', wall.at + 120_001],
  ] as const) {
    r.relay.emit('frame', wireOf(r.phone, msg(id, { t })));
    await drain(r);
  }
  await settle();
  assert.equal(presence.isAbsent(pair), true);
  assert.equal(r.relay.sent.length, 0);
  assert.equal(r.delivered.length, 2, 'both were handed over: they are authentic');
  r.relay.emit('frame', wireOf(r.phone, heard('fresh')));
  await drain(r);
  assert.equal(presence.isAbsent(pair), false);
});

test('a failing presence hook is noted, never pauses the session or loses the message, and the frame was already acknowledged', async () => {
  const { r } = await wired({
    onPhoneFrame: () => {
      throw new Error('hook failed');
    },
  });
  const acks = [] as any[];
  Object.assign(r.relay, { acks: true, sendAck: (m: any) => (acks.push(m), true) });
  r.relay.emit('frame', wireOf(r.phone, heard('a')));
  await drain(r);
  assert.equal(r.channel.closedReason(r.phone.pairId), null, 'not paused as a failed save');
  assert.deepEqual(
    r.delivered.map(([, m]) => m.id),
    ['a'],
  );
  assert.equal(acks.length, 1);
});
