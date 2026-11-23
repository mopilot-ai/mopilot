// Claude Code CLI probes (--version, --help) run off main's event loop: callers meanwhile share one ask, a forced
// probe replaces it without an older answer overwriting a newer one, and a chat's start waits for its binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakes, load, fakeBin, flush, tmp } from './support/electron-claude.ts';

const user = (text: string) => ({ role: 'user', content: text });

/** Holds every --version and --help ask until the test answers it. */
function holdProbes(t: any) {
  const held: { cmd: string; args: string[]; answer: (out: string | null) => void }[] = [];
  const real = fakes.execFile;
  fakes.execFile = (cmd: string, args: string[], opts: any, cb: Function) => {
    if (args[0] !== '--version' && args[0] !== '--help') return real(cmd, args, opts, cb);
    held.push({ cmd, args, answer: (out) => (out == null ? cb(new Error('not runnable'), '', '') : cb(null, out, '')) });
  };
  t.after(() => (fakes.execFile = real));
  return held;
}

/** A home folder with one CLI in ~/.local/bin, and no CLAUDE_BIN. */
function home(t: any, version: string) {
  const dir = fs.mkdtempSync(path.join(tmp, 'probe-'));
  const saved = { HOME: process.env.HOME, CLAUDE_BIN: process.env.CLAUDE_BIN };
  process.env.HOME = dir;
  delete process.env.CLAUDE_BIN;
  t.after(() => {
    process.env.HOME = saved.HOME;
    if (saved.CLAUDE_BIN === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = saved.CLAUDE_BIN;
  });
  return fakeBin(path.relative(tmp, path.join(dir, '.local/bin/claude')), version);
}

test('CLI versions: callers share one ask, a forced ask replaces it, and an older answer never overwrites a newer one', async (t) => {
  const bin = home(t, '2.1.0');
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never);
  const held = holdProbes(t);
  const first = cli.findBinary();
  const second = cli.candidates();
  await flush();
  assert.deepEqual(
    held.map((h) => h.args),
    [['--version']],
    'one ask for both callers',
  );
  // updated in place while that ask is out: the forced ask runs the new binary (one binary is asked once)
  fs.writeFileSync(bin, '#!/bin/sh\n# updated\n');
  const forced = cli.candidates(true);
  await flush();
  assert.equal(held.length, 2, 'a forced ask does not wait for the one out');
  const during = cli.findBinary();
  // the newer answer comes first, then the older one
  held[1].answer('2.2.0 (Claude Code)\n');
  assert.deepEqual(await forced, [{ path: bin, version: '2.2.0', via: 'unknown', from: '' }]);
  assert.equal(await during, bin, 'a read during the forced ask waits for it');
  held[0].answer('2.1.0 (Claude Code)\n');
  assert.equal(await first, bin);
  assert.deepEqual(await second, [{ path: bin, version: '2.1.0', via: 'unknown', from: '' }]);
  assert.deepEqual(await cli.candidates(), [{ path: bin, version: '2.2.0', via: 'unknown', from: '' }], 'the newer answer stays');
  assert.equal(held.length, 2, 'and is remembered');
});

test('the default CLI is the newest release: a newer prerelease ranks below it, and is run only when it is the one installed', async (t) => {
  const release = home(t, '2.1.300');
  const pre = fakeBin('probes/pre-claude', '2.2.0-beta.1');
  process.env.CLAUDE_BIN = pre;
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  assert.equal(await createCli({} as never, { cleanEnv: () => ({}) } as never).findBinary(), release);
  fs.rmSync(release);
  assert.equal(await createCli({} as never, { cleanEnv: () => ({}) } as never).findBinary(), pre);
});

test('opt-in Claude Code selection finds shadowed copies, honors a pin, and sees an install before the next use', async (t) => {
  const stable = home(t, '2.1.310');
  const extraDir = path.join(tmp, 'highest-claude-bin');
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
  });
  process.env.PATH = [path.dirname(stable), extraDir, savedPath].filter(Boolean).join(path.delimiter);
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never, () => true);
  assert.equal(await cli.findBinary(), stable);
  const next = fakeBin(path.relative(tmp, path.join(extraDir, 'claude')), '2.2.0-beta.9');
  assert.equal(await cli.findBinary(), next);
  assert.equal(await cli.findBinary(stable), stable);
  fs.rmSync(next);
  assert.equal(await cli.findBinary(), stable);
  const removed = fakeBin(path.relative(tmp, path.join(extraDir, 'claude')), '3.0.0');
  const held = holdProbes(t);
  const finding = cli.findBinary();
  await flush();
  assert.deepEqual(
    held.map((probe) => probe.cmd),
    [removed],
  );
  fs.rmSync(removed);
  held[0].answer('3.0.0 (Claude Code)');
  assert.equal(await finding, stable, 'a removed candidate cannot win a scan still in flight');
});

test('whether a CLI takes --plugin-dir is asked once for the sessions starting meanwhile', async (t) => {
  const bin = fakeBin('probes/plugin-claude');
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never);
  const held = holdProbes(t);
  const a = cli.takesPluginDirs(bin);
  const b = cli.takesPluginDirs(bin);
  assert.equal(held.length, 1);
  held[0].answer('  --plugin-dir <path>\n');
  assert.deepEqual(await Promise.all([a, b]), [true, true]);
  const other = fakeBin('probes/broken-claude');
  const c = cli.takesPluginDirs(other);
  held[1].answer(null);
  assert.equal(await c, false, 'no answer: it starts without plugins');
});

test("a chat's first start waits for its CLI to be found, and a second send meanwhile uses the same process", async (t) => {
  home(t, '2.1.0');
  const tt = load();
  tt.claude.setPlugins({ markNative: () => undefined, forClaude: async () => ({ plugins: [], withheld: [], release: async () => {} }) });
  const held = holdProbes(t);
  const before = fakes.queries.length;
  const one = tt.claude.send('claude:probe1', { sessionId: 'probe1', ephemeral: true }, user('one'));
  const two = tt.claude.send('claude:probe1', { sessionId: 'probe1', ephemeral: true }, user('two'));
  await flush();
  assert.deepEqual(
    held.map((h) => h.args),
    [['--version']],
  );
  assert.equal(fakes.queries.length, before, 'no CLI before it is found');
  held[0].answer('2.1.0 (Claude Code)\n');
  await flush();
  assert.deepEqual(
    held.map((h) => h.args),
    [['--version'], ['--help']],
  );
  assert.equal(fakes.queries.length, before, 'nor before its options are known');
  held[1].answer('  --plugin-dir <path>\n');
  await Promise.all([one, two]);
  assert.equal(fakes.queries.length, before + 1, 'one process for both sends');
  await tt.call('claude:control', 'claude:probe1', 'close');
});

test('a CLI whose child holds its pipes open cannot hold a login read past the CLI’s own timeout and a short grace (#5177)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never);
  const killed: string[] = [];
  const real = fakes.execFile;
  // execFile calls back only when the pipes close: here they never do
  fakes.execFile = () => ({ kill: (signal: string) => void killed.push(signal) }) as never;
  t.after(() => (fakes.execFile = real));
  const read = cli.run('/bin/claude', ['auth', 'status', '--json'], 15000);
  const refused = assert.rejects(read, /did not answer in time/);
  t.mock.timers.tick(15999);
  assert.deepEqual(killed, []);
  t.mock.timers.tick(1);
  await refused;
  assert.deepEqual(killed, ['SIGKILL']);
  // a CLI that cannot be killed (already gone) still refuses
  fakes.execFile = () => undefined as never;
  const second = assert.rejects(cli.run('/bin/claude', ['auth', 'status'], 1000), /did not answer in time/);
  t.mock.timers.tick(2000);
  await second;
});

test('a CLI that cannot start, or answers at once, leaves no timer behind (#5177)', async (t) => {
  const { createCli } = await import('../electron/harness/claude/cli.cjs');
  const cli = createCli({} as never, { cleanEnv: () => ({}) } as never);
  const real = fakes.execFile;
  t.after(() => (fakes.execFile = real));
  const timers = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
  const before = timers();
  // execFile throws (a missing file argument): the caller sees the error and no bound is left to fire later
  fakes.execFile = () => {
    throw new TypeError('The "file" argument must be of type string');
  };
  await assert.rejects(cli.run(null as never, ['auth', 'status'], 15000), /file/);
  // an answer that comes before execFile returns needs no bound either
  fakes.execFile = ((_c: string, _a: string[], _o: unknown, cb: Function) => (cb(null, 'ok', ''), undefined)) as never;
  assert.equal(await cli.run('/bin/claude', ['--version'], 15000), 'ok');
  assert.equal(timers(), before);
});
