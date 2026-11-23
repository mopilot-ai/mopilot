// The Host's opener (host/src/opener.mjs, #3368): a page a process the Host started asks to open is written down for the app instead of opening on this machine's screen; `open` and its kin resolve to it through PATH, BROWSER points at it, and a sign-in under way relays what it recorded (host/src/login.mjs).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createOpener, OPENER_NAMES, OPENED_ENV, withOpener } from '../host/src/opener.mjs';
import { createLogin, loginEnv } from '../host/src/login.mjs';

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-opener-')));
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
const URL1 = 'https://accounts.example.test/o/oauth2/auth?state=abc';

test('every opener name resolves to the shim through PATH ahead of the system one, and only records http(s) links', () => {
  const dataDir = fs.mkdtempSync(path.join(base, 'd-'));
  const opener = createOpener({ dataDir });
  const env = opener.env({ PATH: '/usr/bin:/bin', KEEP: '1' });
  assert.deepEqual(
    [env.PATH, env.BROWSER, env[OPENED_ENV], env.KEEP],
    [`${opener.dir}${path.delimiter}/usr/bin:/bin`, path.join(opener.dir, 'open'), path.join(dataDir, 'opened.links'), '1'],
  );
  assert.equal(fs.statSync(opener.dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, 'opened.links')).mode & 0o777, 0o600);
  for (const name of OPENER_NAMES) {
    // what a tool that spawns `open` by name gets: the shim, ahead of the system one (asked of the shell, nothing is run)
    assert.equal(spawnSync('sh', ['-c', `command -v ${name}`], { env, encoding: 'utf8' }).stdout.trim(), path.join(opener.dir, name));
    // run through sh (the test guard refuses a command named like an app opener, even this one)
    const r = spawnSync('sh', [path.join(opener.dir, name), URL1, '-a', 'Safari', 'file:///etc/passwd'], { env });
    assert.equal(r.status, 0, name);
  }
  assert.deepEqual(
    opener.take(),
    OPENER_NAMES.map(() => URL1),
  );
  assert.deepEqual(opener.take(), [], 'taken once');
  // $BROWSER <url>, the way Claude Code and many CLIs open a page
  spawnSync('sh', [env.BROWSER as string, 'http://localhost:1455/cb'], { env });
  assert.deepEqual(opener.take(), ['http://localhost:1455/cb']);
  // with no file named it records nothing and still succeeds
  assert.equal(spawnSync('sh', [path.join(opener.dir, 'open'), URL1], { env: { ...env, [OPENED_ENV]: '' } }).status, 0);
  assert.deepEqual(opener.take(), []);
  fs.rmSync(path.join(dataDir, 'opened.links'));
  assert.deepEqual(opener.take(), [], 'a file removed under the Host holds nothing');
  assert.deepEqual(createOpener({ dataDir }).env({}).PATH, opener.dir, 'no PATH: the opener alone');
});

test('withOpener gives a process built elsewhere the Host’s opener; without one its env is left as it is', () => {
  const from = { PATH: '/op:/usr/bin', BROWSER: '/op/open', [OPENED_ENV]: '/d/opened.links' };
  assert.deepEqual(withOpener(from, { PATH: '/usr/bin', X: '1' }), {
    PATH: '/op:/usr/bin',
    BROWSER: '/op/open',
    [OPENED_ENV]: '/d/opened.links',
    X: '1',
  });
  const env = { PATH: '/usr/bin' };
  assert.equal(withOpener({ PATH: '/x' }, env), env);
  // a sign-in CLI keeps the opener as its BROWSER; with none, `true` opens nothing
  assert.equal(loginEnv(from).BROWSER, '/op/open');
  assert.equal(loginEnv({ PATH: '/usr/bin' }).BROWSER, 'true');
});

test('a sign-in under way relays the links the opener recorded, and none from before it began', async () => {
  const dataDir = fs.mkdtempSync(path.join(base, 'l-'));
  const opener = createOpener({ dataDir });
  const env = opener.env({ PATH: process.env.PATH });
  // left over from before this sign-in
  spawnSync('sh', [env.BROWSER as string, 'https://stale.example.test/'], { env });
  let child: any;
  const login = createLogin({
    runtime: { host: {} } as any,
    env,
    which: (name: string) => `/bin/${name}`,
    opened: opener,
    // the vendor CLI opens its page itself with $BROWSER (the opener), then waits
    spawnFn: (_bin: string, _args: string[], opts: any) =>
      (child = spawn('sh', ['-c', `"$BROWSER" '${URL1}'; read x`], { ...opts, env: opts.env })),
    probe: async () => true,
  });
  login.start({ harness: 'claude' });
  await until(() => login.status('claude')!.links.includes(URL1));
  assert.deepEqual(login.status('claude')!.links, [URL1]);
  child.stdin.write('done\n');
  await until(() => login.idle());
});
