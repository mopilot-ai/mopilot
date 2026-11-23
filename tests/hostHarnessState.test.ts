// `status` reports each harness as { id, detected, signedIn } (host/src/harnessState.mjs, signedIn.mjs): the contract the Mac's sign-in confirm reads (2.5).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { acpHarnesses, createAcpRuntime } from '../host/src/acp.mjs';
import { main } from '../host/src/cli.mjs';
import { claudeSignedOutReason, listHarnesses, probeHarness, reportedHarness } from '../host/src/harnessState.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createSignedIn } from '../host/src/signedIn.mjs';
import { askHost } from '../host/src/server.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-harness-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const mk = (name: string) => fs.mkdtempSync(path.join(base, `${name}-`));
const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** An execFile stand-in: `answers[bin + ' ' + args]` is [error?, stdout]. */
const execOf =
  (answers: Record<string, [Error | null, string]>, calls: string[] = []): any =>
  (bin: string, args: string[], _o: unknown, cb: Function) => {
    calls.push(`${path.basename(bin)} ${args.join(' ')}`);
    const [error, stdout] = answers[`${path.basename(bin)} ${args.join(' ')}`] ?? [new Error('not found'), ''];
    cb(error, stdout);
  };
const present =
  (...names: string[]) =>
  (name: string) =>
    names.includes(name) ? `/bin/${name}` : null;

test('Claude Code and Codex are asked of their own CLIs, and an ACP harness is signed in only when installed and seen signed in', async () => {
  const calls: string[] = [];
  const answers: Record<string, [Error | null, string]> = {
    'claude auth status': [null, JSON.stringify({ loggedIn: true, email: 'a@b.test' })],
    'codex login status': [null, 'Logged in using ChatGPT'],
  };
  const acp = [
    { id: 'fake', bin: '/bin/fake', signedIn: true },
    { id: 'noBin', bin: null, signedIn: true },
    { id: 'out', bin: '/bin/out', signedIn: false },
  ];
  const list = await listHarnesses({ env: {}, which: present('claude', 'codex') as any, acp, exec: execOf(answers, calls) });
  assert.deepEqual(list, [
    { id: 'claude', detected: true, signedIn: true },
    { id: 'codex', detected: true, signedIn: true },
    { id: 'fake', detected: true, signedIn: true },
    { id: 'noBin', detected: false, signedIn: false },
    { id: 'out', detected: true, signedIn: false },
  ]);
  assert.deepEqual(calls.sort(), ['claude auth status', 'codex login status']);

  // logged out and a failing CLI read as signed out; unreadable output is still being checked, never signed out (#5118); neither CLI installed asks nothing
  const out = await listHarnesses({
    env: {},
    which: present('claude', 'codex') as any,
    acp: [],
    exec: execOf({
      'claude auth status': [null, JSON.stringify({ loggedIn: false })],
      'codex login status': [new Error('exit 1'), 'Not logged in'],
    }),
  });
  assert.deepEqual(
    out.map((h) => h.signedIn),
    [false, false],
  );
  const garbled = await listHarnesses({
    env: {},
    which: present('claude') as any,
    acp: [],
    exec: execOf({ 'claude auth status': [null, '<html>'] }),
  });
  assert.deepEqual(garbled, [
    { id: 'claude', detected: true, signedIn: false, checking: true },
    { id: 'codex', detected: false, signedIn: false },
  ]);
  const none: string[] = [];
  const bare = await listHarnesses({ env: {}, which: present() as any, acp: [], exec: execOf({}, none) });
  assert.deepEqual([bare.map((h) => h.detected), none], [[false, false], []]);
  // a CLI that prints nothing at all
  const silent = await listHarnesses({
    env: {},
    which: present('codex') as any,
    acp: [],
    exec: ((_b: string, _a: string[], _o: unknown, cb: Function) => cb(null, undefined)) as any,
  });
  assert.equal(silent[1].signedIn, true);
});

test('what a Host knows of its ACP logins survives a restart, and a damaged record knows nothing', () => {
  const dir = mk('si');
  const a = createSignedIn(dir);
  assert.equal(a.get('fake'), false);
  a.set('fake', true);
  assert.equal(createSignedIn(dir).get('fake'), true);
  assert.equal(fs.statSync(path.join(dir, 'signed-in.json')).mode & 0o777, 0o600);
  const before = fs.statSync(path.join(dir, 'signed-in.json')).mtimeMs;
  a.set('fake', true);
  assert.equal(fs.statSync(path.join(dir, 'signed-in.json')).mtimeMs, before, 'nothing rewritten for the same answer');
  a.set('fake', false);
  assert.equal(createSignedIn(dir).get('fake'), false);
  fs.writeFileSync(path.join(dir, 'signed-in.json'), '{nope');
  assert.equal(createSignedIn(dir).get('fake'), false);
  // the data dir may not exist yet
  const fresh = path.join(mk('si2'), 'new');
  createSignedIn(fresh).set('x', true);
  assert.equal(createSignedIn(fresh).get('x'), true);
});

test('a turn that ran to its end marks its harness signed in; one that failed for want of a login marks it signed out', () => {
  const dir = mk('rt');
  const signedIn = createSignedIn(dir);
  const rt = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {}, signedIn });
  const turn = (key: string, id: string, end: object) => {
    rt.host.emit('event', { kind: 'turnStart', key, turnId: id });
    rt.host.emit('event', { kind: 'turnEnd', turnId: id, ...end });
  };
  turn('acp:fake:a', 't1', { stopReason: 'end_turn' });
  assert.equal(signedIn.get('fake'), true);
  turn('acp:fake:a', 't2', { stopReason: 'end_turn', error: new Error('Authentication required') });
  assert.equal(signedIn.get('fake'), false);
  turn('acp:fake:a', 't3', { stopReason: 'end_turn' });
  turn('acp:fake:a', 't4', { stopReason: null, error: 'connection reset' });
  assert.equal(signedIn.get('fake'), true, 'another failure says nothing about the login');
  turn('acp:fake:a', 't5', { stopReason: 'cancelled' });
  assert.equal(signedIn.get('fake'), true, 'nor does a cancelled turn');
  turn('not-acp', 't6', { stopReason: 'end_turn' });
  assert.equal(signedIn.get('not-acp'), false);
  rt.close();
  // a runtime built without the record notes nothing
  const plain = createAcpRuntime({ paths: createPaths({ dataDir: mk('rt2'), env: {} }), env: {} });
  plain.host.emit('event', { kind: 'turnStart', key: 'acp:fake:a', turnId: 'p1' });
  plain.host.emit('event', { kind: 'turnEnd', turnId: 'p1', stopReason: 'end_turn' });
  plain.close();
});

test('the ACP harnesses a Host can name are its own and the built-in ones, each with the binary it finds', () => {
  const dir = mk('ah');
  const bin = mk('bin');
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ mine: { label: 'Mine', bin: '/opt/mine' } }));
  const none = acpHarnesses({ dataDir: dir, env: { PATH: '/nowhere' } });
  assert.deepEqual(none[0], { id: 'mine', bin: '/opt/mine' });
  assert.ok(none.length > 1 && none.slice(1).every((h: any) => h.bin === null));
  // a built-in harness is found by the name of its program on PATH
  const { quirks } = createRequire(import.meta.url)('../electron/harness/quirks/index.cjs');
  const builtIn = none[1].id;
  const program = path.join(bin, quirks(builtIn).bins[0]);
  fs.writeFileSync(program, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(acpHarnesses({ dataDir: dir, env: { PATH: bin } }).find((h: any) => h.id === builtIn)?.bin, program);
});

/** A directory with a `claude` and a `codex` that answer as signed in. */
function vendorBin() {
  const dir = mk('vendor');
  fs.writeFileSync(path.join(dir, 'claude'), '#!/bin/sh\necho \'{"loggedIn":true}\'\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return dir;
}

test('mopilot-host status lists the harnesses with their state, running or not', async () => {
  const dir = mk('st');
  const env = { PATH: `${vendorBin()}:/usr/bin:/bin` };
  fs.writeFileSync(path.join(dir, 'harnesses.json'), JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [] } }));
  createSignedIn(dir).set('fake', true);
  const out: string[] = [];
  assert.equal(await main(['status', '--data-dir', dir], { out: (l: string) => out.push(l), err: () => {}, env }), 0);
  const offline = JSON.parse(out[0]);
  assert.equal(offline.running, false);
  const byId = Object.fromEntries(offline.harnesses.map((h: any) => [h.id, h]));
  assert.deepEqual(
    [byId.claude, byId.codex, byId.fake],
    [
      { id: 'claude', detected: true, signedIn: true },
      { id: 'codex', detected: true, signedIn: true },
      { id: 'fake', detected: true, signedIn: true },
    ],
  );

  // the running Host answers the same way, over its socket
  const signals: any = new EventEmitter();
  const lines: string[] = [];
  const running = main(['serve', '--data-dir', dir], { out: (l: string) => lines.push(l), err: () => {}, env, signals });
  await until(() => lines.some((l) => l.includes('serving')));
  const live: any = await askHost(createPaths({ dataDir: dir, env: {} }).socketPath, 'status');
  assert.equal(live.running, true);
  assert.deepEqual(
    live.harnesses.find((h: any) => h.id === 'fake'),
    {
      id: 'fake',
      detected: true,
      signedIn: true,
      models: [],
      // the running Host also says which credentials exist, the one a chat would use, and that this agent has one sign-in
      sources: { own: true, key: false, org: false },
      using: 'own',
      loginsSupported: false,
    },
  );
  // a missing agent the Host can install says so, and the Host's PATH finds what it installs into its own prefix
  assert.deepEqual(
    live.harnesses.find((h: any) => h.id === 'gemini'),
    {
      id: 'gemini',
      detected: false,
      signedIn: false,
      takesKey: true,
      installable: true,
      sources: { own: false, key: false, org: false },
      using: 'own',
      loginsSupported: false,
    },
  );
  assert.equal(live.harnesses.find((h: any) => h.id === 'cursor')?.installable, undefined, 'no npm line, no install');
  assert.ok(env.PATH.split(':').includes(path.join(dir, 'tools', 'bin')));
  // `mopilot-host status` asks the running Host rather than reading the machine itself
  const viaCli: string[] = [];
  assert.equal(await main(['status', '--data-dir', dir], { out: (l: string) => viaCli.push(l), err: () => {}, env }), 0);
  assert.equal(JSON.parse(viaCli[0]).running, true);
  signals.emit('SIGTERM');
  assert.equal(await running, 0);
});

test("probeHarness asks the harness's own CLI, and an absent CLI is not signed in", async () => {
  const answers: Record<string, [Error | null, string]> = {
    'claude auth status': [null, JSON.stringify({ loggedIn: true })],
    'codex login status': [new Error('Not logged in'), ''],
  };
  const o = { env: {}, which: present('claude', 'codex'), exec: execOf(answers) };
  assert.equal(await probeHarness('claude', o), true);
  assert.equal(await probeHarness('codex', o), false, 'a non-zero exit is signed out');
  assert.equal(await probeHarness('codex', { ...o, exec: execOf({ 'codex login status': [null, 'Logged in'] }) }), true);
  assert.equal(await probeHarness('claude', { ...o, which: present() }), false, 'not installed');
});

test('a Mac Host tells a locked keychain apart from never signed in, asking `security` for the keychain settings only', async () => {
  const seen: string[][] = [];
  /** `security show-keychain-info` answering with `stderr` (and failing) or not. */
  const sec =
    (stderr: string | null): any =>
    (bin: string, args: string[], _o: unknown, cb: Function) => {
      if (bin === '/usr/bin/security') return seen.push(args), cb(stderr === null ? null : new Error('exit 36'), '', stderr ?? '');
      cb(null, JSON.stringify({ loggedIn: false }));
    };
  const list = (stderr: string | null, platform: NodeJS.Platform) =>
    listHarnesses({ env: {}, which: present('claude') as any, acp: [], exec: sec(stderr), platform });
  const locked = 'security: SecKeychainCopySettings login.keychain-db: User interaction is not allowed.';
  assert.deepEqual((await list(locked, 'darwin'))[0], { id: 'claude', detected: true, signedIn: false, reason: 'keychain-locked' });
  assert.deepEqual(seen, [['show-keychain-info']], 'only the settings are read, never an item');
  assert.deepEqual((await list('A default keychain could not be found.', 'darwin'))[0].reason, 'keychain-locked');
  assert.deepEqual(
    (await list(null, 'darwin'))[0],
    { id: 'claude', detected: true, signedIn: false },
    'an open keychain: plainly signed out',
  );
  assert.deepEqual((await list('some other failure', 'darwin'))[0], { id: 'claude', detected: true, signedIn: false });
  seen.length = 0;
  assert.deepEqual((await list(locked, 'linux'))[0], { id: 'claude', detected: true, signedIn: false }, 'no keychain on Linux');
  assert.deepEqual(seen, []);
  // a failing `security` that prints nothing at all
  const bare: any = (bin: string, _a: string[], _o: unknown, cb: Function) =>
    cb(bin === '/usr/bin/security' ? new Error('x') : null, '', undefined);
  assert.equal(await claudeSignedOutReason({ env: {}, exec: bare, platform: 'darwin' }), null);
});

test('status: Codex and Claude Code that can run list their models; both take a lent key and run signed out with one', async () => {
  const o = (keyed: boolean) => ({
    codex: { models: async () => ['gpt'] },
    sessions: { modelsOf: (id: string) => [`${id}-model`] },
    leases: { has: () => keyed },
    // a Mac signed in to Claude Code must not leak its own login record into the answer: the CLI's folder is an empty one
    env: { HOME: mk('no-claude-login') },
  });
  const h = (id: string, detected: boolean, signedIn: boolean) => ({ id, detected, signedIn });
  assert.deepEqual(await reportedHarness(h('codex', true, true), o(false)), {
    ...h('codex', true, true),
    takesKey: true,
    takesOrg: true,
    planMode: true,
    models: ['gpt'],
  });
  assert.deepEqual(await reportedHarness(h('codex', true, false), o(false)), {
    ...h('codex', true, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
  });
  assert.deepEqual(await reportedHarness(h('codex', true, false), o(true)), {
    ...h('codex', true, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
    models: ['gpt'],
  });
  assert.deepEqual(await reportedHarness(h('codex', false, false), o(true)), {
    ...h('codex', false, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
  });
  assert.deepEqual(await reportedHarness(h('claude', true, true), o(false)), {
    ...h('claude', true, true),
    takesKey: true,
    takesOrg: true,
    planMode: true,
    models: ['claude-model'],
  });
  assert.deepEqual(await reportedHarness(h('claude', true, false), o(false)), {
    ...h('claude', true, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
  });
  assert.deepEqual(await reportedHarness(h('claude', true, false), o(true)), {
    ...h('claude', true, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
    models: ['claude-model'],
  });
  assert.deepEqual(await reportedHarness(h('claude', false, false), o(true)), {
    ...h('claude', false, false),
    takesKey: true,
    takesOrg: true,
    planMode: true,
  });
  // an ACP agent that signs in with an env key takes the user's key; one that does not is reported as it is
  assert.deepEqual(await reportedHarness(h('gemini', true, true), o(true)), {
    ...h('gemini', true, true),
    takesKey: true,
    models: ['gemini-model'],
  });
  assert.deepEqual(await reportedHarness(h('dsh', true, true), o(true)), {
    ...h('dsh', true, true),
    takesKey: true,
    models: ['dsh-model'],
  });
  assert.deepEqual(await reportedHarness(h('opencode', true, true), o(true)), { ...h('opencode', true, true), models: ['opencode-model'] });
});

test('ACP model discovery is restricted to installed agents with their own login or lent credentials', async () => {
  const o = {
    codex: { models: async () => [] },
    sessions: { modelsOf: (id: string) => [id] },
    leases: { has: () => false },
    env: { HOME: mk('no-claude-login') },
  };
  const h = { id: 'gemini', detected: true, signedIn: false };
  assert.deepEqual(await reportedHarness(h, o), { ...h, takesKey: true });
  assert.deepEqual(await reportedHarness(h, { ...o, leases: { has: () => true } }), { ...h, takesKey: true, models: ['gemini'] });
  assert.deepEqual(await reportedHarness({ ...h, detected: false }, { ...o, leases: { has: () => true } }), {
    ...h,
    detected: false,
    takesKey: true,
  });
});
