// bench/scratch-chrome.mjs and chromeGuard/newPids in bench/lib/contract.mjs: a contract instance never starts Chrome
// on the VM's default (real, synced) profile, and its teardown quits only the Chrome it started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const c = await import('../bench/lib/contract.mjs');
const WRAPPER = path.join(import.meta.dirname, '../bench/scratch-chrome.mjs');
const REAL = { MOPILOT_SCRATCH_CHROME_REAL: '/chrome' };

test('the guard refuses Chrome without its own --user-data-dir, or without the Chrome the run named', () => {
  const refused = 'refusing to start Chrome without --user-data-dir: the default profile is a real, synced one';
  assert.deepEqual(c.chromeGuard(['http://localhost:8890/s/webauthn-get'], REAL), { refuse: refused });
  assert.deepEqual(c.chromeGuard(['--profile-directory=Default', 'http://x/'], REAL), { refuse: refused });
  assert.deepEqual(c.chromeGuard(['--user-data-dir=', 'http://x/'], REAL), { refuse: refused }, 'an empty dir is the default one');
  assert.deepEqual(c.chromeGuard(['--user-data-dir=/w/chrome-profile', 'http://x/'], {}), {
    refuse: 'MOPILOT_SCRATCH_CHROME_REAL names no Chrome to start',
  });
  assert.deepEqual(c.chromeGuard(['--user-data-dir=/w/chrome-profile', 'http://x/'], REAL), {
    chrome: '/chrome',
    extension: null,
    pair: false,
  });
  // MoPilot's extension folder, loaded into every Chrome the wrapper starts (#1561)
  assert.deepEqual(c.chromeGuard(['--user-data-dir=/w/p'], { ...REAL, MOPILOT_SCRATCH_CHROME_EXTENSION: '/m/electron/chrome-extension' }), {
    chrome: '/chrome',
    extension: '/m/electron/chrome-extension',
    pair: false,
  });
  // pairing as the operator, only with the extension
  const ext = { ...REAL, MOPILOT_SCRATCH_CHROME_EXTENSION: '/m/ext', MOPILOT_SCRATCH_CHROME_PAIR: '1' };
  assert.equal((c.chromeGuard(['--user-data-dir=/w/p'], ext) as any).pair, true);
  assert.equal((c.chromeGuard(['--user-data-dir=/w/p'], { ...REAL, MOPILOT_SCRATCH_CHROME_PAIR: '1' }) as any).pair, false);
  assert.equal((c.chromeGuard(['--user-data-dir=/w/p'], { ...ext, MOPILOT_SCRATCH_CHROME_PAIR: 'yes' }) as any).pair, false);
});

test("teardown's pids: only the Chrome processes that were not running before the suite", () => {
  assert.deepEqual(c.newPids([100, 101], [101, 200, 100, 201]), [200, 201]);
  assert.deepEqual(c.newPids([100], [100]), []);
  assert.deepEqual(c.newPids([], []), []);
});

/** Runs the wrapper as an instance's Chrome relay would, with `real` as the Chrome it starts. */
const wrap = (args: string[], real?: string, extension?: string, pair = false) => {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.MOPILOT_SCRATCH_CHROME_REAL;
  delete env.MOPILOT_SCRATCH_CHROME_EXTENSION;
  delete env.MOPILOT_SCRATCH_CHROME_PAIR;
  if (real) env.MOPILOT_SCRATCH_CHROME_REAL = real;
  if (extension) env.MOPILOT_SCRATCH_CHROME_EXTENSION = extension;
  if (pair) env.MOPILOT_SCRATCH_CHROME_PAIR = '1';
  return spawnSync(process.execPath, [WRAPPER, ...args], { env, encoding: 'utf8', timeout: 30_000 });
};

/**
 * A fake Chrome speaking the DevTools pipe (reads fd 3, writes fd 4): it records its arguments and the commands, answers
 * Extensions.loadUnpacked with `id`, Target.getTargets with the extension's worker when `runs`, and pairing's calls; on
 * Target.setDiscoverTargets it announces a pairing page, whose Pair shows on the second look; with `failCreate` it
 * refuses to open a page. It exits 100 ms after `exitAfter` (for Runtime.evaluate: once Pair was pressed), or when its
 * pipe closes.
 */
const pipeChrome = (
  dir: string,
  name: string,
  { id, runs, exitAfter, failCreate = false }: { id: string; runs: boolean; exitAfter: string; failCreate?: boolean },
) => {
  const f = path.join(dir, name);
  const log = path.join(dir, `${name}.log`);
  fs.writeFileSync(
    f,
    `#!${process.execPath}
const fs = require('node:fs');
const net = require('node:net');
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2) }) + '\\n');
const out = new net.Socket({ fd: 4, readable: false, writable: true });
const say = (m) => out.write(JSON.stringify(m) + '\\0');
let rest = '';
let looks = 0;
new net.Socket({ fd: 3, readable: true, writable: false }).on('data', (d) => {
  const parts = (rest + d).split('\\0');
  rest = parts.pop();
  for (const line of parts) {
    const m = JSON.parse(line);
    fs.appendFileSync(${JSON.stringify(log)}, m.method + (m.params && m.params.url ? ' ' + m.params.url : '') + '\\n');
    const page = 'chrome-extension://${id}/options.html#pair=claim-1';
    const result = m.method === 'Extensions.loadUnpacked' ? { id: ${JSON.stringify(id)} }
      : m.method === 'Target.getTargets' ? { targetInfos: ${runs} ? [{ type: 'service_worker', url: 'chrome-extension://${id}/background.mjs' }] : [] }
      : m.method === 'Target.attachToTarget' ? { sessionId: 'S1' }
      : m.method === 'Runtime.evaluate' ? { result: { value: ++looks > 1 ? 'pressed' : 'waiting' } }
      : {};
    if (m.method === 'Target.createTarget' && ${failCreate}) say({ id: m.id, error: { message: 'cannot open' } });
    else say({ id: m.id, result });
    if (m.method === 'Target.setDiscoverTargets') say({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'P1', type: 'page', url: page } } });
    // a real Chrome keeps running; this one quits after the call the case waits for (non-blocking sockets: an fs
    // stream on the pipe would leave a blocked read that process.exit waits for)
    if (m.method === ${JSON.stringify(exitAfter)} && (m.method !== 'Runtime.evaluate' || looks > 1)) setTimeout(() => process.exit(0), 100);
  }
}).on('end', () => process.exit(0));
`,
    { mode: 0o755 },
  );
  return { f, log };
};

test('the wrapper starts nothing without --user-data-dir or a named Chrome, and otherwise runs it with the same arguments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-chrome-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = (name: string, body: string) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return f;
  };
  const marker = path.join(dir, 'args');
  const chrome = fake('chrome', `printf '%s\\n' "$@" > '${marker}'`);

  const bare = wrap(['http://localhost:8890/s/webauthn-get'], chrome);
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /refusing to start Chrome without --user-data-dir/);
  assert.equal(fs.existsSync(marker), false, 'Chrome never started');

  const unnamed = wrap(['--user-data-dir=/p', 'http://x/']);
  assert.equal(unnamed.status, 2);
  assert.match(unnamed.stderr, /names no Chrome/);

  const ok = wrap([`--user-data-dir=${dir}/profile`, 'http://x/'], chrome);
  assert.equal(ok.status, 0);
  assert.deepEqual(fs.readFileSync(marker, 'utf8').trim().split('\n'), [`--user-data-dir=${dir}/profile`, 'http://x/']);

  assert.equal(wrap(['--user-data-dir=/p'], fake('fails', 'exit 3')).status, 3, "Chrome's exit code");
  assert.equal(wrap(['--user-data-dir=/p'], fake('killed', 'kill -TERM $$')).status, 1, 'a Chrome killed by a signal');
  const missing = wrap(['--user-data-dir=/p'], path.join(dir, 'no-such-chrome'));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test('with MOPILOT_SCRATCH_CHROME_EXTENSION the wrapper loads MoPilot’s extension over the pipe, and quits a Chrome where it does not run (#1561)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-chrome-pipe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ID = 'jhnfobeoiefjfneilcdkljfnapchmoej';

  // the page it was asked to open waits until the extension runs, then opens over the pipe
  const good = pipeChrome(dir, 'good', { id: ID, runs: true, exitAfter: 'Target.createTarget' });
  const ok = wrap([`--user-data-dir=${dir}/profile`, 'http://x/'], good.f, '/m/electron/chrome-extension');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stderr, new RegExp(`MoPilot's extension ${ID} runs`));
  const [first, ...calls] = fs.readFileSync(good.log, 'utf8').trim().split('\n');
  assert.deepEqual(JSON.parse(first).args, [
    `--user-data-dir=${dir}/profile`,
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    'about:blank',
  ]);
  assert.deepEqual(calls, ['Extensions.uninstall', 'Extensions.loadUnpacked', 'Target.getTargets', 'Target.createTarget http://x/']);
  assert.match(fs.readFileSync(path.join(dir, 'profile', 'scratch-chrome.log'), 'utf8'), /extension .* runs/, 'noted in the profile');

  // as the bench's operator: Pair pressed on the pairing page Chrome announces
  const pairing = pipeChrome(dir, 'pairing', { id: ID, runs: true, exitAfter: 'Runtime.evaluate' });
  const paired = wrap([`--user-data-dir=${dir}/paired`], pairing.f, '/m/electron/chrome-extension', true);
  assert.equal(paired.status, 0, paired.stderr);
  assert.match(paired.stderr, /pressed Pair on MoPilot's pairing page \(P1\)/);
  assert.deepEqual(fs.readFileSync(pairing.log, 'utf8').trim().split('\n').slice(1), [
    'Extensions.uninstall',
    'Extensions.loadUnpacked',
    'Target.getTargets',
    'Target.setDiscoverTargets',
    'Target.attachToTarget',
    'Runtime.evaluate',
    'Runtime.evaluate',
  ]);

  // guard: without MOPILOT_SCRATCH_CHROME_PAIR=1 the wrapper never watches for pairing pages, attaches to one or presses
  // anything, even with the extension loaded: pairing as the operator is for bench runs that ask for it
  const unasked = pipeChrome(dir, 'unasked', { id: ID, runs: true, exitAfter: 'Target.createTarget' });
  const plainRun = wrap([`--user-data-dir=${dir}/unasked`, 'http://x/'], unasked.f, '/m/electron/chrome-extension');
  assert.equal(plainRun.status, 0, plainRun.stderr);
  assert.doesNotMatch(plainRun.stderr, /Pair/);
  assert.deepEqual(fs.readFileSync(unasked.log, 'utf8').trim().split('\n').slice(1), [
    'Extensions.uninstall',
    'Extensions.loadUnpacked',
    'Target.getTargets',
    'Target.createTarget http://x/',
  ]);

  // a start on a profile whose Chrome runs (its SingletonLock names a live process): handed over as it was, no pipe
  const busy = path.join(dir, 'busy');
  fs.mkdirSync(busy);
  fs.symlinkSync(`host-${process.pid}`, path.join(busy, 'SingletonLock'));
  const plain = path.join(dir, 'plain');
  const seen = path.join(dir, 'plain-args');
  fs.writeFileSync(plain, `#!/bin/sh\nprintf '%s\\n' "$@" > '${seen}'\n`, { mode: 0o755 });
  const handed = wrap([`--user-data-dir=${busy}`, 'http://x/'], plain, '/m/electron/chrome-extension');
  assert.equal(handed.status, 0, handed.stderr);
  assert.match(handed.stderr, /a Chrome already runs on this profile: handing the start over to it/);
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split('\n'), [`--user-data-dir=${busy}`, 'http://x/']);

  // a page that fails to open after the extension runs is noted; Chrome is left running
  const failing = pipeChrome(dir, 'failing', { id: ID, runs: true, exitAfter: 'Target.createTarget', failCreate: true });
  const noted = wrap([`--user-data-dir=${dir}/noted`, 'http://x/'], failing.f, '/m/electron/chrome-extension');
  assert.equal(noted.status, 0, noted.stderr);
  assert.match(noted.stderr, /after loading the extension: Target\.createTarget: cannot open/);

  // another extension in that folder: Chrome is quit, and the wrapper exits 3 saying why
  const wrong = pipeChrome(dir, 'wrong', { id: 'abcdefabcdefabcdefabcdefabcdefab', runs: true, exitAfter: 'none: the wrapper quits it' });
  const bad = wrap([`--user-data-dir=${dir}/profile`], wrong.f, '/elsewhere');
  assert.equal(bad.status, 3);
  assert.match(
    bad.stderr,
    /\/elsewhere loaded as abcdefabcdefabcdefabcdefabcdefab, not MoPilot's extension .* Quitting this Chrome: browser use needs the extension\./,
  );
});
