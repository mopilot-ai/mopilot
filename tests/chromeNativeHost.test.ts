// MoPilot's Chrome extension native messaging host (#1632): the launcher and manifests main installs, the checks on who connects, main's socket answering a claim, and the app wiring. The real sage-mcp host against it: tests/chromeNativeHostBinary.test.ts.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { memoryPairing, emptyChromeFolder } from './support/chrome-extension-kit.ts';
import { until } from './support/chrome-relay-kit.ts';
import { request, hostServer, STORE } from './support/native-host-kit.ts';
import { fakeCore, ancestryOf } from './support/fake-core.ts';

const require = createRequire(import.meta.url);
const nh = require('../electron/capabilities/browser/chromeNativeHost.cjs');
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { DEV_EXTENSION_ID } = require('../electron/capabilities/browser/chromeExtensionIds.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mpnh-'));
const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));

test('the launcher runs the binary as the host on the socket, with Chrome’s arguments, whatever the paths hold', () => {
  const dir = tmp();
  const binary = path.join(dir, "it's a host");
  fs.writeFileSync(binary, '#!/bin/sh\nfor a in "$@"; do echo "[$a]"; done\n', { mode: 0o755 });
  const launcher = path.join(dir, 'launch');
  fs.writeFileSync(launcher, nh.launcherScript({ binary, socket: '/tmp/a b/$x`y`.sock' }), { mode: 0o755 });
  const r = spawnSync(launcher, ['chrome-extension://x/'], { encoding: 'utf8' });
  assert.equal(r.stdout, '[--chrome-native-host]\n[/tmp/a b/$x`y`.sock]\n[chrome-extension://x/]\n');
});

test('the manifest names the host, the launcher and exactly the extension’s origins', () => {
  assert.deepEqual(nh.hostManifest({ launcher: '/l', ids: [STORE, DEV_EXTENSION_ID] }), {
    name: 'ai.mopilot.code.chrome',
    description: "MoPilot's Chrome extension pairing",
    path: '/l',
    type: 'stdio',
    allowed_origins: [`chrome-extension://${STORE}/`, `chrome-extension://${DEV_EXTENSION_ID}/`],
  });
});

test('the folder: the Chrome folder pairing pages open in, alone (the scratch one when a run names one), when it exists; macOS only', () => {
  assert.deepEqual(nh.hostFolders({ platform: 'win32', env: {} }), []);
  const all = () => true;
  assert.deepEqual(nh.hostFolders({ platform: 'darwin', env: { MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/s/c' }, exists: all }), [
    '/s/c/NativeMessagingHosts',
  ]);
  assert.deepEqual(nh.hostFolders({ platform: 'darwin', env: {}, home: '/h', exists: all }), [
    '/h/Library/Application Support/Google/Chrome/NativeMessagingHosts',
  ]);
  // no Chrome there: nothing is written, and no other browser gets it instead
  assert.deepEqual(nh.hostFolders({ platform: 'darwin', env: {}, home: '/h', exists: () => false }), []);
  assert.ok(nh.hostFolders().every((p: string) => p.endsWith('NativeMessagingHosts')));
});

test('install: an owner-only launcher (kept so on a rewrite) and a manifest per folder; a folder that can’t be written is left out', () => {
  const dir = tmp();
  const launcher = path.join(dir, 'host', 'launch');
  const blocked = path.join(dir, 'blocked');
  fs.writeFileSync(blocked, 'a file, not a folder');
  const folders = [path.join(dir, 'Chrome', 'NativeMessagingHosts'), path.join(blocked, 'NativeMessagingHosts')];
  const manifest = nh.hostManifest({ launcher, ids: [STORE] });
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const written = nh.installHost({ launcher, script: 'one', manifest, folders });
    assert.deepEqual(written, [path.join(folders[0], 'ai.mopilot.code.chrome.json')]);
    assert.deepEqual(JSON.parse(fs.readFileSync(written[0], 'utf8')), manifest);
    assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);
    fs.chmodSync(launcher, 0o755);
    nh.installHost({ launcher, script: 'two', manifest, folders: [] });
    assert.equal(fs.readFileSync(launcher, 'utf8'), 'two');
    assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);
  } finally {
    warn.mock.restore();
  }
});

/** An execFile stand-in for codesign, the one command the checks still run, and a core answering what files run and who started whom. */
function fakeWorld({
  exe = {},
  parents = {},
  signed = true,
}: {
  exe?: Record<string, string>;
  parents?: Record<number, number>;
  signed?: boolean;
}) {
  const calls: string[][] = [];
  const fn = (cmd: string, args: string[], _o: any, cb: (e: any, out: any) => void) => {
    calls.push([cmd, ...args]);
    if (cmd === '/usr/bin/codesign') return cb(signed ? null : new Error('invalid signature'), '');
    return cb(new Error(`unexpected ${cmd}`), '');
  };
  const core = fakeCore({
    'caps.executable': (pid: string) => exe[pid] ?? new Error('no such process'),
    'caps.ancestry': ancestryOf(parents),
  });
  return { fn, calls, core };
}

test('verifying a host: the file it runs (not its argv[0]) is ours, it holds the socket, Google Chrome started it, for one of the ids', async () => {
  const binary = '/A/MoPilot.app/Contents/Helpers/sage-mcp';
  const good = { exe: { '40': binary }, parents: { 40: 30 } };
  // macOS's checks (the core, codesign); the Linux branch is tested in chromeHostLinux.test.ts
  const base = {
    socket: {},
    pid: 40,
    origin: `chrome-extension://${STORE}/`,
    binary,
    ids: [STORE],
    holds: async () => null,
    platform: 'darwin',
  };
  const v = (o: any, e: any = good) => {
    const x = fakeWorld(e);
    return nh.verifyHostPeer({ ...base, execFile: x.fn, addon: x.core.addon, ...o }).then((r: any) => [r, x.calls, x.core.asked]);
  };
  const [ok, calls, asked] = await v({});
  assert.equal(ok, null);
  assert.deepEqual(asked, ['caps.executable 40', 'caps.ancestry 40']);
  assert.deepEqual(calls.at(-1), [
    '/usr/bin/codesign',
    '--verify',
    '--ignore-resources',
    '-R=anchor apple generic and certificate leaf[subject.OU] = "EQHXZ8M8AV"',
    '30',
  ]);
  for (const pid of [undefined, 'x', 1, 2.5]) assert.equal((await v({ pid }))[0], 'no pid');
  assert.equal((await v({ origin: `chrome-extension://${STORE}` }))[0], 'not an extension of MoPilot');
  assert.equal((await v({ origin: `chrome-extension://${DEV_EXTENSION_ID}/` }))[0], 'not an extension of MoPilot');
  // another file, or none readable (the process is gone, or its file was deleted): ps's argv[0] is never asked
  assert.equal((await v({}, { ...good, exe: { '40': '/tmp/evil' } }))[0], "process 40 is not MoPilot's host");
  assert.equal((await v({}, { ...good, exe: {} }))[0], "process 40 is not MoPilot's host");
  assert.equal((await v({ holds: async () => 'process 40 is not the one connected' }))[0], 'process 40 is not the one connected');
  assert.equal((await v({}, { exe: good.exe, parents: {} }))[0], 'no browser started the host');
  assert.equal((await v({}, { exe: good.exe, parents: { 40: 1 } }))[0], 'no browser started the host');
  assert.equal((await v({}, { ...good, signed: false }))[0], 'the host was not started by Google Chrome');
  // no core: no file, so nothing is handed over
  assert.equal((await v({ addon: null }))[0], "process 40 is not MoPilot's host");
  // the file check, the socket and the parent all use the one core named, and the socket is checked with it
  const seen: any[] = [];
  const x = fakeWorld(good);
  await nh.verifyHostPeer({ ...base, execFile: x.fn, addon: x.core.addon, holds: async (o: any) => (seen.push(o), null) });
  assert.equal(seen[0].addon, x.core.addon);
});

test('a host that went away during the checks spends no claim and opens nothing', async () => {
  const spent: string[] = [];
  const { socket } = await hostServer(stops, {
    claim: () => (spent.push('claim'), 'code'),
    open: async () => (spent.push('open'), true),
    verify: async (v: any) => (v.socket.destroy(), null),
  });
  for (const type of ['claim', 'open']) {
    const line = `${JSON.stringify({ type: 'hello', pid: 7, origin: `chrome-extension://${STORE}/`, request: { type, what: 'try' } })}\n`;
    assert.equal(await request(socket, line), '');
  }
  assert.deepEqual(spent, []);
});

/** A client on the server's socket, as the host speaks: one line out, one line back. */

test('the server: a verified host gets the pending claim, or none; a refused one, a bad line or an unknown request gets nothing', async () => {
  const hello = (o: any = {}) =>
    `${JSON.stringify({ type: 'hello', pid: 7, origin: `chrome-extension://${STORE}/`, request: { type: 'claim' }, ...o })}\n`;
  const seen: any[] = [];
  let code: any = `mopilot-claim:1:47615:${'c'.repeat(32)}`;
  const asks: any[] = [];
  const refusals: string[] = [];
  const opens: unknown[] = [];
  const { socket } = await hostServer(stops, {
    open: async (what: unknown) => (opens.push(what), what === 'try'),
    claim: (o: any) => (asks.push(o), code),
    verify: async (v: any) => (seen.push(v), v.pid === 7 ? null : 'no pid'),
    onRefused: (r: string) => refusals.push(r),
  });
  assert.deepEqual(JSON.parse(await request(socket, hello())), { type: 'claim', code });
  assert.equal(seen[0].binary, '/b/sage-mcp');
  assert.deepEqual(seen[0].ids, [STORE]);
  assert.equal(seen[0].origin, `chrome-extension://${STORE}/`);
  code = null;
  assert.deepEqual(JSON.parse(await request(socket, hello())), { type: 'none', reason: 'MoPilot is not offering a pairing now' });
  // the user is asked in MoPilot: the extension asks again
  code = { pending: true };
  assert.deepEqual(JSON.parse(await request(socket, hello())), {
    type: 'none',
    pending: true,
    reason: 'Waiting for the user to allow it in MoPilot',
  });
  code = 'x';
  assert.deepEqual(JSON.parse(await request(socket, hello({ pid: 8 }))), { type: 'refused', reason: 'no pid' });
  assert.deepEqual(refusals, ['no pid']);
  // the extension asking by itself says so, and only `true` counts
  // the extension's page asks MoPilot to open what it names (Try it); a host that fails the checks opens nothing
  const open = (what: unknown, o: any = {}) => request(socket, hello({ request: { type: 'open', what }, ...o })).then((x) => JSON.parse(x));
  assert.deepEqual(await open('try'), { type: 'opened' });
  assert.deepEqual(await open('other'), { type: 'none', reason: "MoPilot can't open that" });
  assert.deepEqual(await open('try', { pid: 9 }), { type: 'refused', reason: 'no pid' });
  assert.deepEqual(opens, ['try', 'other']);
  code = 'y';
  await request(socket, hello({ request: { type: 'claim', auto: true } }));
  await request(socket, hello({ request: { type: 'claim', auto: 'yes' } }));
  assert.deepEqual(asks.slice(-2), [{ auto: true }, { auto: false }]);
  assert.deepEqual(JSON.parse(await request(socket, 'not json\n')), { type: 'error', reason: 'unreadable request' });
  assert.deepEqual(JSON.parse(await request(socket, hello({ type: 'other' }))), { type: 'error', reason: 'unknown request' });
  assert.deepEqual(JSON.parse(await request(socket, hello({ request: { type: 'unpair' } }))), { type: 'error', reason: 'unknown request' });
  assert.deepEqual(JSON.parse(await request(socket, 'null\n')), { type: 'error', reason: 'unknown request' });
  // the line can come in pieces; what follows it is ignored
  const c = net.connect(socket);
  let got = '';
  c.on('data', (d) => (got += d));
  const line = hello();
  c.write(line.slice(0, 10));
  await new Promise((r) => setTimeout(r, 10));
  c.write(`${line.slice(10)}more\n`);
  await until(() => got.includes('\n'));
  assert.equal(JSON.parse(got).type, 'claim');
  c.destroy();
});

test('the server checks with verifyHostPeer by default: a process that isn’t the host is refused; data after the line is ignored', async () => {
  const s = new nh.ChromeNativeHostServer({ claim: () => 'never', ids: () => [STORE], binary: '/b/sage-mcp' });
  stops.push(() => s.stop());
  const socket = await s.start();
  const hello = `${JSON.stringify({ type: 'hello', pid: process.pid, origin: `chrome-extension://${STORE}/`, request: { type: 'claim' } })}\n`;
  assert.deepEqual(JSON.parse(await request(socket, hello)), {
    type: 'refused',
    // the default check refuses on every platform: on Linux (the CI runners) the gate is closed outside E2E
    reason:
      process.platform === 'linux' ? 'the Chrome native host is not available on Linux' : `process ${process.pid} is not MoPilot's host`,
  });
  // a second line while the first is being checked gets no second answer
  let release: () => void = () => undefined;
  let checks = 0;
  const slow = await hostServer(stops, { verify: () => (checks++, new Promise<null>((r) => (release = () => r(null)))) });
  const c = net.connect(slow.socket);
  let got = '';
  c.on('data', (d) => (got += d));
  c.write(hello);
  await until(() => checks === 1);
  c.write(hello);
  await new Promise((r) => setTimeout(r, 20));
  release();
  await until(() => got.includes('\n'));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(checks, 1);
  assert.equal(got.split('\n').filter(Boolean).length, 1);
  c.destroy();
});

test('the server: a check that fails answers an error; a line too long or too slow is cut off', async () => {
  const warn = mock.method(console, 'warn', () => undefined);
  try {
    const failing = await hostServer(stops, {
      verify: async () => {
        throw new Error('ps failed');
      },
    });
    const hello = `${JSON.stringify({ type: 'hello', pid: 7, request: { type: 'claim' } })}\n`;
    assert.deepEqual(JSON.parse(await request(failing.socket, hello)), { type: 'error', reason: 'MoPilot could not check the host' });
    const { socket } = await hostServer(stops, { lineMs: 50 });
    assert.equal(await request(socket, Buffer.alloc(70 * 1024, 'a')), '');
    assert.equal(await request(socket, '{"type":"hel'), '');
  } finally {
    warn.mock.restore();
  }
});

test('the channel: hostClaim is the pending claim code while it is good; with the host installed the page carries no code', async (t) => {
  const pairing = memoryPairing();
  const opened: string[] = [];
  let route = true;
  const ch = new ChromeExtensionChannel({
    pairing,
    openPage: async (u: string) => opened.push(u),
    port: 0,
    connectMs: 50,
    hostRoute: () => route,
    pageId: () => STORE,
  });
  stops.push(() => ch.stop());
  assert.equal(ch.hostClaim(), null);
  assert.equal(await ch.pair(), 'opened');
  assert.equal(opened[0], `chrome-extension://${STORE}/options.html#pair=host`);
  const code = ch.hostClaim();
  assert.match(code, new RegExp(`^mopilot-claim:1:${pairing.get().port}:[A-Za-z0-9_-]{32}$`));
  route = false;
  assert.equal(await ch.pair(), 'opened');
  assert.match(opened[1], /#pair=mopilot-claim%3A1%3A/);
  assert.notEqual(ch.hostClaim(), code, 'a new offer replaces the claim the host hands over');
  assert.equal(ch.hostClaim({ auto: true }), ch.hostClaim(), 'an offer from Settings answers the extension asking by itself');
  // a chat's wait offers too, but only the user's Pair on the page takes it
  const waiting = new ChromeExtensionChannel({
    pairing: memoryPairing(),
    openPage: async () => undefined,
    port: 0,
    connectMs: 30,
    hostRoute: () => true,
  });
  stops.push(() => waiting.stop());
  await waiting.start();
  await assert.rejects(waiting.connect('c'));
  assert.ok(waiting.hostClaim());
  // ...and the extension asking by itself raises "Allow Chrome to connect?" instead (chromePairOffers.cjs)
  const asks: number[] = [];
  waiting.on('ask', () => asks.push(1));
  assert.deepEqual(waiting.hostClaim({ auto: true }), { pending: true });
  assert.equal(waiting.status().asking, true);
  assert.equal(waiting.answerAsk(true), true);
  assert.equal(waiting.status().asking, false);
  assert.match(waiting.hostClaim({ auto: true }), /^mopilot-claim:1:/, 'Allow: the next ask takes the user’s offer');
  assert.equal(waiting.answerAsk(true), false, 'no question up');
  assert.deepEqual(asks, [1, 1]);
  pairing.set(null);
  assert.equal(ch.hostClaim(), null);
  pairing.set({ secret: 'S'.repeat(43), port: 1, paired: false });
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 121_000);
  assert.equal(ch.hostClaim(), null);
});

test('which ids get a host: a packaged build once the store id is set; a scratch run that asks; never a developer build otherwise', () => {
  const packaged = '/A.app/Contents/Resources/app.asar/electron/chrome-extension';
  assert.equal(appRelay.nativeHostIds({ dir: packaged, storeId: null, platform: 'darwin', env: {} }), null);
  assert.deepEqual(appRelay.nativeHostIds({ dir: packaged, storeId: STORE, platform: 'darwin', env: {} }), [STORE]);
  assert.equal(appRelay.nativeHostIds({ storeId: STORE, platform: 'darwin', env: {} }), null);
  assert.equal(appRelay.nativeHostIds({ platform: 'darwin', env: { MOPILOT_CHROME_NATIVE_HOST: '1' } }), null);
  assert.deepEqual(
    appRelay.nativeHostIds({
      storeId: STORE,
      platform: 'darwin',
      env: { MOPILOT_CHROME_NATIVE_HOST: '1', MOPILOT_CHROME_RELAY_USER_DATA_DIR: '/s' },
    }),
    [STORE, DEV_EXTENSION_ID],
  );
  assert.equal(appRelay.nativeHostIds({ platform: 'darwin' }), null, 'this checkout installs no host by default');
});

test('setup: the host is served and installed where ids are given, the pairing page then carries no code, and stop ends it', async (t) => {
  emptyChromeFolder(t);
  const dir = tmp();
  const folder = path.join(dir, 'Chrome', 'NativeMessagingHosts');
  const opened: string[] = [];
  const registry = { register: () => () => undefined };
  const base = {
    registry,
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => false,
    kind: 'extension',
    open: async (url: string) => opened.push(url),
  };
  const signals: any[] = [];
  const s = appRelay.setupChromeRelay({
    ...base,
    onStatus: () => signals.push('status'),
    onAsk: (asking: boolean) => signals.push(['ask', asking]),
    onOpen: (what: unknown) => (signals.push(['open', what]), true),
    pairing: memoryPairing({ secret: 'D'.repeat(43), port: 0, paired: false }),
    nativeHost: { launcher: path.join(dir, 'launch'), binary: '/b/sage-mcp', ids: [STORE], folders: [folder], verify: async () => null },
  });
  stops.push(() => s.stop());
  const manifest = path.join(folder, 'ai.mopilot.code.chrome.json');
  await until(() => fs.existsSync(manifest));
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')).allowed_origins, [`chrome-extension://${STORE}/`]);
  assert.match(
    fs.readFileSync(path.join(dir, 'launch'), 'utf8'),
    /exec '\/b\/sage-mcp' --chrome-native-host '.*mpchr-[^']*\/s\.sock' "\$@"/,
  );
  await until(() => s.relay.extServer?.listening);
  // the profile can't be read here (no Chrome folder): the page still opens, without the code
  await until(async () => (await s.relay.pair()) === 'opened' && opened.at(-1)?.endsWith('#pair=host'));
  // a host asking now gets the claim that page was opened for
  const sock = /exec '\/b\/sage-mcp' --chrome-native-host '([^']*)'/.exec(fs.readFileSync(path.join(dir, 'launch'), 'utf8'))?.[1] as string;
  const answer = JSON.parse(await request(sock, `${JSON.stringify({ type: 'hello', pid: 7, origin: '', request: { type: 'claim' } })}\n`));
  assert.deepEqual(answer, { type: 'claim', code: s.relay.hostClaim() });
  // the extension asking by itself with nothing offered: the question reaches the app's notices
  s.relay.offers.current = null;
  const auto = JSON.parse(
    await request(sock, `${JSON.stringify({ type: 'hello', pid: 7, origin: '', request: { type: 'claim', auto: true } })}\n`),
  );
  assert.equal(auto.pending, true);
  assert.deepEqual(signals, ['status', ['ask', true]]);
  // Try it on the install page reaches the app's opener
  const tried = JSON.parse(
    await request(sock, `${JSON.stringify({ type: 'hello', pid: 7, origin: '', request: { type: 'open', what: 'try' } })}\n`),
  );
  assert.deepEqual([tried, signals.at(-1)], [{ type: 'opened' }, ['open', 'try']]);
  s.stop();
  // a host that fails the checks: the next pages carry the code again
  const refusing = appRelay.setupChromeRelay({
    ...base,
    pairing: memoryPairing({ secret: 'E'.repeat(43), port: 0, paired: false }),
    nativeHost: {
      launcher: path.join(dir, 'launch2'),
      binary: '/b/sage-mcp',
      ids: [STORE],
      folders: [folder],
      verify: async () => 'the host was not started by Google Chrome',
    },
  });
  stops.push(() => refusing.stop());
  await until(() => fs.existsSync(path.join(dir, 'launch2')));
  await until(() => refusing.relay.extServer?.listening);
  // no notices given: the question's signal goes nowhere
  refusing.relay.emit('ask', false);
  const sock2 = /--chrome-native-host '([^']*)'/.exec(fs.readFileSync(path.join(dir, 'launch2'), 'utf8'))?.[1] as string;
  await until(async () => (await refusing.relay.pair()) === 'opened' && opened.at(-1)?.endsWith('#pair=host'));
  assert.equal(
    JSON.parse(await request(sock2, `${JSON.stringify({ type: 'hello', pid: 7, request: { type: 'claim' } })}\n`)).type,
    'refused',
  );
  assert.equal(await refusing.relay.pair(), 'opened');
  assert.match(opened.at(-1) as string, /#pair=mopilot-claim/);
  refusing.stop();
  // the developer default: no ids, no host; files give the pairing
  const warn = mock.method(console, 'debug', () => undefined);
  try {
    const plain = appRelay.setupChromeRelay({
      ...base,
      files: { dir, safeStorage: { isEncryptionAvailable: () => false }, packaged: false },
    });
    stops.push(() => plain.stop());
    await until(() => plain.relay.extServer?.listening);
    assert.equal(await plain.relay.pair(), 'opened');
    assert.match(opened.at(-1) as string, /#pair=mopilot-claim/);
    plain.stop();
    // a host that can't be installed is noted; the extension is still served
    fs.writeFileSync(path.join(dir, 'blocked-file'), 'x');
    const broken = appRelay.setupChromeRelay({
      ...base,
      pairing: memoryPairing(),
      nativeHost: { launcher: path.join(dir, 'blocked-file', 'launch'), binary: '/b', ids: [STORE], folders: [] },
    });
    stops.push(() => broken.stop());
    await until(() => warn.mock.calls.some((c: any) => String(c.arguments[0]).includes('native messaging host')));
    broken.stop();
  } finally {
    warn.mock.restore();
  }
});

test('the channel: Not now keeps the extension’s asks unanswered until Pair; a connected extension raises nothing', async () => {
  const pairing = memoryPairing();
  const opened: string[] = [];
  const ch = new ChromeExtensionChannel({
    pairing,
    openPage: async (u: string) => opened.push(u),
    port: 0,
    connectMs: 30,
    hostRoute: () => true,
  });
  stops.push(() => ch.stop());
  assert.equal(ch.hostClaim({ auto: true }), null, 'nothing paired yet: nothing to ask with');
  await ch.start();
  assert.deepEqual(ch.hostClaim({ auto: true }), { pending: true });
  assert.equal(ch.answerAsk(false), false, 'Not now offers nothing');
  assert.equal(ch.hostClaim({ auto: true }), null, 'declined');
  // Pair in Settings lifts it: a later ask raises the question again
  assert.equal(await ch.pair(), 'opened');
  ch.offers.current = null;
  assert.deepEqual(ch.hostClaim({ auto: true }), { pending: true });
  // the saved pairing went: Allow drops the question but offers nothing
  const saved = pairing.get();
  pairing.set(null);
  assert.equal(ch.answerAsk(true), false);
  assert.equal(ch.status().asking, false);
  pairing.set(saved);
  ch.offers.current = null;
  ch.peer = { open: true } as any;
  assert.equal(ch.hostClaim({ auto: true }), null, 'connected: nothing to ask');
  ch.peer = null;
});

test('the server without an opener opens nothing', async () => {
  const { socket } = await hostServer(stops, {});
  const line = `${JSON.stringify({ type: 'hello', pid: 7, origin: `chrome-extension://${STORE}/`, request: { type: 'open', what: 'try' } })}\n`;
  assert.deepEqual(JSON.parse(await request(socket, line)), { type: 'none', reason: "MoPilot can't open that" });
});
