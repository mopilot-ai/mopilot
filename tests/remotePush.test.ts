// Push from the Mac: the notifier's merge rule matches the relay's (one shared fixture), a banner becomes one request per paired phone through the running relay client, quiet hours decide for push as for the banner, and nothing is sent while Mobile Remote is off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Notifier as RelayNotifier } from '../relay/src/notifier.mjs';
import { PARITY_STEPS } from './support/notifierParityFixture.ts';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';
import { tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushBridge } = require('../electron/remote/pushBridge.cjs');
const { openRemote } = require('../electron/remote/runtime.cjs');
const { RelayClient } = require('../electron/remote/relayClient.cjs');
const { createMomoNotices } = require('../electron/momo/notices.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

test('merge-rule parity: the Mac notifier and the relay notifier show, merge and suppress the same sequence', () => {
  let now = 0;
  const mac = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), now: () => now });
  const relay = new RelayNotifier();
  for (const step of PARITY_STEPS) {
    now = step.at;
    const macShown = mac.notify(step.needs ? 'approval' : 'turn', step.chat, {});
    const relayShown = relay.push(step.needs ? 'needsYou' : 'done', step.chat, step.at);
    const label = `${step.at}:${step.chat}`;
    assert.equal(macShown !== null, step.shown, `mac ${label}`);
    assert.equal(relayShown !== null, step.relayShown ?? step.shown, `relay ${label}`);
    if (step.shown) assert.equal(macShown.chats.length, step.count, `mac count ${label}`);
    if (relayShown) assert.equal(relayShown.count, step.relayCount ?? step.count, `relay count ${label}`);
  }
});

function fakeRemote(o: { pairs?: string[]; fail?: boolean } = {}) {
  const sent: any[] = [];
  const remote: any = {
    devices: { list: () => (o.pairs ?? ['p1', 'p1', 'p2']).map((pairId) => ({ pairId })) },
    pushRequest: (req: any) => (sent.push(req), o.fail ? Promise.reject(new Error('relay down')) : Promise.resolve('sent')),
  };
  return { remote, sent };
}

test('the bridge sends one request per paired phone, once per pair, with an opaque ref and no chat text', () => {
  const { remote, sent } = fakeRemote();
  const bridge = createPushBridge({ getKinds: () => ({ turn: true }), remote: () => remote });
  const n = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: bridge.onBanner });
  n.notify('approval', 'chat-secret', { title: 'private title', body: 'private body' });
  assert.deepEqual(
    sent.map((r) => [r.pair, r.kind]),
    [
      ['p1', 'needsYou'],
      ['p2', 'needsYou'],
    ],
  );
  assert.ok(!JSON.stringify(sent).includes('secret') && !JSON.stringify(sent).includes('private'));
});

test('with Mobile Remote off, or no paired phone, the banner shows and nothing is sent', () => {
  for (const remote of [null, undefined, { devices: null }, fakeRemote({ pairs: [] }).remote]) {
    const n = new Notifier({
      getMode: () => 'always',
      show: () => ({ close() {} }),
      onBanner: createPushBridge({ getKinds: () => ({ turn: true }), remote: () => remote as any }).onBanner,
    });
    assert.ok(n.notify('turn', 'c', {}));
  }
});

test('a relay failure is noted and never breaks the banner', async () => {
  const { remote, sent } = fakeRemote({ pairs: ['p1'], fail: true });
  const n = new Notifier({
    getMode: () => 'always',
    show: () => ({ close() {} }),
    onBanner: createPushBridge({ getKinds: () => ({ turn: true }), remote: () => remote }).onBanner,
  });
  assert.ok(n.notify('turn', 'c', {}));
  await tick();
  assert.equal(sent.length, 1);
  assert.ok(recentIgnored().some((e: any) => e.context === 'send a push request to the relay'));
  // the remote going away between the check and the send is a no-op
  let calls = 0;
  const flaky = createPushBridge({ getKinds: () => ({ turn: true }), remote: () => (++calls > 3 ? null : remote) });
  flaky.onBanner({ kind: 'turn', chatId: 'x', needs: false });
  assert.equal(sent.length, 2);
});

test('MoMo: a "needs you" that fell in quiet hours is pushed once when they end, and not before', () => {
  const { remote, sent } = fakeRemote({ pairs: ['p1'] });
  const bridge = createPushBridge({ getKinds: () => ({ turn: true }), remote: () => remote });
  let now = new Date(2030, 0, 1, 23, 0).getTime();
  let tick1: (() => void) | null = null;
  const mac = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: bridge.onBanner, now: () => now });
  const momo = createMomoNotices({
    notifier: mac,
    allowed: () => true,
    prefs: () => ({ momo: { routines: { quietHours: { start: '22:00', end: '07:00' } } } }),
    open: () => undefined,
    now: () => now,
    schedule: (fn: () => void) => ((tick1 = fn), 1),
    cancel: () => undefined,
  });
  momo.needsYou({ kind: 'chat', chatId: 'm1' });
  assert.equal(sent.length, 0);
  now = new Date(2030, 0, 2, 7, 30).getTime();
  tick1!();
  assert.deepEqual(
    sent.map((r) => r.kind),
    ['momoNeedsYou'],
  );
});

test('RelayClient.pushRequest sends {t:"push"} and resolves with the relay\'s status; a refusal rejects', async () => {
  const sockets: FakeSocket[] = [];
  const client = new RelayClient({
    url: () => 'wss://x',
    getToken: async () => 'jwt',
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    random: () => 1,
  });
  client.start();
  await tick();
  sockets[0].hello();
  const ok = client.pushRequest({ pair: 'p_abcdefgh', kind: 'done', ref: 'r' });
  const sent = sockets[0].sentOf('push')[0];
  assert.deepEqual({ ...sent, rid: undefined }, { t: 'push', pair: 'p_abcdefgh', kind: 'done', ref: 'r', rid: undefined });
  sockets[0].recv({ t: 'push.result', pair: 'p_abcdefgh', status: 'suppressed', rid: sent.rid });
  assert.equal(await ok, 'suppressed');
  const bad = client.pushRequest({ pair: 'p_abcdefgh', kind: 'done', ref: 'r' });
  sockets[0].recv({ t: 'error', code: 'unknown_pair', rid: sockets[0].sentOf('push')[1].rid });
  await assert.rejects(bad, /unknown_pair/);
  client.stop();
});

test('the remote runtime forwards a push request while on and rejects while off', async () => {
  const sockets: FakeSocket[] = [];
  const flag = { on: true };
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: async () => 'jwt' } },
    flagOn: () => flag.on,
    safeStorage: fakeSafe(),
    fs,
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    relayUrl: 'wss://x',
  });
  await assert.rejects(remote.pushRequest({ pair: 'p', kind: 'done', ref: 'r' }), /off/);
  await remote.sync();
  await waitFor(() => sockets.length, 'a relay socket');
  sockets[0].hello();
  const p = remote.pushRequest({ pair: 'p_abcdefgh', kind: 'needsYou', ref: 'r' });
  sockets[0].recv({ t: 'push.result', status: 'sent', rid: sockets[0].sentOf('push')[0].rid });
  assert.equal(await p, 'sent');
  remote.close();
  await assert.rejects(remote.pushRequest({ pair: 'p', kind: 'done', ref: 'r' }), /off/);
});

test('opening the remote attaches the bridge to the app notifier when there is one', () => {
  const notifier: any = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }) });
  const open = (live: any) =>
    openRemote({
      userData: tempDir(),
      live,
      flagOn: () => false,
      safeStorage: fakeSafe(),
      fs,
      createSocket: () => new FakeSocket('u', {}),
    });
  open({ mopilot: {}, notifier });
  assert.equal(typeof notifier.onBanner, 'function');
  // off: a banner still shows and nothing is sent
  assert.ok(notifier.notify('approval', 'c', {}));
  open({ mopilot: {} });
});

test('a sealed title is forwarded to the relay in the push request, and the runtime exposes the titles switch while on', async () => {
  const sockets: FakeSocket[] = [];
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: async () => 'jwt' } },
    flagOn: () => true,
    safeStorage: fakeSafe(),
    fs,
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    relayUrl: 'wss://x',
  });
  assert.equal(remote.pushTitles, null);
  await remote.sync();
  await waitFor(() => sockets.length, 'a relay socket');
  assert.equal(typeof remote.pushTitles.seal, 'function');
  sockets[0].hello();
  const p = remote.pushRequest({ pair: 'p_abcdefgh', kind: 'done', ref: 'r', sealed: 'SEALED' });
  const sent = sockets[0].sentOf('push')[0];
  assert.equal(sent.sealed, 'SEALED');
  sockets[0].recv({ t: 'push.result', status: 'sent', rid: sent.rid });
  await p;
  remote.close();
});

test('MoMo’s opt-in body: the runtime asks the live resolver for the notice’s chat, hands the opt-in to the key object, and forwards a sealed body in the request', async () => {
  const sockets: FakeSocket[] = [];
  const asked: string[] = [];
  const notifier: any = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }) });
  const live: any = {
    mopilot: { relayToken: async () => 'jwt' },
    notifier,
    momoPushBody: (chatId: string) => (asked.push(chatId), 'Morning brief'),
    momoPushBodyOn: () => true,
  };
  const remote = openRemote({
    userData: tempDir(),
    live,
    flagOn: () => true,
    safeStorage: fakeSafe(),
    fs,
    createSocket: (u: string, h: any) => (sockets.push(new FakeSocket(u, h)), sockets.at(-1)),
    relayUrl: 'wss://x',
  });
  await remote.sync();
  await waitFor(() => sockets.length, 'a relay socket');
  sockets[0].hello();
  assert.equal(remote.pushTitles.bodyOn(), true, 'the opt-in reaches the key object');
  live.momoPushBodyOn = () => false;
  assert.equal(remote.pushTitles.bodyOn(), false, 'read at each use');
  // a paired phone: a MoMo notice asks for the body of the chat that raised it
  remote.devices.list = () => [{ pairId: 'p_abcdefgh' }];
  notifier.notify('momo', 'momo:chat:run1', { title: 'MoMo needs you', status: 'needs' });
  assert.deepEqual(asked, ['momo:chat:run1']);
  const sent = sockets[0].sentOf('push')[0];
  assert.equal(sent.kind, 'momoNeedsYou');
  // no key on the phone yet: this push is the fixed text
  assert.equal('sealedBody' in sent, false);
  const p = remote.pushRequest({ pair: 'p_abcdefgh', kind: 'momoNeedsYou', ref: 'r', sealedBody: 'BODY' });
  const second = sockets[0].sentOf('push')[1];
  assert.equal(second.sealedBody, 'BODY');
  sockets[0].recv({ t: 'push.result', status: 'sent', rid: second.rid });
  await p;
  // no resolver wired (MoMo off): the fixed text
  delete live.momoPushBody;
  notifier.notify('momo', 'momo:chat:run2', { title: 'MoMo needs you', status: 'needs' });
  assert.equal('sealedBody' in sockets[0].sentOf('push')[2], false);
  remote.close();
});

test('with no title switch on the remote, the banner pushes with its fixed title', () => {
  const { remote, sent } = fakeRemote({ pairs: ['p1'] });
  const n = new Notifier({
    getMode: () => 'always',
    show: () => ({ close() {} }),
    onBanner: createPushBridge({ getKinds: () => ({ turn: true }), remote: () => remote }).onBanner,
  });
  n.notify('turn', 'c', { title: 'Visible only locally' });
  assert.equal('sealed' in sent[0], false);
  remote.pushTitles = { seal: () => 'SEALED' };
  n.notify('turn', 'd', { title: 'T' });
  assert.equal(sent[1].sealed, 'SEALED');
});
