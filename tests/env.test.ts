// electron/platform/env.cjs: the login shell's environment snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const env = require('../electron/platform/env.cjs');
const { parseEnv0, scrubSnapshot, childEnv, capture, which, MARKER } = env;

test('setExtraEnv: variables every child gets on top (the $BROWSER shim), seeing the env so far; a failing hook is skipped', (t) => {
  t.after(() => env.setExtraEnv(null));
  env.setExtraEnv((e: any) => ({ BROWSER: '/shim.js', MOPILOT_BROWSER_FALLBACK: e.BROWSER }));
  assert.deepEqual(
    { ...childEnv({ PATH: '/usr/bin', BROWSER: 'firefox' }, null, 'darwin'), PATH: undefined },
    { BROWSER: '/shim.js', MOPILOT_BROWSER_FALLBACK: 'firefox', PATH: undefined },
  );
  assert.equal(childEnv({ PATH: 'C:\\x' }, null, 'win32').BROWSER, undefined, 'not on Windows');
  env.setExtraEnv(() => {
    throw new Error('not ready');
  });
  assert.equal(childEnv({ PATH: '/usr/bin' }, null, 'darwin').BROWSER, undefined);
  env.setExtraEnv('nope');
  assert.equal(childEnv({ PATH: '/usr/bin', BROWSER: 'x' }, null, 'darwin').BROWSER, 'x', 'anything but a function clears it');
});

function fakeShell(body: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  const file = path.join(dir, 'fake-shell');
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { dir, file };
}

test('parses NUL-separated env, skipping rc-file noise before the marker', () => {
  const out = `Welcome back!\n${MARKER}\0PATH=/a:/b\0MULTI=line one\nline two\0EQ=a=b=c\0EMPTY=\0=bad\0no-equals\0`;
  assert.deepEqual(parseEnv0(out), { PATH: '/a:/b', MULTI: 'line one\nline two', EQ: 'a=b=c', EMPTY: '' });
});

test('parses output without a marker as plain env -0', () => {
  assert.deepEqual(parseEnv0('A=1\0B=2\0'), { A: '1', B: '2' });
  assert.deepEqual(parseEnv0(''), {});
});

test('the snapshot drops auth and parent-session variables but keeps feature variables', () => {
  const snap = scrubSnapshot({
    PATH: '/x',
    ANTHROPIC_API_KEY: 'k',
    ANTHROPIC_AUTH_TOKEN: 't',
    ANTHROPIC_BASE_URL: 'https://gw',
    ANTHROPIC_CUSTOM_HEADERS: 'h',
    CLAUDE_CODE_OAUTH_TOKEN: 'o',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_ENTRYPOINT: 'cli',
    CLAUDE_CODE_SSE_PORT: '1234',
    CLAUDE_AGENT_SDK_VERSION: '0.3',
    CLAUDECODE: '1',
    SHLVL: '2',
    PWD: '/tmp',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    ANTHROPIC_MODEL: 'claude-x',
    NVM_DIR: '/n',
  });
  assert.deepEqual(snap, {
    PATH: '/x',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
    ANTHROPIC_MODEL: 'claude-x',
    NVM_DIR: '/n',
  });
});

test('child env: snapshot under the process env, PATH merged and widened', () => {
  const e = childEnv(
    { PATH: '/usr/bin:/mine', HOME: '/h', ONLY_BASE: '1' },
    { PATH: '/nvm/bin:/usr/bin', HOME: '/other', LANG: 'en_US.UTF-8' },
  );
  assert.equal(e.HOME, '/h');
  assert.equal(e.LANG, 'en_US.UTF-8');
  assert.equal(e.ONLY_BASE, '1');
  const p = e.PATH.split(':');
  assert.deepEqual(p.slice(0, 3), ['/nvm/bin', '/usr/bin', '/mine']);
  assert.ok(p.includes('/opt/homebrew/bin'));
  assert.equal(new Set(p).size, p.length);
});

test('child env without a snapshot is the process env with a widened PATH', () => {
  const e = childEnv({ PATH: '/usr/bin', A: '1' }, null);
  assert.equal(e.A, '1');
  assert.ok(e.PATH.startsWith('/usr/bin:'));
  assert.ok(e.PATH.includes('/opt/homebrew/bin'));
});

test('captures a login shell: profile exports reach the snapshot, inherited variables do not', async () => {
  const { dir, file } = fakeShell(
    'export PATH="/from/profile:$PATH"\nexport FROM_PROFILE=yes\necho "motd noise"\nfor a; do c=$a; done\nexec /bin/sh -c "$c"',
  );
  const r = await capture({ shell: file, env: { HOME: '/h', INHERITED_SECRET: 'x' } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.env.FROM_PROFILE, 'yes');
  assert.equal(r.env.HOME, '/h');
  assert.equal(r.env.INHERITED_SECRET, undefined);
  assert.ok(r.env.PATH.startsWith('/from/profile:'));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a shell that hangs times out and reports failure', async () => {
  const { dir, file } = fakeShell('sleep 30');
  const t0 = Date.now();
  const r = await capture({ shell: file, timeoutMs: 300, env: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing shell or one that prints no env fails', async () => {
  assert.equal((await capture({ shell: '/nonexistent/shell', env: {} })).ok, false);
  const { dir, file } = fakeShell('echo nothing here');
  assert.equal((await capture({ shell: file, env: {} })).ok, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('which finds an executable on a PATH', () => {
  const { dir } = fakeShell('true');
  fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'plain'), '', { mode: 0o644 });
  assert.equal(which('tool', `/nonexistent:${dir}`), path.join(dir, 'tool'));
  assert.equal(which('plain', dir), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Windows PATH lookup returns the first existing executable after earlier missing candidates', (t) => {
  const exists = fs.existsSync;
  t.mock.method(fs, 'existsSync', (p: string) => (p.startsWith('C:\\') ? p === 'C:\\later\\goose.exe' : exists(p)));
  assert.equal(which('goose.exe', 'C:\\first;C:\\later', 'win32'), 'C:\\later\\goose.exe');
});

test("the terminal's PATH is unknown until the login shell answers; on Windows it is this process's", () => {
  assert.equal(env.loginPath('darwin'), null);
  assert.equal(env.loginPath('win32'), process.env.PATH ?? null);
  const savedPath = process.env.PATH;
  delete process.env.PATH;
  assert.equal(env.loginPath('win32'), null, 'no PATH at all');
  process.env.PATH = savedPath;
  assert.equal(env.loginPath(), process.platform === 'win32' ? (process.env.PATH ?? null) : null);
  assert.equal(env.dirVars().HOME, process.env.HOME, 'no snapshot: this process');
});

test('init caches a scrubbed snapshot: auth exported in the profile never reaches a child', async () => {
  const { dir, file } = fakeShell(
    'export ANTHROPIC_API_KEY=sk-from-profile CLAUDE_CODE_OAUTH_TOKEN=tok CLAUDECODE=1 CLAUDE_CODE_MAX_OUTPUT_TOKENS=9\nfor a; do c=$a; done\nexec /bin/sh -c "$c"',
  );
  assert.equal(await env.init({ shell: file, env: { HOME: '/h' } }), true);
  assert.equal(await env.init({ shell: '/nonexistent' }), true, 'captured once');
  assert.deepEqual(env.status(), { captured: true, error: null });
  const e = childEnv({ PATH: '/usr/bin' });
  assert.equal(e.ANTHROPIC_API_KEY, undefined);
  assert.equal(e.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(e.CLAUDECODE, undefined);
  assert.equal(e.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '9');
  // the login shell's PATH is what a terminal searches; its variables sit under this process's for finding folders
  assert.ok(env.loginPath('darwin').split(':').includes('/usr/bin'));
  assert.equal(env.dirVars().CLAUDE_CODE_MAX_OUTPUT_TOKENS, '9');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('cloud-provider switches are dropped by default and kept on opt-in (D-35)', () => {
  const shell = {
    PATH: '/x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    AWS_REGION: 'us-east-1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'p',
    ANTHROPIC_BASE_URL: 'https://gw',
    ANTHROPIC_API_KEY: 'k',
  };
  assert.deepEqual(scrubSnapshot(shell), { PATH: '/x', AWS_REGION: 'us-east-1', ANTHROPIC_VERTEX_PROJECT_ID: 'p' });
  // opting in restores only the provider switches, never a key or gateway override
  assert.deepEqual(scrubSnapshot(shell, { cloud: true }), {
    PATH: '/x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
    AWS_REGION: 'us-east-1',
    ANTHROPIC_VERTEX_PROJECT_ID: 'p',
  });
  assert.deepEqual(env.pickCloud(shell), {
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_CODE_USE_FOUNDRY: '1',
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
  });
});
