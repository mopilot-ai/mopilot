// The relay's plain-HTTP streaming: an upstream cut off mid-stream ends Codex's request at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { admitAll } from './support/relayPeer.ts';

const upstream = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: {"type":"response.created"}\n\n');
  // the connection drops before the stream finishes
  setTimeout(() => res.socket?.destroy(), 30);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
process.env.SAGE_RELAY_UPSTREAM = `http://127.0.0.1:${(upstream.address() as any).port}`;
const { Relay } = createRequire(import.meta.url)('../electron/identity/accounts/relay.cjs');

test('an upstream that drops mid-stream ends the client response promptly', { timeout: 5000 }, async () => {
  const accounts = {
    pickFor: () => null,
    keyRoute: () => null,
    apiBase: () => process.env.SAGE_RELAY_UPSTREAM,
    noteUsageHeaders: () => {},
  };
  const relay = new Relay(accounts, admitAll);
  const base = await relay.start();
  try {
    for (const headers of [{ 'chatgpt-account-id': 'acct' }, {}]) {
      const t0 = Date.now();
      const outcome = await new Promise((resolve) => {
        const req = http.request(base + '/responses', { method: 'POST', headers }, (res) => {
          let got = '';
          res.on('data', (d) => (got += d));
          res.on('end', () => resolve({ how: 'end', got }));
          res.on('error', () => resolve({ how: 'error', got }));
          res.on('aborted', () => resolve({ how: 'aborted', got }));
        });
        req.on('error', () => resolve({ how: 'error', got: '' }));
        req.end('{}');
      });
      assert.notEqual((outcome as any).how, 'end');
      assert.match((outcome as any).got, /response\.created/);
      assert.ok(Date.now() - t0 < 2000);
    }
  } finally {
    relay.stop();
    upstream.close();
  }
});
