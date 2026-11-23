// The relay path end to end (#2709), over real sockets: a real relay (relay/src/server.mjs on an in-process Postgres), the app's
// relay paths (electron/host/relayPaths.cjs, its host lane on the account token) and the Host's relay link (host/src/relayLink.mjs,
// on its own credential, through Node's WebSocket). The app enrolls the Host, reaches the Host's socket through a tunnel whose SSH
// path never comes up, measures the round trip, keeps a machine pinned to SSH off the relay, and a removed machine's credential is
// revoked: the Host is closed out and forgets it, and the relay keeps nothing of it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig } from '../relay/src/config.mjs';
import { createVerifier } from '../relay/src/auth.mjs';
import { createRelay } from '../relay/src/server.mjs';
import { createRelayLinks } from '../host/src/relayLink.mjs';
import { makeDb, makeKeys } from './support/relayKit.ts';

const require = createRequire(import.meta.url);
const { createRelayPaths } = require('../electron/host/relayPaths.cjs');

const keys = await makeKeys();
const { db, reset } = await makeDb();
const config = loadConfig({ AUTH_PUBLIC_KEY: keys.publicPem, DATABASE_URL: 'postgres://unused' });
const relay = createRelay({
  config,
  db: db as any,
  verifier: createVerifier({ ...config.auth, publicKeyPem: keys.publicPem }),
  send: null,
});
const port = await relay.listen(0, '127.0.0.1');
after(() => relay.close());

const safe = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`x${s}`),
  decryptString: (b: Buffer) => b.toString().slice(1),
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await wait();
  }
  throw new Error(`timed out: ${what}`);
}
/** An SSH tunnel that never comes up, as for a machine on another network. */
function deadSsh(dir: string) {
  const t = {
    localSocket: path.join(dir, 'ssh.sock'),
    state: 'offline' as const,
    reason: 'ssh: connect to host far-away port 22: Operation timed out',
    onState: () => () => undefined,
    acquire: () => ({ socketPath: t.localSocket, ready: new Promise<boolean>(() => undefined), release: () => undefined }),
    fail: () => undefined,
    close: () => undefined,
  };
  return { get: () => t, closeAll: () => undefined };
}

test('an app reaches a Host only through the relay, sees the round trip, and removing the machine revokes the Host', async (t) => {
  await reset();
  // sockets need a short path: the test runner's own temp folder is too deep for one
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/r2e-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // the Host's own socket: an echo, so what comes back went there and back
  const hostSock = path.join(dir, 'host.sock');
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(hostSock, r));
  t.after(() => echo.close());
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const links = createRelayLinks({ configDir: path.join(dir, 'host-config'), socketPath: hostSock });
  t.after(() => links.close());
  const paths = createRelayPaths({
    dir: path.join(dir, 'app'),
    url: () => url,
    getToken: () => keys.sign('u1', 'mac1'),
    safeStorage: safe,
  });
  t.after(() => paths.dispose());

  // enrollment rides the paired connection; here the Host's methods are called directly
  const call = async (method: string, params: any) => (method === 'host.relayEnroll' ? links.enroll(params) : links.forget(params));
  const { hostId } = await paths.enroll('far-away', call);
  assert.ok(paths.enrolled('far-away'));
  const stored = await db.query('SELECT host_id, owner_device_id FROM relay_hosts');
  assert.deepEqual(stored.rows, [{ host_id: hostId, owner_device_id: 'mac1' }]);
  const kept = fs.readFileSync(path.join(dir, 'app', 'host-relay.json'), 'utf8');
  assert.ok(!kept.includes(hostId), 'the app keeps its relay paths sealed');

  const pool = paths.pool(deadSsh(dir), path.join(dir, 'app'));
  const tunnel = pool.get({ destination: 'far-away', remoteSocket: '/x', sshArgs: [] });
  const lease = tunnel.acquire();
  assert.equal(await lease.ready, true);
  assert.equal(tunnel.path, 'relay');
  const socket = net.connect(lease.socketPath);
  const got: Buffer[] = [];
  socket.on('data', (d) => got.push(d as Buffer));
  const big = Buffer.alloc(3 * 1024 * 1024, 7);
  socket.write('hello through the relay ');
  socket.write(big);
  await until(() => Buffer.concat(got).length === 24 + big.length, 'the echo comes back whole');
  assert.equal(Buffer.concat(got).subarray(0, 24).toString(), 'hello through the relay ');
  await until(() => tunnel.latencyMs !== null, 'the round trip is measured');
  assert.equal(paths.view('far-away', tunnel).path, 'relay');
  socket.destroy();

  // pinned to SSH: the relay is not used, and the SSH failure is what it says
  paths.setMode('far-away', 'ssh');
  await until(() => tunnel.state === 'offline', 'off the relay');
  assert.match(tunnel.reason, /Operation timed out/);
  assert.equal(tunnel.path, null);
  paths.setMode('far-away', 'auto');
  await until(() => tunnel.state === 'online', 'back on the relay');
  lease.release();

  // removed: the relay revokes the credential and closes the Host, which forgets it
  assert.equal(await paths.forget('far-away', call), true);
  await until(() => links.status().links.length === 0, 'the Host forgets its enrollment');
  const left = await db.query('SELECT count(*) AS c FROM relay_hosts');
  assert.equal(Number(left.rows[0].c), 0);
  assert.deepEqual(paths.lane.pendingRevokes(), []);
  assert.equal(await paths.forget('far-away', call), false);
});

test('each new pair gets its own tunnel: re-enrolled, removed and added again, repaired after the relay dropped it; revoked, none', async (t) => {
  await reset();
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/r2p-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hostSock = path.join(dir, 'host.sock');
  const echo = net.createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(hostSock, r));
  t.after(() => echo.close());
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const links = createRelayLinks({ configDir: path.join(dir, 'host-config'), socketPath: hostSock });
  t.after(() => links.close());
  const paths = createRelayPaths({
    dir: path.join(dir, 'app'),
    url: () => url,
    getToken: () => keys.sign('u1', 'mac2'),
    safeStorage: safe,
  });
  t.after(() => paths.dispose());
  const call = async (method: string, params: any) => (method === 'host.relayEnroll' ? links.enroll(params) : links.forget(params));
  const pool = paths.pool(deadSsh(dir), path.join(dir, 'app'));
  const target = { destination: 'far', remoteSocket: '/x', sshArgs: [] };
  /** One round trip through the machine's tunnel: what comes back is what went. */
  const roundTrip = async (what: string) => {
    const lease = pool.get(target).acquire();
    try {
      assert.equal(await Promise.race([lease.ready, wait(8000).then(() => false)]), true, `${what}: the tunnel comes up`);
      const socket = net.connect(lease.socketPath);
      const got: Buffer[] = [];
      socket.on('data', (d) => got.push(d as Buffer));
      socket.write(what);
      await until(() => Buffer.concat(got).toString() === what, `${what} comes back`);
      socket.destroy();
    } finally {
      lease.release();
    }
  };
  await paths.enroll('far', call);
  await roundTrip('first pair');
  // enrolled again (a rotation or a repair over SSH): the old tunnel's pair is gone, the new one carries it
  await paths.enroll('far', call);
  await roundTrip('enrolled again');
  // removed and added again
  await paths.forget('far', call);
  await paths.enroll('far', call);
  await roundTrip('added again');
  // the relay drops the pair (here: another device of the account revokes it): the path goes, and the next enrollment works
  const hostId = (await db.query('SELECT host_id FROM relay_hosts')).rows[0].host_id;
  const WebSocket = (await import('ws')).default;
  const other = new WebSocket(`ws://127.0.0.1:${port}/v1/ws?as=hostlink`, {
    headers: { authorization: `Bearer ${await keys.sign('u1', 'mac3')}` },
  });
  await new Promise((r) => other.once('open', r));
  other.send(JSON.stringify({ t: 'host.revoke', host: hostId, rid: 'x' }));
  await until(() => !paths.enrolled('far'), 'the path is dropped');
  other.close();
  await paths.enroll('far', call);
  await roundTrip('repaired');
  // revoked: no relay path, and the tunnel says why
  await paths.forget('far', call);
  const lease = pool.get(target).acquire();
  await wait(50);
  assert.equal(pool.get(target).state, 'offline');
  lease.release();
});
