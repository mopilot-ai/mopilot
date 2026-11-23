// The fixture of MoMo's Routines tests (#2139): a fake Electron safeStorage (reversible and marked, so plain text never shows on disk and a changed byte fails to decrypt) and scratch folders.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';

const MARK = 'sealed:';

/** A safeStorage the test can turn off (`available`) or make fail to encrypt (`failEncrypt`). */
export function fakeSafe() {
  const safe = {
    available: true,
    failEncrypt: false,
    isEncryptionAvailable: () => safe.available,
    encryptString: (text: string) => {
      if (safe.failEncrypt) throw new Error('Error while encrypting the text provided to safeStorage.encryptString.');
      return Buffer.from(MARK + Buffer.from(text, 'utf8').toString('hex'));
    },
    decryptString: (b: Buffer) => {
      const text = b.toString('utf8');
      if (!text.startsWith(MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return Buffer.from(text.slice(MARK.length), 'hex').toString('utf8');
    },
  };
  return safe;
}

/** A scratch folder, removed after the file's tests. */
export function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-test-'));
  after(() => {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return path.join(dir, 'momo');
}

/** A clock the test moves. */
export function clock(start: number) {
  const c = { t: start, now: () => c.t };
  return c;
}

/** Ids in order: id-1, id-2, ... */
export function ids() {
  let n = 0;
  return () => `id-${++n}`;
}
