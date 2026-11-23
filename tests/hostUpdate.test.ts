// `mopilot-host update` (host/src/update.mjs): a checksum-verified, content-addressed version is staged, the Host restarts into it only when idle, and its harness children die with it.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { main } from '../host/src/cli.mjs';
import { createLogin } from '../host/src/login.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { askHost, callHost, startServer } from '../host/src/server.mjs';
import { line } from './support/host-line.ts';
import { createRequire } from 'node:module';
import { activeCli, createUpdater, markHealthy, stageUpdate, updatePaths } from '../host/src/update.mjs';
import { TRUST, signedFacts, trustDataDir } from './support/hostUpdateKit.ts';

import { coreLoads, writeHostCore } from './support/hostCoreFixture.ts';
import { keySafe } from './support/hostKeySafe.ts';
const { loadIdentity, pairWith } = createRequire(import.meta.url)('../electron/host/pairingClient.cjs');
const ROOT = path.join(import.meta.dirname, '..');
const AGENT = path.join(ROOT, 'tests/fixtures/fake-acp-agent.mjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-update-')));
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
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A Host version archive whose cli records which run it was, plus a manifest beside it. */
function release(
  version: string,
  {
    cli = `export async function main(argv, io) { (await import('node:fs')).writeFileSync(process.env.MARK ?? '/dev/null', '${version}:' + (io.delegated ?? '')); return 0; }\n`,
  } = {},
) {
  const dir = mk('rel');
  fs.mkdirSync(path.join(dir, 'pkg/src'), { recursive: true });
  if (cli) fs.writeFileSync(path.join(dir, 'pkg/src/cli.mjs'), cli);
  else fs.writeFileSync(path.join(dir, 'pkg/README'), 'no cli');
  writeHostCore(path.join(dir, 'pkg'));
  spawnSync('tar', ['-czf', path.join(dir, 'host.tgz'), '-C', path.join(dir, 'pkg'), '.']);
  const bytes = fs.readFileSync(path.join(dir, 'host.tgz'));
  const manifest = path.join(dir, 'manifest.json');
  const facts = { version, sha256: sha(bytes), url: 'host.tgz' };
  /** Writes the manifest signed for `hostId` (the tests' Host unless another is named). */
  const sign = (hostId?: string) => fs.writeFileSync(manifest, JSON.stringify(signedFacts(facts, { hostId })));
  sign();
  return { dir, bytes, manifest, sha256: sha(bytes), facts, sign };
}
const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: {} } };
};

test('stageUpdate keeps an archive only when its checksum is the manifest’s, once per content', async () => {
  const dataDir = mk('d');
  const r = release('1.2.0');
  const staged = await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  assert.deepEqual(staged, { version: '1.2.0', sha256: r.sha256, staged: true });
  const p = updatePaths(dataDir);
  assert.ok(fs.existsSync(path.join(p.version(r.sha256), 'src/cli.mjs')));
  assert.ok(fs.existsSync(p.blob(r.sha256)));
  assert.deepEqual(JSON.parse(fs.readFileSync(p.next, 'utf8')), { version: '1.2.0', sha256: r.sha256 });
  // the same content is not fetched again
  fs.rmSync(path.join(r.dir, 'host.tgz'));
  assert.equal((await stageUpdate({ source: r.manifest, dataDir, ...TRUST })).staged, false);

  // a download that is not what the manifest promised is not kept
  const bad = release('1.3.0');
  fs.writeFileSync(bad.manifest, JSON.stringify(signedFacts({ version: '1.3.0', sha256: 'a'.repeat(64), url: 'host.tgz' })));
  const other = mk('d');
  await assert.rejects(stageUpdate({ source: bad.manifest, dataDir: other, ...TRUST }), /checksum/);
  assert.equal(fs.existsSync(updatePaths(other).root), false);
  // something that is not a Host version, an unreadable archive, and a manifest without the fields (nothing it says is trusted)
  const noCli = release('1.4.0', { cli: '' });
  await assert.rejects(stageUpdate({ source: noCli.manifest, dataDir: other, ...TRUST }), /not a Host version/);
  assert.deepEqual(fs.readdirSync(path.join(updatePaths(other).root, 'versions')), []);
  fs.writeFileSync(path.join(noCli.dir, 'host.tgz'), 'not a tarball');
  fs.writeFileSync(
    noCli.manifest,
    JSON.stringify(signedFacts({ version: '1', sha256: sha(Buffer.from('not a tarball')), url: 'host.tgz' })),
  );
  await assert.rejects(stageUpdate({ source: noCli.manifest, dataDir: other, ...TRUST }), /could not be unpacked/);
  fs.writeFileSync(noCli.manifest, JSON.stringify({ version: '1' }));
  await assert.rejects(stageUpdate({ source: noCli.manifest, dataDir: other, ...TRUST }), /not signed by a key this Host trusts/);
});

test('stageUpdate reads https sources through the fetch it is given, and refuses a failed fetch', async () => {
  const r = release('2.0.0');
  const dataDir = mk('d');
  const calls: string[] = [];
  const fetchFn: any = async (url: string) => {
    calls.push(url);
    if (url.endsWith('/missing')) return { ok: false, status: 404, headers: { get: () => null } };
    const body = url.endsWith('manifest.json')
      ? Buffer.from(JSON.stringify(signedFacts({ version: '2.0.0', sha256: r.sha256, url: 'https://updates.example.test/host.tgz' })))
      : r.bytes;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: (async function* () {
        yield body;
      })(),
    };
  };
  assert.equal((await stageUpdate({ source: 'https://updates.example.test/manifest.json', dataDir, fetchFn, ...TRUST })).staged, true);
  assert.deepEqual(calls, ['https://updates.example.test/manifest.json', 'https://updates.example.test/host.tgz']);
  await assert.rejects(stageUpdate({ source: 'https://updates.example.test/missing', dataDir, fetchFn, ...TRUST }), /404/);
});

test('activeCli finds a version only while its files exist', async () => {
  const dataDir = mk('d');
  assert.equal(activeCli(dataDir), null);
  const r = release('3.0.0');
  await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  const p = updatePaths(dataDir);
  assert.equal(activeCli(dataDir), null, 'staged, not yet active');
  fs.copyFileSync(p.next, p.active);
  assert.equal(activeCli(dataDir)?.version, '3.0.0');
  fs.writeFileSync(p.active, '{"sha256":"nope"}');
  assert.equal(activeCli(dataDir), null);
  fs.writeFileSync(p.active, '{bad');
  assert.equal(activeCli(dataDir), null);
  fs.writeFileSync(p.active, JSON.stringify({ version: '9', sha256: 'b'.repeat(64) }));
  assert.equal(activeCli(dataDir), null, 'its files are gone');
});

test('a staged version that never serves is dropped after a few starts, and one that serves is cleared', async () => {
  const dataDir = mk('d');
  const p = updatePaths(dataDir);
  markHealthy(dataDir);
  assert.equal(fs.existsSync(p.active), false);
  const r = release('5.5.0');
  await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  fs.copyFileSync(p.next, p.active);
  assert.ok(activeCli(dataDir));
  assert.ok(activeCli(dataDir));
  markHealthy(dataDir);
  assert.equal(JSON.parse(fs.readFileSync(p.active, 'utf8')).tries, 0);
  for (let i = 0; i < 3; i++) assert.ok(activeCli(dataDir));
  assert.equal(activeCli(dataDir), null, 'three starts without serving: the base code runs instead');
});

test('an update that cannot be activated leaves the Host up', async () => {
  const dataDir = mk('d');
  const p = updatePaths(dataDir);
  const r = release('5.6.0');
  await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  let restarts = 0;
  const u = createUpdater({ dataDir, idle: () => true, restart: () => restarts++ });
  const rename = mock.method(fs, 'renameSync', () => {
    throw new Error('disk full');
  });
  try {
    assert.equal(u.request().state, 'waiting');
  } finally {
    rename.mock.restore();
  }
  assert.equal(restarts, 0);
  assert.equal(u.restarting, false);
  assert.ok(fs.existsSync(p.next));
});

test('the updater restarts only when idle, takes no new work meanwhile, and activates the version at that moment', async () => {
  const dataDir = mk('d');
  const p = updatePaths(dataDir);
  let idle = false;
  let restarts = 0;
  const u = createUpdater({ dataDir, idle: () => idle, restart: () => restarts++, pollMs: 10 });
  assert.deepEqual(u.request(), { state: 'none' });
  const r = release('4.0.0');
  await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  assert.equal(u.restarting, false);
  assert.deepEqual(u.request(), { state: 'waiting', version: '4.0.0' });
  assert.equal(u.restarting, true);
  assert.deepEqual(u.request(), { state: 'waiting', version: '4.0.0' }, 'asking again joins');
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(restarts, 0);
  assert.equal(fs.existsSync(p.active), false, 'a busy Host keeps its version');
  idle = true;
  await until(() => restarts === 1);
  assert.equal(JSON.parse(fs.readFileSync(p.active, 'utf8')).version, '4.0.0');
  assert.equal(fs.existsSync(p.next), false);
  u.close();
  assert.equal(u.restarting, false);
  // idle at the request: it goes at once
  await stageUpdate({ source: r.manifest, dataDir, ...TRUST });
  fs.rmSync(p.active);
  const now = createUpdater({ dataDir, idle: () => true, restart: () => restarts++ });
  assert.equal(now.request().state, 'restarting');
  assert.equal(restarts, 2);
  now.close();
  // a pointer to a version that is gone is nothing to restart into
  fs.writeFileSync(p.next, JSON.stringify({ version: '5', sha256: 'c'.repeat(64) }));
  assert.equal(createUpdater({ dataDir, idle: () => true, restart: () => {} }).request().state, 'none');
});

test('runtime and sign-in report idle only when nothing is running or starting', async () => {
  const dir = mk('rt');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's') } } }),
  );
  const runtime = createAcpRuntime({
    paths: createPaths({ dataDir: dir, env: {} }),
    env: {},
    hostOptions: { cancelRetryMs: 5, cancelForceMs: 5000 },
  });
  const login = createLogin({ runtime });
  try {
    assert.equal(runtime.idle() && login.idle(), true);
    const sending = runtime.send({ key: 'acp:fake:i', text: 'SLOW', cwd: dir, progressMs: 100 });
    assert.equal(runtime.idle(), false, 'a send still starting counts');
    const { turnId } = await sending;
    assert.equal(runtime.idle(), false, 'so does a running turn');
    await until(() => runtime.turn(turnId)?.state === 'ended');
    assert.equal(runtime.idle(), true);
  } finally {
    runtime.close();
  }
});

test('serve restarts into a staged version when asked, once idle, and refuses new work meanwhile', async () => {
  const dir = mk('srv');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's') } } }),
  );
  const paths = createPaths({ dataDir: dir, env: {} });
  const signals: any = new EventEmitter();
  const unref = { unref: () => {} };
  const spawnFn: any = mock.fn(() => unref);
  const o = io();
  const running = main(['serve', '--data-dir', dir], { ...o.io, signals, spawnFn, updatePollMs: 20 });
  await until(() => o.out.some((l) => l.includes('serving')));
  const r = release('6.0.0');
  // a turn is running: the update waits for it
  // (a chat is served only to a client the Host paired)
  await until(() => o.out.some((l) => l.startsWith('Pairing code: ')));
  const conn = line(paths.socketPath);
  await pairWith(
    conn.request,
    loadIdentity(path.join(base, 'serve-app.json'), keySafe),
    o.out.find((l) => l.startsWith('Pairing code: '))!.slice(14),
  );
  const sent: any = await conn.request('send', { key: 'acp:fake:u', text: 'SLOW', cwd: dir, progressMs: 400 });
  assert.equal(((await callHost(paths.socketPath, 'update')) as any).result.state, 'none', 'nothing staged yet');
  const cli = io();
  r.sign(trustDataDir(dir));
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...cli.io, coreLoads }), 0);
  assert.match(cli.out.join('\n'), /Staged version 6\.0\.0/);
  assert.match(cli.out.join('\n'), /as soon as it is idle/);
  const refused: any = await conn.call('send', { key: 'acp:fake:v', text: 'hi', cwd: dir });
  assert.match(refused.error, /restarting for an update/);
  assert.match(((await callHost(paths.socketPath, 'login', { harness: 'fake' })) as any).error, /restarting/);
  assert.equal(((await callHost(paths.socketPath, 'ping')) as any).result, 'pong');
  conn.close();
  // the watchdog ends the turn, the Host goes idle and leaves
  assert.equal(await running, 0);
  assert.equal(spawnFn.mock.calls.length, 1);
  const [exe, args, opts] = spawnFn.mock.calls[0].arguments;
  assert.equal(exe, process.execPath);
  assert.deepEqual(args.slice(1), ['serve', '--data-dir', dir]);
  assert.match(args[0], /host[\\/]bin[\\/]mopilot-host\.mjs$/);
  assert.deepEqual(opts, { detached: true, stdio: 'ignore' });
  assert.equal(JSON.parse(fs.readFileSync(updatePaths(dir).active, 'utf8')).version, '6.0.0');
  assert.equal(fs.existsSync(paths.socketPath), false);
  assert.ok(sent.turnId);

  // the next `serve` runs the staged version, not this code
  const mark = path.join(dir, 'mark');
  const delegated = io();
  const old = process.env.MARK;
  process.env.MARK = mark;
  try {
    assert.equal(await main(['serve', '--data-dir', dir], { ...delegated.io }), 0);
  } finally {
    if (old === undefined) delete process.env.MARK;
    else process.env.MARK = old;
  }
  assert.equal(fs.readFileSync(mark, 'utf8'), '6.0.0:6.0.0');
});

test('a delegated serve does not look for a version again, and reports the version it runs', async () => {
  const dir = mk('del');
  const r = release('8.0.0');
  await stageUpdate({ source: r.manifest, dataDir: dir, ...TRUST });
  fs.copyFileSync(updatePaths(dir).next, updatePaths(dir).active);
  const paths = createPaths({ dataDir: dir, env: {} });
  const signals: any = new EventEmitter();
  const o = io();
  const running = main(['serve', '--data-dir', dir], { ...o.io, signals, delegated: '8.0.0' });
  await until(() => o.out.some((l) => l.includes('serving')));
  assert.equal(((await askHost(paths.socketPath, 'status')) as any).version, '8.0.0');
  signals.emit('SIGTERM');
  assert.equal(await running, 0);
});

test('mopilot-host update: usage, a failed fetch, no Host running, and a Host that is idle', async () => {
  const dir = mk('cli');
  const hostId = trustDataDir(dir);
  for (const argv of [['update'], ['update', '--manifest']]) {
    const o = io();
    assert.equal(await main([...argv, '--data-dir', dir], o.io), 1);
    assert.match(o.err[0], /Usage/);
  }
  const bad = io();
  assert.equal(await main(['update', '--manifest', path.join(dir, 'nope.json'), '--data-dir', dir], bad.io), 1);
  assert.match(bad.err[0], /ENOENT/);
  const text = io();
  const failing: any = async () => {
    throw 'offline';
  };
  assert.equal(
    await main(['update', '--manifest', 'https://updates.example.test/m.json', '--data-dir', dir], { ...text.io, fetchFn: failing }),
    1,
  );
  assert.equal(text.err[0], 'offline');

  const r = release('7.0.0');
  r.sign(hostId);
  const none = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...none.io, coreLoads }), 0);
  assert.match(none.out.join('\n'), /Staged version 7\.0\.0/);
  assert.match(none.out.join('\n'), /No Host is running/);
  const again = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...again.io, coreLoads }), 0);
  assert.match(again.out[0], /already here/);

  // an idle Host is told to restart now
  const paths = createPaths({ dataDir: dir, env: {} });
  let restarted = false;
  const updater = createUpdater({ dataDir: dir, idle: () => true, restart: () => (restarted = true) });
  const server = await startServer({ paths, updater, runningVersion: '7.0.0' });
  const idle = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...idle.io, coreLoads }), 0);
  assert.match(idle.out.at(-1) as string, /idle and restarts now/);
  assert.equal(restarted, true);
  assert.equal(((await askHost(paths.socketPath, 'status')) as any).version, '7.0.0');
  updater.close();
  await server.close();
});

test('the Host’s harness children die with it', async () => {
  const dir = mk('kids');
  fs.writeFileSync(
    path.join(dir, 'harnesses.json'),
    JSON.stringify({ fake: { label: 'Fake', bin: process.execPath, args: [AGENT], env: { FAKE_ACP_STATE: path.join(dir, 's') } } }),
  );
  const child = spawn(process.execPath, [path.join(ROOT, 'host/bin/mopilot-host.mjs'), 'serve', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  let printed = '';
  child.stdout.on('data', (c) => (printed += c));
  await until(() => /Pairing code: \S+/.test(printed));
  const sock = createPaths({ dataDir: dir, env: {} }).socketPath;
  // the Host serves a chat only to a client it paired
  const conn = line(sock);
  await pairWith(conn.request, loadIdentity(path.join(base, 'kids-app.json'), keySafe), /Pairing code: (\S+)/.exec(printed)![1]);
  await conn.request('send', { key: 'acp:fake:k', text: 'SLOW', cwd: dir });
  conn.close();
  const kids = await until(() => {
    const found = spawnSync('pgrep', ['-P', String(child.pid)], { encoding: 'utf8' })
      .stdout.split('\n')
      .filter(Boolean)
      .map(Number);
    return found.length ? found : null;
  });
  child.kill('SIGTERM');
  await exited;
  await until(() => kids.every((pid: number) => spawnSync('kill', ['-0', String(pid)]).status !== 0));
});

test('under a supervisor the Host exits for the update without starting a copy of itself', async () => {
  const dir = mk('sup');
  const paths = createPaths({ dataDir: dir, env: {} });
  const signals: any = new EventEmitter();
  const spawnFn: any = mock.fn();
  const o = io();
  const running = main(['serve', '--data-dir', dir], {
    ...o.io,
    env: { MOPILOT_HOST_SUPERVISED: '1' },
    signals,
    spawnFn,
    updatePollMs: 20,
  });
  await until(() => o.out.some((l) => l.includes('serving')));
  await stageUpdate({ source: release('9.0.0').manifest, dataDir: dir, ...TRUST });
  await callHost(paths.socketPath, 'update');
  assert.equal(await running, 0);
  assert.equal(spawnFn.mock.calls.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(updatePaths(dir).active, 'utf8')).version, '9.0.0');
});

test('an idle Host that restarts for an update has told the caller first, not hung up on it', async () => {
  const dir = mk('srv-idle');
  const signals: any = new EventEmitter();
  const spawnFn: any = mock.fn(() => ({ unref: () => {} }));
  const o = io();
  const running = main(['serve', '--data-dir', dir], { ...o.io, signals, spawnFn, updatePollMs: 20 });
  await until(() => o.out.some((l) => l.includes('serving')));
  const r = release('6.1.0');
  r.sign(trustDataDir(dir));
  const cli = io();
  assert.equal(await main(['update', '--manifest', r.manifest, '--data-dir', dir], { ...cli.io, coreLoads }), 0);
  assert.match(cli.out.join('\n'), /Staged version 6\.1\.0/);
  assert.match(cli.out.at(-1) as string, /idle and restarts now/);
  assert.equal(await running, 0);
});

test('the updater says whether the Host is idle, for the app to ask before it updates or removes the machine', () => {
  let busy = true;
  const u = createUpdater({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'idle-')), idle: () => !busy, restart: () => undefined });
  assert.equal(u.isIdle(), false);
  busy = false;
  assert.equal(u.isIdle(), true);
});
