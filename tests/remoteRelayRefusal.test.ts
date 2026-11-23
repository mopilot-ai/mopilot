// The relay's refusals on the Mac: the shared codes, words and waits (shared/remote/relayRefusal.mjs), the relay client's `refused` state with its long backoff, and the reason reaching Settings through the runtime and the IPC state; the host lane waits the same way.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
import { R, RelayClient, rig, withTimers } from './support/remote-relay-kit.ts';
import { tick } from './support/async-scenarios.ts';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';
import {
  REFUSAL_BASE_MS,
  REFUSAL_CAP_MS,
  REFUSAL_TEXT,
  RELAY_DISABLED_ERROR,
  RelayRefused,
  refusalOf,
  refusalWait,
} from '../shared/remote/relayRefusal.mjs';

const require = createRequire(import.meta.url);
const { openRemote } = require('../electron/remote/runtime.cjs');
const { createRelayPaths } = require('../electron/host/relayPaths.cjs');
const { register } = require('../electron/app/ipc/remoteSettings.cjs');

test('the shared refusals: three close codes, what a person reads, and a wait of 15 s doubling to 5 minutes with jitter', () => {
  assert.deepEqual([4503, 4429, 4423, 4403, 1006, '4503', undefined].map(refusalOf), [
    'capacity',
    'account_limit',
    'disabled',
    null,
    null,
    null,
    null,
  ]);
  assert.equal(REFUSAL_TEXT.capacity, 'Mobile Remote is at capacity. Try again shortly.');
  assert.match(REFUSAL_TEXT.account_limit, /Too many of your devices/);
  assert.match(REFUSAL_TEXT.disabled, /turned off for this account/);
  assert.equal(RELAY_DISABLED_ERROR, 'relay_disabled');
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 50].map((n) => refusalWait(n, 1)),
    [15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000],
  );
  assert.deepEqual([refusalWait(0, 0), refusalWait(9, 0)], [REFUSAL_BASE_MS / 2, REFUSAL_CAP_MS / 2]);
  const refused = new RelayRefused('capacity');
  assert.deepEqual(
    [refused.name, refused.refusal, refused.message, refused instanceof Error],
    ['RelayRefused', 'capacity', REFUSAL_TEXT.capacity, true],
  );
});

/** Advances the fake clock until another socket is opened; returns how long that took. */
async function untilNextSocket(sockets: FakeSocket[], limitMs = 400_000) {
  const before = sockets.length;
  let waited = 0;
  while (sockets.length === before) {
    mock.timers.tick(5000);
    await tick();
    waited += 5000;
    if (waited > limitMs) assert.fail('never reconnected');
  }
  return waited;
}

test('at capacity: the state is refused with its reason, the next tries wait 15 s doubling to 5 minutes, and a good open clears it', async () => {
  await withTimers(async () => {
    const { client, sockets, states, asked } = rig({ random: () => 1 });
    client.start();
    await tick();
    const waits: number[] = [];
    for (let i = 0; i < 6; i++) {
      sockets.at(-1)!.serverClose(4503);
      assert.deepEqual([client.state, client.refusal], ['refused', 'capacity']);
      waits.push(await untilNextSocket(sockets));
      assert.equal(client.refusal, 'capacity', 'the reason stays while the next try is made');
    }
    assert.deepEqual(waits, [15_000, 30_000, 60_000, 120_000, 240_000, 300_000]);
    assert.ok(!states.includes('backoff'), 'never the short backoff');
    assert.ok(
      asked.every((force) => !force),
      'a full relay is no reason for a new token',
    );
    // frames wait meanwhile, as for any other reconnect
    assert.equal(client.sendFrame({ pair: 'p_abcdefgh', dir: 'm2p', ctr: 1, nonce: 'AA==', box: 'AA==' }), 'queued');
    sockets.at(-1)!.hello();
    assert.deepEqual([client.state, client.refusal], ['open', null]);
    sockets.at(-1)!.serverClose(4429);
    assert.deepEqual([client.state, client.refusal], ['refused', 'account_limit']);
    assert.equal(await untilNextSocket(sockets), 15_000, 'a good open starts the wait again at 15 s');
    client.stop();
    assert.equal(client.refusal, null);
  });
});

test('refusals: a change of reason is told to listeners, an ordinary failure clears the reason, and start() begins again', async () => {
  await withTimers(async () => {
    const { client, sockets, states } = rig({ random: () => 0 });
    client.start();
    await tick();
    sockets[0].serverClose(4503);
    mock.timers.tick(REFUSAL_BASE_MS / 2);
    await tick();
    assert.equal(sockets.length, 2, 'jitter: half the wait at the least');
    // the timer that would have retried is replaced: a second refusal while waiting only changes the reason
    sockets[1].serverClose(4503);
    const told = states.length;
    (client as any).socket = sockets[1];
    sockets[1].onclose?.({ code: 4429 });
    assert.equal(client.refusal, 'account_limit');
    assert.deepEqual(states.slice(told), ['refused'], 'told though the state did not change');
    await untilNextSocket(sockets);
    sockets.at(-1)!.serverClose(1006);
    assert.deepEqual([client.state, client.refusal], ['backoff', null]);
    client.stop();
    client.start();
    await tick();
    sockets.at(-1)!.serverClose(4503);
    mock.timers.tick(REFUSAL_BASE_MS / 2);
    await tick();
    assert.equal(client.state, 'connecting', 'start() forgot the earlier refusals');
    client.stop();
  });
});

test('switched off: a 4423 close asks the account service for a fresh token, and its refusal keeps the client refused instead of in the short backoff', async () => {
  await withTimers(async () => {
    const sockets: FakeSocket[] = [];
    const asked: boolean[] = [];
    let off = false;
    const client = new RelayClient({
      url: () => 'wss://relay.example/v1/ws',
      getToken: async (force: boolean) => (asked.push(force), off ? null : 'jwt-1'),
      refused: () => (off ? 'disabled' : null),
      createSocket: (url: string, headers: Record<string, string>) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s as any;
      },
      random: () => 1,
    });
    client.start();
    await tick();
    sockets[0].hello();
    off = true;
    sockets[0].serverClose(4423);
    assert.deepEqual([client.state, client.refusal], ['refused', 'disabled']);
    mock.timers.tick(15_000);
    await tick();
    assert.deepEqual(asked, [false, true], 'the next try asks for a new token');
    assert.deepEqual(
      [client.state, client.refusal, sockets.length],
      ['refused', 'disabled', 1],
      'no token, no socket, and no 1 s retry loop',
    );
    mock.timers.tick(29_000);
    await tick();
    assert.equal(asked.length, 2);
    off = false;
    mock.timers.tick(1000);
    await tick();
    assert.equal(sockets.length, 2, 'switched on again: the next try connects');
    sockets[1].hello();
    assert.deepEqual([client.state, client.refusal], ['open', null]);
    client.stop();
  });
});

test('the runtime says why the relay is turning this Mac away, and Settings is told; nothing while Mobile Remote is off', async (t) => {
  const mopilot: any = {
    relayToken: async () => null,
    relayRefusal: 'disabled',
    creds: { user: { id: 'u', email: 'ann@example.com' }, deviceId: 'd' },
  };
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot },
    safeStorage: fakeSafe(),
    fs: { ...fs, readFile: async () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })) },
    flagOn: () => true,
    scope: () => 'owner',
    onChannel: () => undefined,
    createSocket: () => assert.fail('no socket without a token'),
  });
  t.after(() => remote.close());
  assert.equal(remote.refusal, null, 'not running yet');
  await remote.sync();
  await tick();
  assert.equal(remote.running, true);
  assert.equal(remote.refusal, 'disabled');

  const handles = new Map<string, Function>();
  const listeners = new Map<string, Function>();
  const live: any = { mopilot, remote, remoteConsent: { enabled: () => true, warning: false } };
  register(
    { handle: (k: string, fn: Function) => handles.set(k, fn), on: (k: string, fn: Function) => listeners.set(k, fn) },
    { live, allowed: () => true },
  );
  const sender: any = { mainFrame: {}, isDestroyed: () => false, once: () => undefined, on: () => undefined };
  const event: any = { sender, senderFrame: sender.mainFrame };
  listeners.get('remoteSettings:document')!(event);
  assert.equal(handles.get('remoteSettings:state')!(event, event.returnValue).refusal, 'disabled');
  live.remote = undefined;
  assert.equal(handles.get('remoteSettings:state')!(event, event.returnValue).refusal, null);
  // a sign-in that is not refused gives no reason
  mopilot.relayRefusal = undefined;
  const plain = openRemote({
    userData: tempDir(),
    live: { mopilot },
    safeStorage: fakeSafe(),
    fs: { ...fs, readFile: async () => Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })) },
    flagOn: () => true,
    scope: () => 'owner',
    onChannel: () => undefined,
    createSocket: () => assert.fail('no socket without a token'),
  });
  t.after(() => plain.close());
  await plain.sync();
  await tick();
  assert.equal(plain.refusal, null);
});

test('the host lane of a switched-off account waits like a refused one', async (t) => {
  for (const [live, state] of [
    [{ mopilot: { relayToken: async () => null, relayRefusal: 'disabled' } }, 'refused'],
    [{ mopilot: { relayToken: async () => null } }, 'backoff'],
    [undefined, 'backoff'],
  ] as const) {
    const paths = createRelayPaths({
      dir: path.join(tempDir(), 'app'),
      url: () => 'wss://relay.example/v1/ws',
      live,
      safeStorage: fakeSafe(),
      createSocket: () => assert.fail('no socket without a token'),
    });
    t.after(() => paths.dispose());
    paths.lane.start();
    await tick();
    assert.equal(paths.lane.state, state);
    paths.lane.stop();
  }
});

test('R exports are unchanged for the callers that read them', () => {
  assert.deepEqual([R.CLOSE_REVOKED, R.CLOSE_UNAUTHORIZED, R.BACKOFF_MAX_MS], [4403, 4401, 10_000]);
});
