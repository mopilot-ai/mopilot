// electron/identity/accounts/relay.cjs against a local fake Codex backend: account choice and replay on usage limits and
// expired tokens, API-key routes, pass-through, error bodies in any encoding, and the WebSocket handshake.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createRelayAccounts, admitAll } from './support/relay-accounts.ts';
const newRelay = (accounts: any) => new Relay(accounts, admitAll);

type Handler = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => void;
let handler: Handler = (_req, res) => res.end('ok');
let onUpgrade: (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => void = (_r, s) => s.destroy();
const seen: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
const upstream = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = Buffer.concat(chunks).toString();
  seen.push({ url: req.url!, headers: req.headers, body });
  handler(req, res, body);
});
const openSockets: net.Socket[] = [];
upstream.on('upgrade', (req, socket, head) => {
  openSockets.push(socket as net.Socket);
  seen.push({ url: req.url!, headers: req.headers, body: '' });
  onUpgrade(req, socket as net.Socket, head);
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const UP = `http://127.0.0.1:${(upstream.address() as any).port}`;
process.env.SAGE_RELAY_UPSTREAM = `${UP}/codex`;
const { Relay, usageLimit, upstreamBase } = createRequire(import.meta.url)('../electron/identity/accounts/relay.cjs');
const { recentIgnored } = createRequire(import.meta.url)('../electron/ignored.cjs');
const ignored = (context: string) => recentIgnored().filter((e: any) => e.context === context);

const { accounts, calls } = createRelayAccounts(`${UP}/v1`);

const relays: any[] = [];
async function relayWith(acc: any) {
  const r = newRelay(acc);
  await r.start();
  relays.push(r);
  return r;
}
after(() => {
  for (const s of openSockets) s.destroy();
  for (const r of relays) r.stop();
  upstream.closeAllConnections();
  upstream.close();
});

function send(url: string, headers: Record<string, string> = {}, body = '{}'): Promise<{ status: number; headers: any; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
const reset = () => {
  calls.length = 0;
  seen.length = 0;
};
const limitBody = (extra: any = {}) => JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1234, ...extra } });

test('the backend is ChatGPT unless a test points it at a fake one', () => {
  assert.equal(upstreamBase({}), 'https://chatgpt.com/backend-api/codex');
  assert.equal(upstreamBase({ SAGE_RELAY_UPSTREAM: 'http://127.0.0.1:9' }), 'http://127.0.0.1:9');
});

test('usageLimit: only a 429 for usage or credits, with its reset time', () => {
  assert.equal(usageLimit(500, Buffer.from('')), null);
  assert.equal(usageLimit(429, Buffer.from('not json')), null);
  assert.equal(usageLimit(429, Buffer.from('null')), null);
  assert.equal(usageLimit(429, Buffer.from(JSON.stringify({ error: { type: 'rate_limit' } }))), null);
  assert.deepEqual(usageLimit(429, Buffer.from(JSON.stringify({ error: { code: 'insufficient_credits' } }))), { resetsAt: null });
  assert.deepEqual(usageLimit(429, Buffer.from(limitBody())), { resetsAt: 1234 });
  const r = usageLimit(429, Buffer.from(JSON.stringify({ error: { type: 'usage_not_included', resets_in_seconds: 60 } })));
  assert.ok(Math.abs(r.resetsAt - (Math.floor(Date.now() / 1000) + 60)) <= 1);
});

test('only the secret path is served; the bare prefix is a valid route', async () => {
  const relay = await relayWith(accounts({ pick: null }));
  const port = relay.server.address().port;
  assert.equal((await send(`http://127.0.0.1:${port}/elsewhere`)).status, 404);
  assert.equal(relay.route(`/${relay.secret}`), '');
  assert.equal(relay.route(`/${relay.secret}x`), null);
  reset();
  handler = (_req, res) => res.end('root');
  const r = await send(relay.base, { 'chatgpt-account-id': 'x' });
  assert.equal(r.body, 'root');
  assert.equal(seen[0].url, '/codex');
});

test('a usage limit moves the request to the next account, decoding the error in any encoding', async () => {
  const relay = await relayWith(accounts());
  const encoders: Record<string, (b: Buffer) => Buffer> = {
    gzip: zlib.gzipSync,
    br: zlib.brotliCompressSync,
    deflate: zlib.deflateSync,
    zstd: (b) => (zlib as any).zstdCompressSync(b),
    identity: (b) => b,
  };
  for (const [enc, fn] of Object.entries(encoders)) {
    reset();
    handler = (req, res) => {
      if (req.headers['chatgpt-account-id'] === 'cg-a') {
        res.writeHead(429, { 'content-encoding': enc, 'content-type': 'application/json' });
        return res.end(fn(Buffer.from(limitBody())));
      }
      res.writeHead(200, { 'x-codex-primary-used-percent': '5' });
      res.end('from b');
    };
    const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x', 'session-id': 's1' });
    assert.equal(r.body, 'from b', enc);
    assert.deepEqual(
      calls.filter((c) => c[0] === 'limited'),
      [['limited', 'a', 1234]],
      enc,
    );
    assert.equal(seen[1].headers.authorization, 'Bearer tok-b');
    assert.equal(seen[1].headers['session-id'], 's1');
  }
  // a body that claims an encoding but isn't one is read as is
  reset();
  handler = (req, res) => {
    res.writeHead(req.headers['chatgpt-account-id'] === 'cg-a' ? 429 : 200, { 'content-encoding': 'gzip' });
    res.end(req.headers['chatgpt-account-id'] === 'cg-a' ? 'not gzip' : 'b');
  };
  const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(r.status, 429); // not a usage limit: Codex sees it
  assert.equal(r.body, 'not gzip');
  assert.ok(ignored('decode a gzip answer').length);
});

test('every account limited: the last refusal goes to Codex', async () => {
  const relay = await relayWith(accounts());
  reset();
  handler = (_req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', connection: 'keep-alive' });
    res.end(limitBody());
  };
  const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(r.status, 429);
  assert.match(r.body, /usage_limit_reached/);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'limited').map((c) => c[1]),
    ['a', 'b'],
  );
});

test('an expired token is refreshed once on the same account, then the next account is tried', async () => {
  const relay = await relayWith(accounts());
  reset();
  handler = (req, res) => {
    const auth = req.headers.authorization;
    res.writeHead(auth === 'Bearer tok-a' || auth === 'Bearer tok-a-fresh' ? 401 : 200);
    res.end(auth);
  };
  const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(r.body, 'Bearer tok-b');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'tokens'),
    [
      ['tokens', 'a', false],
      ['tokens', 'a', true],
      ['tokens', 'b', false],
    ],
  );

  // refresh fails: the account is skipped; with none left, the 401 reaches Codex
  const relay2 = await relayWith(
    accounts({
      list: [{ id: 'a' }],
      tokens: (a: any, force: boolean) => {
        if (force) throw new Error('signed out');
        return { accessToken: 'old', chatgptAccountId: 'cg' };
      },
    }),
  );
  handler = (_req, res) => {
    res.writeHead(401);
    res.end('expired');
  };
  const r2 = await send(`${relay2.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(r2.status, 401);
  assert.equal(r2.body, 'expired');
});

test('withAccounts: token failures skip an account, no account answers 503, and it gives up after eight tries', async () => {
  const relay = newRelay(
    accounts({
      tokens: (a: any) => {
        if (a.id === 'a') throw new Error('x');
        return { accessToken: 't', chatgptAccountId: 'c' };
      },
    }),
  );
  reset();
  const r = await relay.withAccounts('s', async (acct: any) => ({ status: 200, headers: null, body: acct.id }));
  assert.equal(r.body, 'b');
  assert.equal(
    calls.some((c) => c[0] === 'usage'),
    false,
  ); // no headers to note

  const none = newRelay(accounts({ pick: undefined }));
  const answer = await none.withAccounts('s', async () => assert.fail('no attempt'));
  assert.equal(answer.status, 503);
  assert.match(answer.body.toString(), /No ChatGPT account is available/);
  const done = { status: 200, done: true };
  assert.equal(await newRelay(accounts()).withAccounts('s', async () => done), done);

  let n = 0;
  const forever = newRelay(accounts({ pick: () => ({ id: `x${n}` }) }));
  const last = await forever.withAccounts('s', async () => ({ status: 429, headers: {}, body: Buffer.from(limitBody()), n: ++n }));
  assert.equal(n, 8);
  assert.equal(last.n, 8);
});

test('withAccounts logs its choices with SAGE_RELAY_DEBUG', async () => {
  const lines: any[] = [];
  const realError = console.error;
  console.error = (...a: any[]) => lines.push(a[3]);
  process.env.SAGE_RELAY_DEBUG = '1';
  try {
    for (const pick of [null, { id: 'a' }, {}]) {
      const relay = newRelay(accounts({ pick: (_s: any, tried: Set<string>) => (tried.size ? undefined : pick), tokens: () => ({}) }));
      await relay.withAccounts('s', async () => ({ status: 200, headers: {} }));
    }
    await newRelay(accounts({ pick: undefined })).withAccounts('s', async () => ({}));
  } finally {
    console.error = realError;
    delete process.env.SAGE_RELAY_DEBUG;
  }
  assert.deepEqual(lines, ['pass-through', 'a', 'none', 'none']);
});

test('pass-through: API-key sign-ins and keyed chats; an unreachable upstream is a 502', async () => {
  const relay = await relayWith(accounts({ keyRoute: (s: string) => (s === 'keyed' ? { base: `${UP}/key`, key: 'sk-1' } : null) }));
  reset();
  handler = (req, res) => res.end(`${req.url} ${req.headers.authorization ?? ''} ${req.headers['chatgpt-account-id'] ?? '-'}`);
  assert.equal((await send(`${relay.base}/models`, { authorization: 'Bearer user' })).body, '/v1/models Bearer user -');
  assert.equal(
    (await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x', 'session-id': 'keyed' })).body,
    '/key/responses Bearer sk-1 -',
  );
  assert.equal(seen[1].body, '{}');

  const dead = await relayWith(accounts({ apiBase: 'https://127.0.0.1:1' }));
  const r = await send(`${dead.base}/models`);
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.body).error.message, /ECONNREFUSED/);
});

test('pass-through: an upstream reset after the headers ends the client response', async () => {
  const relay = await relayWith(accounts());
  handler = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: 1\n\n');
    setTimeout(() => (req.socket as any).resetAndDestroy(), 20);
  };
  const outcome = await new Promise((resolve) => {
    const req = http.request(`${relay.base}/models`, { method: 'POST' }, (res) => {
      res.on('data', () => {});
      res.on('end', () => resolve('end'));
      res.on('error', () => resolve('error'));
      res.on('aborted', () => resolve('aborted'));
    });
    req.on('error', () => resolve('error'));
    req.end();
  });
  assert.notEqual(outcome, 'end');
});

test('ChatGPT route: pass-through account, an unreachable backend, a broken error body, and relay errors', async () => {
  const relay = await relayWith(accounts({ pick: null }));
  reset();
  handler = (_req, res) => res.end('plain');
  assert.equal((await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' })).body, 'plain');
  assert.equal(
    calls.some((c) => c[0] === 'usage'),
    false,
  );

  // the backend hangs up without answering
  handler = (req) => req.socket.destroy();
  const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(r.status, 502);
  assert.match(JSON.parse(r.body).error.message, /socket hang up/);

  // a 429 whose body is cut off is replayed with what arrived (nothing)
  handler = (req, res) => {
    res.writeHead(429, { 'content-length': '100' });
    res.write('partial');
    setTimeout(() => req.socket.destroy(), 20);
  };
  const cut = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(cut.status, 429);
  assert.equal(cut.body, '');
  assert.ok(ignored('read an error answer from the Codex backend').length);

  const broken = await relayWith({
    ...accounts(),
    keyRoute: () => {
      throw new Error('store gone');
    },
  });
  const b = await send(`${broken.base}/responses`, { 'chatgpt-account-id': 'x' });
  assert.equal(b.status, 502);
  assert.equal(JSON.parse(b.body).error.message, 'Relay error');
});

test('a request Codex abandons before an account is ready never reaches the backend', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const relay = await relayWith(accounts({ tokens: async () => (await gate, { accessToken: 't', chatgptAccountId: 'c' }) }));
  reset();
  const req = http.request(`${relay.base}/responses`, { method: 'POST', headers: { 'chatgpt-account-id': 'x' } });
  req.on('error', () => {});
  req.end('{}');
  while (!calls.some((c) => c[0] === 'tokens')) await new Promise((r) => setTimeout(r, 5));
  req.destroy();
  await new Promise((r) => setTimeout(r, 30));
  release();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(seen.length, 0);
});

/* WebSocket */

function rawUpgrade(
  base: string,
  headers: Record<string, string>,
  head = '',
): Promise<{ data: string; socket: net.Socket; closed: Promise<void> }> {
  const u = new URL(base);
  return new Promise((resolve) => {
    const socket = net.connect(Number(u.port), '127.0.0.1');
    openSockets.push(socket);
    let data = '';
    const closed = once(socket, 'close').then(() => {});
    socket.on('data', (d) => (data += d));
    socket.on('error', () => {});
    const lines = [`GET ${u.pathname}/responses HTTP/1.1`, 'Host: x', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)];
    socket.write(lines.join('\r\n') + '\r\n\r\n' + head);
    const done = () =>
      resolve({
        get data() {
          return data;
        },
        socket,
        closed,
      } as any);
    socket.once('data', () => setTimeout(done, 30));
    socket.once('close', done);
  });
}
const WS = { connection: 'Upgrade', upgrade: 'websocket' };

test('websocket: refused without the secret path or a ChatGPT account, and for chats on an API key', async () => {
  const relay = await relayWith(accounts({ keyRoute: (s: string) => (s === 'k' ? { base: '', key: '' } : null) }));
  for (const [base, h] of [
    [relay.base.replace(relay.secret, 'nope'), { ...WS, 'chatgpt-account-id': 'x' }],
    [relay.base, WS],
    [relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 'k' }],
  ] as const) {
    const r = await rawUpgrade(base, h as any);
    await r.closed;
    assert.equal(r.data, '');
  }
  const broken = await relayWith({
    ...accounts(),
    keyRoute: () => {
      throw new Error('x');
    },
  });
  const r = await rawUpgrade(broken.base, { ...WS, 'chatgpt-account-id': 'x' });
  await r.closed;
  assert.equal(r.data, '');
});

test('no usable account: a request and a socket both get a 503 instead of hanging', async () => {
  // every account fails to give a token, so none can be tried
  const relay = await relayWith(
    accounts({
      tokens: () => {
        throw new Error('expired');
      },
    }),
  );
  reset();
  const r = await send(`${relay.base}/responses`, { 'chatgpt-account-id': 'x', 'session-id': 's' });
  assert.equal(r.status, 503);
  assert.match(r.body, /No ChatGPT account is available/);
  const ws = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 's' });
  await ws.closed;
  assert.match(ws.data, /^HTTP\/1\.1 503 Service Unavailable\r\n/);
  assert.match(ws.data, /No ChatGPT account is available/);
  assert.equal(seen.length, 0); // nothing reached the upstream
});

test("websocket: the handshake is relayed with both sides' early bytes, then the streams are piped; dropSession closes it", async () => {
  const relay = await relayWith(accounts());
  reset();
  onUpgrade = (req, socket, head) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Codex-Primary-Used-Percent: 3\r\n\r\nWORLD`,
    );
    socket.write(`[head:${head}]`);
    socket.on('data', (d) => socket.write(`echo:${d}`));
    socket.on('end', () => socket.end());
    socket.on('error', () => {});
  };
  const r = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 's1' }, 'HELLO');
  await new Promise((res) => setTimeout(res, 30));
  assert.match(r.data, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(r.data, /X-Codex-Primary-Used-Percent: 3/);
  assert.match(r.data, /WORLD/);
  await new Promise((res) => setTimeout(res, 30));
  assert.match(r.data, /\[head:\]/); // the client's early bytes follow the handshake as data
  assert.match(r.data, /echo:HELLO/);
  assert.equal(seen[0].headers.authorization, 'Bearer tok-a');
  assert.equal(seen[0].headers.upgrade, 'websocket');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'usage'),
    [['usage', 'a']],
  );
  r.socket.write('ping');
  await new Promise((res) => setTimeout(res, 30));
  assert.match(r.data, /echo:ping/);
  assert.equal(relay.sockets.get('s1').size, 1);

  // a second connection for the session, closed by the client, leaves the first registered
  const r2 = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 's1' });
  assert.equal(relay.sockets.get('s1').size, 2);
  r2.socket.destroy();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(relay.sockets.get('s1').size, 1);

  relay.dropSession('s1');
  await r.closed;
  assert.equal(relay.sockets.has('s1'), false);
  relay.dropSession('nobody');

  // the last connection of a session closing by itself unregisters the session
  const r4 = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 's2' });
  assert.equal(relay.sockets.get('s2').size, 1);
  r4.socket.destroy();
  await new Promise((res) => setTimeout(res, 30));
  assert.equal(relay.sockets.has('s2'), false);

  // without a session, nothing is registered; the backend closing ends the client
  onUpgrade = (_req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    setTimeout(() => socket.destroy(), 20);
  };
  const r3 = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x' });
  await r3.closed;
  assert.equal(relay.sockets.size, 0);
});

test('websocket: a limited account is replayed on the next; refusals and failures are answered as HTTP', async () => {
  const relay = await relayWith(accounts());
  reset();
  onUpgrade = (req, socket) => {
    if (req.headers['chatgpt-account-id'] === 'cg-a') {
      const body = limitBody();
      socket.end(
        `HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
      return;
    }
    socket.end('HTTP/1.1 599 Whatever\r\nConnection: close\r\nContent-Length: 2\r\n\r\nno');
  };
  const r = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x' });
  await r.closed;
  assert.match(r.data, /^HTTP\/1\.1 599 \r\n/);
  assert.match(r.data, /content-length: 2\r\nconnection: close\r\n\r\nno$/);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'limited').map((c) => c[1]),
    ['a'],
  );

  // the backend hangs up: 502 with an empty body
  onUpgrade = (_req, socket) => socket.destroy();
  const passThrough = await relayWith(accounts({ pick: null }));
  const f = await rawUpgrade(passThrough.base, { ...WS, 'chatgpt-account-id': 'x' });
  await f.closed;
  assert.match(f.data, /^HTTP\/1\.1 502 Bad Gateway\r\n/);
  assert.match(f.data, /content-length: 0/);

  // a refusal whose body is cut off
  onUpgrade = (_req, socket) => {
    socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 50\r\n\r\npart');
    setTimeout(() => socket.destroy(), 20);
  };
  const c = await rawUpgrade(passThrough.base, { ...WS, 'chatgpt-account-id': 'x' });
  await c.closed;
  assert.match(c.data, /^HTTP\/1\.1 403 Forbidden\r\n/);
});

test('websocket: a handshake refused on a kept-alive connection is replayed on a fresh one for the next account', async () => {
  const relay = await relayWith(accounts());
  reset();
  const connections = new Set<net.Socket>();
  onUpgrade = (req, socket) => {
    connections.add(socket);
    if (req.headers['chatgpt-account-id'] === 'cg-a') {
      // a usage limit that keeps the connection open, as a real backend may
      const body = limitBody();
      socket.write(
        `HTTP/1.1 429 Too Many Requests\r\nConnection: keep-alive\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\nREADY');
  };
  const r = await rawUpgrade(relay.base, { ...WS, 'chatgpt-account-id': 'x', 'session-id': 'replay' });
  await new Promise((res) => setTimeout(res, 30));
  assert.match(r.data, /^HTTP\/1\.1 101 Switching Protocols\r\n/);
  assert.match(r.data, /READY/);
  assert.deepEqual(
    seen.map((x) => x.headers['chatgpt-account-id']),
    ['cg-a', 'cg-b'],
  );
  assert.equal(connections.size, 2, 'each handshake attempt has its own connection');
  relay.dropSession('replay');
  for (const c of connections) c.destroy();
});

test('websocket: a client gone before the handshake or before the answer gets nothing', async () => {
  const relay = newRelay(accounts({ pick: null }));
  relay.secret = 's';
  const sock = (destroyed: boolean) => ({
    destroyed,
    writes: [] as any[],
    on() {},
    off() {},
    destroy() {},
    end(b: any) {
      this.writes.push(b);
    },
  });
  reset();
  const gone = sock(true);
  await relay.onUpgrade({ url: '/s/responses', headers: { 'chatgpt-account-id': 'x', upgrade: 'websocket' } }, gone, Buffer.alloc(0));
  assert.deepEqual(gone.writes, []);
  assert.equal(seen.length, 0);

  // the client leaves while the backend answers
  const leaving = sock(false);
  onUpgrade = (_req, socket) => {
    leaving.destroyed = true;
    socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  };
  await relay.onUpgrade({ url: '/s/responses', headers: { 'chatgpt-account-id': 'x' } }, leaving, Buffer.alloc(0));
  assert.deepEqual(leaving.writes, []);
  assert.equal(seen[0].headers.upgrade, 'websocket');
});
