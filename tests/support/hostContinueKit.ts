// Loopback kit for the continue tests: real epoch/ledger/owner files per Host, a fake target, and a network that can lose a request or its reply at any call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
// @ts-ignore: plain ESM without declarations
import { createEpochStore } from '../../host/src/epochs.mjs';
// @ts-ignore
import { createLedger } from '../../host/src/ledger.mjs';
// @ts-ignore
import { createOwnerStore } from '../../host/src/owners.mjs';
// @ts-ignore
import { createContinueHost } from '../../host/src/continue.mjs';
// @ts-ignore
import { parseParams } from '../../shared/host/schema.mjs';

const require = createRequire(import.meta.url);
const { OwnershipStore } = require('../../electron/host/ownership.cjs');
const { createContinueMachine } = require('../../electron/host/continue.cjs');

export const CHAT = 'claude:c1';
export const quiet = { report: () => undefined };
export const tmpDir = (name = 'host-continue-') => fs.mkdtempSync(path.join(os.tmpdir(), name));

export type Kit = ReturnType<typeof makeHost>;

/** One Host: its files, a fake target that records what it opened and closed, and the switches a test flips. `dir` reused means a restart. */
export function makeHost(id: string, dir = tmpDir(), opts: { ttlMs?: number } = {}) {
  const problems: string[] = [];
  const epochs = createEpochStore(path.join(dir, 'epochs.json'), { report: (p: string) => problems.push(p) });
  const ledger = createLedger(path.join(dir, 'ledger'), { report: (p: string) => problems.push(p) });
  const owners = createOwnerStore(path.join(dir, 'owners.json'), { report: (p: string) => problems.push(p) });
  const log = { opened: [] as any[], discarded: [] as string[], served: [] as any[], retired: [] as string[], checks: [] as any[] };
  const state = {
    busy: false,
    now: 1_000,
    gate: null as null | Promise<void>,
    quiesce: null as null | Promise<void>,
    notConfigured: false,
    failRetire: false,
    failDiscard: false,
    /** the chats this Host runs now */
    running: new Set<string>(),
  };
  let natives = 0;
  let prepared = 0;
  const target = {
    async check(a: { harness: string; cwd: string }) {
      log.checks.push(a);
      if (state.gate) await state.gate;
      if (a.cwd === '/missing') throw Object.assign(new Error('That folder does not exist.'), { code: 'directory_missing' });
      if (state.notConfigured) throw Object.assign(new Error('Not set up.'), { code: 'harness_not_configured' });
      return a.cwd;
    },
    async open(a: any) {
      log.opened.push(a);
      if (state.gate) await state.gate;
      return { nativeId: `${id}-native-${++natives}` };
    },
    async discard(nativeId: string) {
      if (state.failDiscard) throw new Error('session would not close');
      log.discarded.push(nativeId);
    },
    serve(rec: any) {
      log.served.push(rec);
      state.running.add(rec.chatId);
    },
  };
  const host = createContinueHost({
    epochs,
    ledger,
    owners,
    target,
    serves: (chatId: string) => state.running.has(chatId),
    busy: () => state.busy,
    quiesce: () => state.quiesce ?? undefined,
    retire: async (chatId: string) => {
      if (state.failRetire) throw new Error('subscribers would not close');
      log.retired.push(chatId);
      state.running.delete(chatId);
    },
    report: (p: string) => problems.push(p),
    newId: () => `prep-${id}-${String(++prepared).padStart(4, '0')}`,
    now: () => state.now,
    ttlMs: opts.ttlMs,
  });
  return { id, dir, epochs, ledger, owners, host, log, state, problems, reopen: () => makeHost(id, dir, opts) };
}

type Rule = { hostId?: string; method: string; skip?: number; when: 'before' | 'after'; times?: number; error?: any };

/** The wire between the app and its Hosts. Every call is parsed by the real schema and served by the real Host module; a rule loses the request ('before') or only its reply ('after'). */
export function makeNet(hosts: Record<string, Kit>) {
  const down = new Set<string>();
  const calls: { hostId: string; method: string; params: any }[] = [];
  const rules: Rule[] = [];
  const serve = async (kit: Kit, method: string, raw: any) => {
    const p = parseParams(method, raw);
    if (method === 'chat.prepareContinue') return kit.host.prepare(p);
    if (method === 'chat.commitContinue') return kit.host.commit(p);
    if (method === 'chat.release') return kit.host.release(p);
    if (method === 'chat.subscribe') {
      kit.epochs.admit(p.chatId, p.epoch);
      kit.host.touch(p.chatId, p.epoch);
      return { subscribed: true };
    }
    throw new Error(`unserved ${method}`);
  };
  const take = (hostId: string, method: string, when: Rule['when']) => {
    const rule = rules.find((r) => r.method === method && r.when === when && (!r.hostId || r.hostId === hostId) && (r.times ?? 1) > 0);
    if (!rule) return null;
    if (rule.skip) return void rule.skip--, null;
    rule.times = (rule.times ?? 1) - 1;
    return rule;
  };
  const lost = (rule: Rule) => rule.error ?? Object.assign(new Error('The host is unreachable.'), { code: 'host_unreachable' });
  return {
    down,
    calls,
    /** Fails a call once (or `times`): 'before' never reaches the Host, 'after' loses only the answer. `skip` lets that many matching calls through first. */
    lose(rule: Rule) {
      rules.push(rule);
    },
    channel: (hostId: string) => ({
      async call(method: string, params: any) {
        calls.push({ hostId, method, params });
        if (down.has(hostId)) throw Object.assign(new Error('The host is unreachable.'), { code: 'host_unreachable', notSent: true });
        const before = take(hostId, method, 'before');
        if (before) throw before.error ?? Object.assign(lost(before), { notSent: true });
        const result = await serve(hosts[hostId], method, params);
        const after = take(hostId, method, 'after');
        if (after) throw lost(after);
        return result;
      },
    }),
  };
}

/** The app: a side map, the machine over the net, and the switches a test flips. */
export function makeApp(net: ReturnType<typeof makeNet>, o: { confirm?: (a: any) => Promise<boolean>; file?: string } = {}) {
  const file = o.file ?? path.join(tmpDir('host-continue-map-'), 'host-ownership.json');
  const ownership = new OwnershipStore(file);
  const offline = new Set<string>();
  const reports: string[] = [];
  const confirms: any[] = [];
  const merged: any[] = [];
  const tails: Record<string, any[]> = {};
  let keys = 0;
  let rev = 7;
  const machine = createContinueMachine({
    ownership,
    hostState: (id: string) => (net.down.has(id) || offline.has(id) ? 'offline' : 'online'),
    channel: net.channel,
    confirmLostHost: async (a: any) => (confirms.push(a), o.confirm ? o.confirm(a) : true),
    mirrorRev: () => rev,
    newKey: () => `key-${String(++keys).padStart(6, '0')}`,
    fetchTail: async ({ chatId, hostId, fromRev }: any) => (tails[`${hostId}|${chatId}`] ?? []).filter((i) => i.rev > fromRev),
    mergeTail: async (a: any) => void merged.push(a),
    report: (p: string) => reports.push(p),
    sleep: async () => undefined,
  });
  return {
    file,
    ownership,
    machine,
    offline,
    reports,
    confirms,
    merged,
    tails,
    setRev: (n: number) => (rev = n),
    reopenMap: () => new OwnershipStore(file),
  };
}

export const req = (over: Record<string, unknown> = {}) => ({
  chatId: CHAT,
  targetHostId: 'B',
  harness: 'claude',
  cwd: '/work/b',
  handoff: 'the conversation so far',
  ...over,
});

/** Hosts A (the source, running the chat) and B (the target) on one net, plus the app. */
export function scene(opts: { confirm?: (a: any) => Promise<boolean> } = {}) {
  const A = makeHost('A');
  const B = makeHost('B');
  A.state.running.add(CHAT);
  const hosts: Record<string, Kit> = { A, B };
  const net = makeNet(hosts);
  const app = makeApp(net, opts);
  app.ownership.set(CHAT, { hostId: 'A', ownerHostId: 'A', epoch: 0, folder: '/work/a' });
  return { A, B, hosts, net, app };
}
