// Mobile Remote end to end, scenario 7: push. A banner on the Mac becomes a fixed-title provider payload with an empty body and an opaque chat handle; a chat title travels only sealed, and only when the Mac opted in; the token goes when the phone unpairs or unregisters.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startRelay, startMac, startPhone, until, sleep, type Relay } from './support/mobileStack.ts';
import { apnsBody, fcmMessage } from '../relay/src/pushPayload.mjs';
import { chatRef } from '../shared/remote/ref.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './support/remoteKit.ts';

const sealedPath = '../mobile/src/push/sealedTitle.ts';
const { openSealedTitle } = await import(sealedPath);
const require = createRequire(import.meta.url);
const native = require('../electron/platform/sodiumPrimitives.cjs').createSodiumPrimitives();
const { createPushSettingsOps } = require('../electron/remote/pushSettingsOps.cjs');
const { Notifier } = require('../electron/platform/notify.cjs');
const { createQuietHold } = require('../electron/platform/quietHold.cjs');

const SECRET = 'Quarterly layoff plan';
async function paired(relay: Relay) {
  const mac = await startMac(relay);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  return { mac, phone, pairId };
}
const banner = (mac: any, o: object) => mac.live.notifier.onBanner({ chatTitle: SECRET, needs: false, ...o });
const tokens = async (relay: Relay) => Number((await relay.db.query('SELECT count(*)::int AS n FROM relay_push_tokens')).rows[0].n);
/** Everything the relay stores, as text. */
const everythingStored = async (relay: Relay) => {
  const out: string[] = [];
  for (const t of ['relay_pairs', 'relay_mailbox', 'relay_drops', 'relay_push_tokens', 'relay_activity_tokens', 'relay_revoked_devices'])
    out.push(JSON.stringify((await relay.db.query(`SELECT * FROM ${t}`)).rows));
  for (const t of ['frames', 'streams', 'epochs', 'drops'])
    out.push(JSON.stringify((await relay.db.query(`SELECT * FROM remote_durable.${t}`)).rows));
  return out.join('\n');
};

test('a banner becomes a push with the kind’s fixed title, an empty body and an opaque handle, never the chat’s words', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await paired(relay);
  // no token yet: the relay has nothing to push to
  banner(mac, { kind: 'turn', chatId: 'c1' });
  await sleep(150);
  assert.deepEqual(relay.pushed, []);

  await phone.runtime.pushRegister('apns', 'apns-token-1');
  assert.equal(await tokens(relay), 1);
  banner(mac, { kind: 'turn', chatId: 'c1' });
  banner(mac, { kind: 'approval', chatId: 'c2', needs: true });
  banner(mac, { kind: 'momo', chatId: 'momo-main', needs: true });
  await until(() => relay.pushed.length === 3, 'three pushes');
  const [done, needs, momo] = relay.pushed as any[];
  assert.deepEqual([done.kind, done.title], ['done', 'A chat finished']);
  assert.deepEqual([needs.kind, needs.title], ['needsYou', 'A chat needs you']);
  assert.deepEqual([momo.kind, momo.title], ['momoNeedsYou', 'MoMo needs you']);
  assert.equal(done.ref, chatRef(pairId, 'c1'));
  for (const m of relay.pushed as any[]) {
    const apns = apnsBody(m) as any;
    assert.equal(apns.aps.alert.body, '');
    const text = JSON.stringify([apns, fcmMessage(m)]);
    assert.ok(!text.includes(SECRET) && !text.includes('layoff'), 'no chat words in a provider payload');
    assert.ok(!text.includes('"c1"') && !text.includes('"c2"') && !text.includes('momo-main'), 'the chat id is not in it either');
    assert.equal(m.sealed, undefined, 'titles are off, so none is sealed');
  }
  assert.ok(!(await everythingStored(relay)).includes('layoff'), 'the relay stored no chat words');
});

test('with titles on, the title travels sealed, only the phone can open it, MoMo keeps its fixed title', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await paired(relay);
  await phone.runtime.pushRegister('fcm', 'fcm-token-1');
  await mac.remote.pushTitles.setEnabled(true);
  await until(() => phone.eventsOf('push.titleKey').length > 0, 'the title key to reach the phone');
  const key = phone.eventsOf('push.titleKey').at(-1).patch.key as string;

  banner(mac, { kind: 'approval', chatId: 'c3', needs: true });
  banner(mac, { kind: 'momo', chatId: 'momo-main', needs: true });
  await until(() => relay.pushed.length === 2, 'two pushes');
  const [chat, momo] = relay.pushed;
  assert.equal(chat.title, 'A chat needs you', 'the visible title is still the fixed one');
  assert.ok(chat.sealed, 'the chat’s title rides sealed');
  assert.equal(momo.sealed, undefined, 'MoMo’s push is never sealed');
  assert.ok(!JSON.stringify([apnsBody(chat), fcmMessage(chat)]).includes('layoff'));
  assert.ok(!(await everythingStored(relay)).includes('layoff'));

  const keys = [Uint8Array.from(Buffer.from(key, 'hex'))];
  const open = (k: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => native.aeadOpen(k, nonce, box, aad);
  assert.equal(openSealedTitle({ sealed: chat.sealed, ref: chat.ref, keys, open }), SECRET, 'the phone reads it with its key');
  assert.equal(
    openSealedTitle({ sealed: chat.sealed, ref: chatRef(pairId, 'other'), keys, open }),
    null,
    'a blob replayed for another chat fails',
  );
  assert.equal(openSealedTitle({ sealed: chat.sealed, ref: chat.ref, keys: [new Uint8Array(32)], open }), null, 'another key fails');
});

test('the push token is gone when the phone unpairs, and when it unregisters', async () => {
  const relay = await startRelay();
  const { mac, phone, pairId } = await paired(relay);
  await phone.runtime.pushRegister('apns', 'apns-token-1');
  await phone.runtime.pushUnregister();
  assert.equal(await tokens(relay), 0);
  banner(mac, { kind: 'turn', chatId: 'c1' });
  await sleep(150);
  assert.deepEqual(relay.pushed, []);

  await phone.runtime.pushRegister('apns', 'apns-token-2');
  assert.equal(await tokens(relay), 1);
  await mac.remote.pairing.unpair(mac.remote.devices.list()[0].id, pairId);
  await until(async () => (await tokens(relay)) === 0, 'the token to be dropped with the last pair');
  banner(mac, { kind: 'turn', chatId: 'c1' });
  // even a request for the removed pair, which the Mac no longer makes, pushes nothing: the relay holds no token and no pair for it
  await mac.remote.pushRequest({ pair: pairId, kind: 'done', ref: 'x' }).catch(() => undefined);
  await sleep(150);
  assert.deepEqual(relay.pushed, [], 'nothing is pushed to a phone that unpaired');
});

test('the phone turns chat titles in push on through the Mac’s settings, and the next push carries a sealed title', async () => {
  const relay = await startRelay();
  const prefs: Record<string, unknown> = {};
  const holder: { mac?: Awaited<ReturnType<typeof startMac>> } = {};
  const mac = await startMac(relay, {
    pushSettings: createPushSettingsOps({
      prefs: () => prefs,
      patchPrefs: (set: Record<string, unknown>) => (Object.assign(prefs, set), true),
      titles: () => holder.mac?.remote.pushTitles ?? null,
      momoOn: () => false,
    }),
  });
  holder.mac = mac;
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  await phone.runtime.pushRegister('apns', 'apns-token-1');

  assert.equal((await phone.ask('push.settings.get')).titlesInPush, false);
  banner(mac, { kind: 'turn', chatId: 'c1' });
  await until(() => relay.pushed.length === 1, 'the first push');
  assert.equal(relay.pushed[0].sealed, undefined);

  const after = await phone.ask('push.settings.set', { titlesInPush: true, mode: 'always' });
  assert.equal(after.titlesInPush, true);
  assert.equal(prefs.notifyOnComplete, 'always');
  await until(() => phone.eventsOf('push.titleKey').length > 0, 'the title key');
  banner(mac, { kind: 'approval', chatId: 'c2', needs: true });
  await until(() => relay.pushed.length === 2, 'the second push');
  assert.ok(relay.pushed[1].sealed, 'now sealed');
  assert.ok(!JSON.stringify(relay.pushed).includes('layoff'));
  assert.equal((await phone.ask('push.settings.set', { titlesInPush: false })).titlesInPush, false);
});

test('the phone sets quiet hours; a needs-you inside them makes no push until they end, then one fixed-title push, also after the Mac restarted', async () => {
  const relay = await startRelay();
  const prefs: Record<string, unknown> = {};
  const holder: { mac?: Awaited<ReturnType<typeof startMac>> } = {};
  const mac = await startMac(relay, {
    pushSettings: createPushSettingsOps({
      prefs: () => prefs,
      patchPrefs: (set: Record<string, unknown>) => (Object.assign(prefs, set), true),
      titles: () => holder.mac?.remote.pushTitles ?? null,
      momoOn: () => false,
    }),
  });
  holder.mac = mac;
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  const pairId = phone.snap().pairs[0].pairId;
  await phone.runtime.connect(pairId);
  await phone.runtime.pushRegister('apns', 'apns-token-1');

  const set = await phone.ask('push.settings.set', { quietHours: { start: '22:00', end: '07:00' } });
  assert.deepEqual(set.quietHours, { start: '22:00', end: '07:00' });
  assert.deepEqual(prefs.notifyQuietHours, { start: '22:00', end: '07:00' });

  // the Mac's own notifier, with the hold and the bridge the remote installed on the app's notifier
  let now = new Date(2030, 0, 1, 23, 30).getTime();
  const timers: (() => void)[] = [];
  const file = path.join(tempDir(), 'notify-quiet.json');
  const run = () => {
    const notifier = new Notifier({
      getMode: () => 'always',
      show: () => ({ close() {} }),
      now: () => now,
      onBanner: (b: unknown) => mac.live.notifier.onBanner(b),
      quietHold: createQuietHold({
        quietHours: () => prefs.notifyQuietHours,
        deliver: (held: unknown) => mac.live.notifier.onCatchUp(held),
        file,
        now: () => now,
        schedule: (fn: () => void) => (timers.push(fn), 1),
        cancel: () => undefined,
      }),
    });
    return notifier;
  };
  const night = run();
  night.notify('approval', 'c-night', { title: SECRET, chatTitle: SECRET });
  night.notify('turn', 'c-done', { title: SECRET });
  await sleep(200);
  assert.deepEqual(relay.pushed, [], 'nothing is pushed inside the quiet hours');

  // the Mac quits in the window and starts again after it ended
  now = new Date(2030, 0, 2, 7, 5).getTime();
  timers.length = 0;
  run();
  timers.splice(0).forEach((fn) => fn());
  await until(() => relay.pushed.length === 1, 'the catch-up push');
  const [push] = relay.pushed as any[];
  assert.deepEqual([push.kind, push.title], ['needsYou', 'A chat needs you']);
  assert.equal(push.ref, chatRef(pairId, 'c-night'));
  assert.equal(push.sealed, undefined);
  const text = JSON.stringify([apnsBody(push), fcmMessage(push)]);
  assert.ok(!text.includes('layoff') && !text.includes('c-night') && !text.includes('c-done'));
  assert.equal((apnsBody(push) as any).aps.alert.body, '');

  // once: the next looks find nothing to say (the Mac has noted that the relay took it)
  await until(() => JSON.parse(fs.readFileSync(file, 'utf8')).held.length === 0, 'the Mac to note it was said');
  timers.splice(0).forEach((fn) => fn());
  run();
  timers.splice(0).forEach((fn) => fn());
  await sleep(200);
  assert.equal(relay.pushed.length, 1);
  assert.ok(!(await everythingStored(relay)).includes('layoff'));
});
