// The SSH fixture propagates resident EOF instead of leaving a falsely online app connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { waitFor } from './support/waitFor.ts';
import { connectSocket } from './support/connectSocket.ts';

for (const variable of ['FAKE_HOST_WIRE_SOCK', 'FAKE_HOST_CHATS_SOCK']) {
  test(`${variable}: resident EOF closes the forwarded app stream`, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-eof-'));
    const local = path.join(dir, 'app');
    const upstream = path.join(dir, 'host');
    const server = net.createServer();
    let child: ReturnType<typeof spawn> | undefined;
    let app: net.Socket | undefined;
    let resident: net.Socket | undefined;
    t.after(async () => {
      app?.destroy();
      resident?.destroy();
      if (child) {
        child.kill();
        await waitFor(() => child?.exitCode !== null || child?.signalCode !== null, 'SSH child exit');
      }
      let closed = false;
      server.close(() => {
        closed = true;
      });
      await waitFor(() => closed, 'resident server close');
      fs.rmSync(dir, { recursive: true, force: true });
    });
    server.listen(upstream);
    await once(server, 'listening');
    child = spawn(process.execPath, ['tests/e2e/fixtures/fake-ssh/ssh', '-L', `${local}:remote`, '--', 'box'], {
      env: { ...process.env, FAKE_HOST_WIRE_SOCK: undefined, FAKE_HOST_CHATS_SOCK: undefined, FAKE_HOST_ROOT: dir, [variable]: upstream },
      stdio: 'ignore',
    });
    app = await connectSocket(local, 'the forwarded socket accepting connections');
    app.on('data', () => undefined); // an unread reply (the fixture's own hello answer) would hold the close back
    const accepted = once(server, 'connection');
    // the fixture holds the real Host's rule: a versioned request is refused until hello came first on the connection
    app.write(
      `${JSON.stringify({ id: '0', method: 'host.hello', params: {} })}\n${JSON.stringify({ id: '1', method: 'chat.send', params: {} })}\n`,
    );
    [resident] = (await accepted) as [net.Socket];
    let seen = '';
    resident.on('data', (chunk) => (seen += chunk));
    await waitFor(() => seen.includes('"method":"chat.send"'), 'the chat request reaching the resident Host');
    const closed = once(app, 'close', { signal: AbortSignal.timeout(1500) });
    resident.end();
    await closed;
    assert.equal(app.destroyed, true);
  });
}
