// Shared by the Switch host service tests: a Mac with a continue Host, machines B and C running the real protocol, and the helpers to talk to them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeHostProcess } from './hostProcessKit.ts';

const require = createRequire(import.meta.url);
const { createHostContinue } = require('../../electron/host/hostContinue.cjs');
const { createLocalContinue } = require('../../electron/host/localContinue.cjs');
const { createTailStore } = require('../../electron/host/tailStore.cjs');
const { createContinueInbox } = require('../../electron/host/continueInbox.cjs');
const { OwnershipStore } = require('../../electron/host/ownership.cjs');

export const CHAT = 'claude:c1';
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-service-'));
export const code = (c: string) => (e: any) => e?.code === c;
export const turns = [
  {
    id: 't1',
    status: 'completed',
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'fix the login bug' }] },
      { type: 'agentMessage', text: 'Fixed it in auth.ts.' },
    ],
  },
];

/** `harness`: what the chat runs on (default an ACP agent the fake Hosts take); `kept`: told the agent a continued chat runs on. */
export function world(over: { harness?: string; kept?: (chatId: string, harness: string) => void } = {}) {
  const dir = tmp();
  const hosts: Record<string, ReturnType<typeof makeHostProcess>> = { B: makeHostProcess('B'), C: makeHostProcess('C') };
  const down = new Set<string>();
  const problems: string[] = [];
  const retired: string[] = [];
  const inbox = createContinueInbox({ dir: path.join(dir, 'inbox') });
  const local = createLocalContinue({
    dir: path.join(dir, 'local'),
    target: inbox.target,
    serves: () => true,
    busy: () => false,
    retire: async (chatId: string) => void retired.push(chatId),
    report: (p: string) => problems.push(p),
  });
  const ownership = new OwnershipStore(path.join(dir, 'host-ownership.json'));
  ownership.set(CHAT, { hostId: 'local', ownerHostId: 'local', epoch: 0, folder: '/mac/app' });
  const tails = createTailStore(path.join(dir, 'tails.json'));
  const sessions: string[] = [];
  let keys = 0;
  const service = createHostContinue({
    ownership,
    hostState: (id: string) => (id === 'local' || !down.has(id) ? 'online' : 'offline'),
    session: async (hostId: string, onEvent?: (e: any) => void) => {
      if (down.has(hostId)) throw new Error('The machine is unreachable.');
      sessions.push(hostId);
      const conn = hosts[hostId].protocol.connection((m: object) => onEvent?.(m));
      return { call: (method: string, params: object) => conn.call(method, params), close: () => conn.close() };
    },
    local: local.channel,
    localTurns: async () => ({ turns, failed: [], label: 'Claude Code', model: null }),
    harnessOf: () => ({ harness: over.harness ?? 'acp:gemini', label: 'Gemini' }),
    tails,
    report: (p: string) => problems.push(p),
    newKey: () => `service-key-${String(++keys).padStart(6, '0')}`,
    mirrorRev: () => 1,
    mirror: () => null,
    sleep: async () => undefined,
    ...(over.kept ? { kept: over.kept } : {}),
  });
  return { dir, hosts, down, problems, retired, local, inbox, ownership, tails, sessions, service };
}
export const req = (over: object = {}) => ({ chatId: CHAT, targetHostId: 'B', cwd: '/work/b', lostHostConfirmed: false, ...over });
/** A client connection that has said hello. */
export async function connect(host: ReturnType<typeof makeHostProcess>) {
  const events: any[] = [];
  const conn = host.protocol.connection((m: object) => events.push(m));
  await conn.call('host.hello', { protocol: { minor: 1, floor: 1 }, features: ['epoch', 'dedupe', 'isolation', 'lanes'] });
  return { conn, events };
}
let n = 0;
export const key = () => `direct-key-${String(++n).padStart(6, '0')}`;
