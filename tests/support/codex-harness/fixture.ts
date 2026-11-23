// electron/harness/codex.cjs beyond tests/codexAdapter.test.ts: the app-server process itself (a
// fake spawn), the turn-parameter helpers, crash restarts, goals across quit, writer leases, the
// window API, turns, goals and helper threads on their less travelled paths.
import { createRequire } from 'node:module';
import { tick } from '../async-scenarios.ts';
export { tick };
export { defined } from '../defined.ts';

export const require = createRequire(import.meta.url);
export const codex = require('../../../electron/harness/codex.cjs');
export const {
  AppServer,
  CodexAdapter,
  ThreadLocked,
  buildInput,
  permissionParams,
  sandboxPolicyFor,
  turnParams,
  chatPrefs,
  goalErrorMessage,
  CODEX_API,
} = codex;
const { SessionStore } = require('../../../electron/session/state.cjs');
export const { killTree } = require('../../../electron/platform/winbin.cjs');
export const { recentIgnored, clearIgnored } = require('../../../electron/ignored.cjs');

export const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await tick();
};
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Handler = (params: any, n: number) => any;
export const NO_REPLY: Handler = () => undefined;
/** Throws from server.send itself (a closed pipe). */
export const SEND_THROWS: Handler = () => undefined;

export function fakeServer(handlers: Record<string, Handler> = {}) {
  const counts: Record<string, number> = {};
  const s: any = {
    listeners: new Set<(e: any) => void>(),
    sent: [] as any[],
    starts: 0,
    proc: { kills: 0, kill: () => s.proc.kills++ },
    start() {
      s.starts++;
    },
    send(m: any) {
      if (m.method && handlers[m.method] === SEND_THROWS) throw new Error('pipe closed');
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      const h = handlers[m.method];
      if (h === NO_REPLY) return;
      const n = (counts[m.method] = (counts[m.method] ?? 0) + 1);
      setImmediate(async () => {
        try {
          const result = h ? await h(m.params, n) : {};
          s.emit({ kind: 'message', msg: { id: m.id, result } });
        } catch (e: any) {
          s.emit({ kind: 'message', msg: { id: m.id, error: { code: -32600, message: e.message } } });
        }
      });
    },
    emit(e: any) {
      for (const l of s.listeners) l(e);
    },
    notify(method: string, params: any) {
      s.emit({ kind: 'message', msg: { method, params } });
    },
    methods: () => s.sent.filter((m: any) => m.method).map((m: any) => m.method),
    params: (method: string) => s.sent.filter((m: any) => m.method === method).map((m: any) => m.params),
  };
  return s;
}

export const thread = (id: string, extra: any = {}) => ({ id, cwd: '/work', name: null, preview: '', ephemeral: false, ...extra });

/** What MoMo's Codex app-server reports of its effective config: its own shell, exec and image tools off (codexMomoHome.cjs). */
export const SHELL_OFF_CONFIG = { config: { features: { shell_tool: false, unified_exec: false, view_image: false } } };

export function setup(handlers: Record<string, Handler> = {}, o: any = {}) {
  const server = fakeServer({
    initialize: () => ({ userAgent: 'codex_cli_rs/0.50.0 (Mac)' }),
    // an isolated chat's turn first confirms the shell is off (CodexIsolation.shellOff)
    ...(o.isolated ? { 'config/read': () => SHELL_OFF_CONFIG } : {}),
    'thread/resume': (p: any) => ({ thread: thread(p.threadId) }),
    'turn/start': () => ({ turn: { id: 'turn-1' } }),
    ...handlers,
  });
  const state = new SessionStore();
  const segs: Record<string, any> = o.segments ?? {};
  const owner = new Map(
    Object.entries(segs)
      .filter(([, v]) => typeof v === 'string')
      .map(([chat, nid]) => [nid, chat]),
  );
  const events: { e: any; target: any }[] = [];
  const statuses: any[] = [];
  const clock = { t: 1_000_000 };
  const store = { goals: o.goals as any, writes: 0 };
  const a = new CodexAdapter({
    server,
    state,
    nativeOf: o.nativeOf ?? ((chat: string) => (segs[chat] === null ? null : { kind: 'codex', id: segs[chat] ?? chat })),
    chatOf: (nid: string) => owner.get(nid) ?? nid,
    prefs: o.prefs ?? (() => ({ permission: 'default' })),
    emit: (e: any, target: any) => events.push({ e, target }),
    onExit: () => o.paused ?? [],
    onStatus: (st: any) => statuses.push(st),
    backoff: o.backoff,
    now: () => clock.t,
    tools: o.tools,
    goalStore:
      o.goals !== undefined
        ? {
            read: () => store.goals,
            write: (all: any) => {
              store.writes++;
              if (o.writeThrows) throw new Error('disk full');
              store.goals = all;
            },
          }
        : null,
    chatConfig: (chat: string) => o.config?.[chat] ?? null,
    probe: o.probe ?? null,
    isolated: o.isolated,
  });
  const of = (kind: string) => events.filter((x) => x.e.kind === kind);
  return { a, server, state, events, statuses, clock, store, of };
}
