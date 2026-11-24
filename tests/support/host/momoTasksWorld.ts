// A running MoMo home with the tasks service over scripted Host sessions: a fake chat runtime, its event stream and turn states, and a bound chat and brain.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import gateService from '../../../host/src/momoServices/gate.mjs';
// @ts-ignore
import learningService from '../../../host/src/momoServices/learning.mjs';
// @ts-ignore
import tasksService from '../../../host/src/momoServices/tasks.mjs';
import { typedTurnEnd } from '../../../shared/host/turnErrorCode.mjs';
import type { ResultCard, WatchNotice } from '../../../shared/momoTasks/types.ts';
import { A, host } from './momoMoveWorld.ts';

export const REPORT = 'Result: Built Acme-quote.xlsx.\nFiles: Acme-quote.xlsx\nEvidence: opened it, totals match.';

export function fakeSessions() {
  const turns = new Map<string, string>();
  const s = {
    events: new EventEmitter(),
    state: { has: (id: string) => turns.has(id), get: (id: string) => ({ turn: turns.get(id) }) },
    turns,
    sent: [] as { key: string; text: string; cwd: string }[],
    modes: [] as { chatId: string; value: string }[],
    cancelled: [] as string[],
    sendFails: null as null | Error,
    /** Runs inside `send`, before it resolves: a session that speaks (or fails) before its start is answered. */
    duringSend: null as null | ((p: { key: string }) => void),
    modeFails: false,
    cancelFails: false,
    chatRuntime: {
      send: async (p: { key: string; text: string; cwd: string }) => {
        if (s.sendFails) throw s.sendFails;
        s.sent.push(p);
        turns.set(p.key, 'running');
        s.duringSend?.(p);
      },
      setMode: async (p: { chatId: string; value: string }) => {
        if (s.modeFails) throw new Error('no plan mode');
        s.modes.push(p);
      },
      host: {
        cancel: async (key: string) => {
          if (s.cancelFails) throw new Error('gone');
          s.cancelled.push(key);
        },
      },
    },
    emit: (e: object) => s.events.emit('event', e),
    say(chatId: string, text: string) {
      s.emit({ kind: 'update', key: chatId, update: { sessionUpdate: 'agent_message_chunk', content: { text } } });
    },
    end(chatId: string, over: object = {}) {
      turns.set(chatId, 'idle');
      s.emit(typedTurnEnd({ kind: 'turnEnd', key: chatId, turnId: 't1', stopReason: 'end_turn', ...over }));
    },
  };
  return s;
}

/** What the home's wiring gives every service: a folder for what an agent makes, outside the home's storage. */
export const withWorkDir = (home: any, dataDir: string) => {
  home.workDir = (name: string) => path.join(dataDir, 'momo-work', name);
};

export async function tasksWorld(t: any, { bind = true, start = true } = {}) {
  const h = await host(t, A);
  const sessions = fakeSessions();
  const reports: string[] = [];
  const cards: ResultCard[] = [];
  const notices: WatchNotice[] = [];
  const asked: string[] = [];
  const askedData: (string | undefined)[] = [];
  const brain = { answer: '{"met": true, "reason": "ok", "checked": "opened it"}' };
  const chat = { down: false };
  const clock = { at: 1_700_000_000_000 };
  const now = () => clock.at;
  const dataDir = path.join(h.dir, 'data');
  withWorkDir(h.home, dataDir);
  const deps = { home: h.home, sessions, now, report: (m: string) => reports.push(m) };
  gateService(deps);
  learningService(deps);
  tasksService(deps);
  const tasks = h.home.service('tasks');
  const agents = {
    list: [
      { id: 'claude', state: 'ready' },
      { id: 'codex', state: 'ready' },
      { id: 'acp:kimi', state: 'ready' },
    ] as { id: string; state: string }[],
  };
  const readings: object[] = [];
  const binding = {
    watches: { toolIsReadOnly: async () => true, read: async () => (readings.shift() ?? { fingerprint: 'same' }) as any },
    machine: { name: 'Studio', agents: () => agents.list },
    check: { ask: async (p: string, data?: string) => (asked.push(p), askedData.push(data), brain.answer) },
    chat: {
      chatId: () => 'momo-chat',
      postResult: async (c: ResultCard) => {
        if (chat.down) throw new Error('chat down');
        cards.push(c);
      },
      postWatchChanged: async (n: WatchNotice) => void notices.push(n),
    },
  };
  if (bind) tasks.bind(binding);
  if (start) await h.home.start(A);
  t.after(() => h.home.lifecycle('pause'));
  return {
    ...h,
    dataDir,
    sessions,
    reports,
    cards,
    notices,
    asked,
    askedData,
    brain,
    chat,
    clock,
    readings,
    tasks,
    gate: h.home.service('gate'),
    agents,
    binding,
  };
}

export const ask = { title: 'Build the Acme quote sheet', doneMeans: 'Sheet opens', origin: 'asked' as const, userStarted: true };
export const tick = () => new Promise((r) => setImmediate(r));
/** Waits for something the sealed files make asynchronous: polls until `cond` holds, or fails after three seconds. */
export async function until(cond: () => unknown | Promise<unknown>, what = 'the condition') {
  for (let i = 0; i < 300; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
export const filesIn = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
export const tasksDir = (momoDir: string) => path.join(momoDir, 'tasks');
