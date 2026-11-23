// The fixture of the remote MoMo tests: a phone rig over MoMo's real handlers on a tapped ipcMain (momoRig), a momoAction card asked through the real sentinel, gate and audit log (cardRig), and the reply helpers.
import './tz-la.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { rig } from './remote-kit.ts';
import { world } from './momo-routines.ts';
import { fakeSafe as memorySafe } from './momo-memory.ts';
import { auditLog } from './momo-trust.ts';

const require = createRequire(import.meta.url);
const { PARSERS } = require('../../shared/remote/schema.mjs');
const { wireMomoRemote } = require('../../electron/remote/momoOps.cjs');
const { MemoryStore } = require('../../electron/momo/memory.cjs');
const { registerMemoryIpc } = require('../../electron/momo/memoryIpc.cjs');
const { registerRoutinesIpc } = require('../../electron/momo/routinesIpc.cjs');
const { registerMomoMainChatIpc } = require('../../electron/momo/mainChatIpc.cjs');
const { ApprovalBroker } = require('../../electron/capabilities/contract/approvals.cjs');
const { createMomoActionAsk } = require('../../electron/momo/actionAsk.cjs');
const { Sentinel, LEVELS } = require('../../electron/momo/sentinel.cjs');
const { createTrustGate } = require('../../electron/momo/trustGate.cjs');
const { cardOf, answerOf } = require('../../electron/capabilities/browser/chromePanelCards.cjs');
const { SessionStore } = require('../../electron/session/state.cjs');
const { momoPrefsForPhones } = require('../../electron/app/ipc/momoPrefs.cjs');
const { OpenLoopStore } = require('../../electron/momo/openLoops.cjs');
const { createLoopActs } = require('../../electron/momo/loopActs.cjs');
const { registerLoopsIpc } = require('../../electron/momo/loopsIpc.cjs');
const { registerTasksIpc } = require('../../electron/momo/tasksIpc.cjs');
const { waitingCards } = require('../../electron/momo/tasks.cjs');
const { createTaskMarks, memoryStorage } = require('../../electron/momo/taskMarks.cjs');
const { createSuggestions, memoryStorage: suggestionsMemory } = require('../../electron/momo/suggestions.cjs');
const { registerSuggestionsIpc } = require('../../electron/momo/suggestionsIpc.cjs');
const { registerBriefIpc } = require('../../electron/momo/briefIpc.cjs');
const { createChannels, memoryStorage: channelsStorage } = require('../../electron/momo/channels.cjs');
const { registerChannelsIpc } = require('../../electron/momo/channelsIpc.cjs');

/** The clock of the rig's open loops, and the two it starts with (L1, L2). */
export const LOOPS_NOW = Date.UTC(2026, 10, 3, 12);

// momo.home.* is another gate (the `momo.home` flag, absent not forbidden): tests/remoteMomoHome.test.ts
export const MOMO_METHODS = Object.keys(PARSERS).filter((m) => m.startsWith('momo.') && !m.startsWith('momo.home.'));
export const HARNESSES = ['codex', 'claude', 'acp:opencode'];
export const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
export const fail = (r: any, code: string, message?: RegExp) => {
  assert.equal(r.ok, false, 'expected a refusal');
  assert.equal(r.error.code, code, r.error.message);
  if (message) assert.match(r.error.message, message);
};
export const UNINVITED = /MoMo (isn't|is not) available/;
/** What a phone of an account MoMo is not allowed for gets for any momo.* call: exactly the answer to an unknown method. */
export const UNKNOWN_MOMO = /^Unknown request: momo\./;

/** A phone's request whose reply may wait on a disk write: polls the inbox until it arrives. */
export async function askSlow(p: any, method: string, params: any = {}) {
  const id = `slow-${++slowId}`;
  await p.send({ id, t: 1, kind: 'request', method, params });
  for (let i = 0; i < 400; i++) {
    const reply = p.inbox.find((m: any) => m.inReplyTo === id);
    if (reply) return reply;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`no reply to ${method}`);
}
let slowId = 0;

/** Sample params that pass each method's schema. */
export const SAMPLE: Record<string, any> = {
  'momo.home.google': { op: 'status' },
  'momo.home.intent': { intent: { kind: 'wake' } },
  'momo.chat.send': { id: 'r1', text: 'hi' },
  'momo.memory.search': { query: 'tea' },
  'momo.memory.edit': { factId: 'f1', text: 'x' },
  'momo.memory.forget': { factId: 'f1' },
  'momo.routines.pause': { id: 'r' },
  'momo.routines.resume': { id: 'r' },
  'momo.routines.run': { id: 'r' },
  'momo.routines.approve': { id: 'r', seen: 1 },
  'momo.brain.set': { brain: { harness: 'codex' } },
  'momo.card.answer': { cardId: 'a', rev: 1, key: 'once' },
  'momo.prefs.set': { paused: false },
  'momo.routines.edit': { id: 'r', edit: { name: 'x' } },
  'momo.routines.delete': { id: 'r' },
  'momo.memory.undo': { changeId: 'c1' },
  'momo.memory.writeDoc': { doc: 'aboutYou', text: 'x' },
  'momo.loops.act': { loopId: 'L1', action: 'done' },
  'momo.chat.transcribe': { stream: 'voice-0001', mime: 'audio/wav' },
  'momo.tasks.mark': { taskId: 'run:c1', mark: 'done' },
  'momo.suggestions.act': { id: 's1', action: 'start' },
  'momo.channels.create': { name: 'Trip' },
  'momo.channels.rename': { channelId: 'ch_0123456789abcdef', name: 'Trip' },
  'momo.channels.archive': { channelId: 'ch_0123456789abcdef' },
  'momo.channels.delete': { channelId: 'ch_0123456789abcdef' },
  'momo.channels.move': { channelId: 'ch_0123456789abcdef', group: null },
  'momo.channels.welcome': { channelId: 'ch_0123456789abcdef', answer: 'yes' },
  'momo.channels.group.create': { name: 'Home' },
  'momo.channels.group.rename': { groupId: 'gr_0123456789abcdef', name: 'Home' },
  'momo.channels.group.delete': { groupId: 'gr_0123456789abcdef' },
};

/** MoMo's real handlers on a tapped ipcMain, a fake MoMo main chat and a rig with the phone ops made over them. */
export function momoRig(o: { allowed?: boolean; harness?: string; remoteBrain?: boolean; dir?: string; noMainChat?: boolean } = {}) {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const told: [string, unknown][] = [];
  const wired = wireMomoRemote({ ipcMain, toWindows: (ch: string, payload?: unknown) => told.push([ch, payload]) });
  const gate = { allowed: o.allowed ?? true, remoteBrain: o.remoteBrain ?? false, paused: false };
  const brains: unknown[] = [];
  // MoMo's main chat: there from the start unless noMainChat; ensureMainChat makes it, mainChatId only reads it
  const main = { exists: !o.noMainChat, made: 0 };
  const refuse = () => {
    if (!gate.allowed) throw Object.assign(new Error('MoMo is not available for this account.'), { code: 'not_allowed' });
  };
  const mainChat = {
    ensureMainChat: async () => {
      refuse();
      if (!main.exists) (main.exists = true), main.made++;
      return { chatId: 'momo-main' };
    },
    mainChatId: () => (refuse(), main.exists ? 'momo-main' : null),
    getBrain: () => ({ harness: o.harness ?? 'codex', account: null, model: null }),
    setBrain: (b: unknown) => (brains.push(b), b),
  };
  registerMomoMainChatIpc(wired.ipc, { service: mainChat as any, allowed: () => gate.allowed });
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'momo-remote-'));
  const store = new MemoryStore({ dir, safeStorage: memorySafe(), isMomoChat: (id: string) => id === 'momo-main' });
  registerMemoryIpc(wired.ipc, { store, allowed: () => gate.allowed, broadcast: (ch: string) => wired.broadcast(ch) });
  // MoMo's open loops (momoMemory:loops, momoMemory:loopAct), two of them open
  let loopN = 0;
  const loops = new OpenLoopStore({
    dir: path.join(dir, 'loops'),
    safeStorage: memorySafe(),
    now: () => LOOPS_NOW,
    newId: () => `L${++loopN}`,
  });
  const dismissed: string[] = [];
  const loopAct = createLoopActs({ loops, dismissed: (k: string) => void dismissed.push(k), now: () => LOOPS_NOW });
  registerLoopsIpc(wired.ipc, { loops, act: loopAct, allowed: () => gate.allowed, broadcast: (ch: string) => wired.broadcast(ch) });
  // MoMo's Tasks list (momoTasks:list): the loops above, the routine runs the test puts in `runs` and the cards main's session state holds
  const runs: any[] = [];
  // the four-tab panel (M0a) is off, as `momo.tasksPanel` is by default; a test turns it on with `tasksPanel.on = true`
  const tasksPanel = { on: false };
  // MoMo's suggestions have their own flag (`momo.suggestions`), off by default whatever the panel is; a test turns it on with `suggestionsFlag.on = true`
  const suggestionsFlag = { on: false };
  const taskMarks = createTaskMarks({ storage: memoryStorage({ now: () => LOOPS_NOW }), now: () => LOOPS_NOW });
  registerTasksIpc(wired.ipc, {
    panel: () => tasksPanel.on,
    marks: taskMarks,
    routines: () => [{ id: 'r1', name: 'Daily brief', status: 'ACTIVE', rrule: 'FREQ=DAILY' }],
    nextRun: () => new Date(LOOPS_NOW + 3_600_000),
    paused: () => false,
    loops,
    runsSince: (at: number) => runs.filter((r) => r.startedAt >= at),
    routineName: (id: string) => (id === 'r1' ? 'Daily brief' : null),
    cards: () => waitingCards(controller, mainChat, { enabled: () => true, registry: channelsRegistry }),
    allowed: () => gate.allowed,
    broadcast: (ch: string) => wired.broadcast(ch),
    now: () => LOOPS_NOW,
  });
  // MoMo's suggestions (momoSuggestions:list and :act) behind the same flag; Start's send is recorded, not made
  const suggestions = createSuggestions({ storage: suggestionsMemory({ now: () => LOOPS_NOW }), now: () => LOOPS_NOW });
  const suggestionStarts: [string, string][] = [];
  registerSuggestionsIpc(wired.ipc, {
    store: suggestions,
    allowed: () => gate.allowed,
    enabled: () => suggestionsFlag.on,
    start: async (s: { id: string }, text: string) => void suggestionStarts.push([s.id, text]),
    broadcast: (ch: string) => wired.broadcast(ch),
    now: () => LOOPS_NOW,
  });
  // the morning brief's Try again (momoBrief:runNow): on while the Tasks panel is, its run a test's to change
  const briefRun = { run: async (): Promise<unknown> => 'chat' };
  registerBriefIpc(wired.ipc, {
    allowed: () => gate.allowed,
    enabled: () => tasksPanel.on,
    run: () => briefRun.run(),
    failed: async () => undefined,
    broadcast: (ch: string) => wired.broadcast(ch),
  });
  // MoMo's channels (momoChannels:*), on in this rig (their flag is the Mac's own); a test of the channels' chats builds its own service (tests/remoteMomoChannels.test.ts)
  const channelsRegistry = createChannels({ storage: channelsStorage() });
  registerChannelsIpc(wired.ipc, {
    channels: channelsRegistry,
    chats: {} as any,
    everything: { list: () => ({ rows: [], filters: [], unavailable: false }) } as any,
    allowed: () => gate.allowed,
    enabled: () => true,
    broadcast: (ch: string) => wired.broadcast(ch),
  });
  const w = world({ allowed: true });
  const routinesIpc = registerRoutinesIpc(wired.ipc, {
    routines: w.routines,
    service: w.service,
    allowed: () => gate.allowed,
    broadcast: (ch: string) => wired.broadcast(ch),
  });
  // Settings' sources list (momoSources:list): the connected flags the phone reads, refused while MoMo is not allowed
  const sourceList: { sources: object[] } = { sources: [] };
  wired.ipc.handle('momoSources:list', async () =>
    gate.allowed ? { ok: true, ...sourceList } : { ok: false, reason: 'not_allowed', error: 'MoMo is not available' },
  );
  const sent: any[] = [];
  const stopped: string[] = [];
  const ran: any[] = [];
  const controller = {
    send: async (chatId: string, item: any, origin: unknown, wait: unknown) => (
      sent.push([chatId, item, origin, wait]), { action: 'queued', id: item.id }
    ),
    stopChat: (chatId: string) => stopped.push(chatId),
    state: new SessionStore(),
  };
  const r = rig({ momo: true });
  const broker = new ApprovalBroker({ controller: { addApproval: () => undefined, resolveApproval: () => true } });
  const live = {
    controller,
    computerUse: { broker },
    momoRoutines: w.service,
    chromePanel: { service: { ops: { cardAnswer: answerOf }, onMomoChanged: (area: string) => r.service.onMomoChanged(area) } },
  };
  // prefs.momo as main holds it: what a settings write saved, over the switches the rig's tests flip (paused, brain change)
  const saved: Record<string, unknown> = {};
  const readState = () => ({
    prefs: { momo: { ...saved, paused: gate.paused, suggestions: suggestionsFlag.on, remote: { brainChange: gate.remoteBrain } } },
  });
  // main's own setter (app/ipc/momoPrefs.cjs) over it; a save keeps the pause switch in step
  const patchPrefs = (set: { momo: Record<string, unknown> }) => (
    Object.assign(saved, set.momo), (gate.paused = set.momo.paused === true), true
  );
  const { setPref } = momoPrefsForPhones({ readState, live: { patchPrefs } }, { allowed: () => gate.allowed });
  const remote = wired.attach({
    live,
    mainChat,
    readState,
    runAttended: async (task: any) => ran.push(task),
    allowed: () => gate.allowed,
    setPref,
  });
  r.service.momo = () => remote;
  return {
    r,
    w,
    sourceList,
    live,
    store,
    gate,
    brains,
    sent,
    stopped,
    ran,
    told,
    wired,
    handlers,
    routinesIpc,
    controller,
    mainChat,
    remote,
    dir,
    loops,
    runs,
    tasksPanel,
    suggestionsFlag,
    channelsRegistry,
    taskMarks,
    suggestions,
    suggestionStarts,
    briefRun,
    dismissed,
    setPref,
    main,
  };
}

/** A momoAction card up in MoMo's chat, asked through the real sentinel, gate and audit log, with a phone following. */
export async function cardRig() {
  const m = momoRig();
  const approvals: any[] = [];
  const controller = {
    addApproval: (_chat: string, a: any) => approvals.push(a),
    resolveApproval: (id: string) => approvals.splice(0, approvals.length, ...approvals.filter((a) => a.id !== id)).length >= 0,
  };
  const broker = new ApprovalBroker({ controller });
  const asks = createMomoActionAsk({ broker: () => broker, harnessOf: () => 'claude', sourceName: () => 'Mail' });
  const sentinel = new Sentinel({ askUser: asks.askUser, allowed: () => true, sources: { mail: { level: LEVELS.ASK, private: true } } });
  const t = auditLog({});
  const gate = createTrustGate({ sentinel, audit: t.log });
  // main's controller state holds the approvals; the phone sees them as cards
  m.controller.state.get = () => ({ approvals }) as any;
  m.live.computerUse = { broker } as any;
  m.live.controller = m.controller as any;
  m.remote = m.wired.attach({
    live: m.live,
    mainChat: m.mainChat,
    readState: () => ({ prefs: { momo: { remote: { brainChange: m.gate.remoteBrain } } } }),
    runAttended: async () => undefined,
    allowed: () => m.gate.allowed,
    setPref: m.setPref,
  });
  m.r.service.momo = () => m.remote;
  m.r.ops.state = { get: () => ({ rev: 4 }), snapshot: () => ({ rev: 4 }) } as any;
  m.r.ops.cardsOf = async () => approvals.map((a) => ({ ...cardOf(a, 'MoMo'), version: a.id }));
  const call = {
    chatId: 'momo-main',
    tool: 'mail_send',
    source: 'mail',
    kind: 'change',
    account: 'work',
    harness: 'claude',
    args: { to: 'ann@example.com' },
    egress: { recipients: ['ann@example.com'] },
  };
  const p = m.r.phone('p1');
  const entries = async () =>
    (await t.log.exportJsonl())
      .split('\n')
      .filter(Boolean)
      .map((l: string) => JSON.parse(l));
  return { m, p, gate, call, approvals, entries, log: t.log, asks };
}
