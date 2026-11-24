// Turning Mobile Remote's opt-in off (Settings › Allow connections) drops what is live: the relay socket the phones reach this Mac through is closed and the channel detaches, so a phone connected now is disconnected (electron/remote/runtime.cjs sync → retire).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, fs, tempDir } from './support/remoteKit.ts';
import { FakeSocket } from './support/remoteSocket.ts';
import { waitFor } from './support/waitFor.ts';

const { openRemote, DEFAULT_RELAY_URL } = createRequire(import.meta.url)('../electron/remote/runtime.cjs');

test('opting out closes the relay connection and detaches the channel; opting in again starts a new one', async () => {
  const sockets: FakeSocket[] = [];
  const channels: unknown[] = [];
  let optedIn = true;
  const remote = openRemote({
    userData: tempDir(),
    live: { mopilot: { relayToken: async () => 'jwt' } },
    flagOn: () => true,
    chatId: () => 'chat-1',
    safeStorage: fakeSafe(),
    fs,
    relayUrl: DEFAULT_RELAY_URL ?? 'wss://relay.example.test/v1/ws',
    optedIn: () => optedIn,
    onChannel: (c: unknown) => channels.push(c),
    createSocket: (url: string, headers: any) => (sockets.push(new FakeSocket(url, headers)), sockets.at(-1)),
  });
  await remote.sync();
  await waitFor(() => sockets.length === 1, 'a relay socket');
  sockets[0].hello();
  assert.equal(remote.running, true);
  assert.equal(sockets[0].closed.length, 0);
  optedIn = false;
  await remote.sync();
  assert.ok(sockets[0].closed.length > 0, 'the live connection is closed');
  assert.equal(channels.at(-1), null, 'the channel detaches');
  assert.equal(remote.running, false);
  optedIn = true;
  await remote.sync();
  await waitFor(() => sockets.length === 2, 'a new relay socket');
  remote.close();
});
