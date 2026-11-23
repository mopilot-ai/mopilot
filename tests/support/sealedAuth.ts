// An added Codex account's sign-in as electron/identity/accounts/authVault.cjs keeps it at rest: auth.json.enc decrypted
// with the fakeSafe stand-in, and no plain auth.json beside it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fakeSafe } from './computerHistory.ts';

export function sealedAuth(home: string): any {
  assert.equal(fs.existsSync(path.join(home, 'auth.json')), false, `no plain sign-in in ${home}`);
  const env = JSON.parse(fs.readFileSync(path.join(home, 'auth.json.enc'), 'utf8'));
  assert.equal(env.enc, 'safe');
  return JSON.parse(fakeSafe().decryptString(Buffer.from(env.data, 'base64')));
}

/** The sealed sign-in once the account's sidecar (which reads it in plain text while it runs) has closed. */
export async function sealedAfterSidecar(accounts: any, home: string): Promise<any> {
  await accounts.sidecars.get(home)?.close();
  return sealedAuth(home);
}
