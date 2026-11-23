// The Claude adapter in main (electron/harness/claude/adapter.cjs) over a fake SDK process and the real SessionStore.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../../electron/session/state.cjs');
const { ClaudeAdapter } = require('../../electron/harness/claude/adapter.cjs');

const MODELS = [
  { value: 'opus', supportsAutoMode: true },
  { value: 'sonnet', supportsAutoMode: false },
];
const CHAT = 'claude:s1';
const ref = (chatId: string) => ({ kind: 'claude', id: chatId.replace(/^claude:/, ''), instance: null, key: chatId });
const tick = () => new Promise((r) => setTimeout(r, 5));

function setup(
  o: {
    prefs?: any;
    metered?: boolean;
    accounts?: any;
    goalText?: string | null;
    failSend?: boolean;
    userTitle?: string | null;
    silent?: boolean;
  } = {},
) {
  const state = new SessionStore();
  const events: [any, any][] = [];
  const sent: any[] = [];
  const enqueued: any[] = [];
  const controls: any[] = [];
  const renamed: any[] = [];
  const notices: any[] = [];
  const interrupted: string[] = [];
  const live = new Set<string>();
  let prefs = {
    permission: 'default',
    claudeSelection: { model: null, effort: null, fast: false },
    claudeBin: '/bin/claude',
    ...(o.prefs ?? {}),
  };
  const api = {
    isLive: (k: string) => live.has(k),
    control: async (k: string, m: string, a?: unknown): Promise<unknown> => void controls.push([k, m, a]),
    // the warm title helper (o.helper) answers nothing unless a test says so: the chat's CLI and the fallback write it
    title: async (...args: any[]): Promise<string | null> => (args[5]?.helper ? null : 'A short title'),
    rename: async (id: string, n: string) => void renamed.push([id, n]),
    userTitle: async () => o.userTitle ?? null,
    goalStatus: async () => o.goalText ?? null,
    sessionCwd: () => '/from/transcript',
    accounts: () => o.accounts ?? { active: 'default', accounts: [{ id: 'default', loggedIn: true }] },
    metered: () => !!o.metered,
  };
  const adapter = new ClaudeAdapter({
    api,
    probeInfo: () => ({ models: MODELS, fastBlocked: null }),
    state,
    prefs: () => prefs,
    send: async (chatId: string, key: string, opts: any, input: any, priority: any, meta: any) => {
      if (o.failSend) throw new Error('Claude Code is not installed');
      sent.push({ chatId, key, opts, input, priority, meta });
      live.add(key);
      // the CLI starts answering, unless the test says when: a new chat's title helper waits for this (#1651)
      if (!o.silent) adapter.observe({ kind: 'message', key, msg: { type: 'stream_event' } });
      return { elsewhere: [] };
    },
    enqueue: (chatId: string, item: any) => void enqueued.push({ chatId, item }),
    interrupted: (key: string) => void interrupted.push(key),
    chatOf: (key: string) => key,
    ref,
    emit: (e: any, target?: any) => (events.push([e, target]), true),
    setGoal: (chatId: string, goal: any) => state.patch(chatId, { goal }),
    notifyGoal: (chatId: string, n: any) => void notices.push({ chatId, ...n }),
    graceMs: 0,
    now: () => 1_000_000,
  });
  return {
    api,
    adapter,
    state,
    events,
    sent,
    enqueued,
    controls,
    renamed,
    notices,
    interrupted,
    live,
    setPrefs: (p: any) => (prefs = { ...prefs, ...p }),
    kinds: () => events.map(([e]) => e.kind),
  };
}
const item = (text = 'hi', opts: any = {}) => ({ id: `q-${text}`, text, attachments: [], opts });
const msg = (type: string, extra: any = {}) => ({ key: CHAT, kind: 'message', msg: { type, ...extra } });
const assistantText = (text: string) => msg('assistant', { message: { content: [{ type: 'text', text }] } });

export { CHAT, ref, tick, setup, item, msg, assistantText };
