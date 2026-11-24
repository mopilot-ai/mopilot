// Whole-repository invariant for organization leases (#3361 Tier 2): the org refresh token is kept only encrypted by the app's orgAccess service, the access token lives only in app memory, Host memory and a harness child's env (Codex) or key helper answer (Claude Code); only the named files touch it, none of them logs it, writes it in the clear or puts it on a command line; a Host's env carries only the allowlisted names; `status` never carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { orgProviderArgs } from '../host/src/codexFamily.mjs';
import { hostStatus } from '../host/src/status.mjs';

const ROOT = path.join(import.meta.dirname, '..');
/** Where a lease's token may be read or handed on, each for one reason. */
const ALLOWED = new Set([
  // the shared table (the env names) and the Host's holder
  'shared/host/orgAccess.mjs',
  'host/src/credentialLease.mjs',
  // Claude Code reads it through the key helper; Codex through its model provider's env; an ACP agent from its env
  'host/src/orgKeyHelper.mjs',
  'host/src/claudeFamily.mjs',
  'host/src/codexFamily.mjs',
  'host/src/acp.mjs',
  // names `host.orgLease` in the list of methods a controller is refused: it reads no token
  'host/src/controllerRefusals.mjs',
  'host/src/cli.mjs',
  // the app: the service that mints it, the IdP client and source adapters it comes from, the lender, sign-out (takes it back) and the wire call
  'electron/host/orgAccess/service.cjs',
  'electron/host/orgAccess/oidc.cjs',
  'electron/host/orgAccess/providers.cjs',
  'electron/host/remoteCredentials.cjs',
  'electron/host/signOut.cjs',
  'electron/host/remoteSignin.cjs',
  // MoMo's Google connection holds the user's own Google OAuth tokens (accessToken, refresh_token): not an organization lease, and never an org token
  'host/src/momoGoogle.mjs',
  // the wire: the request's name and parser (the schema checks it, the protocol hands it to the holder, the server admits it from a paired client only)
  'shared/host/schema.mjs',
  'host/src/protocol.mjs',
  'host/src/server.mjs',
]);
const SCANNED = ['host/src', 'electron/host', 'shared/host'];
const sources = [
  ...SCANNED.flatMap((dir) =>
    fs
      .readdirSync(path.join(ROOT, dir), { recursive: true })
      .map((f) => path.join(dir, String(f)))
      .filter((f) => /\.(c|m)?js$/.test(f)),
  ),
  // the Host's own IPC files; another feature's IPC has no reason to reach a lease
  'electron/app/ipc/host.cjs',
  'electron/app/ipc/hostOrgAccess.cjs',
];
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf8');
/** What reaching a lease's token looks like in source. */
const TOUCH = /\borgLease\??\.?\(|\bsetOrg\(|ANTHROPIC_AUTH_TOKEN|MOPILOT_ORG_TOKEN|CODEX_TOKEN_ENV|accessToken|refresh_token|\.orgLease\b/;

test('a lease’s token is reached only by the files that mint, hold or hand it on', () => {
  const touching = sources.filter((f) => TOUCH.test(read(f)));
  assert.deepEqual(
    touching.filter((f) => !ALLOWED.has(f)),
    [],
    'a new place that reads an organization token: route it through credentialLease.mjs / orgAccess/service.cjs, or add it here with a reason',
  );
});

test('the files that hold a token never log it, never write it in the clear and never start a process with it in argv', () => {
  for (const f of [
    'host/src/credentialLease.mjs',
    'host/src/orgKeyHelper.mjs',
    'shared/host/orgAccess.mjs',
    'electron/host/orgAccess/oidc.cjs',
    'electron/host/orgAccess/providers.cjs',
  ])
    assert.doesNotMatch(read(f), /console\.|noteIgnored|report\(|writeFile|appendFile|spawn\(|execFile/, f);
  const service = read('electron/host/orgAccess/service.cjs');
  assert.doesNotMatch(service, /console\.|noteIgnored|spawn\(|execFile/);
  // the refresh token and an org key are written only as safeStorage encrypted them; the access token is never written
  assert.match(service, /const encrypted = encryptForStore\(safeStorage, value\);/);
  assert.doesNotMatch(service, /rec\[field\] = value|refresh: t\.|refreshToken\s*[,}]\s*\)?\s*;?\s*write|write\(\{[^)]*accessToken/);
  assert.doesNotMatch(service, /writePrivate\([^)]*token/i);
  // the IPC answers views, never a token
  const ipc = read('electron/app/ipc/hostOrgAccess.cjs');
  assert.doesNotMatch(ipc, /accessToken|refresh|\.token\b/);
  // Codex's arguments carry the gateway address and the env name, never the token
  assert.equal(orgProviderArgs.length, 1);
  assert.doesNotMatch(orgProviderArgs('https://llm.example.test/v1').join(' '), /eyJ|dummy-org-token/);
  assert.match(
    orgProviderArgs('https://llm.example.test/v1').join(' '),
    /env_key = "MOPILOT_ORG_TOKEN"/,
    'the token is named by its env, never given',
  );
  // the Claude Code CLI asks the helper; the spawn adds the helper's command and capability, never the token
  assert.doesNotMatch(read('host/src/claudeFamily.mjs'), /\.token\b/);
});

test('a Host gives a harness only the allowlisted env names, and `status` never says which token it holds', () => {
  const leases = createCredentialLeases();
  const TOKEN = 'eyJ.dummy-org-token-invariant-0000.sig';
  const gateways = { anthropic: 'https://llm.example.test/a', openai: 'https://llm.example.test/o' };
  for (const harness of ['claude', 'codex', 'acp'])
    leases.setOrg({ harness, identity: 'a'.repeat(32), token: TOKEN, gateways, expiresAt: Date.now() + 3_600_000 }, Date.now());
  assert.equal(leases.orgIdentity('codex'), 'a'.repeat(32));
  assert.equal(leases.orgIdentity('gemini'), undefined);
  const ALLOW = new Set(['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_BASE_URL', 'OPENAI_API_KEY']);
  for (const harness of ['claude', 'codex', 'acp', 'gemini'])
    for (const name of Object.keys(leases.envFor(harness))) assert.ok(ALLOW.has(name), `${harness}: ${name}`);
  assert.equal(JSON.stringify(leases.envFor('claude')).includes(TOKEN), false, 'Claude Code’s env never carries the token');
  assert.equal(JSON.stringify(leases.envFor('codex')).includes(TOKEN), false);
  const status = hostStatus({
    running: true,
    harnesses: [{ id: 'claude', detected: true, signedIn: false, takesKey: true, takesOrg: true } as any],
  });
  assert.doesNotMatch(JSON.stringify(status), /dummy-org-token/);
  leases.clear();
});

test('the scan sees a new reader when one is written', () => {
  for (const line of ['leases.orgLease(h)', 'env.ANTHROPIC_AUTH_TOKEN = t', 'x.setOrg(l, now)', 'const { accessToken } = t'])
    assert.match(line, TOUCH);
});
