// Claude Code's key helper for an organization lease (host/src/orgKeyHelper.mjs, orgKeyHelperBin.mjs) and how the Host's Claude family starts a CLI with it (claudeFamily.mjs): the token comes over a socket in the Host's own folder to a caller with the capability of the identity its CLI was started for, never through the env or argv; a renewal reaches a running CLI with no restart, another identity's CLI never reads it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAcpRuntime } from '../host/src/acp.mjs';
import { createClaudeFamily } from '../host/src/claudeFamily.mjs';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { installElectronPorts } from '../host/src/electronPorts.mjs';
import {
  createOrgKeyHelper,
  HELPER_ENV,
  HELPER_TTL_MIN_MS,
  HELPER_TTL_MS,
  helperTtl,
  printKey,
  withKeyHelper,
} from '../host/src/orgKeyHelper.mjs';
import { createPaths } from '../host/src/paths.mjs';
import { createHostSessions } from '../host/src/sessions.mjs';
// @ts-ignore: plain ESM without declarations
import { createFakeClaudeSdk } from './support/fakeClaudeSdk.mjs';

const TOKEN_A = 'eyJ.dummy-org-token-alice-0000.sig';
const TOKEN_A2 = 'eyJ.dummy-org-token-alice-1111.sig';
const TOKEN_B = 'eyJ.dummy-org-token-bobby-0000.sig';
const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const GW = { anthropic: 'http://127.0.0.1:8787/anthropic' };
// a short folder: a unix socket path must fit sockaddr_un
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'okh-')));
const configDir = path.join(base, 'claude-config');
process.env.CLAUDE_CONFIG_DIR = configDir;
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
const lease = (o: Record<string, unknown> = {}) => ({
  harness: 'claude',
  identity: A,
  token: TOKEN_A,
  gateways: GW,
  expiresAt: Date.now() + 3_600_000,
  ...o,
});

/** What the helper prints for `env`, and its exit code. */
async function ask(env: Record<string, string | undefined>) {
  let out = '';
  const code = await printKey({ env, stdout: { write: (s: string) => (out += s) } });
  return { code, out };
}

test('the helper prints the token of the identity its capability is bound to, renewed tokens included; a wrong capability, no lease or no env prints nothing', async () => {
  const leases = createCredentialLeases();
  const helper = createOrgKeyHelper({ dir: base, leaseOf: (h, id) => leases.orgLease(h, id) });
  // a socket left by a Host killed hard with this pid is taken over, not refused
  fs.writeFileSync(helper.env(A, 3_600_000)[HELPER_ENV.socket], 'stale');
  await helper.listen();
  await helper.listen();
  try {
    const envA = helper.env(A, 3_600_000);
    const envB = helper.env(B, 3_600_000);
    assert.equal(envA[HELPER_ENV.cap], helper.env(A, 3_600_000)[HELPER_ENV.cap], 'one capability per identity');
    assert.notEqual(envA[HELPER_ENV.cap], envB[HELPER_ENV.cap]);
    assert.equal(envA[HELPER_ENV.ttl], String(HELPER_TTL_MS));
    for (const v of Object.values(envA)) assert.doesNotMatch(String(v), /dummy-org-token/, 'the env never carries the token');
    assert.deepEqual(await ask(envA), { code: 1, out: '' }, 'no lease yet');
    leases.setOrg(lease(), Date.now());
    leases.setOrg(lease({ identity: B, token: TOKEN_B }), Date.now());
    assert.deepEqual(await ask(envA), { code: 0, out: TOKEN_A }, "A's CLI reads A's token while B is in use");
    assert.deepEqual(await ask(envB), { code: 0, out: TOKEN_B });
    leases.setOrg(lease({ token: TOKEN_A2 }), Date.now());
    assert.deepEqual(await ask(envA), { code: 0, out: TOKEN_A2 }, 'a renewal reaches the running CLI at its next ask');
    assert.deepEqual(await ask({ ...envA, [HELPER_ENV.cap]: 'f'.repeat(64) }), { code: 1, out: '' });
    assert.deepEqual(await ask({ ...envA, [HELPER_ENV.cap]: 'short' }), { code: 1, out: '' });
    assert.deepEqual(await ask({}), { code: 2, out: '' });
    assert.deepEqual(await ask({ [HELPER_ENV.socket]: path.join(base, 'nothing.sock'), [HELPER_ENV.cap]: 'x' }), { code: 1, out: '' });
    // a caller that sends more than a line before its newline is cut off
    const flood = net.connect(envA[HELPER_ENV.socket]);
    await new Promise((r) => flood.once('connect', r));
    flood.write('x'.repeat(300));
    await new Promise((r) => flood.once('close', r));
    // a caller that goes away mid-line leaves the socket serving
    const gone = net.connect(envA[HELPER_ENV.socket]);
    gone.on('error', () => undefined);
    await new Promise((r) => gone.once('connect', r));
    gone.write('abc');
    gone.destroy();
    assert.equal((await ask(envB)).out, TOKEN_B);
    // the program Claude Code runs prints the same, and nothing else
    const [node, bin] = JSON.parse(`[${helper.command.replace('" "', '","')}]`);
    const printed = await new Promise<{ out: string; code: number }>((resolve) =>
      execFile(node, [bin], { env: { ...envA, PATH: process.env.PATH } }, (e, out) => resolve({ out, code: e ? Number(e.code) : 0 })),
    );
    assert.deepEqual(printed, { out: TOKEN_A2, code: 0 });
  } finally {
    helper.close();
    helper.close();
  }
});

test('the socket that will not open is a refusal; the helper made with the default node and random bytes names this node', async () => {
  const blocker = path.join(base, 'blk');
  fs.mkdirSync(blocker);
  const taken = createOrgKeyHelper({ dir: path.join(blocker, 'missing-dir'), leaseOf: () => null });
  await assert.rejects(taken.listen());
  assert.match(taken.command, new RegExp(JSON.stringify(process.execPath).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
  const fixed = createOrgKeyHelper({ dir: base, leaseOf: () => null, node: '/opt/node', randomBytes: (n) => Buffer.alloc(n, 7) });
  assert.match(fixed.command, /^"\/opt\/node" ".*orgKeyHelperBin\.mjs"$/);
  assert.equal(fixed.env(A, 3_600_000)[HELPER_ENV.cap], '07'.repeat(32));
});

test('withKeyHelper merges the helper into the --settings JSON the SDK passes, or adds its own', () => {
  const cmd = '"/n" "/h.mjs"';
  assert.deepEqual(withKeyHelper(['--print', '--settings', '{"fastMode":true}'], cmd), [
    '--print',
    '--settings',
    JSON.stringify({ fastMode: true, apiKeyHelper: cmd }),
  ]);
  assert.deepEqual(withKeyHelper(['--print'], cmd), ['--print', '--settings', JSON.stringify({ apiKeyHelper: cmd })]);
  // a settings file path, an array or a dangling flag: a second --settings carries the helper
  for (const args of [['--settings', '/x/settings.json'], ['--settings', '[1]'], ['--settings']])
    assert.deepEqual(withKeyHelper(args, cmd).slice(-2), ['--settings', JSON.stringify({ apiKeyHelper: cmd })]);
});

test('I: a CLI started with a lease in use gets the gateway and its identity’s capability, the helper in its settings, and no token anywhere; a renewal retires nothing, a new credential does', async () => {
  const dir = fs.mkdtempSync(path.join(base, 'd-'));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\n');
  const fake = createFakeClaudeSdk({ configDir });
  const leases = createCredentialLeases();
  const orgKey = createOrgKeyHelper({ dir: base, leaseOf: (h, id) => leases.orgLease(h, id) });
  const restore = installElectronPorts({
    paths: { dataDir: dir, configDir: path.join(dir, 'config') },
    openExternal: async () => undefined,
  });
  const runtime = createAcpRuntime({ paths: createPaths({ dataDir: dir, env: {} }), env: {} });
  let family: any;
  const sessions = createHostSessions({
    paths: createPaths({ dataDir: dir, env: {} }),
    env: { MOPILOT_CLAUDE_BIN: bin },
    runtime,
    families: { claude: (ctx: any) => (family = createClaudeFamily({ sdk: fake.sdk, leases, orgKey })(ctx)) },
  });
  try {
    leases.setOrg(lease(), Date.now());
    await sessions.chatRuntime.send({ key: `claude:${crypto.randomUUID()}`, text: 'hello', cwd: dir });
    const spawnCli = await until(() => fake.queries[0]?.options.spawnClaudeCodeProcess);
    const script =
      'process.stdout.write(JSON.stringify({ base: process.env.ANTHROPIC_BASE_URL ?? null, auth: process.env.ANTHROPIC_AUTH_TOKEN ?? null, key: process.env.ANTHROPIC_API_KEY ?? null, cap: process.env.MOPILOT_ORG_KEY_CAP ?? null, sock: process.env.MOPILOT_ORG_KEY_SOCKET ?? null, argv: process.argv.slice(1) }))';
    const seen = async () => {
      const child = spawnCli({
        command: process.execPath,
        args: ['-e', script, '--', '--settings', '{"fastMode":true}'],
        cwd: dir,
        env: { PATH: process.env.PATH },
        signal: new AbortController().signal,
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d));
      await new Promise((r) => child.once('close', r));
      return JSON.parse(out);
    };
    const lent = await seen();
    assert.equal(lent.base, GW.anthropic);
    assert.deepEqual([lent.auth, lent.key], [null, null], 'the token is not in the env');
    assert.equal(lent.cap, orgKey.env(A, 3_600_000)[HELPER_ENV.cap]);
    const settings = JSON.parse(lent.argv[lent.argv.indexOf('--settings') + 1]);
    assert.deepEqual(settings, { fastMode: true, apiKeyHelper: orgKey.command });
    assert.doesNotMatch(JSON.stringify(lent), /dummy-org-token/);
    assert.deepEqual(
      await ask({ [HELPER_ENV.socket]: lent.sock, [HELPER_ENV.cap]: lent.cap }),
      { code: 0, out: TOKEN_A },
      'prepare opened the socket',
    );
    // B's message: a CLI started now is B's; A's keeps reading A's token
    leases.setOrg(lease({ identity: B, token: TOKEN_B }), Date.now());
    const forB = await seen();
    assert.equal(forB.cap, orgKey.env(B, 3_600_000)[HELPER_ENV.cap]);
    assert.equal((await ask({ [HELPER_ENV.socket]: lent.sock, [HELPER_ENV.cap]: lent.cap })).out, TOKEN_A);
    // a renewal and a switch retire no CLI; a lease taken back does
    leases.setOrg(lease({ identity: B, token: TOKEN_A2 }), Date.now());
    assert.equal(!!fake.queries[0].closed, false);
    leases.setOrg({ harness: 'claude', identity: B, token: null }, Date.now());
    await until(() => fake.queries[0].closed);
    const plain = await seen();
    assert.deepEqual([plain.base, plain.cap], [null, null], 'no lease in use: a plain CLI');
    assert.equal(plain.argv.filter((a: string) => a === '--settings').length, 1, 'the SDK args untouched');
  } finally {
    sessions.close();
    runtime.close();
    await family?.close();
    orgKey.close();
    restore();
  }
});

test('A: a CLI asks the helper again within a tenth of its lease’s life, between 10 s and 5 min, so a renewal at 80% reaches it before the old token ends', () => {
  assert.equal(helperTtl(8 * 3_600_000), HELPER_TTL_MS, 'an 8 h lease: every 5 minutes');
  assert.equal(helperTtl(20 * 60_000), 120_000, 'a 20 min lease: every 2 minutes');
  assert.equal(helperTtl(90_000), HELPER_TTL_MIN_MS, 'a 90 s token: every 10 s, not more often');
  assert.equal(helperTtl(-5), HELPER_TTL_MIN_MS);
  const helper = createOrgKeyHelper({ dir: base, leaseOf: () => null });
  assert.equal(helper.env(A, 20 * 60_000)[HELPER_ENV.ttl], '120000');
});
