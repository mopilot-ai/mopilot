// Shared scripted app-server, session state, and adapter fixtures for Codex adapter unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defined } from '../defined.ts';
import { tick } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexAdapter, buildInput, turnParams } = require('../../../electron/harness/codex.cjs');
const { SessionStore } = require('../../../electron/session/state.cjs');

type Handler = (params: any) => any;
/** A request the fake never answers. */
const NO_REPLY: Handler = () => undefined;

/** An app-server stand-in: answers each request from `handlers` on the next tick. */
function fakeServer(handlers: Record<string, Handler> = {}) {
  const s = {
    listeners: new Set<(e: any) => void>(),
    stderrListeners: new Set<(text: string) => void>(),
    sent: [] as any[],
    starts: 0,
    proc: {},
    start() {
      s.starts++;
    },
    send(m: any) {
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        try {
          const h = handlers[m.method];
          if (h === NO_REPLY) return;
          s.emit({ kind: 'message', msg: { id: m.id, result: h ? h(m.params) : {} } });
        } catch (e: any) {
          s.emit({ kind: 'message', msg: { id: m.id, error: { code: -32600, message: e.message } } });
        }
      });
    },
    emit(e: any) {
      for (const l of s.listeners) l(e);
    },
    stderr(text: string) {
      for (const l of s.stderrListeners) l(text);
    },
    notify(method: string, params: any) {
      s.emit({ kind: 'message', msg: { method, params } });
    },
    ask(id: string, method: string, params: any) {
      s.emit({ kind: 'message', msg: { id, method, params } });
    },
    methods: () => s.sent.filter((m) => m.method).map((m) => m.method),
  };
  return s;
}

const thread = (id: string, extra: any = {}) => ({ id, cwd: '/work', name: null, preview: '', ephemeral: false, ...extra });

function setup(
  handlers: Record<string, Handler> = {},
  o: {
    segments?: Record<string, string>;
    prefs?: any;
    now?: () => number;
    backoff?: number[];
    paused?: string[];
    tools?: any;
    goals?: Record<string, any>;
    config?: Record<string, any>;
    probe?: any;
    provider?: () => any;
    turnChanges?: any;
    codexCopies?: any;
  } = {},
) {
  const server = fakeServer({
    initialize: () => ({ userAgent: 'fake', codexHome: '/h' }),
    'thread/resume': (p) => ({ thread: thread(p.threadId) }),
    'turn/start': () => ({ turn: { id: 'turn-1' } }),
    ...handlers,
  });
  // the installed copies the binary lookup hands the app-server (electron/app/codexServer.cjs)
  if (o.codexCopies) (server as any).copies = o.codexCopies;
  const state = new SessionStore();
  // chat -> its current Codex thread; native -> chat
  const segs = o.segments ?? {};
  const owner = new Map(Object.entries(segs).map(([chat, nid]) => [nid, chat]));
  const events: { e: any; target: any }[] = [];
  const observed: any[] = [];
  const exits: string[] = [];
  const statuses: any[] = [];
  const a = new CodexAdapter({
    server,
    state,
    nativeOf: (chat: string) => ({ kind: 'codex', id: segs[chat] ?? chat, key: segs[chat] ?? chat }),
    chatOf: (nid: string) => owner.get(nid) ?? nid,
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null, ...(o.prefs ?? {}) }),
    emit: (e: any, target: any) => events.push({ e, target }),
    observe: (m: any) => observed.push(m),
    tools: o.tools,
    turnChanges: o.turnChanges,
    provider: o.provider,
    onExit: (r: string) => (exits.push(r), o.paused ?? []),
    onStatus: (st: any) => statuses.push(st),
    backoff: o.backoff,
    now: o.now,
    goalStore: o.goals ? { read: () => o.goals, write: (all: any) => (o.goals = all) } : null,
    chatConfig: (chat: string) => o.config?.[chat] ?? null,
    probe: o.probe ?? null,
  });
  const kinds = () => events.map((x) => x.e.kind).filter((k) => k !== 'negotiated');
  return { a, server, state, events, observed, exits, statuses, kinds, goals: () => o.goals };
}
const settle = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const crash = (server: any) => server.emit({ kind: 'exit', code: 1, signal: null, stderr: 'boom' });
const inits = (server: any) => server.methods().filter((m: string) => m === 'initialize').length;
const goalSet = (p: any) => ({ goal: { threadId: p.threadId, objective: 'ship it', status: p.status } });

export { test, assert, require, thread, setup, wait, crash, inits, defined, NO_REPLY, settle, goalSet, buildInput, turnParams };
