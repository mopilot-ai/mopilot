// Whole-repository invariant for the user's model key lent to a Host (#3361 Tier 1): the key's env names are read only where the key is defined, held or handed to a harness process; the files that hold it never log it, write it in the clear or put it on a command line; and the Host's `status` never carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCredentialLeases } from '../host/src/credentialLease.mjs';
import { hostStatus } from '../host/src/status.mjs';

const ROOT = path.join(import.meta.dirname, '..');
/** Where a lent key may be named or its value touched: the shared table, the app's store and lender, the Host's holder and the one spawn that reads it. */
const ALLOWED = new Set([
  'shared/host/credentials.mjs',
  'electron/host/apiKeys.cjs',
  'electron/host/remoteCredentials.cjs',
  'host/src/credentialLease.mjs',
  'host/src/claudeFamily.mjs',
  'host/src/codexFamily.mjs',
  // Tier 2: the shared lease table names the env Codex must never be given it under; an ACP agent reads the lease from its env
  'shared/host/orgAccess.mjs',
  'host/src/acp.mjs',
]);
/** The code a Host's or the app's Host side runs. */
const SCANNED = ['host/src', 'electron/host', 'shared/host'];
const sources = SCANNED.flatMap((dir) =>
  fs
    .readdirSync(path.join(ROOT, dir), { recursive: true })
    .map((f) => path.join(dir, String(f)))
    .filter((f) => /\.(c|m)?js$/.test(f)),
);

test('the lease and its env name are touched only by the files that hold or hand it on', () => {
  const touching = sources.filter((f) =>
    /ANTHROPIC_API_KEY|OPENAI_API_KEY|\bleases\??\.(envFor|loginKey)\b|forHarness\(/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')),
  );
  assert.deepEqual(
    touching.filter((f) => !ALLOWED.has(f)),
    [],
    'a new place that reads the key: route it through credentialLease.mjs / remoteCredentials.cjs, or add it here with a reason',
  );
});

test('the files that hold the key never log it, never write it in the clear and never start a process with it in argv', () => {
  for (const f of ['host/src/credentialLease.mjs', 'electron/host/remoteCredentials.cjs', 'shared/host/credentials.mjs']) {
    const source = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.doesNotMatch(source, /console\.|noteIgnored|report\(|writeFile|appendFile|spawn\(|execFile/, f);
  }
  // the Host's view of the keys and the provider key store it shares with routed chats (electron/routing/providerKeys.cjs)
  for (const f of [
    'electron/host/apiKeys.cjs',
    'electron/routing/providerKeys.cjs',
    'electron/app/ipc/routing.cjs',
    'electron/app/ipc/hostApiKeys.cjs',
  ])
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /console\.|spawn\(|execFile/, f);
  for (const f of ['electron/host/apiKeys.cjs', 'electron/routing/providerKeys.cjs'])
    assert.doesNotMatch(
      fs.readFileSync(path.join(ROOT, f), 'utf8'),
      /noteIgnored|readStoreFile/,
      `${f} logs nothing that could quote the key file`,
    );
  const store = fs.readFileSync(path.join(ROOT, 'electron/routing/providerKeys.cjs'), 'utf8');
  // the store writes only what safeStorage encrypted
  assert.match(store, /encryptForStore\(safeStorage, trimmed\)/);
  assert.match(store, /keys: \{ \.\.\.now\.keys, \[slot\]: encrypted\.value \}/);
  assert.doesNotMatch(store, /\[(provider|slot)\]: (trimmed|key)\b/);
  // the Claude Code CLI gets it in its env
  const spawn = fs.readFileSync(path.join(ROOT, 'host/src/claudeFamily.mjs'), 'utf8');
  assert.match(
    spawn,
    /env: \{\s*\.\.\.withOpener\(ctx\.env, o\.env\),\s*\.\.\.\(own \? \{\} : leases\?\.envFor\('claude'\)\),\s*\.\.\.\(identity && orgKey \? orgKey\.env\(identity, [^)]*\)\.expiresAt - Date\.now\(\)\) : \{\}\),?\s*\}/,
  );
  // the SDK's args change only by the key helper's setting (orgKeyHelper.mjs), which names a command, never a token
  assert.match(spawn, /const args = identity && orgKey \? withKeyHelper\(o\.args, orgKey\.command\) : o\.args;/);
  // Codex is told the key over its stdin after initialize, only by a process started with an ephemeral store; its arguments carry the store mode, never the key
  const codex = fs.readFileSync(path.join(ROOT, 'host/src/codexFamily.mjs'), 'utf8');
  assert.match(codex, /const EPHEMERAL_STORE = \['-c', 'cli_auth_credentials_store="ephemeral"'\];/);
  assert.match(codex, /const key = startedKeyed \? leases\?\.loginKey\('codex'\) : null;/);
  assert.match(codex, /adapter\.call\('account\/login\/start', \{ type: 'apiKey', apiKey: key \}/);
  assert.doesNotMatch(codex, /console\.|noteIgnored\([^)]*key/);
});

test('the Host status says whether Claude Code takes a key, never which one', () => {
  const leases = createCredentialLeases();
  const KEY = 'sk-ant-dummy-0000-test-key-abcd';
  leases.set('claude', KEY);
  const status = hostStatus({ running: true, harnesses: [{ id: 'claude', detected: true, signedIn: false, takesKey: true } as any] });
  assert.doesNotMatch(JSON.stringify(status), /sk-ant-dummy/);
  assert.equal(leases.has('claude'), true);
});

test('the scan sees a new reader when one is written', () => {
  assert.match('env.ANTHROPIC_API_KEY = key', /ANTHROPIC_API_KEY/);
  assert.match('leases.envFor(harness)', /\bleases\.envFor\b/);
});
