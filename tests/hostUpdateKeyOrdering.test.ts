// Host trust ordering: independent store instances and processes must observe committed revocations, and an authentication timestamp must never replace them with an older snapshot.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-ignore: plain ESM without declarations
import { createUpdateKeys } from '../host/src/updateKeys.mjs';
import { keyIdOf } from '../shared/host/updateSignature.mjs';
import { KEYS, pemPair } from './support/hostUpdateKit.ts';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'host-key-order-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
const make = () => {
  const configDir = fs.mkdtempSync(path.join(base, 'config-'));
  const store = () => createUpdateKeys({ configDir, fileKey: () => KEYS.pub, now: () => 1_800_000_000_000 });
  return { configDir, store };
};

test('a long-lived reader sees another instance revoke, and marking seen cannot resurrect the key', () => {
  const { store } = make();
  const held = store();
  assert.equal(held.entries().length, 1);
  store().apply({ signedBy: keyIdOf(pemPair().pub), revoke: [keyIdOf(KEYS.pub)] });
  assert.deepEqual(held.revoked(), [keyIdOf(KEYS.pub)], 'a held instance reads authoritative state');
  held.markSeen(keyIdOf(KEYS.pub));
  assert.deepEqual(store().entries(), [], 'authentication cannot undo the revocation');
  assert.deepEqual(store().revoked(), [keyIdOf(KEYS.pub)]);
});

test('two independent writers retain both revocations instead of replacing one with a cached snapshot', () => {
  const { store } = make();
  const a = store();
  const b = store();
  a.entries();
  b.entries();
  const first = keyIdOf(pemPair().pub);
  const second = keyIdOf(pemPair().pub);
  const signer = keyIdOf(KEYS.pub);
  a.apply({ signedBy: signer, revoke: [first] });
  b.apply({ signedBy: signer, revoke: [second] });
  assert.deepEqual(new Set(store().revoked()), new Set([first, second]));
});

test('a service instance cannot overwrite a revocation committed by a separate CLI process', () => {
  const { configDir, store } = make();
  const service = store();
  service.entries();
  const module = new URL('../host/src/updateKeys.mjs', import.meta.url).href;
  const signer = keyIdOf(pemPair().pub);
  const revoked = keyIdOf(KEYS.pub);
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import { createUpdateKeys } from ${JSON.stringify(module)};
    const cli = createUpdateKeys({configDir:${JSON.stringify(configDir)}, fileKey:()=>null});
    cli.apply({signedBy:${JSON.stringify(signer)}, revoke:[${JSON.stringify(revoked)}]});
  `,
  ]);
  service.markSeen(revoked);
  assert.deepEqual(store().revoked(), [revoked]);
  assert.deepEqual(service.entries(), []);
});
