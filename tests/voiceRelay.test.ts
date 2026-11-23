import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import http from 'node:http';
import https from 'node:https';
import { createRequire } from 'node:module';
import { admitAll } from './support/relayPeer.ts';

process.env.SAGE_RELAY_UPSTREAM = 'https://backend.example.test/backend-api/codex';
process.env.SAGE_RELAY_REALTIME_UPSTREAM = 'https://audio.example.test';
const require = createRequire(import.meta.url);
const { UsageRefresh } = require('../electron/identity/contract/usageRefresh.cjs');
const { Relay } = require('../electron/identity/accounts/relay.cjs');
const { Accounts } = require('../electron/identity/codexAccounts.cjs');
const fs = require('node:fs');

class Socket extends EventEmitter {
  destroyed = false;
  writes: any[] = [];
  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit('close');
    }
  }
  write(data: any) {
    this.writes.push(data);
    return true;
  }
  end(data: any) {
    this.write(data);
    this.destroy();
  }
  pipe(destination: any) {
    return destination;
  }
}

type Reply = { status?: number; body?: string; location?: string; upgrade?: boolean; error?: boolean; before?: () => void };
function fixture(t: any, replies: Reply[] = [], pooled = true) {
  const requests: any[] = [];
  const refreshes: any[] = [];
  const limited: string[] = [];
  const users = [{ id: 'a' }, { id: 'b' }];
  const accounts: any = {
    usageRefresh: new UsageRefresh(),
    pickFor: (_session: string, tried: Set<string>) => (pooled ? users.find((a) => !tried.has(a.id) && !limited.includes(a.id)) : null),
    tokens: async (a: any, force = false) => {
      refreshes.push([a.id, force]);
      return { accessToken: `token-${a.id}${force ? '-fresh' : ''}`, chatgptAccountId: `account-${a.id}` };
    },
    markLimited: (a: any) => limited.push(a.id),
    noteUsageHeaders: () => {},
    keyRoute: () => null,
    apiBase: () => 'https://api-key.example.test/v1',
  };
  const upstreamSockets: Socket[] = [];
  const request = (url: string, init: any) => {
    const req: any = new EventEmitter();
    req.destroy = () => {};
    req.end = (body: any) => {
      requests.push({ url, ...init, body: body?.toString() });
      const reply = replies.shift();
      assert.ok(reply, `unexpected request: ${url}`);
      queueMicrotask(() => {
        reply.before?.();
        if (reply.error) return req.emit('error', new Error('upstream unavailable'));
        if (reply.upgrade) {
          const socket = new Socket();
          upstreamSockets.push(socket);
          req.emit('upgrade', { statusCode: 101, headers: {}, rawHeaders: ['Upgrade', 'websocket'] }, socket, Buffer.from(''));
        } else {
          const response: any = Readable.from([Buffer.from(reply.body ?? '{}')]);
          response.statusCode = reply.status ?? 200;
          response.headers = reply.location ? { location: reply.location } : {};
          response.rawHeaders = [];
          req.emit('response', response);
        }
      });
    };
    return req;
  };
  t.mock.method(http, 'request', request);
  t.mock.method(https, 'request', request);
  const relay = new Relay(accounts, admitAll);
  relay.base = `http://127.0.0.1:12345/${relay.secret}`;
  relay.realtimeBase = `${relay.base}/backend-api/codex`;
  t.after(() => relay.stop());
  const headers = { authorization: 'Bearer original', 'chatgpt-account-id': 'original-account', 'session-id': 'thread-a' };
  async function call(extra: any = {}) {
    const req: any = Readable.from([Buffer.from('{"sdp":"offer","session":{"model":"gpt-live-1-codex"}}')]);
    req.url = `/${relay.secret}/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas`;
    req.socket = new Socket();
    req.method = 'POST';
    req.headers = { ...headers, 'content-type': 'application/json', ...extra };
    const res: any = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    res.headersSent = false;
    res.writeHead = (status: number, h: any) => {
      res.status = status;
      res.responseHeaders = h;
      res.headersSent = true;
    };
    const finished = new Promise<void>((resolve) => res.on('finish', resolve));
    await relay.onRequest(req, res);
    await finished;
    return res;
  }
  async function attach(id = 'rtc_owned', socket = new Socket()) {
    await relay.onUpgrade(
      {
        url: `/${relay.secret}/v1/live/${id}`,
        headers: { ...headers, authorization: 'Bearer different', 'session-id': 'different-thread', upgrade: 'websocket' },
      },
      socket,
      Buffer.from(''),
    );
    return socket;
  }
  return { relay, accounts, requests, refreshes, limited, users, upstreamSockets, call, attach };
}

test('relay startup exposes distinct model, ChatGPT call and API sideband URLs', async (t) => {
  const server: any = new EventEmitter();
  server.listen = (_port: number, host: string, done: () => void) => {
    assert.equal(host, '127.0.0.1');
    done();
  };
  server.address = () => ({ port: 43210 });
  server.close = () => {};
  t.mock.method(http, 'createServer', () => server);
  const relay = new Relay({}, admitAll);
  const base = await relay.start();
  assert.equal(relay.realtimeBase, base + '/backend-api/codex');
  assert.equal(relay.realtimeSidebandBase, base + '/v1/live');
  assert.equal(relay.route(`/${relay.secret}/backend-api/codex/realtime/calls?intent=x`), '/realtime/calls?intent=x');
  assert.equal(relay.route(`/${relay.secret}/responses`), '/responses');
  assert.equal(relay.route(`/${relay.secret}`), '');
  assert.equal(relay.route(`/${relay.secret}wrong/responses`), null);
  relay.stop();
});

test('ChatGPT call creation preserves the JSON body, query and account pin', async (t) => {
  const f = fixture(t, [{ location: '/v1/live/rtc_owned' }]);
  const res = await f.call();
  assert.equal(res.status, 200);
  assert.equal(f.requests[0].url, 'https://backend.example.test/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas');
  assert.equal(f.requests[0].headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(f.requests[0].body), { sdp: 'offer', session: { model: 'gpt-live-1-codex' } });
  assert.equal(f.requests[0].headers.authorization, 'Bearer token-a');
  assert.equal(f.relay.voiceCalls.get('rtc_owned').session, 'thread-a');
});

test('sideband attaches with the creator account after the active account changes', async (t) => {
  const f = fixture(t, [{ location: '/v1/realtime/calls/calls/rtc_owned' }, { upgrade: true }]);
  await f.call();
  f.accounts.pickFor = () => f.users[1];
  const socket = await f.attach();
  assert.equal(f.requests[1].url, 'https://audio.example.test/v1/live/rtc_owned');
  assert.equal(f.requests[1].headers.authorization, 'Bearer token-a');
  assert.equal(f.requests[1].headers['chatgpt-account-id'], 'account-a');
  // exactly one handshake reply, and the voice socket stays open for the session
  assert.equal(socket.writes.length, 1);
  assert.ok(socket.writes[0].includes('101 Switching Protocols'));
  assert.equal(socket.destroyed, false);
  assert.equal(f.relay.voiceCalls.size, 0);
  f.relay.dropSession('thread-a');
  assert.equal(socket.destroyed, true);
  assert.equal(f.upstreamSockets[0].destroyed, true);
});

test('a single-account sideband uses the original call credentials', async (t) => {
  const f = fixture(t, [{ location: 'https://audio.example.test/v1/live/rtc_owned' }, { upgrade: true }], false);
  await f.call();
  await f.attach();
  assert.equal(f.requests[1].headers.authorization, 'Bearer original');
  assert.equal(f.requests[1].headers['chatgpt-account-id'], 'original-account');
  assert.deepEqual(f.refreshes, []);
});

test('call creation can fail over on a usage limit; the sideband follows the successful account', async (t) => {
  const f = fixture(t, [
    { status: 429, body: '{"error":{"type":"usage_limit_reached"}}' },
    { location: '/v1/live/rtc_owned' },
    { upgrade: true },
  ]);
  await f.call();
  await f.attach();
  assert.deepEqual(f.limited, ['a']);
  assert.equal(f.requests[2].headers.authorization, 'Bearer token-b');
});

test('sideband authentication refreshes the creator once, without account failover', async (t) => {
  const f = fixture(t, [{ location: '/v1/live/rtc_owned' }, { status: 401 }, { upgrade: true }]);
  await f.call();
  await f.attach();
  assert.deepEqual(f.refreshes, [
    ['a', false],
    ['a', false],
    ['a', true],
  ]);
  assert.equal(f.requests[2].headers.authorization, 'Bearer token-a-fresh');
});

test('a sideband refused after token refresh stays refused and never moves to another user', async (t) => {
  const f = fixture(t, [{ location: '/v1/live/rtc_owned' }, { status: 401 }, { status: 403, body: 'forbidden' }]);
  await f.call();
  const socket = await f.attach();
  assert.ok(socket.writes.at(-1).toString().startsWith('HTTP/1.1 403'));
  assert.equal(f.requests.length, 3);
  assert.ok(f.refreshes.every(([id]) => id === 'a'));
});

test('unknown, expired and dropped-session call IDs never reach the sideband upstream', async (t) => {
  const f = fixture(t, [{ location: '/v1/live/rtc_owned' }, { location: '/v1/live/rtc_owned' }]);
  assert.equal((await f.attach('unknown')).destroyed, true);
  await f.call();
  f.relay.voiceCalls.get('rtc_owned').at -= 60_001;
  assert.equal((await f.attach()).destroyed, true);
  await f.call();
  f.relay.dropSession('other-thread');
  assert.equal(f.relay.voiceCalls.size, 1);
  f.relay.dropSession('thread-a');
  assert.equal((await f.attach()).destroyed, true);
  assert.equal(f.requests.length, 2);
});

test('unauthorized websocket paths and API-key model sockets are rejected locally', async (t) => {
  const f = fixture(t);
  for (const req of [
    { url: '/wrong/v1/live/id', headers: {} },
    { url: `/${f.relay.secret}/responses`, headers: {} },
    { url: `/${f.relay.secret}/responses`, headers: { 'chatgpt-account-id': 'a' } },
  ]) {
    f.accounts.keyRoute = () => ({ key: 'mock-key' });
    const socket = new Socket();
    await f.relay.onUpgrade(req, socket, Buffer.from(''));
    assert.equal(socket.destroyed, true);
  }
  assert.equal(f.requests.length, 0);
});

test('failed calls and missing or malformed locations do not register sidebands', async (t) => {
  const f = fixture(t, [{ status: 404 }, { status: 503 }, {}, { location: 'https://[' }]);
  for (let i = 0; i < 4; i++) await f.call();
  assert.equal(f.relay.voiceCalls.size, 0);
  // the malformed one is recorded: its sideband can't attach as the creating account
  const { recentIgnored } = require('../electron/ignored.cjs');
  assert.ok(recentIgnored().some((e: any) => e.context === 'read the voice call id from the Codex backend'));
});

test('a sideband upstream error is returned and a client closed during handshake is cleaned up', async (t) => {
  const socket = new Socket();
  const f = fixture(t, [
    { location: '/v1/live/rtc_owned' },
    { error: true },
    { location: '/v1/live/rtc_owned' },
    { upgrade: true, before: () => socket.destroy() },
  ]);
  await f.call();
  const failed = await f.attach();
  assert.ok(failed.writes.at(-1).toString().startsWith('HTTP/1.1 502'));
  await f.call();
  await f.attach('rtc_owned', socket);
  assert.equal(f.upstreamSockets[0].destroyed, true);
});

test('model and API-key HTTP routes retain their original upstream paths', async (t) => {
  const f = fixture(t, [{}, {}, {}]);
  f.accounts.keyRoute = () => ({ base: 'https://custom.example.test/v1', key: 'mock-key' });
  await f.call();
  assert.equal(f.requests[0].url, 'https://custom.example.test/v1/realtime/calls?intent=quicksilver&architecture=avas');
  assert.equal(f.requests[0].headers.authorization, 'Bearer mock-key');
  assert.equal(f.requests[0].headers['chatgpt-account-id'], undefined);
  await f.call({ 'chatgpt-account-id': '' });
  assert.ok(f.requests[1].url.startsWith('https://api-key.example.test/v1/realtime/calls'));
  f.accounts.keyRoute = () => null;
  const socket = new Socket();
  await f.relay.onUpgrade(
    { url: `/${f.relay.secret}/responses`, headers: { 'chatgpt-account-id': 'a', upgrade: 'websocket' } },
    socket,
    Buffer.from(''),
  );
  assert.equal(f.requests[2].url, 'https://backend.example.test/backend-api/codex/responses');
});

test('account relay config adds voice overrides and honors explicit endpoints', async (t) => {
  let config = '';
  // the relay reads config.toml through the harness route reader (electron/identity/accounts/relayConfig.cjs)
  t.mock.method(fs.promises, 'stat', async () => ({ mtimeMs: 1 }));
  t.mock.method(fs.promises, 'readFile', async () => config);
  t.mock.method(Relay.prototype, 'start', function (this: any) {
    this.realtimeBase = 'http://relay/backend-api/codex';
    this.realtimeSidebandBase = 'http://relay/v1/live';
    return 'http://relay';
  });
  const manager: any = {};
  const all = {
    openai_base_url: 'http://relay',
    experimental_realtime_webrtc_call_base_url: 'http://relay/backend-api/codex',
    experimental_realtime_ws_base_url: 'http://relay/v1/live',
  };
  assert.deepEqual(await Accounts.prototype.startRelay.call(manager), all);
  config = 'experimental_realtime_webrtc_call_base_url="https://own/calls"';
  assert.deepEqual(await Accounts.prototype.startRelay.call(manager), { openai_base_url: 'http://relay' });
  config = 'experimental_realtime_ws_base_url="wss://own/live"';
  assert.deepEqual(await Accounts.prototype.startRelay.call(manager), {
    openai_base_url: 'http://relay',
    experimental_realtime_webrtc_call_base_url: 'http://relay/backend-api/codex',
  });
  config = 'model_provider="custom"';
  assert.equal(await Accounts.prototype.startRelay.call(manager), null);
  config = 'openai_base_url="https://own/v1"';
  assert.equal(await Accounts.prototype.startRelay.call(manager), null);
  // no config.toml: nothing custom configured
  t.mock.method(fs.promises, 'stat', async () => {
    throw Object.assign(new Error('no config'), { code: 'ENOENT' });
  });
  assert.deepEqual(await Accounts.prototype.startRelay.call(manager), all);
  t.mock.method(Relay.prototype, 'start', async () => {
    throw new Error('cannot listen');
  });
  assert.equal(await Accounts.prototype.startRelay.call(manager), null);
  assert.equal(manager.relay, null);
});

for (const phase of ['initial', 'retry', 'response', 'reject', 'current-error'] as const) {
  test(`a sideband token remains owned before dispatch: ${phase}`, async (t) => {
    const retry = phase === 'retry' || phase === 'response';
    const f = fixture(t, [
      { location: '/v1/live/rtc_owned' },
      ...(retry
        ? [
            {
              status: 401,
              before: () => {
                if (phase === 'response') f.accounts.usageRefresh.clear('a');
              },
            },
          ]
        : []),
    ]);
    await f.call();
    f.accounts.tokens = async (_row: any, force: boolean) => {
      if (!retry || force) {
        if (phase !== 'current-error') queueMicrotask(() => f.accounts.usageRefresh.clear('a'));
        if (phase === 'reject' || phase === 'current-error') throw new Error('token failed');
      }
      return { accessToken: 'fake-old', chatgptAccountId: 'old' };
    };
    if (phase === 'current-error') await assert.rejects(f.attach(), /token failed/);
    else {
      const socket = await f.attach();
      assert.match(socket.writes.map((x) => x.toString()).join(''), /503.*[\s\S]*login changed/);
    }
    assert.equal(f.requests.length, retry ? 2 : 1);
  });
}
