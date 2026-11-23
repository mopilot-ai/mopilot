// Installing an agent over the Host wire (host.install, host.installStatus, host.installCancel): the shared parsers and the `install` feature gate, the Host's dispatcher and server routing (paired clients only, no new install while the Host restarts), and the remote Host's three methods (A: two connections join one install, W: before hello, offline and an older Host, B: bad input, I: the Host's refusals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createProtocol, UnsupportedError } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
// @ts-ignore
import { startServer } from '../host/src/server.mjs';
// @ts-ignore
import { createPairing } from '../host/src/pairing.mjs';
// @ts-ignore
import { createPaths } from '../host/src/paths.mjs';
import { line } from './support/host-line.ts';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';
import { keySafe } from './support/hostKeySafe.ts';

const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');
const quiet = { report: () => undefined };
const METHODS = ['host.install', 'host.installStatus', 'host.installCancel'];
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** An installer that records what the Host asked of it. */
function fakeInstaller() {
  const seen: { call: string; arg: unknown }[] = [];
  return {
    seen,
    start: (p: any) => (
      seen.push({ call: 'start', arg: p }), { harness: p.harness, state: 'running', line: 'Installing Codex…', error: null }
    ),
    status: (h: string) => (seen.push({ call: 'status', arg: h }), null),
    cancel: (h: string) => (seen.push({ call: 'cancel', arg: h }), true),
  };
}

function protocolWith(t: { after: (fn: () => void) => void }, installer?: ReturnType<typeof fakeInstaller>) {
  const dir = tmp(t);
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), installer: installer as any });
  return { dir, protocol, conn: protocol.connection(() => undefined) };
}

test('B: the install parsers keep the agent and refuse anything else; each method needs the `install` feature of both ends', () => {
  for (const m of METHODS) {
    assert.deepEqual(S.parseParams(m, { harness: 'codex', extra: 1 }), { harness: 'codex' });
    assert.deepEqual(S.REQUIRES[m], ['install']);
    for (const harness of [undefined, '', 3, 'has space', '../x', 'x'.repeat(65)])
      assert.throws(
        () => S.parseParams(m, { harness }),
        (e: any) => e instanceof S.SchemaError && e.code === 'invalid' && e.message === 'Pick an agent to install.',
      );
  }
  assert.ok(S.FEATURES.includes('install'));
  assert.throws(
    () => S.requireFeatures('host.install', { features: ['epoch', 'dedupe'] }),
    (e: any) => e.code === 'feature_missing' && e.missing.includes('install'),
  );
});

test('W: the Host serves an install only after hello, and says so when it cannot install', async (t) => {
  const installer = fakeInstaller();
  const { conn } = protocolWith(t, installer);
  await assert.rejects(conn.call('host.install', { harness: 'codex' }), (e: any) => e.code === 'hello_required');
  assert.deepEqual(installer.seen, []);
  const none = protocolWith(t);
  await none.conn.call('host.hello', S.helloParams());
  for (const m of METHODS)
    await assert.rejects(
      none.conn.call(m, { harness: 'codex' }),
      (e: any) => e instanceof UnsupportedError && e.message === 'This host cannot install an agent.',
    );
});

test('A: two connections start the same install and read it; status and cancel go to the agent named', async (t) => {
  const installer = fakeInstaller();
  const { protocol } = protocolWith(t, installer);
  const a = protocol.connection(() => undefined);
  const b = protocol.connection(() => undefined);
  await a.call('host.hello', S.helloParams());
  await b.call('host.hello', S.helloParams());
  const [x, y] = await Promise.all([a.call('host.install', { harness: 'codex' }), b.call('host.install', { harness: 'codex' })]);
  assert.deepEqual([x.state, y.line], ['running', 'Installing Codex…']);
  assert.equal(await a.call('host.installStatus', { harness: 'codex' }), null);
  assert.equal(await b.call('host.installCancel', { harness: 'codex' }), true);
  assert.deepEqual(installer.seen, [
    { call: 'start', arg: { harness: 'codex' } },
    { call: 'start', arg: { harness: 'codex' } },
    { call: 'status', arg: 'codex' },
    { call: 'cancel', arg: 'codex' },
  ]);
  await assert.rejects(a.call('host.install', { harness: '../x' }), (e: any) => e.code === 'invalid');
  assert.equal(installer.seen.length, 4);
});

test('I: a served Host gives an install to a paired connection only, and starts none once it is restarting', async (t) => {
  const dir = tmp(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const installer = fakeInstaller();
  const { protocol } = protocolWith(t, installer);
  const updater = { restarting: false, request: () => 'ok' };
  const server = await startServer({ paths, runtime: { host: new EventEmitter() } as any, pairing, protocol, updater: updater as any });
  t.after(() => server.close());
  const first = line(paths.socketPath);
  t.after(first.close);
  for (const m of METHODS) {
    const r = await first.call(m, { harness: 'codex' });
    assert.deepEqual([r.error, r.code], ['This client is not paired with the Host.', 'unknown_client']);
  }
  assert.deepEqual(installer.seen, []);
  const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');
  await pairWith(first.request, loadIdentity(path.join(dir, 'app.json'), keySafe), pairing.issueCode());
  assert.ok((await first.call('host.hello', S.helloParams())).result.agreed);
  assert.equal((await first.call('host.install', { harness: 'codex' })).result.state, 'running');
  updater.restarting = true;
  assert.equal((await first.call('host.install', { harness: 'codex' })).error, 'The Host is restarting for an update.');
  assert.equal((await first.call('host.installCancel', { harness: 'codex' })).result, true, 'an install under way can still be cancelled');
  assert.equal((await first.call('host.installStatus', { harness: 'codex' })).result, null);
});

test('the remote Host starts, reads and cancels an install through the shared parsers', async (t) => {
  const w = hostWorld(t);
  w.net.handlers['host.hello'] = () => S.helloParams();
  const { host } = await onlineRemote(w);
  const seen: { method: string; params: any }[] = [];
  const answer = (method: string, result: unknown) => (w.net.handlers[method] = (params) => (seen.push({ method, params }), result));
  answer('host.install', { harness: 'codex', state: 'queued', line: 'Waiting…', error: null });
  answer('host.installStatus', null);
  answer('host.installCancel', false);
  assert.equal((await host.install({ harness: 'codex', junk: 1 })).state, 'queued');
  assert.equal(await host.installStatus({ harness: 'codex' }), null);
  assert.equal(await host.installCancel({ harness: 'codex' }), false);
  assert.deepEqual(seen, [
    { method: 'host.install', params: { harness: 'codex' } },
    { method: 'host.installStatus', params: { harness: 'codex' } },
    { method: 'host.installCancel', params: { harness: 'codex' } },
  ]);
  // input the schema refuses is never written
  const writes = w.net.last.written.length;
  await assert.rejects(host.install({ harness: '' }), (e: any) => e.code === 'invalid');
  assert.equal(w.net.last.written.length, writes);
});

test('W: an older Host without `install` is refused before anything is sent; offline is unreachable', async (t) => {
  const old = hostWorld(t);
  old.net.handlers['host.hello'] = () => ({ ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'install') });
  const { host } = await onlineRemote(old);
  const writes = old.net.last.written.length;
  await assert.rejects(host.install({ harness: 'codex' }), (e: any) => e.code === 'feature_missing' && e.missing.includes('install'));
  assert.equal(old.net.last.written.length, writes);
  const w = hostWorld(t);
  await assert.rejects(w.remote(w.tunnel()).install({ harness: 'codex' }), (e: any) => e.code === 'host_unreachable');
});
