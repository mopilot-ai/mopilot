// Whole-repository invariant for #3368: no process the Host starts can open a page on the Host's own screen. Every agent, CLI and sign-in the served Host creates runs in the opener's env (host/src/opener.mjs): the ACP runtime and its probe, Codex, the sessions (Claude Code), the sign-ins, and the status probes; a vendor sign-in CLI keeps that opener as BROWSER; Claude Code's CLI, whose env the SDK builds from this process, gets the opener added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');

test('the served Host builds every process-starting service on the opener env, never the bare one', () => {
  const cli = read('host/src/cli.mjs');
  const serve = cli.slice(cli.indexOf("case 'serve': {"), cli.indexOf("case 'status': {"));
  assert.match(serve, /const hostEnv = \{ \.\.\.opener\.env\(env\), \.\.\.gitFailFastEnv\(/);
  for (const factory of [
    'createNoSignIn',
    'createAcpRuntime',
    'createCodexFamily',
    'createHostSessions',
    'createLogin',
    'reportedHarnesses',
  ]) {
    const calls = serve.match(new RegExp(`${factory}\\(\\{[^}]*\\}`, 'g')) ?? [];
    assert.ok(calls.length > 0, `${factory} is built in serve`);
    for (const call of calls) assert.match(call, /env: hostEnv/, `${factory} must run on the opener env: ${call}`);
  }
});

test('a vendor sign-in CLI and the Claude Code CLI start with the opener', () => {
  const login = read('host/src/login.mjs');
  assert.match(login, /spawnGroup\(spawnFn, bin, args, \{\s+managed: true,\s+env: \{ \.\.\.loginEnv\(env\)/);
  assert.match(login, /GH_BROWSER: 'true', GH_PROMPT_DISABLED: '1'/);
  assert.match(login, /BROWSER: env\[OPENED_ENV\] && env\.BROWSER \? env\.BROWSER : 'true'/);
  assert.match(read('host/src/claudeFamily.mjs'), /withOpener\(ctx\.env, o\.env\)/);
});

test('the scan sees a service built on the bare env', () => {
  assert.doesNotMatch('createAcpRuntime({ paths, env, signedIn })', /env: hostEnv/);
});
