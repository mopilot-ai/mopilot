// The fixture of MoMo's memory tests (#2139): a fake Electron safeStorage (reversible, marked, so plain text never shows on disk and a changed byte fails to decrypt), and a store on a scratch folder that knows one MoMo chat.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MemoryStore } = require('../../electron/momo/memory.cjs');

const MARK = 'momo-test-v1:';
/** A safeStorage whose `available` and `failEncrypt` the test can turn off. */
export function fakeSafe() {
  const safe = {
    available: true,
    failEncrypt: false,
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => {
      if (safe.failEncrypt) throw new Error('keychain locked');
      return Buffer.from(Buffer.from(MARK + s, 'utf8').map((b) => b ^ 0x5a));
    },
    decryptString: (b: Buffer) => {
      const text = Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8');
      if (!text.startsWith(MARK)) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return text.slice(MARK.length);
    },
  };
  return safe;
}

/** One encrypted line or file, as the store writes it. */
export const sealed = (safe: ReturnType<typeof fakeSafe>, text: string) => safe.encryptString(text).toString('base64');

const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
/** A new scratch folder (removed after the file's tests); the store goes in its `momo` folder. */
export function scratch() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-memory-'));
  made.push(d);
  return d;
}

export const MOMO_CHAT = 'momo-main';
export const src = { chatId: MOMO_CHAT, harness: 'claude' };

/** A store with a fake key, the chat MOMO_CHAT as its only MoMo chat, a clock and ids f1, f2… */
export function momoStore(o: { now?: () => number; fs?: any; dir?: string; safe?: any; momo?: string[] } = {}) {
  let clock = 1_000;
  let n = 0;
  const safe = o.safe ?? fakeSafe();
  const momo = new Set(o.momo ?? [MOMO_CHAT]);
  const s = new MemoryStore({
    dir: o.dir ?? path.join(scratch(), 'momo'),
    safeStorage: safe,
    isMomoChat: (id: string) => momo.has(id),
    now: o.now ?? (() => clock),
    newId: () => `f${++n}`,
    fs: o.fs,
  });
  return { s, safe, tick: (ms = 1) => (clock += ms) };
}
