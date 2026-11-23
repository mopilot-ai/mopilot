// Fixtures for Mobile Remote's main-process tests: a fake safeStorage, a temporary folder, and the real libsodium primitives.
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsp from 'node:fs/promises';
import { after } from 'node:test';

const require = createRequire(import.meta.url);
const { createSodiumPrimitives } = require('../../electron/remote/sodiumPrimitives.cjs');

export const prim = createSodiumPrimitives();

/** safeStorage that reverses bytes; `available` and `broken` flip its failure modes. */
export function fakeSafe(o: { available?: boolean } = {}) {
  const safe = {
    available: o.available ?? true,
    broken: false,
    isEncryptionAvailable: () => safe.available,
    encryptString: (s: string) => {
      if (safe.broken) throw new Error('keychain gone');
      return Buffer.from(`sealed:${s}`);
    },
    decryptString: (b: Buffer) => {
      const s = b.toString();
      if (safe.broken || !s.startsWith('sealed:')) throw new Error('cannot decrypt');
      return s.slice(7);
    },
  };
  return safe;
}

export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mopilot-remote-'));
  after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export const fs = fsp as typeof import('node:fs/promises');

/** A sealed Mobile Remote file's text, opened with the same fake safeStorage that sealed it (a plain JSON file is returned as it is). */
export async function openSealed(file: string, safe: ReturnType<typeof fakeSafe>) {
  const text = await fsp.readFile(file, 'utf8');
  return text.trimStart().startsWith('{') ? text : safe.decryptString(Buffer.from(text.trim(), 'base64'));
}
