// A push from a Host (Remote Run P1): a Host asks for `push` and `activity` on its own pair and only a phone's lane can receive one. The
// sender sees the phone's token; a Mac's lane has none, so a Host never pushes to a Mac; every other pair, kind and size is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { MAX_SEALED } from '../relay/src/pushPayload.mjs';
import { TITLES } from '../relay/src/notifier.mjs';
import { makeDb, makeHub, paired, P } from './support/relayKit.ts';

const { db, reset } = await makeDb();
const HOST = 'h_host0000000000001';
const HOST2 = 'h_host0000000000002';
const PAIR = 'p_hostpair01';
const hash = createHash('sha256').update('s').digest('hex');
const STATE = { needs: 1, running: 0, kind: 'needs', since: 0, at: 0, rows: [] };

async function rig(o: Parameters<typeof makeHub>[1] = {}) {
  await reset();
  const r = makeHub(db, o);
  const phone = await r.lane('u1', 'ph1');
  await phone.say({ t: 'host.register', host: HOST, pair: PAIR, hash });
  const host = await r.host(HOST);
  host.socket.sent.length = 0;
  return { ...r, phone, host };
}
const token = (r: any, deviceId = 'ph1') =>
  r.hub.push.register({ deviceId, userId: 'u1', platform: 'apns', token: 'apns-token-phone-0001' });

test('a Host push reaches the phone behind its lane: the sender gets the phone token, fixed title, the opaque ref and the sealed blob', async () => {
  const r = await rig();
  await token(r);
  await r.host.say({ t: 'push', pair: PAIR, kind: 'needsYou', ref: 'chat-1', sealed: 'c2VhbGVk', rid: 'p1' });
  await Promise.resolve();
  assert.deepEqual(r.host.socket.last(), { t: 'push.result', pair: PAIR, status: 'sent', rid: 'p1' });
  assert.equal(r.pushed.length, 1);
  assert.equal(r.pushed[0].token, 'apns-token-phone-0001');
  assert.equal(r.pushed[0].ref, 'chat-1');
  assert.equal(r.pushed[0].body ?? '', '');
});

test('a phone with no token answers no_token and nothing is sent', async () => {
  const r = await rig();
  await r.host.say({ t: 'push', pair: PAIR, kind: 'done', ref: 'c' });
  assert.deepEqual(r.host.socket.last(), { t: 'push.result', pair: PAIR, status: 'no_token' });
  await r.host.say({ t: 'activity', pair: PAIR, state: STATE });
  assert.equal(r.host.socket.last().status, 'no_token');
  assert.equal(r.pushed.length, 0);
});

test('I: a Host push on a pair whose lane is a Mac’s is answered no_token and sends nothing, even if the Mac id has a token', async () => {
  await reset();
  const r = makeHub(db);
  const mac = await r.lane('u1', 'mac1', 'desktop');
  await mac.say({ t: 'host.register', host: HOST, pair: PAIR, hash });
  const host = await r.host(HOST);
  host.socket.sent.length = 0;
  await host.say({ t: 'push', pair: PAIR, kind: 'needsYou', ref: 'c' });
  assert.equal(host.socket.last().status, 'no_token');
  assert.equal(r.pushed.length, 0);
});

test('I: a Host cannot push on another Host’s pair, an unknown pair, or a Mac-and-phone pair', async () => {
  const r = await rig();
  await token(r);
  await r.phone.say({ t: 'host.register', host: HOST2, pair: 'p_hostpair02', hash });
  for (const pair of ['p_hostpair02', 'p_nopair0001', 'nope', undefined]) {
    await r.host.say({ t: 'push', pair, kind: 'done', ref: 'c' });
    assert.equal(r.host.socket.last().code, 'unknown_pair');
    await r.host.say({ t: 'activity', pair, state: STATE });
    assert.equal(r.host.socket.last().code, 'unknown_pair');
  }
  // a Mac and a phone of the account share a pair; a Host cannot push on it
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: 'p_macphone01' });
  await phone.say({ t: 'pair.join', pair: 'p_macphone01' });
  await r.host.say({ t: 'push', pair: 'p_macphone01', kind: 'done', ref: 'c' });
  assert.equal(r.host.socket.last().code, 'unknown_pair');
  assert.equal(r.pushed.length, 0);
});

test('I: a phone of another account, or its lane, cannot push on a Host pair', async () => {
  const r = await rig();
  await token(r);
  const other = await r.join('u2', 'ph2', 'phone');
  await other.say({ t: 'push', pair: PAIR, kind: 'done', ref: 'c' });
  assert.equal(other.socket.last().code, 'forbidden');
  const lane = await r.lane('u2', 'ph2');
  await lane.say({ t: 'push', pair: PAIR, kind: 'done', ref: 'c' });
  assert.equal(lane.socket.last().code, 'forbidden');
  assert.equal(r.pushed.length, 0);
});

test('B: oversized sealed, unknown kind, bad ref and bad card are refused; so is an activity with a bad state', async () => {
  const r = await rig();
  await token(r);
  const cases = [
    { kind: 'done', ref: 'c', sealed: 'x'.repeat(MAX_SEALED + 1) },
    { kind: 'done', ref: 'c', sealed: 5 },
    { kind: 'bogus', ref: 'c' },
    { kind: 'done', ref: '' },
    { kind: 'done', ref: 'c'.repeat(129) },
    { kind: 'done', ref: 'c', card: '' },
  ];
  for (const c of cases) {
    await r.host.say({ t: 'push', pair: PAIR, ...c });
    assert.equal(r.host.socket.last().code, 'bad_message');
  }
  await r.host.say({ t: 'activity', pair: PAIR, state: 'nope' });
  assert.equal(r.host.socket.last().code, 'bad_message');
  assert.equal(r.pushed.length, 0);
});

test('a Host activity reaches the phone’s Live Activity; a provider that breaks is answered push_failed', async () => {
  const r = await rig();
  await token(r);
  await r.hub.push.registerActivity({ deviceId: 'ph1', userId: 'u1', token: 'ab'.repeat(16) });
  r.pushed.length = 0;
  await r.host.say({ t: 'activity', pair: PAIR, state: STATE, rid: 'a1' });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(r.host.socket.last().status, 'sent');
  assert.equal(r.pushed.length >= 1, true);

  const broken = await rig({
    send: async () => {
      throw new Error('provider down');
    },
  });
  await token(broken);
  await broken.host.say({ t: 'push', pair: PAIR, kind: 'done', ref: 'c' });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(
    broken.host.socket.sent.some((m: any) => m.code === 'push_failed'),
    true,
  );
  await broken.hub.push.registerActivity({ deviceId: 'ph1', userId: 'u1', token: 'ab'.repeat(16) });
  broken.host.socket.sent.length = 0;
  broken.hub.push.activity = async () => {
    throw new Error('provider down');
  };
  await broken.host.say({ t: 'activity', pair: PAIR, state: STATE });
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(
    broken.host.socket.sent.some((m: any) => m.code === 'push_failed'),
    true,
  );
});

test('a phone whose only pair is a Host enrollment keeps its token when its Mac pair goes', async () => {
  const r = await rig();
  await token(r);
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  await mac.say({ t: 'pair.register', pair: 'p_macphone01' });
  await phone.say({ t: 'pair.join', pair: 'p_macphone01' });
  await phone.say({ t: 'pair.remove', pair: 'p_macphone01' });
  assert.ok(await r.store.pushTokenOf('ph1'), 'the token stays: a Host can still push to this phone');
  await r.phone.say({ t: 'host.revoke', host: HOST });
  await r.hub.push.pairRemoved(PAIR, 'ph1');
  assert.equal(await r.store.pushTokenOf('ph1'), null);
});

test('a Host’s next card for a chat and the clearing that replaces its push are both sent, where a Mac’s repeat is held (#4591)', async () => {
  const r = await rig();
  await token(r);
  const say = async (kind: string, rid: string) => (
    await r.host.say({ t: 'push', pair: PAIR, kind, ref: 'chat-1', sealed: 'c2VhbGVk', rid }),
    await Promise.resolve(),
    r.host.socket.last().status
  );
  // a card, its clearing (a "done" under a held "needs you"), and the next card at once: one push each
  assert.equal(await say('needsYou', 'a'), 'sent');
  assert.equal(await say('done', 'b'), 'sent');
  assert.equal(await say('needsYou', 'c'), 'sent');
  assert.deepEqual(
    r.pushed.map((p: any) => p.kind),
    ['needsYou', 'done', 'needsYou'],
  );
});

test('a Host clearing replaces its waiting push (same collapse id) with a title that claims nothing else, and carries no blob', async () => {
  const r = await rig();
  await token(r);
  await r.host.say({ t: 'push', pair: PAIR, kind: 'needsYou', ref: 'chat-1', sealed: 'c2VhbGVk', rid: 'p1' });
  await r.host.say({ t: 'push', pair: PAIR, kind: 'cleared', ref: 'chat-1', sealed: 'c2VhbGVk', rid: 'p2' });
  await new Promise((res) => setTimeout(res, 20));
  assert.deepEqual(r.host.socket.last(), { t: 'push.result', pair: PAIR, status: 'sent', rid: 'p2' });
  const [waiting, cleared] = r.pushed;
  assert.equal(cleared.kind, 'cleared');
  assert.equal(cleared.title, TITLES.cleared);
  assert.notEqual(cleared.title, TITLES.done);
  assert.equal(cleared.collapseId, waiting.collapseId);
  assert.equal(cleared.sealed, undefined, 'the relay forwards a blob only on a needs-you or done push');
});

test('a clearing is a Host’s: a Mac that sends one is refused and nothing goes to the phone', async () => {
  const r = await paired(db, {});
  await r.phone.say({ t: 'push.register', platform: 'apns', token: 'tok' });
  await r.mac.say({ t: 'push', pair: P, kind: 'cleared', ref: 'c' });
  assert.equal(r.mac.socket.last().code, 'bad_message');
  assert.equal(r.pushed.length, 0);
});
