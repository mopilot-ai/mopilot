// `mopilot-host login claude|codex` (host/src/login.mjs): the vendor's own sign-in CLI runs on the Host, its link and code are relayed, a pasted code reaches it, and the sign-in counts as done only when the CLI exits 0 and says it is signed in (W: a CLI that lies, A: cancel and timeout, B: output shapes).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { main } from '../host/src/cli.mjs';
import { createLogin } from '../host/src/login.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { startServer } from '../host/src/server.mjs';

const FAKE = path.join(import.meta.dirname, 'fixtures/fake-cli-login.mjs');
const { createSignin, onVendorSite } = createRequire(import.meta.url)('../electron/host/signin.cjs');
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-login-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

const until = async (fn: () => any, ms = 8000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** A login service whose CLIs are the fake script in `mode`; `ran` records what would have been started, `children` the processes. */
function setup(mode: string, o: { installed?: boolean; signedIn?: boolean; loginMs?: number } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(base, 'o-')), 'typed');
  const ran: { bin: string; args: string[] }[] = [];
  const children: any[] = [];
  const probed: string[] = [];
  const marked: [string, boolean][] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    loginMs: o.loginMs,
    signedIn: { set: (id: string, v: boolean) => marked.push([id, v]) } as any,
    env: { PATH: '' },
    which: (name: string) => (o.installed === false ? null : `/bin/${name}`),
    spawnFn: (bin: string, args: string[], opts: any) => {
      ran.push({ bin, args });
      const child = spawn(process.execPath, [FAKE, ...args], { ...opts, env: { ...process.env, FAKE_CLI_MODE: mode, FAKE_CLI_OUT: out } });
      children.push(child);
      return child;
    },
    probe: async (id: string) => (probed.push(id), o.signedIn !== false),
    gitSignInCheck: Object.assign(async () => ({ 'github.com': o.signedIn === false ? ('no' as const) : ('yes' as const) }), {
      invalidate: () => undefined,
    }),
  });
  return { login, ran, children, probed, marked, out };
}

test('claude: the CLI runs as `claude auth login`, its link and code are relayed, and the sign-in is done once the CLI says so', async () => {
  const h = setup('ok');
  const started = h.login.start({ harness: 'claude' });
  assert.deepEqual(h.ran, [{ bin: '/bin/claude', args: ['auth', 'login'] }]);
  assert.equal(started.methodId, 'cli');
  assert.deepEqual(started.methods, [{ id: 'cli', name: 'Sign in' }]);
  assert.equal(h.login.idle(), false);
  await until(() => h.login.status('claude')?.state === 'done');
  const done = h.login.status('claude')!;
  assert.deepEqual([done.links, done.codes, done.error], [['https://auth.example.com/device'], ['ABCD-1234'], null]);
  assert.deepEqual(h.probed, ['claude']);
  assert.deepEqual(h.marked, [['claude', true]]);
  await until(() => h.login.idle());
  assert.equal(h.login.input('claude', 'late'), false, 'nothing takes input once the sign-in is over');
});

test('codex: the CLI runs as `codex login --device-auth`', async () => {
  const h = setup('ok');
  h.login.start({ harness: 'codex' });
  assert.deepEqual(h.ran, [{ bin: '/bin/codex', args: ['login', '--device-auth'] }]);
  await until(() => h.login.status('codex')?.state === 'done');
  assert.deepEqual(h.marked, [['codex', true]]);
});

test('GitHub: sign-in runs gh on the Host and configures Git before reporting success', async () => {
  const h = setup('ok');
  h.login.start({ harness: 'git:github.com' });
  await until(() => ['done', 'failed'].includes(h.login.status('git:github.com')?.state ?? ''));
  assert.equal(h.login.status('git:github.com')?.state, 'done');
  assert.deepEqual(h.ran, [
    { bin: '/bin/gh', args: ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--clipboard=false'] },
    { bin: '/bin/gh', args: ['auth', 'setup-git', '--hostname', 'github.com'] },
  ]);
  assert.deepEqual(h.marked, [], 'GitHub is not a model credential');
  assert.deepEqual(h.login.status('git:github.com')?.links, [], 'unrelated CLI links are never relayed');
});

test('GitHub relays only the browser device code and URL and never reads a terminal reply', async () => {
  const h = setup('github');
  h.login.start({ harness: 'git:github.com' });
  assert.equal(h.login.input('git:github.com', 'reply from the app'), false);
  assert.equal(h.children[0].stdin.writableEnded, true);
  await until(() => h.login.idle());
  const status = h.login.status('git:github.com')!;
  assert.equal(status.state, 'done');
  assert.deepEqual(status.links, ['https://github.com/login/device']);
  assert.deepEqual(status.codes, ['ABCD-1234']);
  assert.ok(status.links.every((url) => onVendorSite('git:github.com', url)));
  assert.equal(JSON.stringify(status).includes('private-secret'), false);
});

test('GitHub retries an old gh flag rejection once and stays on the same browser sign-in', async () => {
  const h = setup('github-legacy');
  const attempt = h.login.start({ harness: 'git:github.com' });
  await until(() => h.login.idle());
  assert.equal(h.login.status('git:github.com'), attempt);
  assert.equal(attempt.state, 'done');
  assert.deepEqual(attempt.codes, ['ABCD-1234']);
  assert.deepEqual(
    h.ran.map(({ args }) => args),
    [
      ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--clipboard=false'],
      ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web'],
      ['auth', 'setup-git', '--hostname', 'github.com'],
    ],
  );
});

test('GitHub never starts a second device flow when a flag error follows device output on another stream', async () => {
  const h = setup('github-fail');
  h.login.start({ harness: 'git:github.com' });
  await until(() => h.login.idle());
  assert.equal(h.ran.length, 1);
  assert.equal(h.login.status('git:github.com')?.state, 'failed');
  assert.match(h.login.status('git:github.com')!.error!, /could not finish/);
});

test('cancel then sign in again waits for old Host verification and starts a fresh device flow', async () => {
  let verify!: (value: Record<string, 'yes'>) => void;
  let checks = 0;
  let commands = 0;
  const login = createLogin({
    runtime: { host: {} } as any,
    env: {},
    which: () => '/remote/gh',
    spawnFn: () => {
      commands++;
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        kill: () => true,
      });
      setImmediate(() => {
        child.stdout.end();
        child.stderr.end();
        child.emit('close', 0);
      });
      return child as any;
    },
    gitSignInCheck: Object.assign(
      () =>
        ++checks === 1
          ? new Promise<Record<string, 'yes'>>((r) => {
              verify = r;
            })
          : Promise.resolve({ 'github.com': 'yes' as const }),
      { invalidate() {} },
    ),
  });
  let cancel!: () => void;
  const remote = createSignin({
    call: async (_id: string, method: string, p: any) => {
      if (method === 'login') return login.start(p);
      if (method === 'loginStatus') return login.status(p.harness);
      await new Promise<void>((r) => {
        cancel = r;
      });
      return login.cancel(p.harness);
    },
    openExternal() {},
    verify: async () => ({ signedIn: true }),
    pollMs: 1,
  });
  try {
    const first = remote.start({ hostId: 'ssh:box', harness: 'git:github.com' });
    await until(() => verify);
    assert.equal(commands, 2);
    remote.cancel('ssh:box', 'git:github.com');
    assert.equal((await first).state, 'cancelled');
    const second = remote.start({ hostId: 'ssh:box', harness: 'git:github.com' });
    await new Promise((r) => setImmediate(r));
    assert.equal(commands, 2, 'a replacement waits for the old cancellation acknowledgement');
    cancel();
    await new Promise((r) => setImmediate(r));
    assert.equal(commands, 2, 'Host credential verification still owns its writer');
    verify({ 'github.com': 'yes' });
    assert.equal((await second).state, 'signed-in');
    assert.equal(commands, 4, 'the replacement runs both gh commands itself');
  } finally {
    remote.dispose();
    login.close();
  }
});

test('a cancelled ACP completion and a cancelled queued replacement never mark a login or dispatch another writer', async () => {
  let finish!: () => void;
  let starts = 0;
  const marked: any[] = [];
  const agent = Object.assign(new EventEmitter(), {
    caps: { authMethods: [{ id: 'web', name: 'Browser' }] },
    request: () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    kill: () => undefined,
  });
  const login = createLogin({
    runtime: {
      host: {
        agents: new Map(),
        agentForLogin: async () => {
          starts++;
          return agent;
        },
      },
    } as any,
    signedIn: { set: (...args: any[]) => marked.push(args) } as any,
  });
  login.start({ harness: 'acp-test' });
  await until(() => finish);
  login.cancel('acp-test');
  login.start({ harness: 'acp-test' });
  login.cancel('acp-test');
  finish();
  await until(() => login.idle());
  assert.equal(login.status('acp-test')?.state, 'cancelled');
  assert.equal(starts, 1);
  assert.deepEqual(marked, []);
});

test('GitHub: a missing CLI, failed device flow and unusable Git helper never report signed in', async () => {
  for (const [mode, opts, expected] of [
    ['ok', { installed: false }, /not installed/],
    ['fail', {}, /could not finish/],
    ['ok', { signedIn: false }, /Git could not use/],
  ] as const) {
    const h = setup(mode, opts);
    h.login.start({ harness: 'git:github.com' });
    await until(() => h.login.status('git:github.com')?.state === 'failed');
    assert.match(h.login.status('git:github.com')!.error!, expected);
    assert.deepEqual(h.marked, []);
  }
});

test('GitHub: helper setup and verification honor cancellation and never relay command output or secrets', async () => {
  let verify!: (answer: Record<string, 'yes'>) => void;
  const invalidated: string[] = [];
  const envs: any[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: { BROWSER: 'firefox', GH_BROWSER: 'firefox', KEEP: 'remote-env' },
    which: () => '/remote/gh',
    spawnFn: (_bin: string, _args: string[], opts: any) => {
      envs.push(opts.env);
      return spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_CLI_MODE: 'ok' } });
    },
    gitSignInCheck: Object.assign(
      () =>
        new Promise<Record<string, 'yes'>>((r) => {
          verify = r;
        }),
      {
        invalidate: () => {
          invalidated.push('invalidate');
        },
      },
    ),
  });
  login.start({ harness: 'git:github.com' });
  await until(() => verify);
  assert.equal(envs.length, 2);
  assert.ok(envs.every((env) => env.GH_BROWSER === 'true' && env.BROWSER === 'true' && env.KEEP === 'remote-env'));
  assert.equal(invalidated.length, 3);
  login.cancel('git:github.com');
  verify({ 'github.com': 'yes' });
  await until(() => login.idle());
  assert.equal(login.status('git:github.com')?.state, 'cancelled');
  assert.deepEqual(login.status('git:github.com')?.links, []);
});

test('codex: the colored link and code it prints are relayed as plain text, so the page opens and the code shows', async () => {
  const h = setup('codex-color');
  h.login.start({ harness: 'codex' });
  await until(() => h.login.status('codex')?.state === 'done');
  const done = h.login.status('codex')!;
  assert.deepEqual([done.links, done.codes], [['https://auth.openai.com/codex/device'], ['ABCD-EFGHI']]);
});

test('B: a colored failure line reads without its escapes', async () => {
  const h = setup('color-fail');
  h.login.start({ harness: 'codex' });
  await until(() => h.login.status('codex')?.state === 'failed');
  assert.equal(h.login.status('codex')!.error, 'Error: login was refused');
});

test('a code the person pasted reaches the CLI as one line, and a blank or missing one does not', async () => {
  const h = setup('input');
  assert.equal(h.login.input('claude', 'early'), false, 'no sign-in is under way yet');
  h.login.start({ harness: 'claude' });
  await until(() => h.login.status('claude')?.links.length);
  assert.equal(h.login.input('claude', ' \r\n '), false, 'an empty line would answer the prompt with nothing');
  assert.equal(h.login.input('codex', 'abc'), false, 'another harness has no sign-in under way');
  assert.equal(h.login.input('claude', 'abc\n#123\r\n'), true);
  await until(() => h.login.status('claude')?.state === 'done');
  assert.equal(fs.readFileSync(h.out, 'utf8'), 'abc #123\n');
});

test('B: a CLI that closed its input is not written to', async () => {
  const h = setup('hang');
  h.login.start({ harness: 'claude' });
  await until(() => h.login.status('claude')?.links.length);
  h.children[0].stdin.destroy();
  assert.equal(h.login.input('claude', 'abc'), false);
  h.login.cancel('claude');
  await until(() => h.login.status('claude')?.state === 'cancelled');
});

test('B: a link printed without a final newline is still read, and blank lines are not kept as the failure reason', async () => {
  const h = setup('nonl');
  h.login.start({ harness: 'codex' });
  await until(() => h.login.status('codex')?.state === 'done');
  assert.deepEqual(h.login.status('codex')!.links, ['https://auth.example.com/last']);
});

test('a CLI that fails says what it last printed; one that prints nothing says how it ended', async () => {
  const failing = setup('fail');
  failing.login.start({ harness: 'claude' });
  await until(() => failing.login.status('claude')?.state === 'failed');
  assert.equal(failing.login.status('claude')!.error, 'step 4 step 5 Login failed: the code was refused');
  assert.deepEqual(failing.probed, [], 'a failed CLI is not asked whether it signed in');
  assert.deepEqual(failing.marked, []);
  const silent = setup('silent');
  silent.login.start({ harness: 'codex' });
  await until(() => silent.login.status('codex')?.state === 'failed');
  assert.equal(silent.login.status('codex')!.error, 'Codex sign-in ended with code 2.');
});

test('W: a CLI that exits 0 without a login is a failure, not a sign-in', async () => {
  const h = setup('ok', { signedIn: false });
  h.login.start({ harness: 'claude' });
  await until(() => h.login.status('claude')?.state === 'failed');
  assert.equal(h.login.status('claude')!.error, 'Claude Code finished its sign-in, but this Host is still not signed in.');
  assert.deepEqual(h.marked, []);
});

test('W: a CLI that is not installed fails before anything is started', async () => {
  const h = setup('ok', { installed: false });
  h.login.start({ harness: 'codex' });
  await until(() => h.login.status('codex')?.state === 'failed');
  assert.equal(h.login.status('codex')!.error, 'Codex is not installed on this Host.');
  assert.deepEqual(h.ran, []);
});

test('W: a CLI that cannot be started fails with the reason', async () => {
  const login = createLogin({
    runtime: { host: {} } as any,
    env: {},
    which: () => '/nonexistent/claude',
    spawnFn: (bin: string, args: string[], opts: any) => spawn(bin, args, opts),
    probe: async () => true,
  });
  login.start({ harness: 'claude' });
  await until(() => login.status('claude')?.state === 'failed');
  assert.match(login.status('claude')!.error!, /ENOENT/);
});

test('A: cancelling stops the CLI and reads as cancelled, not failed', async () => {
  const h = setup('hang');
  h.login.start({ harness: 'claude' });
  await until(() => h.login.status('claude')?.links.length);
  assert.equal(h.login.cancel('claude'), true);
  await until(() => h.login.status('claude')?.state === 'cancelled');
  assert.equal(h.login.status('claude')!.error, null);
  await until(() => h.children[0].exitCode !== null || h.children[0].signalCode);
  await until(() => h.login.idle());
  assert.equal(h.login.idle(), true);
});

test('A: a sign-in the person never finishes expires (not failed), stops the CLI, and a new start gets a new attempt', async () => {
  const h = setup('hang', { loginMs: 150 });
  h.login.start({ harness: 'claude' });
  await until(() => h.login.status('claude')?.state === 'expired');
  assert.equal(h.login.status('claude')!.error, 'That code expired. Get a new one.');
  await until(() => h.children[0].exitCode !== null || h.children[0].signalCode);
  await until(() => h.login.idle());
  assert.equal(h.login.start({ harness: 'claude' }).state, 'waiting', 'one click starts again');
  assert.equal(h.ran.length, 2);
  h.login.close();
});

test('the vendor CLI signs in with BROWSER=true: no browser opens on the Host’s own screen, and the link it prints is still relayed', async () => {
  const envs: any[] = [];
  const login = createLogin({
    runtime: { host: {} } as any,
    env: { PATH: '/bin', BROWSER: 'firefox', KEEP: '1' },
    which: (name: string) => `/bin/${name}`,
    spawnFn: (_bin: string, _args: string[], opts: any) => (
      envs.push(opts.env), spawn(process.execPath, [FAKE], { ...opts, env: { ...process.env, FAKE_CLI_MODE: 'ok' } })
    ),
    probe: async () => true,
  });
  login.start({ harness: 'claude' });
  await until(() => login.status('claude')?.state === 'done');
  assert.deepEqual(envs, [{ PATH: '/bin', BROWSER: 'true', KEEP: '1' }]);
  assert.deepEqual(login.status('claude')!.links, ['https://auth.example.com/device']);
});

test('A: closing the service stops a sign-in under way', async () => {
  const h = setup('hang');
  h.login.start({ harness: 'codex' });
  await until(() => h.login.status('codex')?.links.length);
  h.login.close();
  await until(() => h.login.status('codex')?.state === 'cancelled');
});

test('mopilot-host login claude: a line typed at the terminal is the code the CLI asked for, and the sign-in ends with exit 0', async () => {
  const h = setup('input');
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const server = await startServer({ paths, runtime: { host: new (await import('node:events')).EventEmitter() } as any, login: h.login });
  try {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const out: string[] = [];
    const err: string[] = [];
    void until(() => h.login.status('claude')?.links.length).then(() => stdin.write('pasted-code\n'));
    const code = await main(['login', 'claude', '--data-dir', dir], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: {},
      pollMs: 20,
      stdin,
    });
    assert.equal(code, 0, err.join('\n'));
    assert.deepEqual(out, ['Signed in.']);
    assert.equal(fs.readFileSync(h.out, 'utf8'), 'pasted-code\n');
    assert.ok(
      err.some((l) => l.includes('https://auth.example.com/paste')),
      'the link is shown',
    );
  } finally {
    await server.close();
  }
});

test('mopilot-host login: a code that expires ends the command with exit 1 and says so', async () => {
  const h = setup('hang', { loginMs: 100 });
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const paths = createPaths({ dataDir: dir, env: {} });
  const server = await startServer({ paths, runtime: { host: new (await import('node:events')).EventEmitter() } as any, login: h.login });
  try {
    const err: string[] = [];
    const code = await main(['login', 'codex', '--data-dir', dir], { out: () => undefined, err: (l) => err.push(l), env: {}, pollMs: 20 });
    assert.deepEqual([code, err.at(-1)], [1, 'That code expired. Get a new one.']);
  } finally {
    await server.close();
  }
});
