// Mobile Remote end to end, beyond the eight scenarios: the sealed session survives the app closing, the Mac restarting and the relay restarting, and a reply too large for one frame is handled rather than lost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, type Relay } from './support/mobileStack.ts';
import { fakeSafe } from './support/remoteKit.ts';

async function connected(relay: Relay, macOpts: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, macOpts);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  return { mac, phone, pairId };
}
const turn = (mac: any, n: number) => mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: `t${n}`, status: 'running' });
/** An event the Mac must deliver (a live view is not sealed for an absent phone, which reads again when it returns): it waits in the mailbox. */
const kept = (mac: any, pairId: string, n: number) =>
  mac.remote.channel.send(pairId, { id: `k${n}`, t: n, kind: 'event', ev: 'momo.changed', area: `a${n}` });
const areas = (phone: any) => phone.eventsOf('momo.changed').map((e: any) => e.area);
const turns = (phone: any) => phone.eventsOf('turn.state').map((e: any) => e.turnId);

test('closing and reopening the phone app resumes the same sealed session, and what the Mac sent meanwhile arrives', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  await phone.ask('chat.follow', { chatId: 'c1' });
  turn(mac, 1);
  await until(() => turns(phone).length === 1, 'the first event');
  phone.runtime.disconnect();

  kept(mac, pairId, 2);
  const reopened = await startPhone(relay, { storage: phone.storage });
  assert.equal(reopened.snap().user?.id, 'u1', 'the account came back from the vault');
  assert.deepEqual(
    reopened.snap().pairs.map((p) => p.pairId),
    [pairId],
  );
  await reopened.runtime.connect(pairId);
  assert.equal((await reopened.ask('machine.hello')).v, 1);
  // the follow belongs to the old session: the Mac keeps it, so the event that waited still arrives
  await until(() => areas(reopened).includes('a2'), 'the event sent while the app was closed');
  turn(mac, 3);
  await until(() => turns(reopened).includes('t3'), 'a live event');
});

test('a restarted Mac resumes the pair from its saved ratchets and the phone reconnects to it', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const first = await connected(relay, { safe });
  const { phone, pairId, mac } = first;
  assert.equal((await phone.ask('machine.hello')).v, 1);
  mac.stop();
  await until(() => phone.snap().phase === 'offline', 'the phone to see the Mac leave');

  const again = await startMac(relay, { userData: mac.userData, safe });
  assert.deepEqual(
    again.remote.devices.list().map((d: any) => d.pairId),
    [pairId],
    'the Mac remembers the phone',
  );
  again.known.add('c1');
  await until(() => again.relayState() === 'open', 'the restarted Mac to reach the relay');
  await phone.runtime.connect(pairId);
  assert.equal((await phone.ask('machine.hello')).v, 1, 'the phone’s next request is opened by the restarted Mac and answered');
  await phone.ask('chat.follow', { chatId: 'c1' });
  turn(again, 1);
  await until(() => turns(phone).length === 1, 'an event from the restarted Mac');
});

test('a relay restart drops every socket and both sides come back; what was sent meanwhile is delivered', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  await phone.ask('chat.follow', { chatId: 'c1' });
  turn(mac, 1);
  await until(() => turns(phone).length === 1, 'the first event');

  await relay.restart(200);
  await until(() => phone.snap().phase === 'offline', 'the phone to notice');
  await until(() => mac.relayState() === 'open', 'the Mac to reconnect', 15000);
  kept(mac, pairId, 2);
  phone.foreground();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to reconnect');
  await until(() => areas(phone).includes('a2'), 'the event sent after the restart');
  turn(mac, 3);
  await until(() => turns(phone).includes('t3'), 'a live event after the restart');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('a followed chat whose recent items are larger than one frame still opens, with fewer of them', async () => {
  const relay = await startRelay();
  const big = 'x'.repeat(40_000);
  const { phone } = await connected(relay, {
    ops: {
      items: async (_id: string, n: number) => ({
        itemsShape: 'rows',
        items: Array.from({ length: n }, (_, i) => ({ role: 'assistant', text: `${i}${big}` })),
      }),
    },
  });
  const snap = await phone.ask('chat.follow', { chatId: 'c1', items: 50 });
  assert.ok(snap.items.length > 0 && snap.items.length < 50, `${snap.items.length} items fit`);
  assert.equal(phone.snap().phase, 'online');
});

test('an answer that cannot be sent at all fails at once with a reason instead of timing out', async () => {
  const relay = await startRelay();
  const { phone } = await connected(relay, {
    ops: { read: async () => ({ chatId: 'c1', rows: [{ role: 'assistant', text: 'x'.repeat(400_000) }] }) },
  });
  const started = Date.now();
  await assert.rejects(phone.ask('chat.read', { chatId: 'c1' }), /too large/);
  assert.ok(Date.now() - started < 5000, 'not after the request timeout');
});
