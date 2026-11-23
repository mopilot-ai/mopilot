// Mobile Remote in main (electron/remote/runtime.cjs): nothing exists while remote.enabled is off, the switch starts and stops the whole stack, a failed start is noted and retried, and the stack works end to end over a fake relay socket: the Mac registers a pair, a simulated phone's hello is confirmed through the real ApprovalBroker, and sealed messages then flow both ways through the channel the remote service consumes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import * as E from '../shared/remote/envelope.mjs';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { crypto, helloFor, makePhone, openReply, phoneEnds, phoneSafetyNumber } from './support/remotePhone.ts';
import { FakeSocket } from './support/remoteSocket.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { openRemote, FLAG, DEFAULT_RELAY_URL } = require('../electron/remote/runtime.cjs');
// MoPilot's relay where the build has the MoPilot service; a stand-in in one without it, which names none
const RELAY = DEFAULT_RELAY_URL ?? 'wss://relay.example.test/v1/ws';
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { DEFAULTS, isEnabled } = require('../electron/platform/flags.cjs');

async function until(cond: () => boolean) {
  await waitFor(cond, 'the condition');
  assert.ok(cond(), 'timed out');
}

function rig(
  o: {
    on?: boolean;
    safe?: any;
    chatId?: () => string | null;
    defaultChat?: boolean;
    /** null: none given at all, so the environment's relay decides */
    relayUrl?: string | null;
    noBroker?: boolean;
    scoped?: boolean;
  } = {},
) {
  const userData = tempDir();
  const sockets: FakeSocket[] = [];
  const cards: any[] = [];
  const flag = { on: o.on ?? true };
  const broker: any = new ApprovalBroker({
    controller: {
      addApproval: (chatId: string, a: any) => {
        cards.push({ chatId, ...a });
        setImmediate(() => broker.answer(a.id, { decision: 'allow' }));
      },
      resolveApproval: () => true,
    },
  });
  const tokens: boolean[] = [];
  const live: any = {
    mopilot: {
      relayToken: async (force?: boolean) => {
        tokens.push(!!force);
        return 'jwt';
      },
    },
    computerUse: { broker },
  };
  if (o.noBroker) delete live.computerUse;
  const remote = openRemote({
    userData,
    live,
    flagOn: () => flag.on,
    chatId: o.defaultChat ? undefined : (o.chatId ?? (() => 'chat-1')),
    safeStorage: o.safe ?? fakeSafe(),
    fs,
    createSocket: (url: string, headers: any) => (sockets.push(new FakeSocket(url, headers)), sockets.at(-1)),
    // none given: the app's default, or the stand-in where the build has none
    relayUrl: o.relayUrl === null ? undefined : (o.relayUrl ?? (DEFAULT_RELAY_URL ? undefined : RELAY)),
    scope: o.scoped
      ? () => {
          const c = live.mopilot?.creds;
          return c ? JSON.stringify([c.user.id, c.deviceId]) : null;
        }
      : undefined,
  });
  return { remote, userData, sockets, flag, cards, live, tokens };
}

test('the switch ships on as a kill switch (the `phone` invite gates it, electron/remote/phoneAccess.cjs), in step with the renderer and the web flag list', () => {
  assert.equal(FLAG, 'remote.enabled');
  assert.equal(DEFAULTS[FLAG], true);
  assert.equal(isEnabled(FLAG), true);
});

test('the default switch reader follows the shipped default (on)', async () => {
  const r = rig();
  const remote = openRemote({ userData: r.userData, live: r.live, safeStorage: fakeSafe(), fs });
  await remote.sync();
  assert.equal(remote.running, true);
  remote.close();
});

test('off: nothing is created, read or written, and the accessors are empty', async () => {
  const r = rig({ on: false });
  await r.remote.sync();
  r.remote.close();
  assert.deepEqual(
    [r.remote.running, r.remote.channel, r.remote.pairing, r.remote.devices, r.remote.presence],
    [false, null, null, null, null],
  );
  assert.deepEqual(await fs.readdir(r.userData), []);
  assert.equal(r.sockets.length, 0);
});

test('on: sync starts the stack and opens the relay with the account token; off stops it; both are idempotent', async () => {
  const r = rig();
  await r.remote.sync();
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  assert.equal(r.remote.running, true);
  assert.ok(r.remote.channel && r.remote.pairing && r.remote.devices);
  assert.equal(r.remote.presence.isOnline('p_any'), false, 'no phone is online before the relay says so');
  assert.deepEqual([r.sockets[0].url, r.sockets[0].headers.authorization], [RELAY, 'Bearer jwt']);
  assert.deepEqual(r.remote.channel.pairs(), []);
  r.flag.on = false;
  await r.remote.sync();
  assert.equal(r.remote.running, false);
  assert.deepEqual(r.sockets[0].closed, [1000]);
  await r.remote.sync();
  r.flag.on = true;
  await r.remote.sync();
  await until(() => r.sockets.length === 2);
  r.remote.close();
});

test('on: the relay address can be set, and a signed-out account opens no socket yet', async () => {
  const r = rig({ relayUrl: 'wss://self-hosted.example/v1/ws' });
  r.live.mopilot = undefined;
  await r.remote.sync();
  await tick();
  assert.equal(r.sockets.length, 0);
  r.remote.close();
  const saved = process.env.MOPILOT_RELAY_URL;
  process.env.MOPILOT_RELAY_URL = 'wss://env.example/v1/ws';
  try {
    const e = rig({ relayUrl: null });
    await e.remote.sync();
    await until(() => e.sockets.length === 1);
    assert.equal(e.sockets[0].url, 'wss://env.example/v1/ws');
    e.remote.close();
  } finally {
    if (saved === undefined) delete process.env.MOPILOT_RELAY_URL;
    else process.env.MOPILOT_RELAY_URL = saved;
  }
  const s = rig({ relayUrl: 'wss://self-hosted.example/v1/ws' });
  await s.remote.sync();
  await until(() => s.sockets.length === 1);
  assert.equal(s.sockets[0].url, 'wss://self-hosted.example/v1/ws');
  s.remote.close();
});

test('on: two syncs at once start one stack', async () => {
  const r = rig();
  await Promise.all([r.remote.sync(), r.remote.sync()]);
  await until(() => r.sockets.length === 1);
  r.remote.close();
});

test('on: a stack that can not start is noted, leaves nothing running, and starts on the next sync', async () => {
  const safe = fakeSafe();
  const r = rig({ safe });
  // an unreadable device list stops the channel from loading
  const dir = `${r.userData}/remote`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(`${dir}/devices.key`, 'not sealed');
  await r.remote.sync();
  assert.equal(r.remote.running, false);
  assert.equal(r.sockets.length, 0);
  await fs.rm(`${dir}/devices.key`);
  await r.remote.sync();
  assert.equal(r.remote.running, true);
  r.remote.close();
});

test('a switch that can not be read is noted, not thrown', async () => {
  const r = rig();
  const remote = openRemote({
    userData: r.userData,
    live: r.live,
    flagOn: () => {
      throw new Error('flags broke');
    },
  });
  await remote.sync();
  assert.equal(remote.running, false);
});

test('on: main not passing safeStorage and fs is noted, not thrown', async () => {
  const r = rig();
  const remote = openRemote({ userData: r.userData, live: r.live, flagOn: () => true });
  await remote.sync();
  assert.equal(remote.running, false);
});

test('the switch turned off while the stack is starting leaves nothing running', async () => {
  const r = rig();
  const starting = r.remote.sync();
  r.flag.on = false;
  await starting;
  assert.equal(r.remote.running, false, 'the stack that finished starting is stopped at once');
  await tick();
  assert.deepEqual(r.sockets[0]?.closed ?? [1000], [1000]);
});

test('end to end: pair a phone through the relay and the approval card, then exchange sealed messages both ways', async () => {
  const r = rig();
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  const sock = r.sockets[0];
  sock.hello();
  await until(() => r.remote.running && sock.sentOf('presence').length > 0);

  // the Mac registers the pair the QR names
  const begun = r.remote.pairing.begin();
  await until(() => sock.sentOf('pair.register').length === 1);
  const reg = sock.sentOf('pair.register')[0];
  sock.recv({ t: 'ok', op: 'pair.register', pair: reg.pair, rid: reg.rid });
  const { payload } = await begun;
  assert.equal(reg.pair, crypto.pairId(E.fromBase64(payload.code)));

  // the phone's hello arrives as a frame of counter 0; the user confirms through the card
  const phone = makePhone();
  const events: string[] = [];
  r.remote.pairing.onEvent((e: any) => events.push(e.state));
  sock.recv({ t: 'frame', ...E.toWire(helloFor(phone, payload)) });
  await until(() => r.remote.devices.list().length === 1);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].chatId, 'chat-1');
  assert.equal(r.cards[0].params.remotePair.deviceName, phone.name);
  assert.equal(r.cards[0].params.remotePair.safetyNumber, phoneSafetyNumber(phone, payload));
  await until(() => sock.sentOf('frame').some((f) => f.ctr === 0));
  const answer = sock.sentOf('frame').find((f) => f.ctr === 0);
  const answered = openReply(phone, payload, E.decodeFrame(answer));
  assert.deepEqual(answered, { v: 3, ok: true, pairId: reg.pair });
  assert.deepEqual(events, ['confirming', 'paired']);
  assert.deepEqual(r.remote.channel.pairs(), [reg.pair]);

  // sealed traffic: the phone asks, the service answers, a retry gets the same answer
  const ends = phoneEnds(phone, payload, answered);
  const got = deferred<any>();
  r.remote.channel.onMessage((pairId: string, m: any) => got.resolve([pairId, m]));
  const ask = { id: 'm_1', t: 1, kind: 'request', method: 'machine.hello', params: {} };
  sock.recv({ t: 'frame', ...E.toWire(ends.tx.seal(E.encodeMessage(ask))) });
  assert.deepEqual(await got.promise, [reg.pair, ask]);
  await r.remote.channel.send(reg.pair, { id: 'm_2', t: 2, kind: 'reply', inReplyTo: 'm_1', ok: true, result: { v: 1 } });
  const out = sock.sentOf('frame').filter((f) => f.ctr > 0);
  assert.equal(E.decodeMessage(ends.rx.open(E.decodeFrame(out[0]))).result.v, 1);

  // the relay tells the Mac the phone's device was revoked: the pair key goes
  sock.recv({ t: 'event', ev: 'pair.removed', pair: reg.pair, reason: 'revoked' });
  await until(() => r.remote.channel.pairs().length === 0);
  r.remote.close();
});

test('end to end: a pairing nobody can confirm (no chat for the card, the default) ends declined and the phone is told', async () => {
  const r = rig({ defaultChat: true });
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  const sock = r.sockets[0];
  sock.hello();
  await until(() => r.remote.running && sock.sentOf('presence').length > 0);
  const begun = r.remote.pairing.begin();
  await until(() => sock.sentOf('pair.register').length === 1);
  sock.recv({ t: 'ok', op: 'pair.register', rid: sock.sentOf('pair.register')[0].rid });
  const { payload } = await begun;
  const phone = makePhone();
  sock.recv({ t: 'frame', ...E.toWire(helloFor(phone, payload)) });
  await until(() => sock.sentOf('frame').some((f) => f.ctr === 0));
  assert.deepEqual(openReply(phone, payload, E.decodeFrame(sock.sentOf('frame')[0])), { ok: false, error: 'declined' });
  await until(() => sock.sentOf('pair.remove').length === 1);
  assert.equal(r.remote.devices.list().length, 0);
  r.remote.close();
});

test('end to end: without a broker the pairing is declined, and a relay that takes no frames leaves the outcome as it was', async () => {
  const r = rig({ noBroker: true });
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  const sock = r.sockets[0];
  sock.hello();
  await until(() => r.remote.running && sock.sentOf('presence').length > 0);
  const begun = r.remote.pairing.begin();
  await until(() => sock.sentOf('pair.register').length === 1);
  sock.recv({ t: 'ok', op: 'pair.register', rid: sock.sentOf('pair.register')[0].rid });
  const { payload } = await begun;
  const events: string[] = [];
  r.remote.pairing.onEvent((e: any) => events.push(e.state));
  sock.throwOnSend = true;
  sock.recv({ t: 'frame', ...E.toWire(helloFor(makePhone(), payload)) });
  await until(() => events.includes('declined'));
  assert.equal(sock.sentOf('frame').length, 0, 'the answer could not be sent, and nothing else broke');
  r.remote.close();
});

test('account and device replacement retires the old channel and uses a separate sealed store', async () => {
  const r = rig({ scoped: true });
  r.live.mopilot.creds = { user: { id: 'user-a' }, deviceId: 'device-a' };
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  const first = r.remote.channel;
  await r.remote.pairing.o.identity.get();
  r.live.mopilot.creds = { user: { id: 'user-b' }, deviceId: 'device-b' };
  await r.remote.sync();
  await until(() => r.sockets.length === 2);
  assert.notEqual(r.remote.channel, first);
  await r.remote.pairing.o.identity.get();
  assert.equal((await fs.readdir(`${r.userData}/remote`)).length, 2);
  assert.deepEqual(r.sockets[0].closed, [1000]);
  r.live.mopilot.creds = null;
  await r.remote.sync();
  assert.equal(r.remote.running, false);
  assert.deepEqual(r.sockets[1].closed, [1000]);
});

test('a token arriving after account replacement cannot open the retired socket', async () => {
  const r = rig({ scoped: true });
  const token = deferred<string>();
  r.live.mopilot.creds = { user: { id: 'old' }, deviceId: 'one' };
  r.live.mopilot.relayToken = () => token.promise;
  await r.remote.sync();
  r.live.mopilot.creds = { user: { id: 'new' }, deviceId: 'two' };
  r.live.mopilot.relayToken = async () => 'new-token';
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  token.resolve('old-token');
  await tick();
  assert.equal(r.sockets.length, 1);
  assert.equal(r.sockets[0].headers.authorization, 'Bearer new-token');
  r.remote.close();
});

test('the production relay event retires a QR that the phone removed', async () => {
  const r = rig();
  await r.remote.sync();
  await until(() => r.sockets.length === 1);
  const sock = r.sockets[0];
  sock.hello();
  const started = r.remote.pairing.begin();
  await until(() => sock.sentOf('pair.register').length === 1);
  const reg = sock.sentOf('pair.register')[0];
  sock.recv({ t: 'ok', op: 'pair.register', pair: reg.pair, rid: reg.rid });
  const begun = await started;
  sock.recv({ t: 'event', ev: 'pair.removed', pair: reg.pair });
  assert.equal(await r.remote.pairing.handleHello(helloFor(makePhone(), begun.payload)), 'ignored');
  r.remote.close();
});
