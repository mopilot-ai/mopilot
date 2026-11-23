// Test socket readiness retains a usable connection, bounds silent attempts, and distinguishes peer EOF from startup failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { connectSocket } from './support/connectSocket.ts';

test('a silent connection attempt is destroyed at the readiness deadline', { timeout: 5000 }, async (t) => {
  const attempt = new net.Socket();
  t.after(() => attempt.destroy());
  t.mock.method(net, 'connect', () => attempt);
  await assert.rejects(
    connectSocket('/unused', 'a silent resident', { timeoutMs: 20 }),
    /Timed out after 20 ms waiting for a silent resident/,
  );
  assert.equal(attempt.destroyed, true);
});

for (const rejectsPeer of [false, true]) {
  test(`an established socket observes ${rejectsPeer ? 'peer rejection' : 'the actual protocol reply'}`, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'socket-ready-'));
    const socketPath = path.join(root, 's');
    const accepted = new Set<net.Socket>();
    const server = net.createServer((peer) => {
      accepted.add(peer);
      if (rejectsPeer) peer.end();
      else peer.on('data', (data) => peer.end(`reply: ${data}`));
    });
    let client: net.Socket | undefined;
    t.after(async () => {
      client?.destroy();
      for (const peer of accepted) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    });
    server.listen(socketPath);
    await once(server, 'listening');
    client = await connectSocket(socketPath, 'the test server');
    let response = '';
    client.setEncoding('utf8');
    client.on('data', (data) => (response += data));
    const closed = once(client, 'close');
    if (!rejectsPeer) client.write('hello');
    await closed;
    assert.equal(response, rejectsPeer ? '' : 'reply: hello');
    assert.equal(accepted.size, 1, 'readiness returns the connection used for the assertion');
  });
}
