// The fixture of MoMo's routines service tests (#2139): the real stores on a scratch folder, a real session store, a fake isolated chat start per harness family (each family's chat ids look like its own), fakes of stopping, archiving and deleting a chat, a fake first message and a fake report to MoMo's main chat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, clock } from './momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { createMomoRoutines } = require('../../electron/momo/routines.cjs');
const { RoutineStore } = require('../../electron/momo/routineStore.cjs');
const { SessionStore } = require('../../electron/session/state.cjs');

/** 2030-03-11 09:00:30 local, a Monday */
export const START = new Date(2030, 2, 11, 9, 0, 30).getTime();
export const sweep = { name: 'Inbox sweep', prompt: 'Summarize what needs a reply.', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' };
export const FAMILIES = ['codex', 'claude', 'acp:opencode'];

/** A fake chat start per harness family: each family's chat ids look like its own (thread, session key, ACP key). */
export const chatIdOf = (harness: string, n: number) =>
  harness === 'codex' ? `019a-thread-${n}` : harness === 'claude' ? `claude-key-${n}` : `acp-${harness.slice(4)}-${n}`;

export function world(
  o: { prefs?: any; usable?: (kind: string) => boolean; allowed?: boolean; send?: any; dir?: string; mainBrain?: any } = {},
) {
  const dir = o.dir ?? scratch();
  const safe = fakeSafe();
  const c = clock(START);
  const routines = new RoutineStore({ dir, safeStorage: safe, now: c.now });
  const sessions = new SessionStore();
  const started: any[] = [];
  const sent: any[] = [];
  const reports: any[] = [];
  const chats: any[] = [];
  let allowed = o.allowed ?? true;
  let n = 0;
  const service = createMomoRoutines({
    routines,
    report: async (r: any) => (reports.push(r), true),
    allowed: () => allowed,
    prefs: () => o.prefs ?? {},
    mainBrain: () => (o.mainBrain === undefined ? { harness: 'codex', account: null, model: 'gpt-5.5' } : o.mainBrain),
    usable: async (kind: string, u: any) => (assert.deepEqual(u, { unattended: true }), o.usable ? o.usable(kind) : true),
    startChat: async (brain: any, meta: any) => {
      const id = chatIdOf(brain.harness, ++n);
      started.push([brain.harness, meta, id]);
      return id;
    },
    send:
      o.send ??
      (async (chatId: string, item: any) => {
        sent.push([chatId, item]);
        sessions.patch(chatId, { turn: 'running' });
        return { started: true };
      }),
    sessions,
    stopChat: async (id: string) => chats.push(['stop', id]),
    archiveChat: async (id: string) => chats.push(['archive', id]),
    discardChat: async (id: string) => chats.push(['discard', id]),
    forget: async (id: string) => chats.push(['forget', id]),
    process: { by: { pid: 100, started: 1000 }, alive: async () => false },
    now: c.now,
  });
  return { service, routines, sessions, started, sent, reports, chats, c, dir, setAllowed: (v: boolean) => (allowed = v) };
}

/** What MoMo's main chat was told, as [name, completed, text]. */
export const told = (w: any) => w.reports.map((r: any) => [r.name, r.completed, r.text]);
