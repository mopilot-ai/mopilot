// bench/drivers/mgb.mjs (#1381): the fixture server's and provider proxy's control calls open a fresh connection each
// time, so a native arm's synchronous turn cannot leave them a closed keep-alive socket to reuse (EPIPE).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

const { fixtureServer, limitProxy } = await import('../bench/drivers/mgb.mjs');
const { TOKEN_HEADER } = await import('../bench/lib/mgb/apps/server.mjs');

async function recorder(reply: (req: IncomingMessage) => string) {
  const seen: { url: string; connection: string | undefined; token: string | undefined }[] = [];
  let sockets = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ url: String(req.url), connection: req.headers.connection, token: req.headers[TOKEN_HEADER] as string });
      res.setHeader('content-type', 'application/json');
      res.end(reply(req));
    });
  });
  server.on('connection', () => sockets++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, seen, sockets: () => sockets, close: () => server.close() };
}

test('fixtureServer: load and state each open their own connection, asking the server to close it', async (t) => {
  const s = await recorder((req) => (req.url === '/__mgb/state' ? '{"mail":{}}' : '{"loaded":[]}'));
  t.after(s.close);
  const fx = fixtureServer(s.port, 'tok-0123456789abcdef');
  await fx.load({ mail: {} });
  assert.deepEqual(await fx.state(), { mail: {} });
  assert.deepEqual(await fx.state(), { mail: {} });
  assert.deepEqual(
    s.seen.map((x) => [x.url, x.connection, x.token]),
    [
      ['/__mgb/load', 'close', 'tok-0123456789abcdef'],
      ['/__mgb/state', 'close', 'tok-0123456789abcdef'],
      ['/__mgb/state', 'close', 'tok-0123456789abcdef'],
    ],
  );
  assert.equal(s.sockets(), 3, 'no socket is reused');
});

test('limitProxy: every control call opens its own connection too', async (t) => {
  const s = await recorder(() => '{"armed":false}');
  t.after(s.close);
  const proxy = limitProxy(s.port, 'tok-0123456789abcdef');
  await proxy.arm('tag', 2);
  await proxy.state();
  await proxy.disarm();
  assert.deepEqual(
    s.seen.map((x) => [x.url, x.connection]),
    [
      ['/__limit/arm', 'close'],
      ['/__limit/state', 'close'],
      ['/__limit/disarm', 'close'],
    ],
  );
  assert.equal(s.sockets(), 3);
});
