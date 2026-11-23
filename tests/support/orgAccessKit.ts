// Shared setup for the organization access service tests (electron/host/orgAccess/service.cjs): a temp folder, a reversing safeStorage, a fake IdP client and a fake clock.
import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './ports/clock.ts';

const require = createRequire(import.meta.url);
export const { createOrgAccess, configOf, identityOf } = require('../../electron/host/orgAccess/service.cjs');

export const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-org-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let n = 0;
export const HOUR = 3_600_000;
export const START = 1_000_000;
export const REFRESH = 'refresh-plain-0000-dummy';
export const ISSUER = 'https://idp.example.test';
export const CONFIG = {
  issuer: ISSUER,
  clientId: 'client-1',
  scopes: ' openid email ',
  leaseHours: 8,
  access: { kind: 'gateway', gateways: { anthropic: 'https://gw.example.test/a', openai: 'https://gw.example.test/o' } },
};
/** safeStorage stand-in: the stored bytes are the text reversed, so a plain secret never appears in the file. */
export const safe = (available = true) => ({
  broken: false,
  decrypts: 0,
  isEncryptionAvailable: () => available,
  encryptString: (s: string) => Buffer.from([...s].reverse().join('')),
  decryptString(this: { broken: boolean; decrypts: number }, b: Buffer) {
    this.decrypts++;
    if (this.broken) throw new Error('keychain locked');
    return [...b.toString()].reverse().join('');
  },
});

type Over = { subject?: string; refreshToken?: string | null; lifeMs?: number };
export function setup(
  t: { after: (fn: () => void) => void },
  { available = true, quiet = false, managed = null }: { available?: boolean; quiet?: boolean; managed?: any } = {},
) {
  /** The managed policy's view the service reads; a test sets `.value` to change it. */
  const managedState = { value: managed as any };
  const clock = installFakeClock(t, START);
  const file = path.join(base, `org-${n++}`, 'org.json');
  const storage = safe(available);
  const o: Over & {
    refreshError?: unknown;
    refreshGate?: Promise<void>;
    refreshes: any[];
    revokes: any[];
    signIns: number;
    renewedLife: number;
    nextRefreshToken: string | null;
    releaseSignIn?: () => void;
  } = {
    refreshes: [],
    revokes: [],
    signIns: 0,
    renewedLife: HOUR,
    nextRefreshToken: null,
  };
  const oidc = {
    signIn: async () => {
      o.signIns++;
      if (o.releaseSignIn === undefined) await Promise.resolve();
      return {
        accessToken: `access-signin-${o.signIns}-aaaaaaaa`,
        expiresAt: clock.now() + (o.lifeMs ?? HOUR),
        refreshToken: o.refreshToken === undefined ? REFRESH : o.refreshToken,
        subject: o.subject ?? 'user-1',
        who: 'a@example.test',
      };
    },
    refresh: async (cfg: unknown, refresh: string, now: number) => {
      o.refreshes.push({ refresh, now });
      await o.refreshGate;
      if (o.refreshError !== undefined) throw o.refreshError;
      return {
        accessToken: `access-renewed-${o.refreshes.length}-aaaa`,
        expiresAt: now + o.renewedLife,
        refreshToken: o.nextRefreshToken,
        idToken: undefined,
      };
    },
    revoke: async (cfg: unknown, refresh: string) => (o.revokes.push(refresh), true),
  };
  const reports: Error[] = [];
  const make = () =>
    createOrgAccess({
      file,
      safeStorage: storage,
      oidc,
      managed: () => managedState.value,
      ...(quiet ? {} : { report: (e: Error) => reports.push(e) }),
    });
  const svc = make();
  const changes = { count: 0 };
  svc.onChange(() => changes.count++);
  const host = () => {
    const calls: any[] = [];
    const h = { calls, fail: null as unknown, orgLease: async (p: any) => (calls.push(p), h.fail ? Promise.reject(h.fail) : { ok: true }) };
    return h;
  };
  const raw = () => fs.readFileSync(file, 'utf8');
  const rec = () => JSON.parse(raw());
  const patch = (f: (r: any) => void) => {
    const r = rec();
    f(r);
    fs.writeFileSync(file, JSON.stringify(r));
  };
  return { clock, file, storage, o, svc, make, reports, changes, host, raw, rec, patch, managedState };
}
export const tick = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};
export const id = (subject = 'user-1') => identityOf(ISSUER, subject);
