// Mobile Remote end to end, scenario 11 (continued): the messages waiting on the phone are kept on the device. They survive the app being closed, a message that was on its way waits for the person, one older than a week is cancelled, and another account's leftovers are never read back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, savedOutbox, vaultOf, type Relay } from './support/mobileStack.ts';
import { fakeSafe } from './support/remoteKit.ts';

async function connected(relay: Relay, macOpts: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, macOpts);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  mac.known.add('c2');
  return { mac, phone, pairId };
}
/** What reached the Mac's chat panel, in order. */
const reached = (mac: any) => mac.calls.filter((c: any[]) => c[0] === 'send').map((c: any[]) => `${c[1].chatId}:${c[1].text}`);
/** The OS kills the app and it is opened again on what was saved: the old runtime can no longer change the saved state. */
async function relaunch(relay: Relay, phone: any) {
  const storage = phone.storage.reopen();
  phone.runtime.disconnect();
  phone.goOffline();
  return startPhone(relay, { id: phone.env.id, storage });
}
/** Waits until what the phone saved matches: the app wrote it before it was killed. */
const saved = (phone: any, what: string, ok: (items: any[]) => boolean) =>
  until(async () => ok((await savedOutbox(phone.storage))?.items ?? []), `the saved messages: ${what}`);

test('messages typed while the Mac was away survive the app being closed and are delivered once when the Mac is back', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the Mac');
  const first = phone.runtime.send('c1', 'typed before the app was killed');
  phone.runtime.send('c2', 'and another chat');
  await saved(phone, 'both waiting', (items) => items.length === 2);

  const reopened = await relaunch(relay, phone);
  assert.deepEqual(
    reopened.snap().outbox.map((i: any) => [i.chatId, i.text, i.status]),
    [
      ['c1', 'typed before the app was killed', 'queued'],
      ['c2', 'and another chat', 'queued'],
    ],
    'back on the home screen as waiting',
  );
  assert.equal(reopened.snap().outbox[0].id, first, 'under the send id it was typed with');

  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  again.known.add('c2');
  await reopened.runtime.connect(pairId);
  await until(() => reopened.snap().outbox.length === 0, 'the messages to be delivered');
  assert.deepEqual(reached(again), ['c1:typed before the app was killed', 'c2:and another chat'], 'in order, once');
  // delivered messages are gone from the device too: a second relaunch has nothing to send
  await saved(reopened, 'none left', (items) => items.length === 0);
  const third = await relaunch(relay, reopened);
  assert.deepEqual(third.snap().outbox, []);
  await third.runtime.connect(pairId);
  assert.equal(reached(again).length, 2);
});

test('a message that was on its way when the app was killed waits for the person and goes once on Retry', async () => {
  const relay = await startRelay();
  let release: () => void = () => undefined;
  const taken: string[] = [];
  const { mac, phone, pairId } = await connected(relay, {
    ops: {
      send: async (m: any) => {
        taken.push(m.text);
        await new Promise<void>((resolve) => (release = resolve));
        return {};
      },
    },
  });
  void mac;
  const id = phone.runtime.send('c1', 'was it delivered?');
  await until(() => taken.length === 1, 'the Mac to take it');
  await saved(phone, 'on its way', (items) => items[0]?.status === 'sending');

  const reopened = await relaunch(relay, phone);
  assert.equal(reopened.snap().outbox[0].status, 'failed');
  assert.match(reopened.snap().outbox[0].error!, /app closed while this was sending/);
  await reopened.runtime.connect(pairId);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(taken, ['was it delivered?'], 'not sent again by itself');
  assert.equal(reopened.runtime.retrySend(id), true);
  release();
  await until(() => reopened.snap().outbox.length === 0, 'the retry to be answered');
  assert.deepEqual(taken, ['was it delivered?'], 'the Mac answered the same id with the first outcome');
});

test('a message that waited longer than a week is not sent, only cancelled', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  phone.runtime.send('c1', 'ancient');
  await saved(phone, 'waiting', (items) => items.length === 1);
  const realNow = Date.now;
  Date.now = () => realNow() + 8 * 24 * 60 * 60 * 1000;
  let reopened: any;
  try {
    reopened = await relaunch(relay, phone);
  } finally {
    Date.now = realNow;
  }
  assert.equal(reopened.snap().outbox[0].status, 'failed');
  assert.match(reopened.snap().outbox[0].error!, /waited longer than a week/);
  assert.equal(reopened.runtime.retrySend(reopened.snap().outbox[0].id), false);
  assert.equal(reopened.runtime.cancelSend(reopened.snap().outbox[0].id), true);
  assert.deepEqual(reopened.snap().outbox, []);
});

test('signing out or removing the computer clears what is kept on the device', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  phone.runtime.send('c1', 'to be removed with the computer');
  await saved(phone, 'waiting', (items) => items.length === 1);
  await phone.runtime.unpair(pairId);
  await saved(phone, 'none after the computer was removed', (items) => items.length === 0);
  const afterUnpair = await relaunch(relay, phone);
  assert.deepEqual(afterUnpair.snap().outbox, [], 'nothing kept for a computer that was removed');

  const second = await connected(await startRelay(), { safe: fakeSafe() });
  second.mac.stop();
  await until(() => second.phone.snap().reconnect?.pairId === second.pairId, 'the second phone to wait');
  second.phone.runtime.send('c1', 'to be forgotten at sign-out');
  await saved(second.phone, 'waiting', (items) => items.length === 1);
  await second.phone.runtime.signOut();
  await saved(second.phone, 'none after sign-out', (items) => items.length === 0);
  const afterSignOut = await relaunch(second.mac ? (second.phone.env.relay as any) : null, second.phone);
  assert.deepEqual(afterSignOut.snap().outbox, []);
});

test('what another account left on the device is not read back, and the queue has a size limit', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  const item = { id: 'send-0001', pairId, chatId: 'c1', text: 'not yours', attachments: [], at: Date.now(), status: 'queued', error: null };
  await vaultOf(phone.storage).setOutbox({ user: 'someone-else', items: [item] });
  const reopened = await relaunch(relay, phone);
  assert.deepEqual(reopened.snap().outbox, [], 'another account’s messages are not shown or sent');
  await until(async () => (await savedOutbox(reopened.storage)) === null, 'the other account’s messages to be removed from the device');
  // a full queue refuses another message instead of growing without limit
  reopened.runtime.disconnect();
  await reopened.runtime.connect(pairId).catch(() => undefined);
  await until(() => reopened.snap().reconnect?.pairId === pairId, 'the phone to wait again');
  for (let i = 0; i < 100; i++) reopened.runtime.send('c1', `message ${i}`);
  assert.throws(() => reopened.runtime.send('c1', 'one too many'), /Too many messages are waiting/);
  reopened.runtime.disconnect();
});

test('a save that failed is written again on the next connection, so a cancelled message does not come back', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  const id = phone.runtime.send('c1', 'cancelled but not forgotten');
  await saved(phone, 'waiting', (items) => items.length === 1);
  // the write that records the Cancel fails
  phone.storage.failWrites(true);
  assert.equal(phone.runtime.cancelSend(id), true);
  await until(() => phone.storage.failedWrites() > 0, 'the save of the cancel to fail');
  phone.storage.failWrites(false);
  assert.equal((await savedOutbox(phone.storage))?.items.length, 1, 'the device still holds it');
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await phone.runtime.connect(pairId);
  await saved(phone, 'the cancel recorded after all', (items) => items.length === 0);
  assert.deepEqual(reached(again), [], 'a message that was cancelled is never sent');
});

test('connecting while the saved messages are being read does not leave the phone without a queue on the device', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  phone.runtime.send('c1', 'kept from before');
  await saved(phone, 'waiting', (items) => items.length === 1);
  const storage = phone.storage.reopen();
  phone.runtime.disconnect();
  phone.goOffline();
  const reopened = await startPhone(relay, { id: phone.env.id, storage, signIn: false });
  // a tap on the computer straight after the app opened
  await reopened.runtime.connect(pairId).catch(() => undefined);
  await until(() => reopened.snap().outbox.length === 1, 'the saved message to be shown');
  reopened.runtime.send('c1', 'typed after');
  await saved(reopened, 'both kept', (items) => items.length === 2);
  reopened.runtime.disconnect();
});
