// Terminal runtime shutdown retires pending device loads and credentials; ordinary owner reconciliation still recovers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';

const require = createRequire(import.meta.url);
const { openRemote, DEFAULT_RELAY_URL } = require('../electron/remote/runtime.cjs');
// MoPilot's relay where the build has the MoPilot service; a stand-in in one without it, which names none
const RELAY = DEFAULT_RELAY_URL ?? 'wss://relay.example.test/v1/ws';
const { RelayClient } = require('../electron/remote/relayClient.cjs');
const missing = () => Object.assign(new Error('missing'), { code: 'ENOENT' });

function rig(read: () => Promise<unknown>, token: () => Promise<string> = async () => 'token') {
  const published: any[] = [];
  const sockets: FakeSocket[] = [];
  const owner = { key: 'owner' };
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: token } },
    safeStorage: fakeSafe(),
    fs: { ...fs, readFile: read },
    flagOn: () => true,
    scope: () => owner.key,
    onChannel: (channel: any) => published.push(channel),
    relayUrl: RELAY,
    createSocket: (url: string, headers: any) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
  });
  return { remote, sockets, published, owner };
}

for (const outcome of ['success', 'failure'] as const) {
  test(`close during pending startup never reconnects after a late ${outcome}`, async (t) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    let loads = 0;
    let tokens = 0;
    const r = rig(
      async () => {
        loads++;
        entered.resolve();
        await release.promise;
        throw outcome === 'success' ? missing() : new Error('unreadable storage');
      },
      async () => (tokens++, 'token'),
    );
    t.after(() => r.remote.close());
    const pending = r.remote.sync();
    await entered.promise;
    r.remote.close();
    release.resolve();
    await pending;
    await tick();
    await r.remote.sync();
    await tick();
    assert.equal(loads, 1, 'neither old finally nor a queued sync can construct a replacement');
    assert.equal(tokens, 0, 'a retired stack never asks for credentials');
    assert.equal(r.sockets.length, 0);
    assert.equal(r.remote.running, false);
    assert.equal(r.published.filter(Boolean).length, 0);
  });
}

test('close before first sync never reads storage or flags', async () => {
  let reads = 0;
  const remote = openRemote({
    userData: tempDir(),
    live: {},
    flagOn: () => {
      reads++;
      return true;
    },
  });
  remote.close();
  await remote.sync();
  assert.equal(reads, 0);
  assert.equal(remote.running, false);
});

test('closing a running stack retires both a pending token and a later token request', async (t) => {
  const token = deferred<string>();
  const asked = deferred<void>();
  const relays: any[] = [];
  const start = RelayClient.prototype.start;
  t.mock.method(RelayClient.prototype, 'start', function (this: any) {
    relays.push(this);
    return start.call(this);
  });
  let tokens = 0;
  const r = rig(
    async () => {
      throw missing();
    },
    async () => {
      tokens++;
      asked.resolve();
      return token.promise;
    },
  );
  t.after(() => r.remote.close());
  await r.remote.sync();
  await asked.promise;
  r.remote.close();
  token.resolve('obsolete');
  await tick();
  assert.equal(await relays[0].o.getToken(), null);
  assert.equal(tokens, 1);
  assert.equal(r.sockets.length, 0);
  assert.equal(r.remote.running, false);
});

test('same-owner sync coalesces while storage is pending and an owner replacement still starts', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let loads = 0;
  const r = rig(async () => {
    if (++loads === 1) {
      entered.resolve();
      await release.promise;
    }
    throw missing();
  });
  t.after(() => r.remote.close());
  const first = r.remote.sync();
  await entered.promise;
  await r.remote.sync();
  release.resolve();
  await first;
  await tick();
  assert.equal(loads, 1);
  r.owner.key = 'replacement';
  await r.remote.sync();
  await tick();
  assert.equal(loads, 2);
  assert.equal(r.sockets.length, 2);
  assert.equal(r.remote.running, true);
});

test('owner replacement during pending storage starts only the replacement', async (t) => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let loads = 0;
  const r = rig(async () => {
    if (++loads === 1) {
      entered.resolve();
      await release.promise;
    }
    throw missing();
  });
  t.after(() => r.remote.close());
  const first = r.remote.sync();
  await entered.promise;
  r.owner.key = 'replacement';
  await r.remote.sync();
  release.resolve();
  await first;
  await tick();
  assert.equal(loads, 2);
  assert.equal(r.sockets.length, 1);
  assert.equal(r.published.filter(Boolean).length, 1);
});
