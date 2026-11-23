// Browser channel startup owns its listener through failure, stop and replacement without touching another attempt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import http from 'node:http';

const require = createRequire(import.meta.url);
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');
const { listenLoopback } = require('../electron/platform/listenLoopback.cjs');

class Server extends EventEmitter {
  closed = false;
  callback = () => {};
  listen(_port: number, _host: string, callback: () => void) {
    this.callback = callback;
  }
  address() {
    return { port: 41000 };
  }
  close() {
    this.closed = true;
  }
}
const pairing = () => ({ get: () => null, forPort: () => {}, markPaired: () => {} });

test('a pairing failure closes the listening server before the next startup', async (t) => {
  const servers: Server[] = [];
  let broken = true;
  const ch = new ChromeExtensionChannel({
    openPage: () => {},
    port: 0,
    pairing: {
      ...pairing(),
      forPort: () => {
        if (broken) throw new Error('disk denied');
      },
    },
    createServer: () => {
      const s = new Server();
      servers.push(s);
      return s;
    },
  });
  t.after(() => {
    ch.stop();
    for (const s of servers) s.close();
  });
  const first = ch.start();
  servers[0].callback();
  await assert.rejects(first, /disk denied/);
  assert.equal(servers[0].closed, true);
  assert.equal(ch.extServer, null);
  broken = false;
  const second = ch.start();
  servers[1].callback();
  assert.equal(await second, 41000);
  assert.equal(ch.extServer, servers[1]);
});

for (const extension of [false, true]) {
  test(`${extension ? 'extension' : 'relay'}: stopping after startup resolves prevents a stale connection page`, async (t) => {
    const server = new Server();
    let opened = 0;
    const options = {
      openPage: () => {
        opened++;
      },
      pairing: pairing(),
      port: 0,
      createServer: () => server,
    };
    const ch = extension ? new ChromeExtensionChannel(options) : new ChromeRelay(options);
    t.after(() => ch.stop());
    const starting = ch.connect('chat');
    const rejected = assert.rejects(starting, /closed/);
    server.callback();
    await Promise.resolve();
    ch.stop();
    await rejected;
    assert.equal(opened, 0);
  });
  test(`${extension ? 'extension' : 'relay'}: even cleanup failure retires the failed startup before retry`, async (t) => {
    const servers: Server[] = [];
    const options = {
      openPage: () => {},
      pairing: pairing(),
      port: 0,
      createServer: () => {
        const s = new Server();
        servers.push(s);
        return s;
      },
    };
    const ch = extension ? new ChromeExtensionChannel(options) : new ChromeRelay(options);
    t.after(() => ch.stop());
    const first = extension ? ch.start() : ch.connect('first');
    const failed = assert.rejects(first, /close failed/);
    servers[0].close = () => {
      throw new Error('close failed');
    };
    // The extension retries a refused preferred port before giving up.
    servers[0].emit('error', new Error('listen failed'));
    await Promise.resolve();
    if (extension) servers[0].emit('error', new Error('listen failed again'));
    await failed;
    assert.equal(extension ? ch.serveAbort : ch.listenAbort, null);
    const second = extension ? ch.start() : ch.connect('second');
    const stopped = assert.rejects(second, /stopped/);
    ch.stop();
    await stopped;
    assert.equal(servers[1].closed, true);
  });
  test(`${extension ? 'extension' : 'relay'}: a stop after listening prevents startup from publishing`, async (t) => {
    const server = new Server();
    let published = 0;
    const options = {
      openPage: () => {
        published++;
      },
      pairing: {
        ...pairing(),
        forPort: () => {
          published++;
        },
      },
      port: 0,
      createServer: () => server,
    };
    const ch = extension ? new ChromeExtensionChannel(options) : new ChromeRelay(options);
    t.after(() => ch.stop());
    const starting = extension ? ch.start() : ch.connect('chat');
    const rejected = assert.rejects(starting, /stopped/);
    server.callback();
    ch.stop();
    await rejected;
    assert.equal(published, 0);
    assert.equal(server.closed, true);
  });
  test(`${extension ? 'extension' : 'relay'}: stop cancels startup and its late callback cannot replace the new server`, async (t) => {
    const servers: Server[] = [];
    const options = {
      openPage: () => {},
      pairing: pairing(),
      port: 0,
      createServer: () => {
        const s = new Server();
        servers.push(s);
        return s;
      },
    };
    const ch = extension ? new ChromeExtensionChannel(options) : new ChromeRelay(options);
    t.after(() => ch.stop());
    const start = (id: string) => (extension ? ch.start() : ch.connect(id));
    const first = start('first');
    const rejected = assert.rejects(first, /stopped|closed/);
    ch.stop();
    const second = start('second');
    const secondRejected = assert.rejects(second);
    await rejected;
    servers[0].callback();
    assert.equal(extension ? ch.extServer : ch.server, servers[1]);
    assert.equal(servers[1].closed, false);
    ch.stop();
    await secondRejected;
    assert.equal(servers[1].closed, true);
  });
}

test('listenLoopback settles pre-cancelled and synchronously failing attempts and detaches listeners', async () => {
  const abort = new AbortController();
  const server = new Server();
  abort.abort();
  await assert.rejects(listenLoopback(server, 0, abort.signal), /stopped/);
  assert.equal(server.listenerCount('error'), 1, 'only the server lifetime observer remains');
  const active = new AbortController();
  server.listen = () => {
    throw new Error('listen denied');
  };
  await assert.rejects(listenLoopback(server, 0, active.signal), /listen denied/);
  assert.equal(server.listenerCount('error'), 1);
  active.abort();
});

test('a late captured error callback cannot change an already successful listen result', async () => {
  const server = new Server();
  const starting = listenLoopback(server, 0, new AbortController().signal);
  const failed = server.listeners('error').at(-1)!;
  server.callback();
  failed(new Error('late error'));
  assert.equal(await starting, 41000);
  assert.equal(server.listenerCount('error'), 1);
});

for (const extension of [false, true]) {
  test(`${extension ? 'extension' : 'relay'}: a retired server drains an actual queued bind error without touching the retry`, async (t) => {
    const servers: Server[] = [];
    const options = {
      openPage: () => {},
      pairing: pairing(),
      port: 0,
      createServer: () => {
        const server = new Server();
        servers.push(server);
        return server;
      },
    };
    const ch = extension ? new ChromeExtensionChannel(options) : new ChromeRelay(options);
    t.after(() => ch.stop());
    const first = extension ? ch.start() : ch.connect('first');
    const rejected = assert.rejects(first, /stopped/);
    ch.stop();
    const second = extension ? ch.start() : ch.connect('second');
    const secondRejected = assert.rejects(second, /stopped/);
    await rejected;
    assert.doesNotThrow(() => servers[0].emit('error', new Error('late bind failure')));
    assert.equal(extension ? ch.extServer : ch.server, servers[1]);
    assert.equal(servers[0].listenerCount('error'), 1);
    ch.stop();
    await secondRejected;
  });
}

test('a real occupied-port bind error remains handled when listening is cancelled immediately', async (t) => {
  const occupied = http.createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => occupied.close());
  const server = http.createServer();
  t.after(() => server.close());
  const abort = new AbortController();
  const pending = listenLoopback(server, (occupied.address() as import('node:net').AddressInfo).port, abort.signal);
  const rejected = assert.rejects(pending, /stopped/);
  abort.abort();
  server.close();
  await rejected;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(server.listening, false);
});
