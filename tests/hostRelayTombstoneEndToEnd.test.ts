// #5747 end to end over a real relay (relay/src/server.mjs, unchanged, on an in-process Postgres): B removes the controller that paired by code, so its relay link becomes a tombstone; A's next connection through the relay hears `unknown_client` marked `linkRemoved` and never reaches B's socket; A revokes its own pair (the relay's `host.revoke` on A's lane, the pair being A's), the relay closes B's link, B forgets the tombstone and records it, nothing is left on the relay, and A's machine stays marked removed until A removes it too.
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
const noSsh = (dir: string) => {
  const t = {
    localSocket: path.join(dir, 'ssh.sock'),
    state: 'offline' as const,
    reason: 'no ssh',
    onState: () => () => undefined,
    acquire: () => ({ socketPath: t.localSocket, ready: new Promise<boolean>(() => undefined), release: () => undefined }),
    fail: () => undefined,
    close: () => undefined,
  };
  return { get: () => t, closeAll: () => undefined };
};

test('a controller removed on B: A hears it was removed, revokes its own pair, B forgets the tombstone, and the relay keeps nothing', async (t) => {
  await reset();
  const dir = fs.realpathSync(fs.mkdtempSync('/tmp/r2t-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // B's own socket: a tombstone must never reach it
  const hostSock = path.join(dir, 'host.sock');
  let reached = 0;
  const hostSocket = net.createServer((s) => (reached++, s.pipe(s)));
  await new Promise<void>((r) => hostSocket.listen(hostSock, r));
  t.after(() => hostSocket.close());
  const url = `ws://127.0.0.1:${port}/v1/ws`;
  const links = createRelayLinks({ configDir: path.join(dir, 'b-config'), socketPath: hostSock });
  const told: any[] = [];
  links.onTombstone((e) => told.push(e));
  t.after(() => links.close());
  const paths = createRelayPaths({ dir: path.join(dir, 'a'), url: () => url, getToken: () => keys.sign('u1', 'macA'), safeStorage: safe });
  t.after(() => paths.dispose());
  const machine = 'relay:b';
  const call = async (method: string, params: any) =>
    method === 'host.relayEnroll' ? links.enroll(params, { createOnly: true }) : links.forget(params);
  const { hostId } = await paths.enroll(machine, call);

  // B removes the controller: its link is a tombstone now
  assert.deepEqual(links.retire({ hostId }), { retired: true });
  const tunnel = paths.pool(noSsh(dir), path.join(dir, 'a')).get({ destination: machine, remoteSocket: '/x', sshArgs: [] });
  const lease = tunnel.acquire();
  assert.equal(await lease.ready, true, 'A still reaches B through the relay, and hears the refusal there');
  const socket = net.connect(lease.socketPath);
  let text = '';
  socket.on('data', (d) => (text += d));
  socket.write(`${JSON.stringify({ id: 1, method: 'host.challenge' })}\n${JSON.stringify({ id: 2, method: 'host.auth', params: {} })}\n`);
  await until(() => text.split('\n').length > 2, 'both answers');
  const answers = text
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  for (const a of answers) {
    assert.equal(a.code, 'unknown_client');
    assert.deepEqual(a.details, { linkRemoved: true });
  }
  assert.equal(reached, 0, 'B’s socket was never reached');
  socket.destroy();
  lease.release();

  // A removes its own pair: the relay closes B's link, which forgets the tombstone
  assert.equal(await paths.peerRemoved(machine), true);
  assert.equal(paths.enrolled(machine), false);
  assert.equal(paths.removedByPeer(machine), true);
  await until(() => links.status().links.length === 0, 'B forgets the tombstone');
  assert.deepEqual(told, [
    { kind: 'link.retired', outcome: 'kept' },
    { kind: 'link.forgotten', outcome: 'revoked' },
  ]);
  const left = await db.query('SELECT (SELECT count(*) FROM relay_hosts) AS h, (SELECT count(*) FROM relay_pairs) AS p');
  assert.deepEqual([Number(left.rows[0].h), Number(left.rows[0].p)], [0, 0], 'no stale pair on the relay');
  assert.deepEqual(paths.lane.pendingRevokes(), []);
  assert.equal(await paths.peerRemoved(machine), false, 'once is enough');

  // the mark lasts until A removes the machine (a restart keeps it), and goes with it
  const again = createRelayPaths({ dir: path.join(dir, 'a'), url: () => url, getToken: () => keys.sign('u1', 'macA'), safeStorage: safe });
  t.after(() => again.dispose());
  assert.equal(again.removedByPeer(machine), true);
  assert.equal(await again.forget(machine), false);
  assert.equal(again.removedByPeer(machine), false);
  assert.equal(await again.forget(machine), false, 'nothing left to forget');
});
