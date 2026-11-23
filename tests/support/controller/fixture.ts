// The ChatController in main (electron/session/controller.cjs): NativeRef from the v2 chat files, the
// send queue with full SendOptions (#50), the turn state machine and the seams to the Codex and Claude adapters.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
export { tick } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
export const { SessionStore } = require('../../../electron/session/state.cjs');
export const { ChatController, crashText } = require('../../../electron/session/controller.cjs');
export const { ChatsStore } = require('../../../electron/platform/chats.cjs');
export const { unattendedReason } = require('../../../electron/capabilities/contract/policy.cjs');
export const { assertCodexRef } = require('../../../electron/harness/codexRef.cjs');

// done: an adapter's start ({started, turnId?}) or the switcher's handoff ({ready, prefix?, note?, after?})
type Exec = { chatId: string; kind: string; item: any; ref: any; origin: number | null; done: (r: Record<string, unknown>) => void };

export function setup(o: { auto?: boolean; graceMs?: number; notify?: (...a: any[]) => void; retract?: (chatId: string) => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-controller-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const state = new SessionStore();
  const execs: Exec[] = [];
  const claudeSends: any[] = [];
  const crashes: string[] = [];
  const stops: string[] = [];
  const claudeCrashes: string[] = [];
  const acpSends: any[] = [];
  const acpCancels: string[] = [];
  // a step as an adapter or the switcher runs it; `auto` answers that it started (or is ready)
  const step = (kind: string, chatId: string, item: any, ref: any, origin: number | null) =>
    new Promise((done) => {
      execs.push({ chatId, kind, item, ref, origin, done });
      if (o.auto !== false)
        done(kind === 'handoff' ? { ready: true, prefix: '<handoff>', note: { kind: 'switch', text: 'switched' } } : { started: true });
    });
  const c = new ChatController({
    state,
    chats,
    graceMs: o.graceMs,
    notify: o.notify,
    retract: o.retract,
    chatTitle: (id: string) => (id === 'named' ? 'Named chat' : null),
    acpPlan: (kind: string) =>
      kind === 'acp:qwen' ? { mode: 'plan' } : kind === 'acp:kimi' ? { configOption: 'mode', value: 'plan' } : null,
    codex: {
      serverObservers: new Set(),
      // a voice session loads the thread and applies the chat's permission before it starts (electron/session/voice.cjs)
      ensureResumed: async () => undefined,
      applyPermission: async () => undefined,
      startTurn: (chatId: string, ref: any, item: any, origin: number | null) => step('turn', chatId, item, ref, origin),
      startGoal: (chatId: string, ref: any, item: any, origin: number | null) => step('goal', chatId, item, ref, origin),
      steer: (chatId: string, ref: any, item: any, origin: number | null) => step('steer', chatId, item, ref, origin),
    },
    // the Claude adapter (electron/harness/claude/adapter.cjs): a turn or steer it would start, a stop, a crash it hears of
    claudeTurns: {
      startTurn: (chatId: string, ref: any, item: any, origin: number | null) => step('claude-turn', chatId, item, ref, origin),
      steer: (chatId: string, ref: any, item: any, origin: number | null) => step('claude-steer', chatId, item, ref, origin),
      stop: async (chatId: string) => void stops.push(chatId),
      crashed: (chatId: string) => void claudeCrashes.push(chatId),
    },
    // the ACP turn start (electron/harness/acpTurns.cjs)
    acpTurns: { startTurn: (chatId: string, ref: any, item: any, origin: number | null) => step('acp-turn', chatId, item, ref, origin) },
    // a pending switch (electron/session/switch.cjs): main settles it and writes the handoff record
    switcher: { perform: (chatId: string, ps: any, origin: number | null) => step('handoff', chatId, ps, null, origin) },
    claude: { send: async (...a: any[]) => (claudeSends.push(a), { elsewhere: [] }) },
    onCrash: (chatId: string) => crashes.push(chatId),
    acp: { send: async (...a: any[]) => (acpSends.push(a), { turnId: 'at-x' }), cancel: (key: string) => (acpCancels.push(key), true) },
  });
  return { c, state, chats, execs, claudeSends, acpSends, acpCancels, crashes, stops, claudeCrashes, s: (id: string) => state.get(id) };
}
export const codex = (method: string, params: any, id?: number) => ({ method, params, ...(id != null ? { id } : {}) });

// A durable chat can hold background cards from several native segments at once.
export function selectSegment(c: any, chats: any, chat: string, segments: [string, string][]) {
  chats.ensure(chat);
  chats.setSegments(
    chat,
    segments.map(([harness, nativeId], i) => ({ harness, nativeId, start: i, count: i === segments.length - 1 ? null : 1 })),
  );
  c.invalidate();
}
