// One account cannot use up what the relay stores for everyone (security review AI-1): its pairs together hold a bounded number of frames and bytes, it may join a bounded number of pairs, and an account at its quota leaves another account's frames alone, in the durable mailbox and the plain one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { migrateDurable } from '../relay/src/durableStore.mjs';
import { makeDb, makeHub, b64, settle, MAILBOX } from './support/relayKit.ts';

const { db, reset } = await makeDb();
await migrateDurable(db);
beforeEach(reset);

const PAIRS = ['p_attack0001', 'p_attack0002', 'p_attack0003'];
const VICTIM = 'p_victim0001';
const frameOn = (pair: string, dir: 'm2p' | 'p2m', ctr: number, o: object = {}) => ({
  t: 'frame',
  pair,
  dir,
  ctr,
  nonce: b64(24),
  box: b64(40, ctr),
  ...o,
});

/** An attacker (u1: one Mac, one phone, three pairs between them) and a victim (u2: one pair), nobody acknowledging anything. */
async function rig(limits: object, o: Parameters<typeof makeHub>[1] = {}) {
  const r = makeHub(db, { durable: true, mailbox: { ...MAILBOX, maxFrames: 5 }, limits, ...o });
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  for (const pair of PAIRS) {
    await mac.say({ t: 'pair.register', pair });
    await phone.say({ t: 'pair.join', pair });
  }
  const mac2 = await r.join('u2', 'mac2', 'desktop');
  const phone2 = await r.join('u2', 'ph2', 'phone');
  await mac2.say({ t: 'pair.register', pair: VICTIM });
  await phone2.say({ t: 'pair.join', pair: VICTIM });
  return { ...r, mac, phone, mac2, phone2 };
}

test('an account that fills its own quota through several pairs is refused with scope account, and another account still stores and receives', async () => {
  // the relay holds 10 frames in all: two of the attacker's pairs filled to their 5 would take every one of them
  const r = await rig({ globalMaxFrames: 10, globalMaxBytes: 1_000_000, accountMaxFrames: 6, accountMaxBytes: 1_000_000 });
  // the phone side never acknowledges: it is the attacker's own
  r.phone.socket.sent.length = 0;
  let ctr = 0;
  const refused: any[] = [];
  for (const pair of PAIRS)
    for (let i = 1; i <= 5; i++) {
      await r.mac.say(frameOn(pair, 'm2p', i, { rid: `a${++ctr}` }));
      const last = r.mac.socket.last();
      if (last.t === 'error') refused.push(last);
    }
  assert.equal(
    Number((await db.query("SELECT count(*) AS n FROM remote_durable.frames WHERE pair_id LIKE 'p_attack%'")).rows[0].n),
    6,
    'the account holds its quota and no more',
  );
  assert.deepEqual(refused[0], { t: 'error', code: 'mailbox_full', rid: 'a7', pair: PAIRS[1], ctr: 2, scope: 'account' });
  assert.ok(refused.every((e) => e.scope === 'account'));
  // the other account is not affected: its frame is stored and delivered
  await r.mac2.say(frameOn(VICTIM, 'm2p', 1, { rid: 'v1' }));
  assert.equal(r.mac2.socket.of('ack').at(-1)?.via, 'mailbox');
  assert.equal(r.phone2.socket.of('frame').at(-1)?.pair, VICTIM);
  assert.match(r.hub.metrics.render(), /^relay_mailbox_full_total\{scope="account"\} 9$/m);
  // a receipt makes room in the account, as it does in a pair
  await r.phone.say({ t: 'ack', pair: PAIRS[0], dir: 'm2p', ctr: 1 });
  await r.mac.say(frameOn(PAIRS[2], 'm2p', 1, { rid: 'room' }));
  assert.equal(r.mac.socket.last().via, 'mailbox');
});

test('before the quota existed this was the outage: with no account quota one account takes every frame the relay may hold and the other account is refused', async () => {
  // the same traffic with the account quota out of the way (as on main before the fix): the mechanism the quota removes
  const r = await rig({ globalMaxFrames: 10, globalMaxBytes: 1_000_000, accountMaxFrames: 1_000_000, accountMaxBytes: 1_000_000_000 });
  for (const pair of PAIRS.slice(0, 2)) for (let i = 1; i <= 5; i++) await r.mac.say(frameOn(pair, 'm2p', i));
  await r.mac2.say(frameOn(VICTIM, 'm2p', 1, { rid: 'v1' }));
  assert.deepEqual(r.mac2.socket.last(), { t: 'error', code: 'mailbox_full', rid: 'v1', pair: VICTIM, ctr: 1, scope: 'relay' });
});

test('the account quota counts bytes too, and a repeat of a frame already stored is still answered at the quota', async () => {
  // a frame is 24 + 40 bytes: three fit in 200
  const r = await rig({ accountMaxFrames: 1000, accountMaxBytes: 200 });
  for (let i = 1; i <= 3; i++) await r.mac.say(frameOn(PAIRS[0], 'm2p', i));
  await r.mac.say(frameOn(PAIRS[1], 'm2p', 1, { rid: 'over' }));
  assert.deepEqual(r.mac.socket.last(), { t: 'error', code: 'mailbox_full', rid: 'over', pair: PAIRS[1], ctr: 1, scope: 'account' });
  await r.mac.say(frameOn(PAIRS[0], 'm2p', 2));
  assert.equal(r.mac.socket.last().via, 'mailbox');
  // the phone's own direction counts against the same account
  await r.phone.say(frameOn(PAIRS[2], 'p2m', 1, { rid: 'p' }));
  assert.equal(r.phone.socket.last().scope, 'account');
  // the pair's own cap is still told apart
  const pairFull = await rig({ accountMaxFrames: 1000, accountMaxBytes: 1_000_000 });
  for (let i = 1; i <= 6; i++) await pairFull.mac.say(frameOn(PAIRS[0], 'm2p', i, { rid: `f${i}` }));
  assert.equal(pairFull.mac.socket.last().scope, 'pair');
});

test('the plain mailbox has the same account and relay-wide bounds: pairing frames cannot be piled up across pairs either', async () => {
  const r = await rig({ accountMaxFrames: 3, accountMaxBytes: 1_000_000, globalMaxFrames: 5, globalMaxBytes: 1_000_000 });
  // counter 0 is the pairing frame: it goes to the plain mailbox when the peer cannot take it
  r.phone.socket.failSend = true;
  r.phone2.socket.failSend = true;
  const results: string[] = [];
  for (const pair of PAIRS)
    for (let i = 0; i < 2; i++) {
      await r.mac.say(frameOn(pair, 'm2p', 0, { rid: `${pair}${i}` }));
      results.push(r.mac.socket.last().t);
    }
  assert.deepEqual(results, ['ack', 'ack', 'ack', 'error', 'error', 'error'], 'three across its pairs, then refused');
  assert.equal(r.mac.socket.last().code, 'mailbox_full');
  assert.match(r.hub.metrics.render(), /^relay_mailbox_full_total\{scope="plain"\} 3$/m);
  await r.mac2.say(frameOn(VICTIM, 'm2p', 0));
  assert.equal(r.mac2.socket.last().t, 'ack', 'the other account still stores');
  // bytes: one more frame of 40 would pass 3 frames' worth
  const bytes = await rig({ accountMaxFrames: 1000, accountMaxBytes: 100 });
  bytes.phone.socket.failSend = true;
  for (let i = 0; i < 3; i++) await bytes.mac.say(frameOn(PAIRS[i], 'm2p', 0));
  assert.equal(bytes.mac.socket.last().code, 'mailbox_full');
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM relay_mailbox')).rows[0].n), 2);
  // the relay as a whole: other accounts' frames count
  await reset();
  const whole = await rig({ accountMaxFrames: 1000, accountMaxBytes: 1_000_000, globalMaxFrames: 2, globalMaxBytes: 1_000_000 });
  whole.phone.socket.failSend = true;
  whole.phone2.socket.failSend = true;
  await whole.mac.say(frameOn(PAIRS[0], 'm2p', 0));
  await whole.mac.say(frameOn(PAIRS[1], 'm2p', 0));
  await whole.mac2.say(frameOn(VICTIM, 'm2p', 0, { rid: 'full' }));
  assert.equal(whole.mac2.socket.last().code, 'mailbox_full');
  await reset();
  const wholeBytes = await rig({ accountMaxFrames: 1000, accountMaxBytes: 1_000_000, globalMaxFrames: 1000, globalMaxBytes: 70 });
  wholeBytes.phone.socket.failSend = true;
  wholeBytes.phone2.socket.failSend = true;
  await wholeBytes.mac.say(frameOn(PAIRS[0], 'm2p', 0));
  await wholeBytes.mac2.say(frameOn(VICTIM, 'm2p', 0, { rid: 'full' }));
  assert.equal(wholeBytes.mac2.socket.last().code, 'mailbox_full');
});

test('an account may join a bounded number of pairs; past it the join is refused pair_limit, a pair that goes makes room, and another account is unaffected', async () => {
  const r = makeHub(db, { durable: true, limits: { pairsPerAccount: 2 } });
  const mac = await r.join('u1', 'mac1', 'desktop');
  const phone = await r.join('u1', 'ph1', 'phone');
  for (const pair of PAIRS) await mac.say({ t: 'pair.register', pair });
  await phone.say({ t: 'pair.join', pair: PAIRS[0], rid: 'j1' });
  await phone.say({ t: 'pair.join', pair: PAIRS[1], rid: 'j2' });
  assert.equal(phone.socket.last().t, 'ok');
  await phone.say({ t: 'pair.join', pair: PAIRS[2], rid: 'j3' });
  assert.deepEqual(phone.socket.last(), { t: 'error', code: 'pair_limit', rid: 'j3', pair: PAIRS[2] });
  // joining one it already has is still fine (a reconnect), and one whose window closed still reads as expired
  await phone.say({ t: 'pair.join', pair: PAIRS[0], rid: 'again' });
  assert.equal(phone.socket.last().t, 'ok');
  const mac2 = await r.join('u2', 'mac2', 'desktop');
  const phone2 = await r.join('u2', 'ph2', 'phone');
  await mac2.say({ t: 'pair.register', pair: VICTIM });
  await phone2.say({ t: 'pair.join', pair: VICTIM, rid: 'v' });
  assert.equal(phone2.socket.last().t, 'ok');
  await phone.say({ t: 'pair.remove', pair: PAIRS[1] });
  await phone.say({ t: 'pair.join', pair: PAIRS[2], rid: 'room' });
  assert.equal(phone.socket.last().t, 'ok');
  // with no cap named the store refuses nobody, and an expired window is told apart from the cap
  await mac.say({ t: 'pair.register', pair: 'p_attack0004' });
  r.clock.advance(181_000);
  assert.deepEqual(await r.store.joinPair({ pairId: 'p_attack0004', userId: 'u1', phoneDeviceId: 'ph1', now: r.clock.now() }), {
    ok: false,
    code: 'expired',
  });
  // at the cap too, a pair whose window closed reads as expired, not as the cap
  await mac.say({ t: 'pair.register', pair: 'p_attack0005' });
  r.clock.advance(181_000);
  await phone.say({ t: 'pair.join', pair: 'p_attack0005', rid: 'late' });
  assert.equal(phone.socket.last().code, 'expired');
});

test('switching an account off deletes the frames stored for it, in both mailboxes, and the relay-wide count follows', async () => {
  const { setAccountAccess } = await import('../relay/src/access.mjs');
  const r = await rig({ globalMaxFrames: 6, globalMaxBytes: 1_000_000, accountMaxFrames: 1000, accountMaxBytes: 1_000_000 });
  r.phone.socket.failSend = true;
  await r.mac.say(frameOn(PAIRS[0], 'm2p', 0));
  for (let i = 1; i <= 5; i++) await r.mac.say(frameOn(PAIRS[0], 'm2p', i));
  await r.mac.say(frameOn(PAIRS[1], 'm2p', 1));
  await r.mac2.say(frameOn(VICTIM, 'm2p', 1, { rid: 'v1' }));
  assert.equal(r.mac2.socket.last().scope, 'relay', 'the relay is full');
  // a frame the account still has in flight when the switch lands is not handled: its socket is closed before the frames are deleted
  const closing = setAccountAccess(r.hub, { userId: 'u1', disabled: true, atMs: r.clock.now() });
  r.mac.h.message(JSON.stringify(frameOn(PAIRS[2], 'm2p', 1)));
  assert.deepEqual(await closing, { sockets: 2, frames: 7 });
  await settle(r.hub);
  assert.equal(r.mac.socket.closedWith?.code, 4423);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM remote_durable.frames')).rows[0].n), 0);
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM relay_mailbox')).rows[0].n), 0);
  await r.mac2.say(frameOn(VICTIM, 'm2p', 1, { rid: 'v2' }));
  assert.equal(r.mac2.socket.last().via ?? r.mac2.socket.of('ack').at(-1)?.via, 'mailbox', 'room at once, not when the count is next read');
  // a hub without the durable mailbox clears the plain one
  await reset();
  const plain = makeHub(db);
  assert.deepEqual(await setAccountAccess(plain.hub, { userId: 'u1', disabled: true, atMs: plain.clock.now() }), { sockets: 0, frames: 0 });
});
