// What the tests of the Mac's wiring of MoMo's real home share (tests/momoHomeService*.test.ts): the Hosts' ids, a system key that only hides the text, a start over the real machines service, and what each Host says to the methods MoMo's home asks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { startHomeService } = require('../../electron/momo/homeService.cjs');
const { sayHello } = require('../../electron/host/helloFirst.cjs');

export const STUDIO = 'a'.repeat(32);
export const MINI = 'b'.repeat(32);
export const RUNNING = { homeId: STUDIO, leaseEpoch: 3, state: 'running', stateSince: 1, lastSeenAt: 1, name: 'Studio' };

/** A system key that only makes the text unreadable, for a test that looks inside the file. */
export const safe = (on = true) => ({
  isEncryptionAvailable: () => on,
  encryptString: (s: string) => Buffer.from(`sealed:${Buffer.from(s).toString('base64')}`),
  decryptString: (b: Buffer) => Buffer.from(b.toString().replace(/^sealed:/, ''), 'base64').toString(),
});
export const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-home-service-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
export const tick = () => new Promise((r) => setTimeout(r, 30));
export const start = (o: any) =>
  startHomeService({ allowed: () => true, flagOn: () => true, account: () => 'ann', safeStorage: safe(), hello: sayHello, ...o });

/** What each Host says to the methods MoMo's home asks: the Studio holds `home`, the others none. */
export const hostSays =
  (home: object | null, extra: (id: string, method: string, p: any) => any = () => undefined) =>
  async (id: string, method: string, p: any) => {
    const x = extra(id, method, p);
    if (x !== undefined) return x;
    if (method === 'host.momoStatus') return { home: id === 'studio' ? home : null };
    if (method === 'host.momoHomeLook') {
      const h: any = id === 'studio' ? home : null;
      return h?.homeId
        ? { holds: 'home', homeId: h.homeId, leaseEpoch: h.leaseEpoch, name: h.name, state: h.state, grantLive: true }
        : { holds: 'none', leaseEpoch: 0, grantLive: true };
    }
    if (method === 'host.momoHomeStart') return { ok: true };
    if (method === 'host.momoChat') return { chatId: 'claude:c1' };
    // a Host that does not have the method says so as a Host does (an older Host does not know the look)
    throw Object.assign(new Error(`Unknown request: ${method}`), { code: 'unknown_request' });
  };
