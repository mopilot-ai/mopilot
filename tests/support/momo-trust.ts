// The fixture of MoMo's trust-layer tests (#2139): a fake Electron safeStorage (reversible and marked, so a changed byte fails to decrypt, and switchable off), scratch folders removed after the file's tests, and an audit log on one with a fake clock and ids i1, i2…
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AuditLog } = require('../../electron/momo/audit.cjs');

const MARK = 'momo-trust-test-v1:';
/** A safeStorage whose `available` and `failEncrypt` the test can turn off. */
export function fakeSafe() {
  const safe = {
    available: true,
    failEncrypt: false,
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => {
      if (safe.failEncrypt) throw new Error('keychain locked');
      return Buffer.from(Buffer.from(MARK + s, 'utf8').map((b) => b ^ 0x37));
    },
    decryptString: (b: Buffer) => {
      const text = Buffer.from(b.map((x) => x ^ 0x37)).toString('utf8');
      if (!text.startsWith(MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return text.slice(MARK.length);
    },
  };
  return safe;
}

const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
/** A new scratch folder, removed after the file's tests. */
export function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-trust-'));
  made.push(d);
  return d;
}

/** An audit log in a new `audit` folder with a fake key, a clock from 1000 and ids i1, i2… */
export function auditLog(o: { dir?: string; safe?: any; fs?: any; maxBytes?: number; maxFiles?: number; lock?: any } = {}) {
  let clock = 1_000;
  let n = 0;
  const safe = o.safe ?? fakeSafe();
  const dir = o.dir ?? path.join(scratch(), 'audit');
  const log = new AuditLog({
    dir,
    safeStorage: safe,
    fs: o.fs,
    now: () => clock,
    newId: () => `i${++n}`,
    maxBytes: o.maxBytes,
    maxFiles: o.maxFiles,
    lock: o.lock,
  });
  return { log, safe, dir, tick: (ms = 1) => (clock += ms) };
}

/** The log the next process opens on the same folder after this one crashed (its lock's pid counts as gone). */
export const afterCrash = (o: Parameters<typeof auditLog>[0] = {}) => auditLog({ ...o, lock: { pid: 4242, isAlive: () => false } });

export const act = {
  action: 'mail_send',
  args: { to: 'ann@example.com', body: 'secret plan' },
  chatId: 'momo-main',
  harness: 'claude',
  account: 'work',
  decision: 'asked:once',
};
