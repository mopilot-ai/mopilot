// What the home-link tests share: a temp folder, sealed storage, a scripted other Host and its answers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createFileSafeStorage } from '../../host/src/secretStore.mjs';

export const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
export const sealed = (dir: string) => ({ dir, safeStorage: createFileSafeStorage(path.join(dir, 'k')), now: () => 1 });
export const LEASE = { homeId: 'home-a', leaseEpoch: 3 };
export const HOST_B = 'b'.repeat(32);
export const MACHINE = { id: 'm1', name: 'Studio', link: 'opaque-link', hostId: HOST_B };
export const nextTick = () => new Promise((r) => setImmediate(r));

/** The other Host's end of the wire, scripted: what it answers per method, and the events it pushes. */
export function fakeHost(answers: Record<string, any> = {}) {
  const calls: { method: string; params: any }[] = [];
  const listeners: ((e: any) => void)[] = [];
  const closers: (() => void)[] = [];
  let closed = 0;
  const transport = {
    request: async (method: string, params: any) => {
      calls.push({ method, params });
      const a = answers[method];
      if (a instanceof Error) throw a;
      if (typeof a === 'function') return a(params);
      return a ?? {};
    },
    onEvent: (fn: (e: any) => void) => (listeners.push(fn), () => undefined),
    onClose: (fn: () => void) => void closers.push(fn),
    close: () => void closed++,
  };
  return {
    transport,
    calls,
    push: (e: any) => listeners.forEach((fn) => fn(e)),
    drop: () => closers.forEach((fn) => fn()),
    closed: () => closed,
  };
}
export const coded = (code: string, message = code) => Object.assign(new Error(message), { code });
export const AUTH = { 'host.challenge': { nonce: 'n1', hostId: HOST_B }, 'host.auth': { fingerprint: 'f' } };
