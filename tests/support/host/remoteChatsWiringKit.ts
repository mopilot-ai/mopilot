// A fake ACP transcript and the Host IPC composition used by the machine chat wiring tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { keySafe } from '../hostKeySafe.ts';

const require = createRequire(import.meta.url);
const { register } = require('../../../electron/app/ipc/host.cjs');
const { OwnershipStore } = require('../../../electron/host/ownership.cjs');

export const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-chats-wiring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export function acpHostFake() {
  const records: any[] = [];
  const events: any[] = [];
  const closedQuestions: string[] = [];
  return {
    records,
    events,
    closedQuestions,
    questions: { openRemote: () => undefined, closeRemote: (id: string) => closedQuestions.push(id) },
    items: { append: (_id: string, ...r: any[]) => records.push(...r), readAsync: async () => [...records] },
    emitEvent: (e: any) => events.push(e),
  };
}

export const rowListeners: (() => void)[] = [];
export function startWorld(t: any, o: { allowed?: boolean | (() => boolean); row?: any; host?: any; safeStorage?: any } = {}) {
  const dir = tmp(t);
  const acp = acpHostFake();
  const handlers = new Map<string, any>();
  const live: any = { acpHost: acp, controller: { state: { get: () => ({ queue: [] }), patch: () => undefined } } };
  const row =
    'row' in o
      ? o.row
      : {
          name: 'build-box',
          status: 'online',
          harnesses: [
            { id: 'claude', detected: true },
            { id: 'kimi', detected: true, signedIn: false },
          ],
        };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { live, app: { getPath: () => dir }, shellEnv: { childEnv: () => ({}) }, broadcastAll: () => undefined },
    {
      create: () => ({
        list: () => ({ machines: [], resolved: true }),
        hostFor: () => o.host ?? null,
        remove: () => {},
        row: () => row,
        onRowChange: (fn: () => void) => ((rowListeners as any[]).push(fn), () => undefined),
      }),
      allowed: typeof o.allowed === 'function' ? o.allowed : () => (o.allowed as boolean | undefined) ?? true,
      safeStorage: o.safeStorage ?? keySafe,
    },
  );
  const begun: any[] = [];
  const followed: string[] = [];
  const order: string[] = [];
  // the services the handler reaches through main's live object
  const remote = live.remoteSend();
  if (remote) remote.begin = (...a: any[]) => (order.push('begin'), begun.push(a));
  const chats = live.remoteChats();
  if (chats) chats.follow = async (id: string) => (order.push('follow'), void followed.push(id));
  const start = (q: any) => handlers.get('host:startChat')(null, q);
  const own = () => new OwnershipStore(path.join(dir, 'host-ownership.json'));
  const setKey = (provider: string, key: string) => handlers.get('host:setApiKey')(null, provider, key);
  return { start, begun, followed, order, own, setKey, live, handlers };
}
