// Remote service test kit: fake operations that record their calls, a real SessionStore, and a memory link with phones that ask and listen.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createMemoryLink } from '../../shared/remote/transport.mjs';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../../electron/session/state.cjs');
const { RemoteService } = require('../../electron/remote/service.cjs');

/** A phone's send answer without `tookMs` (how long the Mac held the request, a number every time). */
export function sansTook(reply: any) {
  const { tookMs, ...rest } = reply;
  assert.equal(typeof tookMs, 'number');
  return rest;
}

/** Lets the service's promise chains run. */
export const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

export const CARD_CHOICES = [
  { key: 'once', label: 'Allow once' },
  { key: 'similar', label: 'Always allow this prefix', confirm: 'Permanently allow?' },
  { key: 'deny', label: 'Deny', deny: true },
];

/** The panel's operations as fakes; `calls` records [name, ...args]. */
export function fakeOps(extra: Record<string, any> = {}) {
  const calls: any[][] = [];
  const known = new Set(['c1', 'c2']);
  const cards: Record<string, any[]> = {
    c1: [{ id: 'a1', title: 'Run this command?', detail: 'ls', choices: CARD_CHOICES, version: 'v1' }],
  };
  const record =
    (name: string, result: any = {}) =>
    (...args: any[]) => (calls.push([name, ...args]), typeof result === 'function' ? result(...args) : result);
  const holder: { service?: any } = {};
  const state = new SessionStore({ publish: (p: any) => holder.service?.onSessionPatch(p) });
  const ops: Record<string, any> = {
    recent: record('recent', [{ id: 'c1', title: 'One', harness: 'codex', at: 1, project: null, pinned: false }]),
    turn: record('turn', 'running'),
    projects: record('projects', [{ id: 'p1', name: 'P' }]),
    scheduled: record('scheduled', async () => [{ id: 't', name: 'T', next: null }]),
    pin: record('pin', (id: string) => known.has(id)),
    harnesses: record('harnesses', async () => [{ id: 'codex', label: 'Codex' }]),
    usable: record('usable', async (h: string) => h !== 'acp:off'),
    options: record('options', async () => ({ models: [] })),
    commands: record('commands', async () => ({ commands: [] })),
    choose: record('choose', async () => undefined),
    permit: record('permit', async () => undefined),
    switchHarness: record('switchHarness', async () => undefined),
    dictation: {
      engine: async () => 'local',
      transcribe: record('transcribe', async () => ({ text: 'hi' })),
      // a clip a phone sent whole, with no speech lease of its own
      transcribeClip: record('transcribeClip', async () => ({ text: 'hi' })),
    },
    attach: record('attach', { id: '0123456789abcdef', name: 'n', kind: 'file' }),
    browserSettings: record('browserSettings', { ok: true }),
    start: record('start', async () => 'new-chat'),
    open: record('open'),
    read: record('read', async (id: string) => ({ chatId: id, rows: [{ role: 'user', text: 'hi' }] })),
    older: record('older', async (_id: string, before: string, limit: number) =>
      before === 'gone' ? null : { rows: [{ role: 'user', text: `before ${before} x${limit}`, id: 'r0' }], more: true },
    ),
    send: record('send', async () => ({ warning: null })),
    stop: record('stop', async () => undefined),
    answer: record('answer', async ({ approvalId }: any) => {
      const up = cards.c1.some((c) => c.id === approvalId);
      cards.c1 = [];
      return up;
    }),
    state,
    reachable: (id: string) => known.has(id),
    cardsOf: async (id: string) => cards[id] ?? [],
    items: record('items', async (_id: string, n: number) => ({ itemsShape: 'rows', items: [{ role: 'user', text: 'hi', n }] })),
    ...extra,
  };
  return { ops, calls, state, cards, known, holder };
}

/** A service on fake operations with a memory link and two paired phones. */
export function rig(
  o: {
    ops?: Record<string, any>;
    policy?: any;
    momo?: boolean;
    momoHome?: { api: () => any; flagOn: () => boolean; on: (fn: (p: object) => void) => () => void };
    machineName?: () => string;
    host?: () => any;
    phoneAbsent?: (pair: string) => boolean;
  } = {},
) {
  const fake = fakeOps(o.ops);
  const link = createMemoryLink();
  link.addPair('p1');
  link.addPair('p2');
  const service = new RemoteService({
    ops: fake.ops,
    goneText: "That chat isn't in MoPilot.",
    policy: o.policy,
    momoAllowed: () => !!o.momo,
    ...(o.momoHome ? { momoHome: o.momoHome } : {}),
    version: '1.2.3',
    now: () => 1000,
    ...(o.machineName ? { machineName: o.machineName } : {}),
    ...(o.host ? { host: o.host } : {}),
    ...(o.phoneAbsent ? { phoneAbsent: o.phoneAbsent } : {}),
  });
  fake.holder.service = service;
  service.attach(link.mac);
  const phone = (pair: string) => {
    const end = link.phone(pair);
    const inbox: any[] = [];
    end.onMessage((m: any) => inbox.push(m));
    let n = 0;
    return {
      inbox,
      send: (msg: any) => end.send(msg),
      ask: async (method: string, params: any = {}, id = `${pair}-r${++n}`) => {
        await end.send({ id, t: 1, kind: 'request', method, params });
        await settle();
        return inbox.filter((m) => m.inReplyTo === id).at(-1);
      },
      events: (ev?: string) => inbox.filter((m) => m.kind === 'event' && (!ev || m.ev === ev)),
    };
  };
  return { ...fake, link, service, phone };
}
