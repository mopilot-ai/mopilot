// Model relay cancellation closes upstream WebSocket handshakes that never answer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { admitAll } from './support/relayPeer.ts';
let onUpgrade: (req: http.IncomingMessage, socket: net.Socket) => void = (_r, s) => s.destroy();
const upstream = http.createServer();
upstream.on('upgrade', (req, socket) => onUpgrade(req, socket as net.Socket));
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.SAGE_RELAY_UPSTREAM = `http://127.0.0.1:${(upstream.address() as net.AddressInfo).port}/codex`;
const { Relay } = createRequire(import.meta.url)('../electron/identity/accounts/relay.cjs');
after(() => upstream.close());
async function relayWith() {
  const relay = new Relay({ pickFor: () => null, keyRoute: () => null }, admitAll);
  await relay.start();
  return relay;
}

for (const stopping of [false, true]) {
  test(`${stopping ? 'relay stop' : 'client disconnect'} cancels an upstream WebSocket handshake that never answers`, {
    timeout: 5000,
  }, async (t) => {
    const relay = await relayWith();
    let accepted!: () => void;
    let finished!: () => void;
    const arrived = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    const closed = new Promise<void>((resolve) => {
      finished = resolve;
    });
    let backend: net.Socket | undefined;
    onUpgrade = (_request, socket) => {
      backend = socket;
      socket.on('close', finished);
      socket.on('end', () => socket.destroy());
      accepted();
    };
    const destination = new URL(relay.base);
    const client = net.connect(Number(destination.port), destination.hostname);
    client.on('error', () => {});
    t.after(() => {
      client.destroy();
      backend?.destroy();
      relay.stop();
    });
    await once(client, 'connect');
    client.write(
      `GET ${destination.pathname}/responses HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nchatgpt-account-id: original\r\n\r\n`,
    );
    await arrived;
    if (stopping) relay.stop();
    else client.destroy();
    let timeout: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        closed,
        new Promise((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('upstream handshake remained open')), 1000);
        }),
      ]);
    } finally {
      clearTimeout(timeout!);
    }
    assert.equal(backend!.destroyed, true);
  });
}

test('websocket: an error on the client socket is absorbed, not thrown', async () => {
  const relay = new Relay({ pickFor: () => null, keyRoute: () => null }, admitAll);
  relay.secret = 's';
  const handlers: Record<string, (...a: any[]) => void> = {};
  const socket = {
    destroyed: true,
    on(event: string, fn: (...a: any[]) => void) {
      handlers[event] = fn;
    },
    destroy() {},
    end() {},
  };
  await relay.onUpgrade({ url: '/s/responses', headers: { 'chatgpt-account-id': 'x', upgrade: 'websocket' } }, socket, Buffer.alloc(0));
  assert.equal(typeof handlers.error, 'function');
  assert.doesNotThrow(() => handlers.error(new Error('ECONNRESET')));
});
