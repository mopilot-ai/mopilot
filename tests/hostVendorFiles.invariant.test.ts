// Nothing in the Host's install, login or sign-in paths reads the Mac's vendor directories: a token is created on the Host and stays there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const PATHS = [
  'host/src/install.mjs',
  'host/src/login.mjs',
  'host/src/cli.mjs',
  'electron/host/signin.cjs',
  'electron/host/sshTunnel.cjs',
  // the API key the user gives the app is lent to the Host's harness env; the CLI's own files are still never read
  'host/src/credentialLease.mjs',
  'electron/host/apiKeys.cjs',
  'electron/host/remoteCredentials.cjs',
];
const VENDOR = /['"`/~](\.codex|\.claude(\.json)?)\b|CODEX_HOME|CLAUDE_CONFIG_DIR|auth\.json|\.credentials/;

test('the install and sign-in sources name no vendor token file or directory', () => {
  for (const file of PATHS) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.doesNotMatch(source, VENDOR, `${file} must not touch the vendor dirs`);
  }
});

test('the scan sees a vendor path when one is written', () => {
  for (const sample of ["fs.readFileSync(os.homedir() + '/.codex/auth.json')", "path.join(home, '.claude')", 'process.env.CODEX_HOME']) {
    assert.match(sample, VENDOR);
  }
});
