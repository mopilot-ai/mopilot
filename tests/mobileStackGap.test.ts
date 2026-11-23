// Mobile Remote end to end: a gap in the frame counters in both directions (the Mac ahead of the phone, the phone ahead of the Mac within and beyond the Mac's cap) closes through the real relay, the real Mac channel and the real phone runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCrypto, MAX_SKIP } from '../shared/remote/crypto.mjs';
import { toHex, fromHex } from '../shared/remote/envelope.mjs';
import { advanceTx } from '../scripts/mobile-dev-host/gap.mjs';
import { startRelay, startMac, startPhone, until, vaultOf } from './support/mobileStack.ts';
import { prim } from './support/remoteKit.ts';

const crypto = createCrypto(prim);

async function following() {
  const relay = await startRelay();
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  await phone.ask('chat.follow', { chatId: 'c1' });
  return { mac, phone, pairId };
}
const turn = (mac: any, n: number) => mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: `t${n}`, status: 'running' });
const states = (phone: any) => phone.eventsOf('turn.state').map((e: any) => e.turnId);
const phoneRx = async (phone: any, pairId: string) => (await vaultOf(phone.storage).getPair(pairId)).rx.ctr as number;
const macRx = (mac: any, pairId: string) => mac.remote.channel.sessions.get(pairId).rx.state().ctr as number;
/** Moves the phone's saved send chain on, as many lost frames would, keeping it the pair's own chain. */
async function advancePhoneTx(phone: any, pairId: string, n: number) {
  await vaultOf(phone.storage).updatePair(pairId, (pair: any) => {
    pair.tx = { ctr: pair.tx.ctr + n, chain: toHex(crypto.advance(fromHex(pair.tx.chain), n)) };
    return { pair, value: null };
  });
}
const settled = (phone: any) => until(() => phone.snap().phase === 'online' && phone.snap().catchingUp !== true, 'the phone online again');

test('the Mac far ahead of the phone: the phone catches up, takes the next event and keeps answering', async () => {
  const { mac, phone, pairId } = await following();
  const before = await phoneRx(phone, pairId);
  await advanceTx({ channel: mac.remote.channel, devices: mac.remote.devices, n: MAX_SKIP + 500 });
  turn(mac, 1);
  // the frame that closes the gap is read and saved; the events inside the gap are gone, so the phone then reconnects and reads again (the opening event itself is not replayed)
  await until(async () => (await phoneRx(phone, pairId)) > before + MAX_SKIP, 'the saved receive counter to jump past the gap');
  await settled(phone);
  assert.notEqual(phone.snap().phase, 'error');
  turn(mac, 2);
  await until(() => states(phone).includes('t2'), 'a later live event');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('the phone ahead of the Mac within its cap: the Mac catches up and answers', async () => {
  const { mac, phone, pairId } = await following();
  const before = macRx(mac, pairId);
  await advancePhoneTx(phone, pairId, MAX_SKIP + 500);
  assert.equal((await phone.ask('machine.hello')).v, 1, 'the request was answered');
  await until(() => macRx(mac, pairId) > before + MAX_SKIP, 'the Mac to move its receive counter');
  assert.notEqual(phone.snap().phase, 'error');
  assert.equal((await phone.ask('machine.hello')).v, 1, 'and keeps answering');
});

test('the phone ahead of the Mac beyond its cap: the Mac drops the frame, keeps its counter, and the phone says so', async () => {
  const { mac, phone, pairId } = await following();
  mac.remote.channel.o.catchUpSkip = 100;
  const before = macRx(mac, pairId);
  await advancePhoneTx(phone, pairId, MAX_SKIP + 500);
  // the 8 s wait for the computer's answer to the probes is shortened; every other timer is the real one
  const realSet = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: any, ms: any, ...a: any[]) => realSet(fn, ms === 8000 ? 50 : ms, ...a)) as any;
  try {
    const answered = await Promise.race([
      phone.ask('machine.hello').then(
        () => true,
        () => false,
      ),
      new Promise((r) => realSet(() => r(null), 1500)),
    ]);
    assert.notEqual(answered, true, 'the request was not answered');
    await until(() => phone.snap().phase === 'error', 'the phone to say what is wrong', 15000);
  } finally {
    globalThis.setTimeout = realSet;
  }
  assert.match(phone.snap().error!, /stopped accepting messages/);
  assert.equal(macRx(mac, pairId), before, 'the Mac moved nothing');
});
