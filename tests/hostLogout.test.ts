// Signing a harness out on a Host (host/src/login.mjs `logout`, the `host.logout` wire method, the remote Host's `logout`): the vendor CLI's own sign-out runs there and the CLI is asked again, Codex's app-server lets the old login go, an ACP harness is reported as not signed out, and an older Host is refused by feature (A: a sign-in under way, B: a CLI that fails, hangs or cannot start, W: gate, I: paired only).
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createLogin } from '../host/src/login.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';
import { hostWorld, onlineRemote } from './support/host-wire-kit.ts';

const require = createRequire(import.meta.url);
const S = require('../shared/host/schema.mjs');

/** A child that exits with `code` after printing `stderr` on its error stream; `hang` never exits. */
function child(o: { code?: number; stderr?: string; hang?: boolean; error?: Error } = {}) {
  const c: any = new EventEmitter();
  c.stderr = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
  c.killed = false;
  c.kill = () => ((c.killed = true), queueMicrotask(() => c.emit('close', null)));
  queueMicrotask(() => {
    if (o.error) return c.emit('error', o.error);
    if (o.stderr) c.stderr.emit('data', o.stderr);
    if (!o.hang) c.emit('close', o.code ?? 0);
  });
  return c;
}

/** A login service whose sign-out CLI behaves as `o` says; `still` is what the CLI says afterwards. */
function setup(o: { still?: boolean; installed?: boolean; child?: Parameters<typeof child>[0]; logoutMs?: number } = {}) {
  const ran: { bin: string; args: string[]; env: any }[] = [];
  const marked: [string, boolean][] = [];
  const signedOut: string[] = [];
  const kids: any[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: { PATH: '/bin' },
    which: (name: string) => (o.installed === false ? null : `/bin/${name}`),
    signedIn: { set: (id: string, v: boolean) => marked.push([id, v]) } as any,
    spawnFn: (bin: string, args: string[], opts: any) => {
      ran.push({ bin, args, env: opts.env });
      const k = child(o.child);
      kids.push(k);
      return k;
    },
    probe: async () => o.still === true,
    families: [{ signedOut: (id: string) => signedOut.push(id) }],
    logoutMs: o.logoutMs,
  });
  return { login, ran, marked, signedOut, kids };
}

test('claude and codex sign out with their own CLI, are asked again, and Codex lets the old login go', async () => {
  const c = setup();
  assert.deepEqual(await c.login.logout('claude'), { harness: 'claude', signedOut: true, error: null });
  assert.deepEqual(
    c.ran.map((r) => [r.bin, r.args]),
    [['/bin/claude', ['auth', 'logout']]],
  );
  assert.equal(c.ran[0].env.BROWSER, undefined, 'a sign-out opens nothing, so it runs in the Host’s own env');
  assert.deepEqual([c.marked, c.signedOut], [[['claude', false]], ['claude']]);
  const x = setup();
  assert.deepEqual(await x.login.logout('codex'), { harness: 'codex', signedOut: true, error: null });
  assert.deepEqual(x.ran[0].args, ['logout']);
  assert.deepEqual(x.signedOut, ['codex']);
});

test('B: a CLI that is still signed in afterwards reports why; one that says nothing gets a plain reason', async () => {
  const said = setup({ still: true, child: { code: 1, stderr: 'Error: keychain locked\n' } });
  assert.deepEqual(await said.login.logout('claude'), { harness: 'claude', signedOut: false, error: 'Error: keychain locked' });
  assert.deepEqual([said.marked, said.signedOut], [[['claude', true]], []]);
  const quiet = setup({ still: true });
  assert.equal((await quiet.login.logout('codex')).error, 'Codex is still signed in.');
});

test('B: a CLI that cannot start or never finishes is ended and reported, and the CLI is still asked', async () => {
  const broken = setup({ still: true, child: { error: new Error('spawn EACCES') } });
  assert.equal((await broken.login.logout('claude')).error, 'spawn EACCES');
  const hung = setup({ still: true, child: { hang: true }, logoutMs: 10 });
  assert.equal((await hung.login.logout('claude')).error, 'Claude Code did not finish signing out.');
  assert.equal(hung.kids[0].killed, true);
  // it hung, but the CLI then says it is signed out: that is the answer
  const late = setup({ child: { hang: true }, logoutMs: 10 });
  assert.equal((await late.login.logout('codex')).signedOut, true);
});

test('a CLI that is not installed has nothing to sign out of; an ACP harness is not signed out from here', async () => {
  const none = setup({ installed: false });
  assert.deepEqual(await none.login.logout('codex'), { harness: 'codex', signedOut: true, error: null });
  assert.deepEqual(none.ran, []);
  const acp = setup();
  assert.deepEqual(await acp.login.logout('gemini'), {
    harness: 'gemini',
    signedOut: false,
    error: 'Sign out of it on the machine itself.',
  });
  assert.deepEqual([acp.ran, acp.marked], [[], []]);
});

test('A: signing out cancels a sign-in under way for that harness first', async () => {
  const h = setup();
  // the sign-in's CLI never exits; the sign-out's child exits at once
  const spawned: any[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: {},
    which: (name: string) => `/bin/${name}`,
    spawnFn: (_b: string, args: string[]) => {
      const k: any = child(args[0] === 'logout' ? {} : { hang: true });
      k.stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined });
      k.stderr = Object.assign(k.stderr, { on: k.stderr.on.bind(k.stderr) });
      k.stdin = Object.assign(new EventEmitter(), { write: () => true, destroyed: false });
      spawned.push(k);
      return k;
    },
    // This child is an emitter, so its retirement stand-in drives the real child's close boundary.
    retire: async (k: any) => {
      k.kill();
    },
    probe: async () => false,
  });
  login.start({ harness: 'codex' });
  assert.equal(login.idle(), false);
  assert.deepEqual(await login.logout('codex'), {
    harness: 'codex',
    signedOut: false,
    error: 'Sign-in is stopping on this machine. Wait for it to stop, then try signing out again.',
  });
  assert.equal(spawned.length, 1, 'sign-out cannot overlap the retiring sign-in writer');
  await waitFor(() => login.idle(), 'the login to go idle');
  assert.equal((await login.logout('codex')).signedOut, true);
  assert.equal(login.idle(), true);
  assert.equal(login.status('codex')!.state, 'cancelled');
  assert.equal(h.ran.length, 0);
});

test('the wire: host.logout reaches the login service after hello, needs the logout feature, and takes a harness only', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-logout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const seen: string[] = [];
  const login: any = { logout: async (h: string) => (seen.push(h), { harness: h, signedOut: true, error: null }) };
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({}), login }).connection(() => undefined);
  await conn.call('host.hello', S.helloParams());
  assert.deepEqual(await conn.call('host.logout', { harness: 'claude', extra: 1 }), { harness: 'claude', signedOut: true, error: null });
  await assert.rejects(conn.call('host.logout', { harness: '../x' }), (e: any) => e.code === 'invalid');
  assert.deepEqual(seen, ['claude']);
  // an end that does not declare it is refused, never served half
  const old = createProtocol({ runtime, epochs, guard, status: () => ({}), login }).connection(() => undefined);
  await old.call('host.hello', { ...S.helloParams(), features: S.FEATURES.filter((f: string) => f !== 'logout') });
  await assert.rejects(old.call('host.logout', { harness: 'claude' }), (e: any) => e.code === 'feature_missing');
  const none = createProtocol({ runtime, epochs, guard, status: () => ({}) }).connection(() => undefined);
  await none.call('host.hello', S.helloParams());
  await assert.rejects(none.call('host.logout', { harness: 'claude' }), (e: any) => e.code === 'unsupported');
});

test('the remote Host signs out through the wire, and an older Host without sign-out is refused before anything is written', async (t) => {
  const w = hostWorld(t);
  const { host } = await onlineRemote(w);
  const writes = w.net.last.written.length;
  await assert.rejects(host.logout({ harness: 'claude' }), (e: any) => e.code === 'feature_missing');
  assert.equal(w.net.last.written.length, writes);
  const n = hostWorld(t);
  n.net.handlers['host.hello'] = () => ({ protocol: { minor: 1, floor: 1 }, features: [...S.FEATURES] });
  n.net.handlers['host.logout'] = (p) => ({ harness: p.harness, signedOut: true, error: null });
  const fresh = await onlineRemote(n);
  assert.deepEqual(await fresh.host.logout({ harness: 'codex' }), { harness: 'codex', signedOut: true, error: null });
});
