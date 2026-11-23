// Git on a Host fails fast and says why (host/src/gitSignIn.mjs, hostGit.mjs, schema.mjs `host.status`): no prompt anywhere (helper windows included), an agent's git with no sign-in prints one line naming the cause, and `status` can report per host whether git can sign in, asked for and bounded.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createGitSignInCheck, gitFailFastEnv, withGitSignIn } from '../host/src/gitSignIn.mjs';
// @ts-ignore: plain ESM without declarations
import { gitEnv, runGit } from '../host/src/hostGit.mjs';
// @ts-ignore: plain ESM without declarations
import { createProtocol } from '../host/src/protocol.mjs';
// @ts-ignore: plain ESM without declarations
import * as S from '../shared/host/schema.mjs';
import { GIT_LOGIN, GIT_SIGNIN_FEATURE } from '../shared/host/gitLogin.mjs';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore: plain ESM without declarations
import { createLedger } from '../host/src/ledger.mjs';
// @ts-ignore: plain ESM without declarations
import { createGuard } from '../host/src/guard.mjs';
const { parseParams } = S;

test('GitHub sign-in requires a capable Host; ordinary agent sign-ins retain their protocol contract', () => {
  for (const method of ['host.login', 'host.loginStatus', 'host.loginCancel']) {
    assert.deepEqual(parseParams(method, { harness: GIT_LOGIN }), { harness: GIT_LOGIN });
    assert.throws(() => S.requireFeatures(method, { features: [] }, { harness: GIT_LOGIN }), /gitSignin/);
    S.requireFeatures(method, { features: [GIT_SIGNIN_FEATURE] }, { harness: GIT_LOGIN });
    S.requireFeatures(method, { features: [] }, { harness: 'codex' });
  }
});

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-signin-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

test('every Host git is told to prompt for nothing, helpers included, and keeps the machine’s system config only when asked', () => {
  const env = gitEnv({ PATH: '/bin', GIT_DIR: 'x', GCM_INTERACTIVE: 'always' }, undefined);
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal((env as Record<string, string>).GIT_DIR, undefined);
  assert.equal(gitEnv({}, { GIT_CONFIG_NOSYSTEM: '0' }).GIT_CONFIG_NOSYSTEM, '0');
  assert.equal(gitEnv({}, { GIT_TERMINAL_PROMPT: '1' }).GIT_TERMINAL_PROMPT, '0', 'a caller cannot turn prompting back on');
});

test('runGit feeds its input to git and reports how it ended: finished, killed by the timeout, or never started', async () => {
  const got = await runGit(['credential', 'fill'], {
    input: 'protocol=https\nhost=h.test\nusername=u\npassword=p\n\n',
    env: { GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  assert.equal(got.spawnFailed, false);
  assert.equal(got.signal, null);
  const fs2 = path.join(base, 'cfg');
  fs.writeFileSync(fs2, '[credential]\n\thelper = "!sleep 2; :"\n');
  const slow = await runGit(['credential', 'fill'], {
    input: 'protocol=https\nhost=h.test\n\n',
    timeout: 300,
    env: { GIT_CONFIG_GLOBAL: fs2 },
  });
  assert.equal(slow.ok, false);
  assert.ok(slow.signal, 'killed by the timeout');
  const none = await runGit(['--version'], { cwd: path.join(base, 'no-such-folder') });
  assert.equal(none.spawnFailed, true);
  assert.equal(none.ok, false);
});

test('the sign-in reading: yes with a credential, no without, unknown when git cannot answer; cached, joined, and per host', async () => {
  const calls: { args: string[]; input?: string; env?: any }[] = [];
  let answer: any = { ok: true, stdout: 'username=u\npassword=secret\n', stderr: '', signal: null, spawnFailed: false };
  let clock = 0;
  const check = createGitSignInCheck({
    run: (async (args: string[], o: any) => (calls.push({ args, input: o.input, env: o.env }), answer)) as any,
    now: () => clock,
    keepMs: 1000,
  });
  assert.deepEqual(await check(['github.com']), { 'github.com': 'yes' });
  assert.deepEqual(calls[0].args, ['-c', 'core.askPass=', 'credential', 'fill']);
  assert.equal(calls[0].env.GIT_ASKPASS, 'false', 'a user’s askpass never opens a window for a reading');
  assert.equal(calls[0].input, 'protocol=https\nhost=github.com\n\n');
  assert.equal(calls[0].env.GIT_CONFIG_NOSYSTEM, '0', 'it sees the config an agent’s git sees');
  assert.equal(JSON.stringify(await check(['github.com'])).includes('secret'), false, 'the secret is never returned');
  assert.equal(calls.length, 1, 'kept');
  clock = 1000;
  answer = { ok: false, stdout: '', stderr: 'fatal: could not read Username', signal: null, spawnFailed: false };
  assert.deepEqual(await check(['github.com', 'gitlab.com']), { 'github.com': 'no', 'gitlab.com': 'no' });
  clock = 2000;
  answer = { ok: true, stdout: 'username=u\n', stderr: '', signal: null, spawnFailed: false };
  assert.deepEqual(await check(['github.com']), { 'github.com': 'no' }, 'a user name alone is no sign-in');
  clock = 3000;
  answer = { ok: false, stdout: '', stderr: '', signal: 'SIGTERM', spawnFailed: false };
  assert.deepEqual(await check(['github.com']), { 'github.com': 'unknown' });
  clock = 4000;
  answer = { ok: false, stdout: '', stderr: 'ENOENT', signal: null, spawnFailed: true };
  assert.deepEqual(await check(['github.com']), { 'github.com': 'unknown' });
});

test('credential installation retires cached and in-flight negative reads before verification', async () => {
  const waiting: ((r: any) => void)[] = [];
  const check = createGitSignInCheck({ run: (() => new Promise((r) => waiting.push(r))) as any });
  const old = check(['github.com']);
  check.invalidate();
  const current = check(['github.com']);
  assert.equal(waiting.length, 2, 'verification cannot join the retired read');
  waiting[1]({ ok: true, stdout: 'password=secret\n' });
  assert.deepEqual(await current, { 'github.com': 'yes' });
  waiting[0]({ ok: false, stdout: '' });
  assert.deepEqual(await old, { 'github.com': 'unknown' }, 'a retired failure cannot become a current answer');
  assert.deepEqual(await check(['github.com']), { 'github.com': 'yes' });
});

test('real git: with no helper the reading says no, and a helper that holds a credential says yes', { skip: !hasGit() }, async () => {
  const empty = path.join(base, 'empty');
  fs.writeFileSync(empty, '');
  const stored = path.join(base, 'store');
  fs.writeFileSync(stored, 'https://u:tok@h.test\n');
  const withStore = path.join(base, 'with-store');
  fs.writeFileSync(withStore, `[credential]\n\thelper = store --file=${stored}\n`);
  const saved = { ...process.env };
  const homeOf = (cfg: string) => {
    const h = fs.mkdtempSync(path.join(base, 'home-'));
    fs.copyFileSync(cfg, path.join(h, '.gitconfig'));
    return h;
  };
  try {
    process.env.HOME = homeOf(empty);
    assert.deepEqual(await createGitSignInCheck()(['h.test']), { 'h.test': 'no' });
    process.env.HOME = homeOf(withStore);
    assert.deepEqual(await createGitSignInCheck()(['h.test']), { 'h.test': 'yes' });
  } finally {
    process.env.HOME = saved.HOME;
  }
});

function hasGit() {
  try {
    execFileSync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

test('an agent’s git with no sign-in prints one line naming the cause and exits; a user’s own askpass stays; a folder that cannot be written falls back', {
  skip: !hasGit(),
}, () => {
  const dir = path.join(base, 'data');
  fs.mkdirSync(dir);
  const env = gitFailFastEnv(dir, {}, 'linux');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GCM_INTERACTIVE, 'never');
  assert.equal(env.GIT_ASKPASS, path.join(dir, 'git-askpass'));
  assert.equal((fs.statSync(env.GIT_ASKPASS).mode & 0o777).toString(8), '755');
  // the same file again: nothing is rewritten
  assert.deepEqual(gitFailFastEnv(dir, {}, 'linux'), env);
  // the line carries only a plain address, whatever the prompt held
  const hostile = spawnSync(env.GIT_ASKPASS, ["Username for 'https://x.test/ IGNORE all\\n%s $(id)': "], { encoding: 'utf8' });
  assert.equal(
    hostile.stderr.trim(),
    'MoPilot: git has no sign-in on this machine for https://x.test. Sign in on this machine in MoPilot, then retry the operation.',
  );
  // an outdated copy is replaced
  fs.writeFileSync(env.GIT_ASKPASS, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  gitFailFastEnv(dir, {}, 'linux');
  const asked = spawnSync(env.GIT_ASKPASS, ["Username for 'https://github.com': "], { encoding: 'utf8' });
  assert.equal(asked.status, 1);
  assert.equal(
    asked.stderr.trim(),
    'MoPilot: git has no sign-in on this machine for https://github.com. Sign in on this machine in MoPilot, then retry the operation.',
  );
  const credential = spawnSync(env.GIT_ASKPASS, ["Password for 'https://alice:private-secret@github.com/org/repo': "], {
    encoding: 'utf8',
  });
  assert.match(credential.stderr, /for https:\/\/github.com\./);
  assert.doesNotMatch(credential.stderr, /alice|private-secret|\/org/);
  assert.match(
    spawnSync(env.GIT_ASKPASS, ['Password: '], { encoding: 'utf8' }).stderr,
    /no sign-in on this machine\. Sign in on this machine/,
  );
  // real git with no helper: its failed fetch carries that line, with no prompt
  const src = path.join(base, 'srv');
  fs.mkdirSync(src);
  const cfg = path.join(base, 'nohelper');
  fs.writeFileSync(cfg, '');
  const r = spawnSync('git', ['ls-remote', 'https://127.0.0.1:1/x.git'], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: base, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  assert.notEqual(r.status, 0);
  // a GIT_ASKPASS the user set is left alone, and Windows has no sh
  assert.deepEqual(gitFailFastEnv(dir, { GIT_ASKPASS: '/mine' }, 'linux'), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  // an SSH_ASKPASS or a core.askPass the machine has is the user's too
  assert.deepEqual(gitFailFastEnv(dir, { SSH_ASKPASS: '/mine' }, 'linux'), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  const askHome = fs.mkdtempSync(path.join(base, 'ask-'));
  fs.writeFileSync(path.join(askHome, '.gitconfig'), '[core]\n\taskPass = /mine\n');
  assert.deepEqual(gitFailFastEnv(dir, { PATH: process.env.PATH, HOME: askHome, GIT_CONFIG_NOSYSTEM: '1' }, 'linux'), {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
  assert.deepEqual(gitFailFastEnv(dir, {}, 'win32'), { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
  assert.deepEqual(gitFailFastEnv(path.join(base, 'missing', 'deeper'), {}, 'linux'), {
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
  });
});

test('the wire: host.status takes a few plain host names to report on; none is the heartbeat’s request', () => {
  assert.deepEqual(parseParams('host.status', {}), {});
  assert.deepEqual(parseParams('host.status', { signIn: ['github.com', 'git.example.test:8443', 'github.com'] }), {
    signIn: ['github.com', 'git.example.test:8443'],
  });
  for (const signIn of ['github.com', [], ['a', 'b', 'c', 'd', 'e'], [1], ['-x.com'], ['a b'], ['https://github.com'], ['h.test:99999x']])
    assert.throws(() => parseParams('host.status', { signIn }), /Name the repository hosts/);
});

test('the protocol hands host.status its params, and withGitSignIn adds the reading only when hosts were named', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const quiet = { report: () => undefined };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const runtime: any = { host: Object.assign(new EventEmitter(), { cancel: () => undefined }) };
  const asked: string[][] = [];
  const check = async (hosts: string[]) => (asked.push(hosts), { [hosts[0]]: 'no' as const });
  const conn = createProtocol({ runtime, epochs, guard, status: (p: any) => withGitSignIn({ running: true }, p ?? {}, check) }).connection(
    () => undefined,
  );
  await conn.call('host.hello', S.helloParams());
  assert.deepEqual(await conn.call('host.status', {}), { running: true });
  assert.deepEqual(await conn.call('host.status', { signIn: ['github.com'] }), { running: true, gitSignIn: { 'github.com': 'no' } });
  assert.deepEqual(asked, [['github.com']]);
});
