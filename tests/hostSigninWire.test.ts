// Sign-in over the Host wire (host.login, host.loginStatus, host.loginCancel): the shared parsers, the Host's dispatcher and server routing (paired clients only, no new sign-in while the Host restarts), and the remote Host's three methods plus its status read (A: joining one sign-in, W: before hello and offline, B: bad input, I: the Host's refusals).
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
const tmp = (t: { after: (fn: () => void) => void }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-signin-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A login service that records what the Host asked of it. */
function fakeLogin() {
  const seen: { call: string; arg: unknown }[] = [];
  return {
    seen,
    start: (p: unknown) => (
      seen.push({ call: 'start', arg: p }),
      { harness: (p as any).harness, state: 'waiting', links: ['https://x.test/a'], codes: ['ABCD-1234'], error: null }
    ),
    status: (h: string) => (seen.push({ call: 'status', arg: h }), null),
    cancel: (h: string) => (seen.push({ call: 'cancel', arg: h }), true),
    input: (h: string, text: string) => (seen.push({ call: 'input', arg: [h, text] }), true),
  };
}

function protocolWith(t: { after: (fn: () => void) => void }, login?: ReturnType<typeof fakeLogin>) {
  const service: any = login;
  const dir = tmp(t);
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }), send: async () => ({ turnId: 't' }) };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const protocol = createProtocol({ runtime, epochs, guard, status: () => ({ running: true }), login: service });
  return { dir, runtime, protocol, conn: protocol.connection(() => undefined) };
}

test('B: the sign-in parsers keep a harness and an optional method and refuse anything else', () => {
  assert.deepEqual(S.parseParams('host.login', { harness: 'gemini', methodId: 'oauth', extra: 1 }), {
    harness: 'gemini',
    methodId: 'oauth',
  });
  assert.deepEqual(S.parseParams('host.login', { harness: 'acp:qwen', methodId: null }), { harness: 'acp:qwen' });
  assert.deepEqual(S.parseParams('host.loginStatus', { harness: 'claude' }), { harness: 'claude' });
  assert.deepEqual(S.parseParams('host.loginCancel', { harness: 'a.b-c_d:e' }), { harness: 'a.b-c_d:e' });
  assert.deepEqual(S.parseParams('host.loginInput', { harness: 'claude', text: 'abc#123', extra: 1 }), {
    harness: 'claude',
    text: 'abc#123',
  });
  const bad = (m: string, p: unknown) =>
    assert.throws(
      () => S.parseParams(m, p),
      (e: any) => e instanceof S.SchemaError && e.code === 'invalid',
    );
  for (const m of ['host.login', 'host.loginStatus', 'host.loginCancel']) {
    for (const harness of [undefined, '', 3, 'has space', '../x', 'x'.repeat(65)]) bad(m, { harness });
  }
  for (const text of [undefined, '', '  ', 3, 'x'.repeat(2049)]) bad('host.loginInput', { harness: 'claude', text });
  bad('host.loginInput', { harness: '../x', text: 'abc' });
  for (const methodId of [3, '', 'a b', 'x'.repeat(129)]) bad('host.login', { harness: 'gemini', methodId });
  assert.equal(S.REQUIRES['host.login'], undefined, 'a sign-in names no chat, so it needs no epoch or key');
});

test('W: the Host serves a sign-in only after hello, and says so when it has none to give', async (t) => {
  const login = fakeLogin();
  const { conn } = protocolWith(t, login);
  await assert.rejects(conn.call('host.login', { harness: 'gemini' }), (e: any) => e.code === 'hello_required');
  assert.deepEqual(login.seen, []);
  await conn.call('host.hello', S.helloParams());
  const none = protocolWith(t);
  await none.conn.call('host.hello', S.helloParams());
  for (const m of ['host.login', 'host.loginStatus', 'host.loginCancel', 'host.loginInput'])
    await assert.rejects(
      none.conn.call(m, { harness: 'gemini', text: 'x' }),
      (e: any) => e instanceof UnsupportedError && e.code === 'unsupported',
    );
});

test('A: two connections start the same sign-in and both read its link and code; cancel and status go to the harness named', async (t) => {
  const login = fakeLogin();
  const { protocol } = protocolWith(t, login);
  const a = protocol.connection(() => undefined);
  const b = protocol.connection(() => undefined);
  await a.call('host.hello', S.helloParams());
  await b.call('host.hello', S.helloParams());
  const [x, y] = await Promise.all([
    a.call('host.login', { harness: 'gemini', methodId: 'oauth' }),
    b.call('host.login', { harness: 'gemini' }),
  ]);
  assert.deepEqual([x.codes, y.codes, x.links], [['ABCD-1234'], ['ABCD-1234'], ['https://x.test/a']]);
  assert.equal(await a.call('host.loginStatus', { harness: 'gemini' }), null);
  assert.equal(await b.call('host.loginCancel', { harness: 'gemini' }), true);
  assert.deepEqual(await a.call('host.loginInput', { harness: 'gemini', text: 'pasted' }), { accepted: true });
  assert.deepEqual(login.seen, [
    { call: 'start', arg: { harness: 'gemini', methodId: 'oauth' } },
    { call: 'start', arg: { harness: 'gemini' } },
    { call: 'status', arg: 'gemini' },
    { call: 'cancel', arg: 'gemini' },
    { call: 'input', arg: ['gemini', 'pasted'] },
  ]);
  // input the schema refuses never reaches the harness
  await assert.rejects(a.call('host.login', { harness: '../x' }), (e: any) => e.code === 'invalid');
  assert.equal(login.seen.length, 5);
});

test('I: a served Host gives sign-in to a paired connection only, and starts none once it is restarting', async (t) => {
  const dir = tmp(t);
  const paths = createPaths({ dataDir: dir, env: {} });
  const pairing = createPairing({ configDir: paths.configDir });
  const loginService = fakeLogin();
  const { protocol } = protocolWith(t, loginService);
  const updater = { restarting: false, request: () => 'ok' };
  const server = await startServer({
    paths,
    runtime: { host: new EventEmitter() } as any,
    pairing,
    protocol,
    updater: updater as any,
    login: loginService as any,
  });
  t.after(() => server.close());
  const first = line(paths.socketPath);
  t.after(first.close);
  for (const m of ['host.login', 'host.loginStatus', 'host.loginCancel', 'host.loginInput']) {
    const r = await first.call(m, { harness: 'gemini', text: 'x' });
    assert.deepEqual([r.error, r.code], ['This client is not paired with the Host.', 'unknown_client']);
  }
  assert.deepEqual(loginService.seen, []);
  // a paired client signs in, unless the Host is about to restart
  const { loadIdentity, pairWith } = require('../electron/host/pairingClient.cjs');
  const app = loadIdentity(path.join(dir, 'app.json'), keySafe);
  await pairWith(first.request, app, pairing.issueCode());
  assert.ok((await first.call('host.hello', S.helloParams())).result.agreed);
  assert.equal((await first.call('host.login', { harness: 'gemini' })).result.state, 'waiting');
  updater.restarting = true;
  const refused = await first.call('host.login', { harness: 'gemini' });
  assert.equal(refused.error, 'The Host is restarting for an update.');
  assert.equal((await first.call('host.loginCancel', { harness: 'gemini' })).result, true, 'a sign-in under way can still be cancelled');
  assert.deepEqual(
    (await first.call('loginInput', { harness: 'gemini', text: 'pasted' })).result,
    { accepted: true },
    'the line protocol takes the typed code too',
  );
  assert.deepEqual(
    (await first.call('loginInput', { harness: 'gemini' })).result,
    { accepted: true },
    'a missing text reaches the login as an empty line, which it refuses itself',
  );
});

test('the remote Host starts, reads and cancels a sign-in through the shared parsers, and reads the Host status', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const seen: { method: string; params: any }[] = [];
  const answer = (method: string, result: unknown) => (w.net.handlers[method] = (params) => (seen.push({ method, params }), result));
  answer('host.login', { harness: 'gemini', state: 'waiting', links: [], codes: [], error: null });
  answer('host.loginStatus', null);
  answer('host.loginCancel', false);
  answer('host.loginInput', { accepted: true });
  answer('host.status', { harnesses: [{ id: 'gemini', detected: true, signedIn: true }] });
  assert.equal((await host.login({ harness: 'gemini', methodId: 'oauth', junk: 1 })).state, 'waiting');
  assert.equal(await host.loginStatus({ harness: 'gemini' }), null);
  assert.equal(await host.loginCancel({ harness: 'gemini' }), false);
  assert.equal((await host.status()).harnesses[0].signedIn, true);
  assert.deepEqual(await host.loginInput({ harness: 'gemini', text: 'abc' }), { accepted: true });
  assert.deepEqual(seen, [
    { method: 'host.login', params: { harness: 'gemini', methodId: 'oauth' } },
    { method: 'host.loginStatus', params: { harness: 'gemini' } },
    { method: 'host.loginCancel', params: { harness: 'gemini' } },
    { method: 'host.status', params: {} },
    { method: 'host.loginInput', params: { harness: 'gemini', text: 'abc' } },
  ]);
});

test("B: the remote Host refuses a sign-in the schema rejects before it is written; I: the Host's refusal arrives with its code", async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  await assert.rejects(host.login({ harness: '' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.loginStatus(undefined), (e: any) => e.code === 'invalid');
  await assert.rejects(host.loginCancel({ harness: 'a b' }), (e: any) => e.code === 'invalid');
  await assert.rejects(host.loginInput({ harness: 'gemini', text: ' ' }), (e: any) => e.code === 'invalid');
  assert.equal(w.net.last.written.length, writes);
  w.net.raw['host.login'] = (id) => ({ id, error: 'This client is not paired with the Host.', code: 'unknown_client' });
  await assert.rejects(host.login({ harness: 'gemini' }), (e: any) => e.code === 'unknown_client' && /not paired/.test(e.message));
});

test('W: the remote Host refuses a sign-in while offline or when the Host could not agree on a version, and after dispose', async (t) => {
  const w = hostWorld(t);
  const off = w.remote(w.tunnel());
  await assert.rejects(off.login({ harness: 'gemini' }), (e: any) => e.code === 'host_unreachable');
  await assert.rejects(off.status(), (e: any) => e.code === 'host_unreachable');
  const old = hostWorld(t);
  old.net.handlers['host.hello'] = () => ({ protocol: { minor: 0, floor: 0 }, features: [] });
  const { host } = await onlineRemote(old);
  await assert.rejects(host.login({ harness: 'gemini' }), (e: any) => e.code === 'version_refused');
  const { host: gone } = await onlineRemote(hostWorld(t));
  gone.dispose();
  await assert.rejects(gone.loginStatus({ harness: 'gemini' }), (e: any) => e.code === 'disposed');
});

test('the remote Host asks for git sign-in per repository host only when told to, and the schema vets the names', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const seen: any[] = [];
  w.net.handlers['host.status'] = (params) => (seen.push(params), { harnesses: [], gitSignIn: { 'github.com': 'no' } });
  assert.deepEqual((await host.status({ signIn: ['github.com'] })).gitSignIn, { 'github.com': 'no' });
  await host.status();
  assert.deepEqual(seen, [{ signIn: ['github.com'] }, {}]);
  await assert.rejects(host.status({ signIn: ['not a host'] }), /Name the repository hosts/);
});
