// The dev host's MoMo channels end to end (scripts/mobile-dev-host/host.mjs, `momo-channels`): a real phone runtime pairs with the host, lists none, makes a channel by name and follows it by id, hears `channels` when the list changes, and an older Mac (`momo-channels off`) does not list the methods and answers off.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPhone, until } from './support/mobileStack.ts';
import { startHost } from '../scripts/mobile-dev-host/host.mjs';

const scratch = mkdtempSync(path.join(tmpdir(), 'dev-host-channels-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

test('a phone lists, makes and follows a channel on the host, hears the list change, and an older Mac hides the methods', async () => {
  const host = await startHost({
    dir: path.join(scratch, 'one'),
    advertise: '127.0.0.1',
    bind: '127.0.0.1',
    port: 0,
    out: () => undefined,
    sleep: async () => undefined,
  });
  after(() => host.stop());
  const relay = {
    wsUrl: host.relayUrl,
    keys: { sign: (_u: string, d: string, o?: { aud?: 'desktop' | 'relay' }) => host.account.sign(d, true, o?.aud ?? 'relay') },
  } as any;
  const phone = await startPhone(relay, { userId: 'dev-user', relayUrl: host.relayUrl });
  await phone.pair((await host.pair()).qr);
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await host.scenarios.run('momo', ['on']);
  const listed = async () => (await phone.ask('machine.hello')).capabilities.methods.includes('momo.channels.list');
  assert.equal(await listed(), true);
  assert.deepEqual((await phone.ask('momo.channels.list')).channels, []);
  const made = (await phone.ask('momo.channels.create', { name: 'Plans' })).channel;
  await until(() => phone.eventsOf('momo.changed').some((e: any) => e.area === 'channels'), 'the list change');
  const snap = await phone.ask('momo.chat.follow', { items: 3, channelId: made.id });
  assert.match(snap.chatId, /^dev-momo-channel-/);
  assert.notEqual(snap.chatId, (await phone.ask('momo.chat.follow', { items: 3 })).chatId);
  // seed gives the bench something to look at, and off is an older Mac
  assert.match(String(await host.scenarios.run('momo-channels', ['seed'])), /3 channels in 2 groups/);
  assert.equal((await phone.ask('momo.channels.list')).channels.length, 4);
  // a card waits in a channel and a needs-you push is sent for its chat (no push keys here: the relay says so and names the phone)
  assert.match(String(await host.scenarios.run('momo-channels', ['push', 'Kitchen'])), /^a card waits in #Kitchen; momoNeedsYou for /);
  await host.scenarios.run('momo-channels', ['off']);
  assert.equal(await listed(), false);
  await assert.rejects(phone.ask('momo.channels.list'), /doesn't allow that/);
});
