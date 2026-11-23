// Security review of Mobile Remote: nothing an unauthenticated client sends may end the relay process.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';

/** The relay in a child process; `exited` resolves with its exit code if it dies. */
async function child(verifyMs = 0) {
  const proc = spawn(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'tests/support/relayChild.mjs', String(verifyMs)],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  proc.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise<number | null>((r) => proc.once('exit', r));
  const port = await new Promise<number>((resolve, reject) => {
    proc.stdout.once('data', (d) => resolve(JSON.parse(String(d)).port));
    proc.once('exit', () => reject(new Error(`the relay did not start: ${stderr}`)));
  });
  const alive = async () => {
    // a health check answers (the fake database is up) and the process has not exited
    const res = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
    return res?.status === 200 && (await Promise.race([exited, new Promise((r) => setTimeout(() => r('running'), 50))])) === 'running';
  };
  return { port, alive, exited, stderr: () => stderr, stop: () => proc.kill() };
}
const raw = (port: number, text: string) =>
  new Promise<net.Socket>((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => (s.write(text), resolve(s)));
    // a relay that is gone refuses the connection: the test then fails on `alive`, not by waiting
    s.on('error', () => resolve(s));
  });

test('requests whose target is not a URL do not end the relay', async () => {
  const relay = await child();
  try {
    for (const target of ['//', '//[', 'http://[']) {
      for (const head of [
        `GET ${target} HTTP/1.1\r\nHost: x\r\n\r\n`,
        `GET ${target} HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      ]) {
        const s = await raw(relay.port, head);
        await new Promise((r) => setTimeout(r, 100));
        s.destroy();
      }
    }
    assert.equal(await relay.alive(), true, `the relay died: ${relay.stderr().slice(0, 400)}`);
  } finally {
    relay.stop();
  }
});

test('many upgrades that reset while their token is checked do not end the relay', async () => {
  const relay = await child(300);
  try {
    const upgrade =
      'GET /v1/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer abc\r\n\r\n';
    const sockets = await Promise.all(Array.from({ length: 40 }, () => raw(relay.port, upgrade)));
    await new Promise((r) => setTimeout(r, 50));
    for (const s of sockets) s.resetAndDestroy();
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await relay.alive(), true, `the relay died: ${relay.stderr().slice(0, 400)}`);
  } finally {
    relay.stop();
  }
});

test('a half-sent request line does not hold the relay forever and the relay keeps serving', async () => {
  const relay = await child();
  try {
    const slow = await Promise.all(Array.from({ length: 20 }, () => raw(relay.port, 'GET /v1/ws HTTP/1.1\r\nHost: x\r\n')));
    assert.equal(await relay.alive(), true);
    for (const s of slow) s.destroy();
  } finally {
    relay.stop();
  }
});

test('process guards: a stray rejection or a dead socket is logged and the relay goes on; anything else ends it', async () => {
  const { EventEmitter } = await import('node:events');
  const { installProcessGuards, SOCKET_ERROR_CODES } = await import('../relay/src/processGuards.mjs');
  const proc = new EventEmitter();
  const logs: [string, any][] = [];
  const exits: number[] = [];
  installProcessGuards({ proc: proc as any, log: (e, d) => logs.push([e, d]), exit: (c) => exits.push(c) });
  proc.emit('unhandledRejection', new Error('late'));
  proc.emit('unhandledRejection', 'text');
  for (const code of SOCKET_ERROR_CODES) proc.emit('uncaughtException', Object.assign(new Error('dead socket'), { code }));
  assert.deepEqual(exits, []);
  assert.deepEqual(logs[0], ['unhandled_rejection', { message: 'late', code: undefined }]);
  assert.equal(logs[1][1].message, 'text');
  proc.emit('uncaughtException', new Error('bug'));
  proc.emit('uncaughtException', undefined);
  assert.deepEqual(exits, [1, 1]);
});

test('in process: a target that is not a URL is a 404, and a verifier that throws is a 500 or a closed socket, never an uncaught error', async () => {
  const { loadConfig } = await import('../relay/src/config.mjs');
  const { createRelay } = await import('../relay/src/server.mjs');
  const logs: string[] = [];
  const relay = createRelay({
    config: loadConfig({ AUTH_PUBLIC_KEY: 'x', DATABASE_URL: 'postgres://unused' }),
    db: { query: async () => ({ rows: [] }) },
    verifier: {
      verify: async () => {
        throw new Error('jwks down');
      },
      verifyRevocation: async () => {
        // not even an Error
        throw 'jwks down';
      },
    } as any,
    send: null,
    log: (event, data: any) => void logs.push(`${event}:${data.message}`),
  });
  const port = await relay.listen(0, '127.0.0.1');
  try {
    const answer = async (head: string) => {
      const s = await raw(port, head);
      const text = await new Promise<string>((resolve) => {
        let got = '';
        s.on('data', (d) => (got += d));
        s.on('close', () => resolve(got));
        setTimeout(() => (s.destroy(), resolve(got)), 500);
      });
      return text.split('\r\n')[0];
    };
    assert.match(await answer('GET // HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /404/);
    assert.match(await answer('POST /v1/revoke HTTP/1.1\r\nHost: x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'), /500/);
    assert.equal(
      await answer(
        'GET /v1/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer abc\r\n\r\n',
      ),
      '',
    );
    assert.deepEqual(logs, ['error:jwks down', 'error:jwks down']);
  } finally {
    await relay.close();
  }
});

test('failRequest answers 500, or drops the connection when the answer had begun; the guards’ defaults are the real process', async () => {
  const { failRequest } = await import('../relay/src/server.mjs');
  const calls: string[] = [];
  const res = (headersSent: boolean) => ({
    headersSent,
    writeHead: (code: number) => (calls.push(`head:${code}`), { end: () => void calls.push('end') }),
    destroy: () => void calls.push('destroy'),
  });
  failRequest(res(false) as any);
  failRequest(res(true) as any);
  assert.deepEqual(calls, ['head:500', 'end', 'destroy']);

  const { mock } = await import('node:test');
  const { EventEmitter } = await import('node:events');
  const { installProcessGuards } = await import('../relay/src/processGuards.mjs');
  const proc = new EventEmitter();
  const err = mock.method(console, 'error', () => undefined);
  const exit = mock.method(process, 'exit', () => undefined as never);
  try {
    installProcessGuards({ proc: proc as any });
    proc.emit('uncaughtException', new Error('bug'));
    assert.deepEqual(
      exit.mock.calls.map((c) => c.arguments[0]),
      [1],
    );
    assert.match(String(err.mock.calls[0].arguments[0]), /"event":"uncaught_exception"/);
  } finally {
    err.mock.restore();
    exit.mock.restore();
  }
  // the defaults hook the real process: the listeners it adds are taken off again so the test runner keeps its own
  const names = ['unhandledRejection', 'uncaughtException'] as const;
  const had = names.map((n) => new Set(process.listeners(n)));
  installProcessGuards();
  names.forEach((n, i) => {
    const added = process.listeners(n).filter((l) => !had[i].has(l));
    assert.equal(added.length, 1, n);
    for (const l of added) process.off(n, l as any);
  });
});

test('a client that is refused and never closes its end does not hold a socket on the relay', async () => {
  const { loadConfig } = await import('../relay/src/config.mjs');
  const { createRelay } = await import('../relay/src/server.mjs');
  const relay = createRelay({
    config: loadConfig({ AUTH_PUBLIC_KEY: 'x', DATABASE_URL: 'postgres://unused' }),
    db: { query: async () => ({ rows: [] }) },
    verifier: { verify: async () => null, verifyRevocation: async () => null } as any,
    send: null,
  });
  const port = await relay.listen(0, '127.0.0.1');
  const open = () => new Promise<number>((resolve) => relay.server.getConnections((_e, n) => resolve(n)));
  let clients: net.Socket[] = [];
  try {
    const upgrade =
      'GET /v1/ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nAuthorization: Bearer abc\r\n\r\n';
    clients = await Promise.all(
      Array.from(
        { length: 20 },
        () =>
          new Promise<net.Socket>((resolve) => {
            const s = net.connect({ port, host: '127.0.0.1', allowHalfOpen: true }, () => (s.write(upgrade), resolve(s)));
            s.on('error', () => undefined);
            s.on('data', () => undefined);
          }),
      ),
    );
    await waitFor(async () => (await open()) === 0, 'refused clients to release their sockets').catch(() => {});
    assert.equal(await open(), 0, 'refused clients still hold sockets');
  } finally {
    for (const c of clients) c.destroy();
    await relay.close();
  }
});

test('a tick that throws is logged and the timer goes on; messageOf survives odd errors', async () => {
  const { loadConfig } = await import('../relay/src/config.mjs');
  const { createRelay } = await import('../relay/src/server.mjs');
  const { messageOf } = await import('../relay/src/processGuards.mjs');
  const logs: string[] = [];
  const relay = createRelay({
    config: loadConfig({ AUTH_PUBLIC_KEY: 'x', DATABASE_URL: 'postgres://unused', PING_SECONDS: '1' }),
    db: { query: async () => ({ rows: [] }) },
    verifier: { verify: async () => null, verifyRevocation: async () => null } as any,
    send: null,
    log: (_e, d: any) => void logs.push(d.message),
  });
  let ticks = 0;
  relay.hub.tick = () => {
    ticks++;
    throw new Error('tick broke');
  };
  await relay.listen(0, '127.0.0.1');
  try {
    await waitFor(() => ticks >= 2, 'two timer ticks').catch(() => {});
    assert.ok(ticks >= 2, 'the timer stopped after the first throw');
    assert.deepEqual(logs.slice(0, 2), ['tick broke', 'tick broke']);
  } finally {
    await relay.close();
  }
  assert.equal(messageOf(Object.create(null)), 'unprintable error');
  assert.equal(messageOf('x'.repeat(500)).length, 200);
});
