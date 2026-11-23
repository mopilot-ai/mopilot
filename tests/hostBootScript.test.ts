// The Add by command install script (electron/host/bootScript.cjs), run for real by `sh` in a scratch home with stand-ins for curl,
// uname, launchctl and the Host's Node: it parses, refuses a missing or malformed code and an unsupported system in one line each,
// downloads and checks the bundle, unpacks it where the SSH installer does, hands `enroll` its input with the code on standard input
// (never on a command line it starts, never on the terminal), then writes and starts the service; a bundle that does not match its
// hash is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { bootScript, UNAMES } = require('../electron/host/bootScript.cjs');
const { NODE_VERSION } = require('../electron/host/nodeRuntime.cjs');
const { CORE_BUILDS } = require('../shared/host/coreBuild.mjs');

const CODE = 'Abc_def-0123456789wxyz';
const enrollment = { relayUrl: 'wss://relay.example/v1/ws', hostId: 'h_host0000000000001', secret: 'S'.repeat(43), pairId: 'p_hostpair01' };

/** A scratch machine: a home, stand-in tools on PATH, the Host bundle as a tarball, and MoPilot's Node already placed. */
function machine(t: any, uname = 'Darwin arm64', build = 'darwin-arm64') {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/boot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(log);
  // the Host bundle: just its entry point
  const src = path.join(root, 'src', 'host', 'bin');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'mopilot-host.mjs'), '// host\n');
  const tgz = path.join(root, 'bundle.tgz');
  spawnSync('tar', ['-czf', tgz, '-C', path.join(root, 'src'), 'host']);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex');
  const write = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('uname', `case "$1" in -sm) echo '${uname}' ;; -s) echo '${uname.split(' ')[0]}' ;; *) echo '${uname}' ;; esac`);
  write(
    'curl',
    `out=''; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; esac; url="$1"; shift; done; echo "$url" >> '${log}/curl'; cp '${tgz}' "$out"`,
  );
  write('launchctl', `echo "$*" >> '${log}/launchctl'`);
  write('systemctl', `echo "$*" >> '${log}/systemctl'`);
  // MoPilot's Node, already on the machine: the stand-in records each run and what it read
  const key = { 'Darwin arm64': 'darwin-arm64', 'Linux x86_64': 'linux-x64', 'Linux aarch64': 'linux-arm64' }[uname] ?? 'darwin-arm64';
  const nodeDir = path.join(home, '.mopilot-host', 'runtime', `node-${NODE_VERSION}-${key}`, 'bin');
  fs.mkdirSync(nodeDir, { recursive: true });
  fs.writeFileSync(
    path.join(nodeDir, 'node'),
    `#!/bin/sh\nif [ "$1" = --version ]; then echo ${NODE_VERSION}; exit 0; fi\nif [ "$1" = -e ]; then echo ${build}; exit 0; fi\necho "$*" >> '${log}/node-args'\ncat >> '${log}/node-stdin'\necho >> '${log}/node-stdin'\n`,
    { mode: 0o755 },
  );
  const run = (script: string, args: string[]) =>
    spawnSync('/bin/sh', ['-s', '--', ...args], {
      input: script,
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, SHELL: '/bin/sh' },
      encoding: 'utf8',
    });
  const read = (f: string) => (fs.existsSync(path.join(log, f)) ? fs.readFileSync(path.join(log, f), 'utf8') : '');
  return { home, sha, run, read };
}

const scriptFor = (sha: string) =>
  bootScript({
    bundleUrl: 'https://relay.example/v1/boot/b_x/bundle',
    bundles: Object.fromEntries(CORE_BUILDS.map((b: string) => [b, sha])),
    enrollment,
    updateKeyPem: '-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----',
  });

test('the script parses, and lists every system MoPilot has a Node for', () => {
  const r = spawnSync('/bin/sh', ['-n'], { input: scriptFor('0'.repeat(64)), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(UNAMES, ['Darwin arm64', 'Darwin x86_64', 'Linux x86_64', 'Linux aarch64', 'Linux arm64']);
  assert.ok(!scriptFor('0'.repeat(64)).includes(CODE));
  assert.doesNotMatch(scriptFor('0'.repeat(64)), /set -x|echo[^\n]*\$code/, 'the code is never echoed');
});

test('each build fetches its own bundle and checks its own hash; a build the app has none of is refused by name', (t) => {
  const m = machine(t, 'Linux x86_64', 'linux-x64-musl');
  const wrong = '0'.repeat(64);
  const script = (sha: string) =>
    bootScript({
      bundleUrl: 'https://relay.example/v1/boot/b_x/bundle',
      bundles: { 'linux-x64-gnu': wrong, 'linux-x64-musl': sha },
      enrollment,
    });
  assert.equal(m.run(script(m.sha), [CODE]).status, 0);
  assert.match(m.read('curl'), /\/bundle\/linux-x64-musl$/m);
  const other = machine(t, 'Linux aarch64', 'linux-arm-gnu');
  const refused = other.run(script(other.sha), [CODE]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /MoPilot: MoPilot has no Host build for this machine \(linux-arm-gnu\)\./);
  assert.equal(other.read('curl'), '', 'nothing was fetched');
});

test('a whole install: the bundle checked and unpacked, enroll given the code on standard input only, the service written and started', (t) => {
  const m = machine(t);
  const r = m.run(scriptFor(m.sha), [CODE]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes(CODE) && !r.stderr.includes(CODE), 'the code is not on the terminal');
  assert.match(r.stderr, /this machine is ready/);
  assert.equal(m.read('curl').trim(), 'https://relay.example/v1/boot/b_x/bundle/darwin-arm64');
  assert.ok(fs.existsSync(path.join(m.home, '.mopilot-host', 'current', 'host', 'bin', 'mopilot-host.mjs')));
  const args = m.read('node-args');
  assert.match(args, /mopilot-host\.mjs enroll/);
  assert.match(args, /mopilot-host\.mjs install/);
  assert.match(args, /mopilot-host\.mjs trust-update-key/);
  assert.ok(!args.includes(CODE), 'no command line carries the code');
  const input = JSON.parse(m.read('node-stdin').split('\n')[0]);
  assert.deepEqual(input, { ...enrollment, code: CODE });
  assert.match(m.read('node-stdin'), /BEGIN PUBLIC KEY/);
  assert.ok(m.read('launchctl').length > 0, 'the service is started');
});

test('one line for each thing that stops it: no code, a malformed one, an unsupported system, a bundle that does not match', (t) => {
  const m = machine(t);
  for (const args of [[], ['short'], ['not a code with spaces']]) {
    const r = m.run(scriptFor(m.sha), args);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.trim(), 'MoPilot: Run the whole command MoPilot showed, with the code at its end.');
  }
  const win = machine(t, 'MINGW64_NT-10.0 x86_64');
  const w = win.run(scriptFor(win.sha), [CODE]);
  assert.equal(w.status, 1);
  assert.equal(w.stderr.trim(), 'MoPilot: MoPilot runs on macOS and Linux (64-bit Intel or ARM); this machine is MINGW64_NT-10.0 x86_64.');
  const bad = m.run(scriptFor('f'.repeat(64)), [CODE]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /does not match its checksum/);
  assert.equal(m.read('node-args'), '', 'nothing ran after a bad download');
  const linux = machine(t, 'Linux x86_64');
  const l = linux.run(scriptFor(linux.sha), [CODE]);
  assert.equal(l.status, 0, l.stderr);
  assert.match(linux.read('systemctl'), /--user/);
});

test('the command runs only the script whose hash it carries; anything else is shown as text, never run', (t) => {
  const { bootCommand } = require('../electron/host/bootScript.cjs');
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/bootcmd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  const served = path.join(root, 'served.sh');
  // curl serves whatever the test put in served.sh
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -o) cp '${served}' "$2"; shift ;; esac; shift; done\n`,
    { mode: 0o755 },
  );
  const run = (command: string) =>
    spawnSync('/bin/sh', ['-c', command], { env: { PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root }, encoding: 'utf8' });
  const good = `#!/bin/sh\necho "ran with $1" > '${root}/ran'\n`;
  const sha = crypto.createHash('sha256').update(good).digest('hex');
  const command = bootCommand({ scriptUrl: 'https://relay.example/v1/boot/b_x', scriptSha256: sha, code: CODE });
  fs.writeFileSync(served, good);
  assert.equal(run(command).status, 0);
  // the script's own failure (the machine was not allowed) is the line's: its status is kept
  const failing = `#!/bin/sh\necho 'MoPilot: MoPilot did not allow this machine.' >&2\nexit 1\n`;
  fs.writeFileSync(served, failing);
  const refused = run(
    bootCommand({
      scriptUrl: 'https://relay.example/v1/boot/b_x',
      scriptSha256: crypto.createHash('sha256').update(failing).digest('hex'),
      code: CODE,
    }),
  );
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /did not allow this machine/);
  fs.writeFileSync(served, good);
  assert.equal(fs.readFileSync(path.join(root, 'ran'), 'utf8').trim(), `ran with ${CODE}`);
  fs.rmSync(path.join(root, 'ran'));
  // a relay that serves another script: nothing runs, the person is told
  fs.writeFileSync(served, `#!/bin/sh\necho evil > '${root}/ran'\n`);
  const tampered = run(command);
  assert.equal(tampered.status, 1, 'the line fails when nothing ran');
  assert.equal(fs.existsSync(path.join(root, 'ran')), false, 'a script that does not match never runs');
  assert.match(tampered.stderr, /MoPilot: the installer could not be checked\. Run the command again\./);
  // the relay's own answer (the app is away): its text is shown, the script is not run
  const { sayScript, SAY } = require('../relay/src/boot.mjs');
  fs.writeFileSync(served, sayScript(SAY.offline));
  assert.equal(run(command).stderr.trim(), `MoPilot: ${SAY.offline}`);
  assert.deepEqual(fs.readdirSync(root).sort(), ['bin', 'served.sh'], 'the downloaded file is removed');
});
