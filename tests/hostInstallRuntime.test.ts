// The Node a Host runs on (electron/host/nodeRuntime.cjs, installRuntime.cjs) and the PATH its service gets (host/src/loginPath.mjs): the pinned build per platform, this Mac's checked cache, the step that keeps, uploads or downloads it (its shell commands run for real against a scratch home), the machine's own Node as the fallback, and the login shell's PATH in the unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { loginShellPath, withDir } from '../host/src/loginPath.mjs';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
const require = createRequire(import.meta.url);
const { nodeBuild, createRuntimeCache, NODE_VERSION } = require('../electron/host/nodeRuntime.cjs');
const { setUpNode, runtimeCommands, HOST_NODE } = require('../electron/host/installRuntime.cjs');
const { bundleOnce } = require('../electron/host/bundle.cjs');

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const tmp = (t: any) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'host-runtime-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

test('each machine uname maps to the pinned official build, and anything else to none', () => {
  for (const [uname, key] of [
    ['Darwin arm64\n', 'darwin-arm64'],
    ['Darwin x86_64', 'darwin-x64'],
    ['Linux x86_64', 'linux-x64'],
    ['Linux aarch64', 'linux-arm64'],
    ['Linux arm64 extra', 'linux-arm64'],
  ]) {
    const b = nodeBuild(uname);
    assert.equal(b.key, key);
    assert.equal(b.name, `node-${NODE_VERSION}-${key}`);
    assert.equal(b.url, `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-${key}.tar.gz`);
    assert.match(b.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(nodeBuild('Linux armv7l'), null);
  assert.equal(nodeBuild('FreeBSD amd64'), null);
});

test("this Mac's cache: fetched once, kept, refetched when the kept file is damaged, refused when the download does not match", async (t) => {
  const dir = tmp(t);
  const bytes = Buffer.from('node build');
  const build = { key: 'k', file: 'n.tar.gz', sha256: sha(bytes), url: 'https://x/n.tar.gz' };
  const asked: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const cache = createRuntimeCache({
    dir,
    download: async (url: string) => {
      asked.push(url);
      await gate;
      return bytes;
    },
  });
  // two requests at once share one download
  const both = Promise.all([cache.get(build), cache.get(build)]);
  release();
  const [a, b] = await both;
  assert.ok(a.equals(bytes) && b.equals(bytes));
  assert.deepEqual(asked, ['https://x/n.tar.gz']);
  // kept: no second download
  assert.ok((await cache.get(build)).equals(bytes));
  assert.equal(asked.length, 1);
  // a damaged file is fetched again
  fs.writeFileSync(path.join(dir, 'n.tar.gz'), 'damaged');
  assert.ok((await cache.get(build)).equals(bytes));
  assert.equal(asked.length, 2);
  // a download that does not match is refused and not kept
  const bad = createRuntimeCache({ dir: path.join(dir, 'bad'), download: async () => Buffer.from('evil') });
  await assert.rejects(bad.get(build), /does not match its checksum \(n\.tar\.gz\)/);
  assert.ok(!fs.existsSync(path.join(dir, 'bad', 'n.tar.gz')));
});

test('the default download asks nodejs.org and refuses an error answer', async (t) => {
  const bytes = Buffer.from('from the web');
  const build = { key: 'w', file: 'w.tar.gz', sha256: sha(bytes), url: 'https://nodejs.org/x' };
  const real = globalThis.fetch;
  t.after(() => (globalThis.fetch = real));
  globalThis.fetch = (async () => new Response(bytes)) as any;
  assert.ok((await createRuntimeCache({ dir: tmp(t) }).get(build)).equals(bytes));
  globalThis.fetch = (async () => new Response('', { status: 404 })) as any;
  await assert.rejects(createRuntimeCache({ dir: tmp(t) }).get(build), /nodejs\.org answered 404/);
});

/** A machine for setUpNode, answering by which runtime command it was given. */
function runner(answers: Record<string, any>) {
  const ran: { which: string; input?: Buffer }[] = [];
  const c = runtimeCommands(nodeBuild('Linux x86_64'));
  const run = async (command: string, input?: Buffer) => {
    const which = Object.keys(c).find((k) => c[k] === command) as string;
    ran.push({ which, input });
    const answer = answers[which];
    return { code: 0, stdout: '', stderr: '', ...(typeof answer === 'function' ? answer() : answer) };
  };
  return { ran, run, order: () => ran.map((r) => r.which) };
}

test('setting up Node: kept, uploaded from the cache, or downloaded on the machine, each said in the step', async () => {
  const kept = runner({ have: { stdout: 'have\n' } });
  assert.deepEqual(await setUpNode({ run: kept.run, uname: 'Linux x86_64', cache: null }), {
    ok: true,
    output: `Node ${NODE_VERSION}, already on the machine`,
  });
  assert.deepEqual(kept.order(), ['have']);

  const bytes = Buffer.alloc(3 * 1024 * 1024 + 1);
  const up = runner({ have: { stdout: 'need\n' }, place: { stdout: 'placed\n' } });
  const out = await setUpNode({ run: up.run, uname: 'Linux x86_64', cache: { get: async () => bytes } });
  assert.deepEqual(out, { ok: true, output: `Node ${NODE_VERSION}, uploaded from this Mac (4 MB)` });
  assert.deepEqual(up.order(), ['have', 'upload', 'place']);
  assert.equal(up.ran[1].input, bytes);

  // the cache cannot get it: the machine downloads it
  const down = runner({ have: { stdout: 'need' }, place: { stdout: 'placed' } });
  const d = await setUpNode({ run: down.run, uname: 'Linux x86_64', cache: { get: async () => Promise.reject(new Error('offline')) } });
  assert.deepEqual(
    [d, down.order()],
    [{ ok: true, output: `Node ${NODE_VERSION}, downloaded on the machine` }, ['have', 'download', 'place']],
  );

  // the upload fails (a full disk): the machine downloads it, and when that fails too both reasons are given
  const full = runner({ have: { stdout: 'need' }, upload: { code: 1, stderr: 'No space left' }, download: { code: 1, stderr: 'no curl' } });
  const f = await setUpNode({ run: full.run, uname: 'Linux x86_64', cache: { get: async () => bytes } });
  assert.equal(f.ok, false);
  assert.equal(f.output, `Neither this Mac nor the machine could get Node ${NODE_VERSION}.\nNo space left\nno curl`);
  const none = runner({ have: { stdout: 'need' }, download: { code: 1 } });
  assert.equal(
    (await setUpNode({ run: none.run, uname: 'Linux x86_64', cache: null })).output,
    `Neither this Mac nor the machine could get Node ${NODE_VERSION}.\n`,
  );
});

test('an upload damaged on the way fails the checksum, and the machine downloads it instead', async () => {
  let tries = 0;
  const damaged = runner({
    have: { stdout: 'need' },
    place: () =>
      ++tries === 1 ? { code: 1, stderr: 'The Node archive on the machine does not match its checksum.' } : { stdout: 'placed' },
  });
  const out = await setUpNode({ run: damaged.run, uname: 'Linux x86_64', cache: { get: async () => Buffer.from('x') } });
  assert.deepEqual(out, { ok: true, output: `Node ${NODE_VERSION}, downloaded on the machine` });
  assert.deepEqual(damaged.order(), ['have', 'upload', 'place', 'download', 'place']);
  // both fail: the step says why the second time
  const twice = runner({ have: { stdout: 'need' }, place: { code: 1, stderr: 'still damaged' } });
  assert.deepEqual(await setUpNode({ run: twice.run, uname: 'Linux x86_64', cache: { get: async () => Buffer.from('x') } }), {
    ok: false,
    output: 'still damaged',
  });
});

test("setting up Node: an archive that does not unpack fails the step; a build that cannot run falls back to the machine's Node 22+", async () => {
  const bad = runner({
    have: { stdout: 'need' },
    place: { code: 1, stderr: 'The Node archive on the machine does not match its checksum.' },
  });
  assert.deepEqual(await setUpNode({ run: bad.run, uname: 'Linux x86_64', cache: null }), {
    ok: false,
    output: 'The Node archive on the machine does not match its checksum.',
  });
  const silent = runner({ have: { stdout: 'need' }, place: { code: 2 } });
  assert.match((await setUpNode({ run: silent.run, uname: 'Linux x86_64', cache: null })).output, /could not be unpacked/);
  const own = runner({ have: { stdout: 'need' }, place: { stdout: 'cannot-run\n' }, system: { stdout: 'v22.9.0\n' } });
  assert.deepEqual(await setUpNode({ run: own.run, uname: 'Linux x86_64', cache: null }), {
    ok: true,
    output: `Node ${NODE_VERSION} does not run here; using the machine's Node v22.9.0`,
  });
  const neither = runner({ have: { stdout: 'need' }, place: { stdout: 'cannot-run' }, system: { code: 1 } });
  assert.match((await setUpNode({ run: neither.run, uname: 'Linux x86_64', cache: null })).output, /glibc 2\.28 or newer.*no Node 22/);
  assert.deepEqual(await setUpNode({ run: neither.run, uname: 'Linux armv7l\n', cache: null }), {
    ok: false,
    output: 'MoPilot needs a 64-bit Intel or ARM machine; this one is Linux armv7l.',
  });
});

test('the runtime commands work in a real shell: need, upload, verify, unpack, link, keep; a bad archive is removed; the fallback links the login shell’s node', (t) => {
  const home = tmp(t);
  const work = tmp(t);
  const name = 'node-vT-linux-x64';
  fs.mkdirSync(path.join(work, name, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(work, name, 'bin', 'node'), '#!/bin/sh\necho vT\n', { mode: 0o755 });
  assert.equal(spawnSync('tar', ['-czf', path.join(work, 'n.tgz'), '-C', work, name]).status, 0);
  const archive = fs.readFileSync(path.join(work, 'n.tgz'));
  const build = { version: 'vT', name, file: `${name}.tar.gz`, sha256: sha(archive), url: 'https://nodejs.org/none' };
  const c = runtimeCommands(build);
  const sh = (command: string, input?: Buffer, env: Record<string, string> = {}) =>
    spawnSync('/bin/sh', ['-c', command], { env: { HOME: home, PATH: process.env.PATH, ...env }, input, encoding: 'utf8' });

  assert.equal(sh(c.have).stdout.trim(), 'need');
  assert.equal(sh(c.upload, archive).status, 0);
  const placed = sh(c.place);
  assert.equal(placed.stdout.trim(), 'placed', placed.stderr);
  assert.equal(
    fs.realpathSync(path.join(home, '.mopilot-host/runtime/current')),
    fs.realpathSync(path.join(home, '.mopilot-host/runtime', name)),
  );
  assert.ok(!fs.existsSync(path.join(home, '.mopilot-host/runtime/incoming', build.file)), 'the archive is removed once unpacked');
  assert.equal(sh(c.have).stdout.trim(), 'have');
  assert.equal(sh(`"${HOST_NODE}" --version`).stdout.trim(), 'vT');

  // a damaged upload is refused and removed
  sh(c.upload, Buffer.from('damaged'));
  const refused = sh(c.place);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /does not match its checksum/);
  assert.ok(!fs.existsSync(path.join(home, '.mopilot-host/runtime/incoming', build.file)));

  // a build that does not start reads as cannot-run
  const broken = { ...build, version: 'vOther' };
  sh(c.upload, archive);
  assert.equal(sh(runtimeCommands(broken).place).stdout.trim(), 'cannot-run');

  // the fallback: the login shell's node, 22 or newer, linked as current; an older one is refused
  const own = path.join(work, 'own-node');
  fs.writeFileSync(own, '#!/bin/sh\ncase "$1" in -p) echo "$MAJOR";; *) echo v$MAJOR.1.0;; esac\n', { mode: 0o755 });
  const shell = path.join(work, 'login-shell');
  fs.writeFileSync(shell, `#!/bin/sh\necho noise\necho ${own}\n`, { mode: 0o755 });
  const ok = sh(c.system, undefined, { SHELL: shell, MAJOR: '22' });
  assert.equal(ok.stdout.trim(), 'v22.1.0', ok.stderr);
  assert.equal(fs.realpathSync(path.join(home, '.mopilot-host/runtime/current/bin/node')), fs.realpathSync(own));
  assert.equal(sh(c.system, undefined, { SHELL: shell, MAJOR: '20' }).status, 1);
  assert.equal(sh(c.system, undefined, { SHELL: path.join(work, 'no-shell') }).status, 1);
});

test("the service's PATH is the login shell's, read past the startup files' noise; anything unreadable keeps the given PATH", () => {
  const said =
    (stdout: any, status = 0) =>
    () =>
      ({ stdout, status }) as any;
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' };
  assert.equal(
    loginShellPath({ env, spawn: said('Welcome!\n__MOPILOT_PATH__\n/opt/homebrew/bin:/usr/bin\n') }),
    '/opt/homebrew/bin:/usr/bin',
  );
  assert.equal(loginShellPath({ env, spawn: said('__MOPILOT_PATH__\n/a\n', 1) }), '/usr/bin:/bin');
  // a startup file that printed without a newline: the marker ends that line
  assert.equal(loginShellPath({ env, spawn: said('\u001b]0;title\u0007__MOPILOT_PATH__\n/opt/x:/usr/bin\n') }), '/opt/x:/usr/bin');
  assert.equal(loginShellPath({ env, spawn: said('no marker\n') }), '/usr/bin:/bin');
  assert.equal(loginShellPath({ env, spawn: said('__MOPILOT_PATH__\n\n') }), '/usr/bin:/bin');
  assert.equal(loginShellPath({ env, spawn: said(null) }), '/usr/bin:/bin');
  assert.equal(loginShellPath({ env: { SHELL: '/bin/zsh' }, spawn: said(null) }), '');
  // no SHELL: nothing is spawned
  assert.equal(loginShellPath({ env: { PATH: '/p' }, spawn: () => assert.fail('spawned') }), '/p');
  assert.equal(loginShellPath({ env: {} }), '');
  assert.equal(withDir('/a:/b', '/n'), '/a:/b:/n');
  assert.equal(withDir('/a:/n', '/n'), '/a:/n');
  assert.equal(withDir('', '/n'), '/n');
});

test('`mopilot-host install` writes the login shell PATH and its own Node folder into the unit', async (t) => {
  const home = tmp(t);
  const shell = path.join(home, 'sh');
  fs.writeFileSync(shell, '#!/bin/sh\necho hi\necho __MOPILOT_PATH__\necho /opt/homebrew/bin:/usr/bin\n', { mode: 0o755 });
  const out: string[] = [];
  const env = { SHELL: shell, PATH: '/usr/bin', XDG_CONFIG_HOME: path.join(home, '.config') };
  assert.equal(
    await main(['install', '--data-dir', path.join(home, 'd')], {
      out: (l: string) => out.push(l),
      err: () => {},
      env,
      home,
      platform: 'linux',
    }),
    0,
  );
  const unit = fs.readFileSync(path.join(home, '.config/systemd/user/mopilot-host.service'), 'utf8');
  assert.match(
    unit,
    new RegExp(
      `^Environment="PATH=/opt/homebrew/bin:/usr/bin:${path.dirname(process.execPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`,
      'm',
    ),
  );
});

test('the Host tarball is built once per app run', (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'host/bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'host/package.json'), JSON.stringify({ version: '0.0.1' }));
  fs.writeFileSync(path.join(root, 'host/bin/mopilot-host.mjs'), 'export {};');
  const once = bundleOnce({ root, outDir: path.join(root, 'out') });
  assert.equal(once(), once());
});
