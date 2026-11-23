// Model relay listener attempts retain ownership across startup, stop, failure and replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { admitAll } from './support/relayPeer.ts';
import { tick } from './support/async-scenarios.ts';
const { Relay } = createRequire(import.meta.url)('../electron/identity/accounts/relay.cjs');
class Server extends EventEmitter {
  closed = false;
  ready = () => {};
  port: number;
  constructor(port: number) {
    super();
    this.port = port;
  }
  listen(_port: number, _host: string, callback: () => void) {
    this.ready = callback;
  }
  address() {
    return { port: this.port };
  }
  close() {
    this.closed = true;
  }
}
function world(t: any) {
  const servers: Server[] = [];
  t.mock.method(http, 'createServer', () => {
    const server = new Server(41000 + servers.length);
    servers.push(server);
    return server;
  });
  const relay = new Relay({}, admitAll);
  t.after(() => relay.stop());
  return { relay, servers };
}

test('concurrent starts share a single listening attempt and retain its ready endpoint', async (t) => {
  const { relay, servers } = world(t);
  const first = relay.start();
  const second = relay.start();
  for (const server of servers) server.ready();
  assert.equal(await first, await second);
  assert.equal(servers.length, 1);
  assert.equal(await relay.start(), relay.base);
  assert.equal(servers.length, 1);
});

test('stop settles pending startup before a late callback and cannot publish stale URLs', async (t) => {
  const { relay, servers } = world(t);
  let settled = false;
  const starting = relay
    .start()
    .then(
      () => 'ready',
      () => 'stopped',
    )
    .finally(() => {
      settled = true;
    });
  relay.stop();
  await tick();
  const stoppedBeforeCallback = settled;
  servers[0].ready();
  await starting;
  assert.equal(stoppedBeforeCallback, true);
  assert.equal(relay.base, null);
  assert.equal(relay.realtimeBase, null);
  assert.equal(relay.realtimeSidebandBase, null);
});

test('a stopped callback cannot overwrite a newer ready listener', async (t) => {
  const { relay, servers } = world(t);
  const first = relay.start().then(
    () => 'ready',
    () => 'stopped',
  );
  relay.stop();
  const second = relay.start();
  servers[1].ready();
  const base = await second;
  servers[0].ready();
  assert.equal(await first, 'stopped');
  assert.equal(relay.base, base);
  assert.equal(relay.server, servers[1]);
  assert.equal(servers[1].closed, false);
});

test('stop closes accepted connections and clears every published endpoint', async (t) => {
  const { relay, servers } = world(t);
  const starting = relay.start();
  servers[0].ready();
  await starting;
  let destroyed = false;
  servers[0].emit('connection', {
    destroy: () => {
      destroyed = true;
    },
    on: () => {},
  });
  relay.stop();
  assert.equal(destroyed, true);
  assert.equal(relay.base, null);
  assert.equal(relay.realtimeBase, null);
  assert.equal(relay.realtimeSidebandBase, null);
});

test('a failed bind retires its attempt and permits a clean retry', async (t) => {
  const { relay, servers } = world(t);
  const first = relay.start();
  const rejected = assert.rejects(first, /bind denied/);
  servers[0].emit('error', new Error('bind denied'));
  await rejected;
  assert.equal(servers[0].closed, true);
  assert.equal(relay.server, null);
  const second = relay.start();
  servers[1].ready();
  await second;
  assert.equal(relay.server, servers[1]);
  assert.doesNotThrow(() => servers[0].emit('error', new Error('late error')));
});

test('stop after bind but before publication rejects the old result and destroys late connections', async (t) => {
  const { relay, servers } = world(t);
  const first = relay.start();
  const rejected = assert.rejects(first, /stopped/);
  servers[0].ready();
  relay.stop();
  const second = relay.start();
  let destroyed = false;
  servers[0].emit('connection', {
    destroy: () => {
      destroyed = true;
    },
  });
  servers[1].ready();
  await rejected;
  assert.equal(destroyed, true);
  assert.equal(await second, relay.base);
  assert.equal(relay.server, servers[1]);
});
