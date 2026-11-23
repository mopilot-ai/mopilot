// MoMo main chat test world (tests/momoMainChat.test.ts, tests/momoBrainRouting.test.ts): the real ChatsStore,
// ChatStarter and SessionStore, fake harness starts, Codex account pool and ClaudeTurns, and the service on them.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../../electron/platform/chats.cjs');
const { ChatStarter } = require('../../electron/platform/chatStart.cjs');
const { SessionStore } = require('../../electron/session/state.cjs');
const { createMomoMainChat } = require('../../electron/momo/mainChat.cjs');

/** A deferred promise: the test settles it. */
export function gate() {
  let open: () => void = () => undefined;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
}

export function world(o: { prefs?: any; dir?: string; chatsDir?: string } = {}) {
  const root = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'momo-'));
  const chats = new ChatsStore(o.chatsDir ?? path.join(root, 'threads'), { legacyMirror: false });
  const state = new SessionStore();
  const log: any[] = [];
  let n = 0;
  const w: any = { root, chats, state, log, allowed: true, failPatch: false, codexGate: null as Promise<void> | null, codexFails: false };
  // a brain saved already, unless the test starts from none
  w.prefs = o.prefs ?? { model: 'gpt-5', claudeSelection: { model: 'opus' }, momo: { brain: { main: { harness: 'codex' } } } };
  const starter = new ChatStarter({
    prefs: () => w.prefs,
    codexThread: async ({ cwd }: any) => {
      log.push(['codex', cwd]);
      await w.codexGate;
      if (w.codexFails) throw new Error('Codex is down');
      return { id: `th${++n}` };
    },
    claudeSession: (key: string, info: any) => log.push(['claude', key, info]),
    acpSession: (key: string, info: any) => log.push(['acp', key, info]),
    chats,
    worktree: async () => ({ ok: false }),
    script: async () => ({ exitCode: 0, output: '' }),
    // the tag is on the chat before any window hears of it
    changed: (id: string) => log.push(['changed', id, chats.records.get(id)?.meta.momo ?? null]),
    started: (e: any) => log.push(['started', e.chatId, chats.records.get(e.chatId)?.meta.momo ?? null]),
  });
  const pool = {
    known: new Set(['cx-work', 'cx-home']),
    pins: new Map<string, string>(),
    get(id: string) {
      return this.known.has(id) ? { id } : null;
    },
    pinChat(thread: string, id: string) {
      this.pins.set(thread, id);
    },
  };
  const claude = {
    own: new Map<string, any>(),
    setOwn(chatId: string, own: any) {
      this.own.set(chatId, own);
    },
    pickOf(chatId: string) {
      return this.own.get(chatId)?.account ?? chats.record(chatId).meta.account?.id ?? null;
    },
  };
  const controller = {
    state,
    ref: (id: string) => {
      const seg = chats.record(id).segments.at(-1);
      return { kind: seg.kind, id: seg.nativeId };
    },
    // a chat the harness holds no session for (a restart forgot a session no message ever started): w.gone names them
    sessionGone: async (id: string) => w.gone.has(id),
  };
  w.gone = new Set<string>();
  w.pool = pool;
  w.claude = claude;
  w.controller = controller;
  w.make = () =>
    createMomoMainChat({
      dir: path.join(root, 'momo'),
      chatStarter: starter,
      controller,
      chats,
      prefs: { get: () => w.prefs, patch: (set: any) => (w.failPatch ? false : ((w.prefs = { ...w.prefs, ...set }), true)) },
      accounts: { codex: () => pool, claude, claudeLogins: () => w.logins, laneOf: (_h: string, a: string) => w.lanes[a] ?? null },
      allowed: () => w.allowed,
      // a test holds the check that a harness can run (it reads the harness's install and sign-in) with w.usableGate
      usable: async (kind: string) => (await w.usableGate, !w.unusable.has(kind)),
      kinds: () => w.kinds,
      changed: (id: string) => w.changes.push(id),
      brainChanged: (b: any) => w.brains.push(b),
      // opencode has a provider here (free models alone can't run MoMo, #2357)
      env: () => w.env ?? { OPENAI_API_KEY: 'test' },
      // the model lists a brain's effort is checked against: none readable unless a test gives them
      efforts: { codexModels: async () => w.codexModels?.() ?? null, claudeProbe: (account?: string) => w.claudeProbe?.(account) ?? null },
    });
  w.unusable = new Set<string>();
  w.kinds = ['claude', 'codex', 'acp:opencode'];
  w.logins = ['du@work', 'du@home'];
  w.lanes = {
    'du@work': 'subscription',
    'du@home': 'subscription',
    'du@api': 'api',
    'cx-work': 'chatgpt',
    'cx-home': 'chatgpt',
    'cx-gone': 'chatgpt',
  };
  w.changes = [] as string[];
  w.brains = [] as any[];
  w.svc = w.make();
  w.stateFile = path.join(root, 'momo', 'state.json');
  return w;
}

/** A chat now on `kind` (a switch committed a later segment). */
export function switched(w: any, chatId: string, kind: string, nativeId: string) {
  const rec = w.chats.record(chatId);
  w.chats.commit({ ...rec, segments: [...rec.segments, { kind, nativeId, start: 1, count: null, model: null, handoff: null }] });
}
