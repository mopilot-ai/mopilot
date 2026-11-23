// The fixture of MoMo's sources tests (#2139 P2): a fake Electron safeStorage (reversible and marked, so plain text never shows on disk and a changed byte fails to decrypt), a decide and an audit that record what they're asked, and a hub on a scratch folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SourcesHub } = require('../../electron/momo/sources/hub.cjs');

const MARK = 'momo-sources-test:';
/** A safeStorage whose `available` the test can turn off. */
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
      if (!text.startsWith(MARK)) throw new Error('Error while decrypting');
      return text.slice(MARK.length);
    },
  };
  return safe;
}

const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});
/** A new scratch folder (real path), removed after the file's tests. */
export function scratch(prefix = 'momo-sources-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  made.push(d);
  return d;
}

/** A hub on a scratch folder with a recording decide (allow by default) and audit; MoMo allowed while `flags.allowed`. */
export function hubFixture(o: { allow?: boolean | ((call: any) => any); now?: () => number; audit?: any; decide?: any } = {}) {
  const dir = scratch();
  const safe = fakeSafe();
  const decided: any[] = [];
  const audited: any[] = [];
  const decide =
    o.decide === undefined
      ? (call: any) => {
          decided.push(call);
          const a = o.allow ?? true;
          return typeof a === 'function' ? a(call) : { allow: a, ...(a ? {} : { reason: 'denied by the user' }) };
        }
      : o.decide;
  const audit = o.audit === undefined ? { append: (e: any) => void audited.push(e) } : o.audit;
  const flags = { allowed: true };
  const hub = new SourcesHub({
    dir,
    safeStorage: safe,
    allowed: () => flags.allowed,
    decide,
    audit,
    now: o.now ?? (() => new Date(2026, 9, 23, 15, 30).getTime()),
  });
  return { dir, safe, hub, decided, audited, flags };
}

/** Whether the sources list marks `id` as connected but refused by macOS (`needsGrant`), the way Settings reads it. */
export const marked = (hub: any, id: string) => hub.list().find((s: any) => s.id === id)?.needsGrant === true;
