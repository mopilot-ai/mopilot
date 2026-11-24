// The Host tarball (electron/host/bundle.cjs): the files the executable reaches and the packages those need, deterministic bytes, the update format and the manifest, a bundle that runs on its own outside the repository, and refusal of a gap in the archive (B1, B2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { hostStatus } from '../host/src/status.mjs';
// @ts-ignore: plain ESM without declarations
import { addonLoads, stageUpdate } from '../host/src/update.mjs';
import { coreBuildHere } from '../shared/host/coreBuild.mjs';
import { TRUST, signedFacts } from './support/hostUpdateKit.ts';
import { waitFor } from './support/waitFor.ts';
const require = createRequire(import.meta.url);
const {
  buildBundle,
  bundleOnce,
  hostFiles,
  tarball,
  appHostBuild,
  appHostVersion,
  HOST_CORE_HASH_FILE,
} = require('../electron/host/bundle.cjs');
const { checkoutCore } = require('../electron/platform/core.cjs');

const ROOT = path.join(import.meta.dirname, '..');
const tmp = (t: any, tag = 'bundle') => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`)));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const write = (root: string, rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
/** A repository root with the Host's entry and `files` (path → text). */
function fake(t: any, files: Record<string, string>) {
  const root = tmp(t, 'fake-root');
  write(root, 'host/package.json', JSON.stringify({ name: 'mopilot-host', version: '9.9.9' }));
  for (const [p, text] of Object.entries(files)) write(root, p, text);
  return root;
}
const ENTRY = 'host/bin/mopilot-host.mjs';
const extract = (file: string, into: string) => assert.equal(spawnSync('tar', ['-xzf', file, '-C', into]).status, 0);

test('the bundle of this repository has the Host, what it reaches and the packages it needs, in the update format, with the same bytes every time', (t) => {
  const out = tmp(t);
  const a = buildBundle({ root: ROOT, outDir: path.join(out, 'a') });
  const b = buildBundle({ root: ROOT, outDir: path.join(out, 'b') });
  assert.equal(a.sha256, b.sha256, 'the same tree is the same checksum');
  assert.ok(a.files > 100);
  const manifest = JSON.parse(fs.readFileSync(a.manifest, 'utf8'));
  assert.deepEqual(manifest, { version: a.version, sha256: a.sha256, url: path.basename(a.file) });
  assert.match(path.basename(a.file), /^host-[\d.]+-[0-9a-f]{12}\.tgz$/);
  const listed = spawnSync('tar', ['-tzf', a.file], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
  assert.ok(listed.includes('src/cli.mjs'), 'the shim `update` unpacks');
  for (const f of [ENTRY, 'host/src/cli.mjs', 'host/package.json', 'shared/host/schema.mjs', 'electron/harness/acp.cjs'])
    assert.ok(listed.includes(f), f);
  // the view contract is split into modules the walker follows by their explicit paths: all of them are in the bundle (a .ts file is shipped as .mjs, with its import paths rewritten)
  for (const f of ['shared/momoView.mjs', 'shared/momoViewBase.mjs', 'shared/momoViewRows.mjs', 'shared/momoViewLists.mjs'])
    assert.ok(listed.includes(f), f);
  assert.ok(
    listed.some((f: string) => f.startsWith('node_modules/mdast-util-from-markdown/')),
    'a package the Host imports',
  );
  assert.ok(!listed.some((f: string) => /^(?:src|tests|mobile|web)\//.test(f) && f !== 'src/cli.mjs'), 'nothing of the app');
  assert.deepEqual(hostFiles(ROOT), [...hostFiles(ROOT)].sort());
});

test('unpacked on its own, outside the repository, it answers status and serves', async (t) => {
  const out = tmp(t);
  const built = buildBundle({ root: ROOT, outDir: out });
  const home = tmp(t, 'target');
  extract(built.file, home);
  const data = path.join(home, 'data');
  const status = spawnSync(process.execPath, [path.join(home, ENTRY), 'status', '--data-dir', data], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.running, false);
  assert.match(parsed.socketPath, /\.sock$/);
  // the Host says which build it is, and the app computes the same id from its own files
  assert.equal(parsed.build, built.buildId);
  assert.equal(appHostBuild(ROOT), built.buildId);
  // and which app version carried it: the order of two builds, which a hash cannot give (#4923)
  assert.equal(parsed.appVersion, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(appHostVersion(ROOT), parsed.appVersion);
  assert.equal(appHostVersion(path.join(home, 'nowhere')), '');
  // the process starts, listens and prints its pairing code, and stops on SIGTERM
  const child = spawn(process.execPath, [path.join(home, ENTRY), 'serve', '--data-dir', data], { stdio: ['ignore', 'pipe', 'pipe'] });
  let printed = '';
  child.stdout.on('data', (c) => (printed += c));
  let errs = '';
  child.stderr.on('data', (c) => (errs += c));
  const exited = new Promise((r) => child.on('exit', r));
  await waitFor(() => /Pairing code: /.test(printed) || child.exitCode !== null, 'the pairing code or exit');
  assert.match(printed, /Host serving on[\s\S]*Pairing code: /, errs);
  child.kill('SIGTERM');
  await exited;
});

test('`mopilot-host update` takes the manifest and runs the version it staged', async (t) => {
  const out = tmp(t);
  const coreRoot = tmp(t, 'cores');
  write(coreRoot, `${coreBuildHere()}/mopilot_core.node`, 'an addon');
  const built = buildBundle({ root: ROOT, outDir: out, build: coreBuildHere(), coreRoot });
  const data = tmp(t, 'data');
  // the bundle's manifest is unsigned; the app signs one for the Host it updates (electron/host/hostUpdate.cjs)
  fs.writeFileSync(built.manifest, JSON.stringify(signedFacts(JSON.parse(fs.readFileSync(built.manifest, 'utf8')))));
  const staged = await stageUpdate({ source: built.manifest, dataDir: data, ...TRUST });
  assert.deepEqual([staged.version, staged.sha256, staged.staged], [built.version, built.sha256, true]);
  const cli = path.join(data, 'updates', 'versions', built.sha256, 'src', 'cli.mjs');
  assert.ok(fs.existsSync(cli));
  const main = (await import(cli)).main;
  assert.equal(typeof main, 'function');
});

test('a reference to a file that is not there, or to a package that is not installed, is an error, never a gap (B1)', (t) => {
  assert.throws(() => hostFiles(fake(t, { [ENTRY]: "import './gone.mjs';" })), /reads \.\/gone\.mjs, which is not there/);
  assert.throws(() => hostFiles(fake(t, { [ENTRY]: "import 'left-pad';" })), /needs the package left-pad, which is not installed/);
  const dep = fake(t, {
    [ENTRY]: "import 'a-pkg';",
    'node_modules/a-pkg/package.json': JSON.stringify({ name: 'a-pkg', dependencies: { 'b-pkg': '1' } }),
    'node_modules/a-pkg/index.js': '',
  });
  assert.throws(() => hostFiles(dep), /a-pkg needs b-pkg, which is not installed/);
});

test('only code names a file: prose after the word from, a JSDoc type import and a line comment are not references', (t) => {
  const ELECTRON_LIKE = ['x', 'y'].join('/');
  const root = fake(t, {
    [ENTRY]: "import './a.mjs';\n",
    'host/bin/a.mjs': [
      "/** Reads `import('../missing/type').T` for the type checker only. */",
      "// require('missing-package') in a comment",
      "const words = ['from', 'to'];",
      "note('where the call came from', error);",
      "   /* import 'also-missing' */",
      `const p = '${ELECTRON_LIKE}';`,
      "import './b.mjs';",
    ].join('\n'),
    'host/bin/b.mjs': 'export {};',
  });
  assert.deepEqual(hostFiles(root), ['host/bin/a.mjs', 'host/bin/b.mjs', ENTRY]);
});

test('an inline JSDoc type import of a declaration file is not a reference, so the archive never needs a file the packager leaves out', (t) => {
  const root = fake(t, {
    [ENTRY]: "import './a.mjs';\n",
    'host/bin/a.mjs':
      "export const f = (/** @type {import('./types.d.mts').T} */ x) => x;\nexport const g = (/** @type {import('./gone.d.ts').U} */ y) => y;\n",
    'host/bin/types.d.mts': 'export type T = string;',
  });
  assert.deepEqual(hostFiles(root), ['host/bin/a.mjs', ENTRY]);
});

test('packages come with the packages they depend on, scoped names and subpaths included, without tests, docs or type files', (t) => {
  const root = fake(t, {
    [ENTRY]: "import { x } from '@s/pkg/sub'; import fs from 'node:fs'; import path from 'path'; import 'electron'; export { x };",
    'node_modules/@s/pkg/package.json': JSON.stringify({ name: '@s/pkg', dependencies: { dep: '1' } }),
    'node_modules/@s/pkg/sub.js': 'x',
    'node_modules/@s/pkg/types.d.ts': 'x',
    'node_modules/@s/pkg/README.md': 'x',
    'node_modules/@s/pkg/LICENSE': 'x',
    'node_modules/@s/pkg/test/a.js': 'x',
    'node_modules/@s/pkg/lib/deep.mjs': 'x',
    'node_modules/@s/pkg/node_modules/inner/package.json': '{}',
    'node_modules/dep/package.json': JSON.stringify({ name: 'dep', dependencies: { '@s/pkg': '1' } }),
    'node_modules/dep/main.cjs': 'x',
    'host/data.json': '{}',
  });
  write(root, ENTRY, `${fs.readFileSync(path.join(root, ENTRY), 'utf8')}\nconst u = new URL('../data.json', import.meta.url);`);
  assert.deepEqual(hostFiles(root), [
    ENTRY,
    'host/data.json',
    'node_modules/@s/pkg/LICENSE',
    'node_modules/@s/pkg/lib/deep.mjs',
    'node_modules/@s/pkg/package.json',
    'node_modules/@s/pkg/sub.js',
    'node_modules/dep/main.cjs',
    'node_modules/dep/package.json',
  ]);
});

test('a path longer than a tar name field is split at a folder; one that cannot be split is refused', (t) => {
  const folder = `host/${'d'.repeat(60)}/${'e'.repeat(60)}`;
  const root = fake(t, {
    // the specifier is built apart from its quotes: a quoted path with holes in it is read as every file it could name
    [ENTRY]: `import ${JSON.stringify(['..', 'd'.repeat(60), 'e'.repeat(60), `${'f'.repeat(30)}.mjs`].join('/'))};`,
    [`${folder}/${'f'.repeat(30)}.mjs`]: 'export {};',
  });
  const out = tmp(t);
  const built = buildBundle({ root, outDir: out });
  const into = tmp(t, 'unpack');
  extract(built.file, into);
  assert.ok(fs.existsSync(path.join(into, folder, `${'f'.repeat(30)}.mjs`)), 'it unpacks to the same path');
  assert.throws(() => tarball([{ path: 'x'.repeat(120), data: Buffer.alloc(1) }]), /too long for a tar archive/);
  assert.throws(() => tarball([{ path: `${'p'.repeat(170)}/f`, data: Buffer.alloc(1) }]), /too long for a tar archive/);
});

test('a file loaded by a computed name or next to its reader by __dirname is in the archive, and an absent folder adds nothing', (t) => {
  const root = fake(t, {
    [ENTRY]: "import '../src/loader.cjs';\n",
    'host/src/loader.cjs':
      "const load = (id, req = require) => req(`./mods/${id}.cjs`);\nconst gone = (id, req) => req(`./nowhere/${id}.cjs`);\nconst text = fs.readFileSync(path.join(__dirname, 'note.txt'), 'utf8');\nconst dir = path.join(__dirname, 'mods');\nconst none = path.join(__dirname, 'absent.txt');\n",
    'host/src/note.txt': 'hi',
    'host/src/mods/a.cjs': "require('./b.cjs');\n",
    'host/src/mods/b.cjs': '',
    'host/src/mods/c.txt': '',
    'host/src/mods/sub/d.cjs': '',
  });
  const files = hostFiles(root);
  for (const f of ['host/src/note.txt', 'host/src/mods/a.cjs', 'host/src/mods/b.cjs']) assert.ok(files.includes(f), f);
  assert.ok(!files.includes('host/src/mods/c.txt'));
  assert.ok(!files.includes('host/src/mods/sub/d.cjs'));
});

test('a private module loaded where the build has it comes with what it needs; one the checkout lacks adds nothing', (t) => {
  const loader =
    "const { optionalPrivate } = require('./optional.cjs');\nconst a = optionalPrivate(path.join(__dirname, '../private/a/index.cjs'));\nconst b = optionalPrivate(path.join(__dirname, '../private/gone/index.cjs'));\n";
  const root = fake(t, {
    [ENTRY]: "import '../src/loader.cjs';\n",
    'host/src/loader.cjs': loader,
    'host/src/optional.cjs': '',
    'host/private/a/index.cjs': "require('../../src/policy.cjs');\n",
    'host/src/policy.cjs': '',
  });
  const files = hostFiles(root);
  for (const f of ['host/private/a/index.cjs', 'host/src/policy.cjs']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f: string) => f.includes('gone')));
});

/** A checkout with a small Host and builds of the core, as the release lays them out. */
function withCores(t: any, builds: Record<string, string>) {
  const root = fake(t, { [ENTRY]: 'export {};' });
  for (const [build, text] of Object.entries(builds)) write(root, `build/vendor/host-core/${build}/mopilot_core.node`, text);
  return root;
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

test('each platform gets its own archive and manifest, with its addon and record, deterministic, and every tar reads it', (t) => {
  const root = withCores(t, { 'linux-x64-gnu': 'an ELF', 'darwin-arm64': 'a Mach-O' });
  const out = tmp(t);
  const a = buildBundle({ root, outDir: out, build: 'linux-x64-gnu' });
  const b = buildBundle({ root, outDir: out, build: 'darwin-arm64' });
  assert.notEqual(a.sha256, b.sha256);
  assert.deepEqual([a.core, b.core], ['linux-x64-gnu', 'darwin-arm64']);
  assert.equal(path.dirname(a.file), path.join(out, 'linux-x64-gnu'));
  assert.deepEqual(JSON.parse(fs.readFileSync(a.manifest, 'utf8')), {
    version: '9.9.9',
    sha256: a.sha256,
    url: path.basename(a.file),
    build: 'linux-x64-gnu',
  });
  assert.equal(buildBundle({ root, outDir: tmp(t), build: 'linux-x64-gnu' }).sha256, a.sha256, 'the same tree is the same checksum');
  // two gzip members: the host part, shared, then the platform's
  const into = tmp(t, 'unpacked');
  extract(a.file, into);
  assert.equal(fs.readFileSync(path.join(into, 'host-core/mopilot_core.node'), 'utf8'), 'an ELF');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(into, 'host-core/build.json'), 'utf8')), {
    build: 'linux-x64-gnu',
    sha256: sha('an ELF'),
  });
  assert.ok(fs.existsSync(path.join(into, ENTRY)));
  assert.equal(a.files, buildBundle({ root, outDir: tmp(t) }).files + 2, 'the record and the addon');
});

test('a checkout with no build for a machine says how to make one; for this machine its own addon serves', (t) => {
  const root = withCores(t, {});
  const other = coreBuildHere() === 'linux-arm64-musl' ? 'darwin-arm64' : 'linux-arm64-musl';
  assert.throws(
    () => buildBundle({ root, outDir: tmp(t), build: other }),
    new RegExp(`no Host build for ${other}: make one with node scripts/build-core.mjs --host ${other} `),
  );
  assert.throws(() => buildBundle({ root, outDir: tmp(t), build: coreBuildHere() }), /no Host build/, 'nothing built here either');
  write(root, path.relative(root, checkoutCore(root)), 'built here');
  const built = buildBundle({ root, outDir: tmp(t), build: coreBuildHere() });
  assert.equal(built.core, coreBuildHere());
  const into = tmp(t);
  extract(built.file, into);
  assert.equal(fs.readFileSync(path.join(into, 'host-core/mopilot_core.node'), 'utf8'), 'built here');
});

test('a package holds its builds to the hashes it recorded: a missing or changed one is refused, by name', (t) => {
  const root = withCores(t, { 'linux-x64-gnu': 'an ELF' });
  write(root, HOST_CORE_HASH_FILE, JSON.stringify({ 'linux-x64-gnu': sha('an ELF'), 'linux-arm64-gnu': sha('other') }));
  const outDir = tmp(t);
  assert.equal(buildBundle({ root, outDir, build: 'linux-x64-gnu' }).core, 'linux-x64-gnu');
  assert.throws(() => buildBundle({ root, outDir, build: 'linux-arm64-gnu' }), /carries no Host build for linux-arm64-gnu/);
  write(root, 'build/vendor/host-core/linux-x64-gnu/mopilot_core.node', 'changed after packaging');
  assert.throws(() => buildBundle({ root, outDir, build: 'linux-x64-gnu' }), /not the one this app was packaged with/);
});

test('a packaged app reads its builds from resources/host-core', (t) => {
  const base = tmp(t);
  const root = path.join(base, 'app.asar');
  write(root, ENTRY, 'export {};');
  write(root, 'host/package.json', JSON.stringify({ version: '1.0.0' }));
  write(base, 'host-core/linux-x64-gnu/mopilot_core.node', 'shipped');
  const was = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
  Object.defineProperty(process, 'resourcesPath', { value: base, configurable: true });
  t.after(() => {
    if (was) Object.defineProperty(process, 'resourcesPath', was);
    else delete (process as any).resourcesPath;
  });
  assert.equal(buildBundle({ root, outDir: tmp(t), build: 'linux-x64-gnu' }).core, 'linux-x64-gnu');
  delete (process as any).resourcesPath;
  assert.throws(
    () => buildBundle({ root, outDir: tmp(t), build: 'linux-x64-gnu' }),
    /no Host build for linux-x64-gnu/,
    'no resources: nothing to carry',
  );
});

test('one archive per platform per app run, and the Host is compressed once for them all', (t) => {
  const root = withCores(t, { 'linux-x64-gnu': 'an ELF', 'linux-x64-musl': 'another ELF' });
  const reads: string[] = [];
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (f: any, ...rest: any[]) => {
    if (String(f).endsWith(ENTRY)) reads.push(String(f));
    return (realRead as any)(f, ...rest);
  });
  const once = bundleOnce({ root, outDir: tmp(t) });
  const gnu = once('linux-x64-gnu');
  const seen = reads.length;
  assert.ok(seen > 0);
  const musl = once('linux-x64-musl');
  assert.equal(reads.length, seen, 'the second platform read no Host file');
  assert.notEqual(gnu.sha256, musl.sha256);
  assert.equal(once('linux-x64-gnu'), gnu);
  assert.equal(once().core, null);
});

test('a staged update for this machine runs; one for another, or with an addon that is not its record, is refused and the Host stays (A)', async (t) => {
  const here = coreBuildHere();
  const other = here === 'linux-x64-gnu' ? 'darwin-arm64' : 'linux-x64-gnu';
  const ship = async (build: string, tamper?: (dir: string) => void) => {
    const root = withCores(t, { [build]: 'an addon' });
    write(root, 'host/bin/mopilot-host.mjs', 'export {};');
    const out = tmp(t);
    const built = buildBundle({ root, outDir: out, build });
    if (tamper) {
      const unpacked = tmp(t, 'tampered');
      extract(built.file, unpacked);
      tamper(unpacked);
      assert.equal(spawnSync('tar', ['-czf', built.file, '-C', unpacked, '.']).status, 0);
      const manifest = JSON.parse(fs.readFileSync(built.manifest, 'utf8'));
      manifest.sha256 = createHash('sha256').update(fs.readFileSync(built.file)).digest('hex');
      fs.writeFileSync(built.manifest, JSON.stringify(manifest));
    }
    const dataDir = tmp(t, 'data');
    const facts = signedFacts(JSON.parse(fs.readFileSync(built.manifest, 'utf8')));
    const manifest = path.join(path.dirname(built.file), 'signed.json');
    fs.writeFileSync(manifest, JSON.stringify(facts));
    return { dataDir, manifest, go: () => stageUpdate({ source: manifest, dataDir, ...TRUST }) };
  };
  const good = await ship(here);
  assert.equal((await good.go()).staged, true);

  const wrong = await ship(other);
  await assert.rejects(wrong.go(), new RegExp(`built for ${other}, and this machine needs ${here}; it was not kept`));
  assert.deepEqual(fs.readdirSync(path.join(wrong.dataDir, 'updates', 'versions')), [], 'nothing was kept');
  assert.deepEqual(fs.readdirSync(path.join(wrong.dataDir, 'updates', 'blobs')), []);
  assert.ok(!fs.existsSync(path.join(wrong.dataDir, 'updates', 'next.json')), 'nothing to restart into');
  assert.ok(!fs.existsSync(path.join(wrong.dataDir, 'updates', 'floor.json')), 'a refused build moves no floor');

  const changed = await ship(here, (d) => fs.writeFileSync(path.join(d, 'host-core/mopilot_core.node'), 'other bytes'));
  await assert.rejects(changed.go(), /Rust core does not match its record/);
  const unreadable = await ship(here, (d) => fs.writeFileSync(path.join(d, 'host-core/build.json'), 'not json'));
  await assert.rejects(unreadable.go(), /Rust core could not be read/);
  const none = await ship(here, (d) => fs.rmSync(path.join(d, 'host-core'), { recursive: true }));
  await assert.rejects(none.go(), /carries no Rust core/);
  const broken = await ship(here);
  const refused = stageUpdate({ source: broken.manifest, dataDir: broken.dataDir, ...TRUST, coreLoads: () => 'wrong architecture' });
  await assert.rejects(refused, /does not load on this machine, so it was not kept: wrong architecture/);
  assert.ok(!fs.existsSync(path.join(broken.dataDir, 'updates', 'next.json')), 'the Host keeps running what it has');
});

test('a Node that cannot load an addon says why, in a child that takes any crash with it', () => {
  const said = (child: object) => addonLoads('/core.node', (() => child) as any);
  assert.equal(said({ status: 0, stderr: '' }), '');
  assert.equal(said({ status: 1, stderr: 'node:internal\n  Error: wrong ELF class\n  at x' }), 'Error: wrong ELF class');
  assert.equal(said({ status: 1, stderr: 'nothing useful' }), 'it stopped with 1');
  assert.equal(said({ status: null, signal: 'SIGSEGV', stderr: '' }), 'it stopped with SIGSEGV');
  let options: any;
  assert.equal(
    addonLoads('/core.node', ((_node: string, _args: string[], opts: any) => {
      options = opts;
      return { status: null, signal: 'SIGKILL', stderr: '' };
    }) as any),
    'it stopped with SIGKILL',
  );
  assert.equal(options.timeout, 30_000);
  assert.equal(options.killSignal, 'SIGKILL', 'a native probe cannot retain the trust lock by ignoring SIGTERM');
});

test('#4923: the archive records the version of the app that built it, and a Host not unpacked from one reports none', (t) => {
  const built = buildBundle({ root: ROOT, outDir: tmp(t) });
  const home = tmp(t, 'target');
  extract(built.file, home);
  assert.equal(fs.readFileSync(path.join(home, 'host/APP_VERSION'), 'utf8').trim(), appHostVersion(ROOT));
  assert.equal(hostStatus({ running: false }).appVersion, '', 'a checkout has no archive record');
});

test('#4923: an unpacked Host reads host/APP_VERSION of the archive into its status', (t) => {
  const built = buildBundle({ root: ROOT, outDir: tmp(t) });
  const home = tmp(t, 'target');
  extract(built.file, home);
  const probe = `import(${JSON.stringify(path.join(home, 'host/src/status.mjs'))}).then((m) => console.log('@@' + JSON.stringify(m.hostStatus({ running: false }))))`;
  const out = spawnSync(process.execPath, ['-e', probe], { encoding: 'utf8', cwd: home });
  const said = JSON.parse(
    out.stdout
      .split('\n')
      .find((l) => l.startsWith('@@'))
      ?.slice(2) ?? 'null',
  );
  assert.equal(said.appVersion, appHostVersion(ROOT));
  assert.equal(said.build, built.buildId);
});

test('#4923: the version of an app is its package.json version, and none when the file cannot be read or names none', (t) => {
  const at = (text: string | null) => {
    const root = tmp(t, 'app');
    if (text !== null) fs.writeFileSync(path.join(root, 'package.json'), text);
    return appHostVersion(root);
  };
  assert.equal(at('{"version":"1.2.3"}'), '1.2.3');
  assert.equal(at('{"version":7}'), '', 'a version that is not text is none');
  assert.equal(at('{}'), '');
  assert.equal(at('not json'), '');
  assert.equal(at(null), '', 'no package.json');
});
