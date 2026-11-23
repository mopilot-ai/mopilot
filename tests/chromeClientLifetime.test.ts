// Connection retirement fences delayed pairing, handshake completion and retries, including real loopback fixture teardown.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { test } from 'node:test';
import { deferred, controlledReads } from './support/async-scenarios.ts';
import { client, FakeWs, handshake, tick, webcrypto, SECRET } from './support/extension-background/fixture.ts';
import { extensionWorld, loopbackWebSocket } from './support/chrome-extension-kit.ts';
import { rawConnect, until } from './support/chrome-relay-kit.ts';

for (const replacementFirst of [false, true]) {
  test(`reset retires delayed pairing with replacement first=${replacementFirst}`, async () => {
    const w = client();
    const reads = controlledReads<any>();
    w.c.o.pairing = reads.read;
    const old = w.c.connect();
    const current = w.c.reset();
    if (replacementFirst) {
      reads.requests[1].resolve(null);
      await current;
    }
    reads.requests[0].resolve({ port: 1234, secret: 'old' });
    await old;
    assert.equal(FakeWs.all.length, 0, 'retired pairing cannot create a socket');
    if (!replacementFirst) {
      reads.requests[1].resolve(null);
      await current;
    }
    assert.equal(w.c.status, 'unpaired');
    w.setPairing({ port: 4321, secret: 'current' });
    w.c.o.pairing = async () => ({ port: 4321, secret: 'current' });
    await w.c.connect();
    assert.match(FakeWs.all[0].url, /:4321\//);
  });
}

test('reset retires an older readiness wait while the current connection can start', async () => {
  const w = client();
  const ready = deferred<void>();
  w.c.o.ready = ready.promise;
  let reads = 0;
  w.c.o.pairing = async () => {
    reads++;
    return { port: 1234, secret: SECRET };
  };
  const old = w.c.connect();
  const current = w.c.reset();
  ready.resolve();
  await Promise.all([old, current]);
  assert.equal(reads, 1, 'retired readiness must not begin another pairing read');
  assert.equal(FakeWs.all.length, 1);
  await handshake(FakeWs.all[0]);
  assert.equal(w.c.status, 'connected');
});

test('an old close and pending pairing cannot disturb a replacement or its successful retry', async () => {
  const w = client();
  const reads = controlledReads<any>();
  w.c.o.pairing = reads.read;
  const first = w.c.connect();
  const duplicate = w.c.connect();
  reads.requests[0].resolve({ port: 1234, secret: SECRET });
  await first;
  const closed = FakeWs.all[0].onclose;
  closed();
  const replacement = w.c.connect();
  reads.requests[1].resolve({ port: 5678, secret: 'obsolete' });
  await duplicate;
  assert.equal(FakeWs.all.length, 1);
  reads.requests[2].resolve({ port: 4321, secret: SECRET });
  await replacement;
  closed();
  assert.equal(w.c.ws, FakeWs.all[1]);
  await handshake(FakeWs.all[1]);
  assert.equal(w.c.status, 'connected');
  assert.equal(w.timers.timeouts.length, 0);
  assert.equal(w.timers.intervals.length, 1);
});

test('a rejected obsolete pairing read leaves the current unpaired status intact', async () => {
  const w = client();
  const oldRead = deferred<any>();
  w.c.o.pairing = () => oldRead.promise;
  const old = assert.rejects(w.c.connect(), /obsolete/);
  w.c.o.pairing = async () => null;
  await w.c.reset();
  oldRead.reject(new Error('obsolete'));
  await old;
  assert.equal(w.c.status, 'unpaired');
  assert.equal(FakeWs.all.length, 0);
});

for (const boundary of ['ready', 'pairing']) {
  for (const rejects of [false, true]) {
    test(`dispose retires pending ${boundary} ${rejects ? 'rejection' : 'success'}`, async () => {
      const w = client();
      const wait = deferred<any>();
      if (boundary === 'ready') w.c.o.ready = wait.promise;
      else w.c.o.pairing = () => wait.promise;
      const pending = w.c.connect();
      const result = rejects ? assert.rejects(pending, /old read/) : pending;
      w.c.dispose();
      if (rejects) wait.reject(new Error('old read'));
      else wait.resolve({ port: 1234, secret: 'old' });
      await result;
      assert.equal(FakeWs.all.length, 0);
      assert.equal(w.c.status, 'offline');
      await w.c.connect();
      await w.c.reset();
      w.c.dispose();
      assert.equal(FakeWs.all.length, 0, 'disposed clients never restart');
      assert.equal(w.timers.timeouts.length, 0);
    });
  }
}

test('dispose closes authenticated ownership once and retires captured socket callbacks and retry', async () => {
  const w = client();
  await w.c.connect();
  const ws = FakeWs.all[0];
  await handshake(ws);
  const closed = ws.onclose;
  const receive = ws.onmessage;
  assert.equal(w.timers.intervals.length, 1);
  await w.c.dispose();
  w.c.dispose();
  closed();
  await receive({ data: JSON.stringify({ chat: 'late' }) });
  assert.equal(ws.closed, 1);
  assert.equal(w.sess.peerGone.mock.callCount(), 1);
  assert.equal(w.handled.length, 0);
  assert.equal(w.c.ws, null);
  assert.equal(w.c.authed, false);
  assert.equal(w.c.status, 'offline');
  assert.equal(w.timers.intervals.length, 0);
  assert.equal(w.timers.timeouts.length, 0);
});

test('a retry queued before dispose cannot reconnect after its timer was cleared', async () => {
  const w = client();
  await w.c.connect();
  FakeWs.all[0].onclose();
  const retry = w.timers.timeouts[0].f;
  w.c.dispose();
  retry();
  await tick();
  assert.equal(FakeWs.all.length, 1);
  assert.equal(w.c.retryTimer, null);
  assert.equal(w.timers.timeouts.length, 0);
});

test('a retry queued before reset cannot clear the replacement retry owner', async () => {
  const w = client();
  await w.c.connect();
  FakeWs.all[0].onclose();
  const retired = w.timers.timeouts[0].f;
  await w.c.reset();
  FakeWs.all[1].onclose();
  const current = w.c.retryTimer;
  retired();
  await tick();
  assert.equal(w.c.retryTimer, current);
  assert.equal(FakeWs.all.length, 2);
  assert.equal(w.timers.timeouts.length, 1);
});

test('replaced retries within one generation retain their own timer identity', async () => {
  const w = client({
    WebSocket: class {
      constructor() {
        throw new Error('not available');
      }
    },
  });
  await w.c.connect();
  const retired = w.timers.timeouts[0].f;
  await w.c.connect();
  const current = w.c.retryTimer;
  retired();
  assert.equal(w.c.retryTimer, current);
  assert.equal(w.timers.timeouts.length, 1);
  w.c.o.WebSocket = FakeWs;
  w.timers.timeouts[0].f();
  await tick();
  assert.equal(FakeWs.all.length, 1, 'current retry still creates the replacement transport');
  assert.equal(w.c.status, 'connecting');
});

for (const boundary of ['ready', 'pairing']) {
  test(`current ${boundary} rejection still reaches its caller`, async () => {
    const w = client();
    const failed = deferred<any>();
    if (boundary === 'ready') w.c.o.ready = failed.promise;
    else w.c.o.pairing = () => failed.promise;
    const result = assert.rejects(w.c.connect(), /current failure/);
    failed.reject(new Error('current failure'));
    await result;
    assert.equal(w.c.status, 'offline');
    assert.equal(FakeWs.all.length, 0);
  });
}

test('a synchronous session-cleanup failure is reported after transport and timer retirement', async () => {
  const logged: any[] = [];
  const w = client({ log: (...args: any[]) => logged.push(args) });
  await w.c.connect();
  await handshake(FakeWs.all[0]);
  w.sess.peerGone = () => {
    throw new Error('cleanup failed');
  };
  w.c.dispose();
  await tick();
  assert.equal(FakeWs.all[0].closed, 1);
  assert.equal(w.c.status, 'offline');
  assert.equal(w.timers.intervals.length, 0);
  assert.equal(logged[0][0], 'let go of the tabs');
  assert.equal(logged[0][1].message, 'cleanup failed');
});

test('abrupt worker disposal retires transport while preserving native sessions for restoration', async () => {
  const w = client();
  await w.c.connect();
  await handshake(FakeWs.all[0]);
  w.c.dispose({ releaseSessions: false });
  w.c.dispose();
  assert.equal(w.sess.peerGone.mock.callCount(), 0);
  assert.equal(w.c.ws, null);
  assert.equal(w.c.status, 'offline');
  assert.equal(w.timers.intervals.length, 0);
  assert.equal(FakeWs.all[0].closed, 1);
});

test('synchronous disposal on connected status leaves no keepalive behind', async () => {
  const w = client();
  w.c.o.onStatus = (status: string) => {
    if (status === 'connected') w.c.dispose();
  };
  await w.c.connect();
  await handshake(FakeWs.all[0]);
  assert.equal(w.c.status, 'offline');
  assert.equal(w.c.pinger, null);
  assert.equal(w.timers.intervals.length, 0);
  assert.equal(w.sess.peerGone.mock.callCount(), 1);
});

for (const source of ['closed', 'constructor failure']) {
  for (const reaction of ['dispose', 'reset']) {
    test(`${source}: synchronous ${reaction} on offline status retires the old retry`, async () => {
      const w = client();
      if (source === 'closed') await w.c.connect();
      else {
        w.c.status = 'unauthorized';
        w.c.o.WebSocket = class {
          constructor() {
            throw new Error('transport failed');
          }
        };
      }
      w.c.o.onStatus = (status: string) => {
        if (status !== 'offline') return;
        w.c.o.WebSocket = FakeWs;
        if (reaction === 'dispose') w.c.dispose();
        else void w.c.reset();
      };
      if (source === 'closed') FakeWs.all[0].onclose();
      else await w.c.connect();
      await tick();
      assert.equal(w.timers.timeouts.length, 0, 'retired close/failure cannot create a retry');
      assert.equal(w.c.retryTimer, null);
      assert.equal(w.c.status, reaction === 'dispose' ? 'offline' : 'connecting');
      assert.equal(w.c.ws, reaction === 'dispose' ? null : FakeWs.all.at(-1));
    });
  }
}

test('real fixture stop retires welcome verification before it can create a keepalive', async (t) => {
  const w = await extensionWorld({ paired: false });
  const entered = deferred<void>();
  const release = deferred<void>();
  const completed = deferred<void>();
  let signs = 0;
  w.client.o.crypto = {
    getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => webcrypto.getRandomValues(bytes),
    subtle: {
      importKey: (...args: any[]) => (webcrypto.subtle.importKey as any)(...args),
      sign: async (...args: any[]) => {
        if (++signs === 2) {
          entered.resolve();
          await release.promise;
          const signed = await (webcrypto.subtle.sign as any)(...args);
          completed.resolve();
          return signed;
        }
        return (webcrypto.subtle.sign as any)(...args);
      },
    },
  };
  t.after(() => {
    // Also clean up the original failing implementation without retaining its leaked real interval.
    release.resolve();
    w.stop();
    w.client.ws = null;
    clearInterval(w.client.pinger);
  });
  w.setCode(`mopilot-chrome:1:${w.port}:${w.pairing.get().secret}`);
  w.pairing.markPaired();
  await w.connectExtension();
  await entered.promise;
  w.channel.peer.close(1000, 'bye');
  w.stop();
  release.resolve();
  await completed.promise;
  await tick();
  assert.equal(w.client.pinger, null, 'late welcome must not start a referenced interval after stop');
  assert.equal(w.client.authed, false);
  assert.equal(w.client.ws, null);
});

test('fixture socket closed during HTTP upgrade cannot reopen when that upgrade finishes', async (t) => {
  const upgraded = deferred<Duplex>();
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    socket.on('error', () => undefined);
    socket.on('end', () => socket.end());
    socket.resume();
    upgraded.resolve(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const { LoopbackWebSocket } = loopbackWebSocket();
  const ws = new LoopbackWebSocket(`ws://127.0.0.1:${port}/`);
  const socket = await upgraded.promise;
  t.after(() => {
    ws.sock?.destroy();
    socket.destroy();
    server.close();
  });
  ws.close();
  ws.close();
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  await until(() => ws.readyState === 3 || ws.sock !== null);
  assert.equal(ws.readyState, 3, 'a late upgrade is retired rather than reopened');
});

test('fixture close cancels a silent HTTP upgrade without retaining either transport', async (t) => {
  const upgraded = deferred<Duplex>();
  const server = http.createServer();
  server.on('upgrade', (_request, socket) => {
    socket.on('error', () => undefined);
    socket.on('end', () => socket.end());
    socket.resume();
    upgraded.resolve(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const { LoopbackWebSocket } = loopbackWebSocket();
  const ws = new LoopbackWebSocket(`ws://127.0.0.1:${port}/`);
  const socket = await upgraded.promise;
  t.after(() => {
    ws.sock?.destroy();
    socket.destroy();
    server.close();
  });
  let closed = 0;
  ws.onclose = () => closed++;
  ws.close();
  await until(() => ws.readyState === 3 && socket.destroyed);
  assert.equal(ws.readyState, 3, 'close does not wait for the HTTP peer to answer');
  assert.equal(socket.destroyed, true, 'the pending raw transport is cancelled');
  assert.equal(closed, 1);
});

test('a refused upgrade retires its HTTP response even when the peer never ends its body', async (t) => {
  const received = deferred<Socket>();
  const server = http.createServer((request, response) => {
    received.resolve(request.socket);
    response.writeHead(403);
    response.write('refused');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  const refused = assert.rejects(rawConnect(`ws://127.0.0.1:${port}/`), { status: 403 });
  const socket = await received.promise;
  t.after(() => {
    socket.destroy();
    server.close();
  });
  await refused;
  await until(() => socket.destroyed);
});
