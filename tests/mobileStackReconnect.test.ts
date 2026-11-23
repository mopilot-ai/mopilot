// Mobile Remote end to end, scenario 10: the phone brings a computer back by itself. A Mac that restarts, a relay that restarts and a phone that loses its network are all retried with backoff, without a tap, a storm or a second socket, and the phone says whether the Mac is online, asleep or unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, sleep, withPhoneTiming, type Relay } from './support/mobileStack.ts';
import { fakeSafe } from './support/remoteKit.ts';

async function connected(relay: Relay, macOpts: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, macOpts);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  mac.known.add('c1');
  await phone.ask('chat.follow', { chatId: 'c1' });
  return { mac, phone, pairId };
}
const turns = (phone: any) => phone.eventsOf('turn.state').map((e: any) => e.turnId);
const turn = (mac: any, n: number) => mac.service.onFeedEvent({ ev: 'turn.state', chatId: 'c1', turnId: `t${n}`, status: 'running' });

test('a Mac that restarts is found again without a tap, and the followed chat keeps flowing', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  assert.equal(phone.snap().presence[pairId].state, 'online');
  mac.stop();
  await until(() => phone.snap().phase === 'offline', 'the phone to see the Mac leave');
  assert.equal(phone.snap().presence[pairId]?.state ?? 'gone', 'gone', 'the Mac is not reachable');
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to start waiting for the Mac');
  const tries = phone.opened();
  await until(() => phone.opened() > tries + 1, 'the phone to keep trying while the Mac is away');
  assert.equal(phone.snap().phase, 'offline');
  assert.ok(phone.snap().presence[pairId].lastSeen, 'last seen is known');

  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to come back by itself');
  assert.equal(phone.snap().reconnect, null, 'the wait is over');
  assert.equal(phone.snap().presence[pairId].state, 'online');
  assert.equal((await phone.ask('machine.hello')).v, 1);
  await phone.ask('chat.follow', { chatId: 'c1' });
  turn(again, 1);
  await until(() => turns(phone).includes('t1'), 'a live event after the resume');
});

test('a Mac that comes back is found at once, not at the end of the phone’s long wait', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  await withPhoneTiming({ baseMs: 150, capMs: 20_000 }, async () => {
    const { mac, phone, pairId } = await connected(relay, { safe });
    mac.stop();
    await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to start waiting for the Mac');
    // waits of 150, 300, 600 and 1200 ms: the next is 2.4 s away
    await until(() => (phone.snap().reconnect?.attempt ?? 0) >= 4, 'the phone to be deep into its backoff', 6000);
    const waitingSince = Date.now();
    const again = await startMac(relay, { userData: mac.userData, safe });
    again.known.add('c1');
    await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to come back', 2000);
    assert.ok(Date.now() - waitingSince < 2000, `back in ${Date.now() - waitingSince} ms, well inside the 2.4 s wait`);
    assert.equal(phone.snap().reconnect, null);
    assert.equal((await phone.ask('machine.hello')).v, 1);
  });
});

test('a relay restart is waited out: the phone reconnects on its own and the session works both ways', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  await relay.restart(150);
  await until(
    () => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId && phone.snap().reconnect === null,
    'the phone to come back',
  );
  await until(() => mac.relayState() === 'open', 'the Mac to come back');
  await phone.ask('chat.follow', { chatId: 'c1' });
  turn(mac, 1);
  await until(() => turns(phone).includes('t1'), 'an event over the new connection');
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('a phone that lost its network backs off, does not storm, and returns when the network does', async () => {
  const relay = await startRelay();
  const { phone, pairId } = await connected(relay);
  phone.goOffline();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to start waiting');
  const start = phone.opened();
  await sleep(600);
  const tries = phone.opened() - start;
  // base 30 ms doubling to 120 ms: well under one try per 25 ms even counting the forced ones
  assert.ok(tries >= 3 && tries <= 12, `${tries} tries in 600 ms`);
  assert.ok(phone.snap().reconnect!.attempt >= 2, 'the attempt count grows');
  phone.foreground();
  phone.foreground();
  phone.foreground();
  await sleep(10);
  assert.ok(phone.opened() - start - tries <= 2, 'three foregrounds in a row make at most one more try');
  phone.comeBack();
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the phone to return with the network');
  assert.equal(phone.snap().reconnect, null);
  assert.equal((await phone.ask('machine.hello')).v, 1);
});

test('the user can force it, and leaving stops the waiting', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  await assert.rejects(phone.runtime.connect(pairId), /offline/);
  assert.equal(phone.snap().phase, 'offline');
  assert.equal(phone.snap().reconnect?.pairId, pairId, 'a failed tap keeps the wait going');
  phone.runtime.disconnect();
  assert.equal(phone.snap().reconnect, null, 'disconnecting ends the wait');
  const tries = phone.opened();
  await sleep(300);
  assert.equal(phone.opened(), tries, 'no attempt after the user left');
});

test('a Mac that goes to sleep is shown as asleep and the phone returns when it wakes', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  const client = (mac.remote.channel as any).o.relay;
  client.setPresence('sleeping');
  await until(
    () => phone.snap().presence[pairId].state === 'sleeping' && phone.snap().phase === 'offline',
    'the phone to hear the Mac sleep',
  );
  assert.equal(phone.snap().reconnect?.pairId, pairId);
  await sleep(300);
  assert.equal(phone.snap().phase, 'offline', 'a sleeping Mac is not connected to, even while its socket is still open');
  assert.equal(phone.snap().presence[pairId].state, 'sleeping');
  client.setPresence('online');
  await until(
    () => phone.snap().phase === 'online' && phone.snap().presence[pairId].state === 'online',
    'the phone to return when the Mac wakes',
  );
  assert.equal((await phone.ask('machine.hello')).v, 1);
  assert.ok(phone.env.sockets.filter((ws: any) => ws.readyState === 1).length <= 1, 'never two live sockets');
});

test('Try now keeps the computer shown as being brought back while it connects, and ends the wait when it succeeds', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait');
  const seen: Array<string | undefined> = [];
  const off = phone.runtime.subscribe(() => seen.push(phone.snap().reconnect?.pairId));
  await assert.rejects(phone.runtime.connect(pairId), /offline/);
  assert.ok(seen.length > 0 && seen.every((id) => id === pairId), 'the chat view never saw the wait end during a failed tap');
  assert.equal(phone.snap().reconnect?.pairId, pairId, 'the failed tap resumed the wait');

  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => again.relayState() === 'open', 'the Mac to be back');
  seen.length = 0;
  await phone.runtime.connect(pairId);
  assert.equal(phone.snap().phase, 'online');
  assert.equal(phone.snap().reconnect, null, 'a tap that connects ends the wait');
  assert.equal(seen.at(-1), undefined);
  off();
});

test('a manual connect that the relay refuses ends the wait instead of leaving it half open', async () => {
  const relay = await startRelay();
  const { phone, pairId } = await connected(relay);
  phone.runtime.disconnect();
  await relay.server.close();
  // the relay is gone: the tap fails like a lost network, which is waited out
  await assert.rejects(phone.runtime.connect(pairId));
  assert.equal(phone.snap().reconnect?.pairId, pairId);
  phone.runtime.disconnect();
  assert.equal(phone.snap().reconnect, null);
});

test('removing another computer does not end the wait for this one', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  const other = await startMac(relay, { deviceId: 'mac-2', userId: 'u1' });
  await phone.pair(await other.qr());
  await until(() => phone.snap().pairs.length === 2 && phone.snap().safetyNumber === null, 'the second pair');
  const second = phone.snap().pairs.find((p: any) => p.pairId !== pairId)!.pairId;
  await phone.runtime.connect(pairId);
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to wait for the first Mac');
  await phone.runtime.unpair(second);
  assert.deepEqual(
    phone.snap().pairs.map((p: any) => p.pairId),
    [pairId],
  );
  assert.equal(phone.snap().reconnect?.pairId, pairId, 'still waiting for the first Mac');
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => phone.snap().phase === 'online' && phone.snap().selectedPair === pairId, 'the first Mac to be found again');
  // removing the computer being waited for ends the wait
  again.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the wait to start again');
  await phone.runtime.unpair(pairId);
  assert.equal(phone.snap().reconnect, null);
  assert.deepEqual(phone.snap().pairs, []);
});

/** The OS kills the app and it is opened again on what was saved. */
async function coldStart(relay: Relay, phone: any) {
  const storage = phone.storage.reopen();
  phone.runtime.disconnect();
  phone.goOffline();
  phone.comeBack();
  return startPhone(relay, { id: phone.env.id, storage, signIn: false });
}
/** What the phone saved as the computer used last (a test reads it the way the app does, then lets the old runtime go). */
const lastUsed = (phone: any) => phone.vault().getLastPair();

test('after the app is killed and opened again it connects to the computer by itself, once, and the followed chat works', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await connected(relay);
  await until(async () => (await lastUsed(phone)) === pairId, 'the connection to be remembered');
  const reopened = await coldStart(relay, phone);
  await until(() => reopened.snap().phase === 'online' && reopened.snap().selectedPair === pairId, 'the phone to connect with no tap');
  assert.equal(reopened.snap().reconnect, null);
  assert.ok(reopened.opened() <= 2, `${reopened.opened()} socket tries for one connection`);
  assert.equal((await reopened.ask('machine.hello')).v, 1);
  mac.known.add('c1');
  await reopened.ask('chat.follow', { chatId: 'c1' });
  turn(mac, 1);
  await until(() => turns(reopened).includes('t1'), 'a live event after the cold start');
});

test('a cold start while the Mac is away waits with backoff, then connects when it is back, without a storm', async () => {
  const relay = await startRelay();
  const safe = fakeSafe();
  const { mac, phone, pairId } = await connected(relay, { safe });
  await until(async () => (await lastUsed(phone)) === pairId, 'the connection to be remembered');
  mac.stop();
  await until(() => phone.snap().reconnect?.pairId === pairId, 'the phone to notice');
  const reopened = await coldStart(relay, phone);
  await until(() => reopened.snap().reconnect?.pairId === pairId, 'the new launch to wait for the Mac');
  const start = reopened.opened();
  await sleep(500);
  const tries = reopened.opened() - start;
  assert.ok(tries >= 2 && tries <= 10, `${tries} tries in 500 ms`);
  const again = await startMac(relay, { userData: mac.userData, safe });
  again.known.add('c1');
  await until(() => reopened.snap().phase === 'online' && reopened.snap().selectedPair === pairId, 'the phone to find the Mac again');
  assert.equal(reopened.snap().reconnect, null);
});

test('a cold start does not connect after the user left the computer, removed it, or signed out', async () => {
  const relay = await startRelay();
  const { phone, pairId } = await connected(relay);
  await until(async () => (await lastUsed(phone)) === pairId, 'the connection to be remembered');
  phone.runtime.disconnect();
  await until(async () => (await lastUsed(phone)) === null, 'the choice to leave to be remembered');
  const left = await coldStart(relay, phone);
  await sleep(400);
  assert.notEqual(left.snap().phase, 'online');
  assert.equal(left.snap().reconnect, null);
  assert.equal(left.opened(), 0, 'no socket was even tried');

  await left.runtime.connect(left.snap().pairs[0].pairId);
  await until(async () => (await lastUsed(left)) === pairId, 'the tap to be remembered');
  await left.runtime.signOut();
  await until(async () => (await lastUsed(left)) === null, 'sign-out to forget it');
  const signedOut = await coldStart(relay, left);
  await sleep(300);
  assert.equal(signedOut.snap().phase, 'signedOut');
  assert.equal(signedOut.opened(), 0);
});

test('a computer that was removed is not resumed', async () => {
  const relay = await startRelay();
  const { phone, pairId } = await connected(relay);
  await until(async () => (await lastUsed(phone)) === pairId, 'the connection to be remembered');
  await phone.runtime.unpair(pairId);
  await until(async () => (await lastUsed(phone)) === null, 'the removal to be remembered');
  const reopened = await coldStart(relay, phone);
  await sleep(300);
  assert.equal(reopened.snap().pairs.length, 0);
  assert.notEqual(reopened.snap().phase, 'online');
  assert.equal(reopened.opened(), 0);
});
