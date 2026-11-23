// Control matrix, where a chat switched Claude Code → Codex is routed (docs/control-plane/matrix.md CM-L11 to CM-L15):
// main's pieces as electron/app wires them (the app-server process with its intercept chain, the Codex adapter, the
// tool channel, the ChatController, the SwitchRunner, the controller plans and the chat store), over a scripted
// app-server that sends the new thread's notifications in the same read as the thread/start answer, and a window
// that does what the renderer does with what it hears (it follows each chat a session patch names, and marks a chat
// whose turn ended unread). A switch's thread must never become a chat of its own: its events, Stop, approval
// cards and built-in browser tabs are the switched chat's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { world } from './support/control-matrix-kit.ts';
import { tick } from './support/async-scenarios.ts';
import { readerTurns } from './support/reader-turns.ts';

export const GUARDS = ['electron/', 'shared/', 'src/store/'];

const require = createRequire(import.meta.url);
const { AppServer } = require('../electron/harness/codexProcess.cjs');
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { ChatController } = require('../electron/session/controller.cjs');
const { SwitchRunner } = require('../electron/session/switch.cjs');
const { ControllerPlans, planInputs } = require('../electron/session/controllerPlan.cjs');
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { IabBackend } = require('../electron/capabilities/browser/iabBackend.cjs');
const { segmentAliases, switchedOwner } = require('../shared/segmentAlias.mjs');
const { heldText } = require('../shared/handoff.mjs');

const settle = async () => {
  for (let i = 0; i < 12; i++) await tick();
};

const NEW = '01a138d6-3ae1-78e0-bc88-d6cd2a48459a';
const CHAT = 'claude:8193dd69-52eb-49fa-8457-1ada73be20b4';
const PANE_TAB = 'tab_a7c6f1';

/** A `codex app-server` child as AppServer spawns it: what main writes is answered by `script`, one read per answer. */
function scriptedProcess() {
  const p: any = new EventEmitter();
  p.pid = 4242;
  p.sent = [] as any[];
  p.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  p.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  /** one read: several messages in one chunk, as the pipe delivers them */
  p.read = (...msgs: any[]) => p.stdout.emit('data', msgs.map((m) => `${JSON.stringify(m)}\n`).join(''));
  p.stdin = Object.assign(new EventEmitter(), {
    write: (line: string) => {
      const m = JSON.parse(line);
      p.sent.push(m);
      if (m.id == null || !m.method) return;
      setImmediate(() => {
        const thread = { id: NEW, cwd: '/repo', name: null, preview: '', ephemeral: false };
        if (m.method === 'initialize') return p.read({ id: m.id, result: { userAgent: 'fake' } });
        // the answer, then the new thread's own notifications in the same read
        if (m.method === 'thread/start')
          return p.read(
            { id: m.id, result: { thread } },
            { method: 'thread/started', params: { thread } },
            { method: 'thread/status/changed', params: { threadId: NEW, status: { type: 'idle' } } },
          );
        if (m.method === 'turn/start')
          return p.read(
            { id: m.id, result: { turn: { id: 'T1', status: 'inProgress', items: [] } } },
            { method: 'turn/started', params: { threadId: NEW, turn: { id: 'T1', status: 'inProgress', items: [] } } },
          );
        p.read({ id: m.id, result: {} });
      });
    },
  });
  return p;
}

/**
 * Main as electron/app wires it. `phantom`: a record keyed by the switch's thread id is already there (an earlier
 * build made one). `iab`: native Codex threads get the Browser plugin's in-app browser backend.
 */
function mainApp(o: { iab?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-switch-routing-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const w = world();
  const proc = scriptedProcess();
  const server = new AppServer({ spawn: () => proc });
  const events: any[] = [];
  const viewing = { chat: CHAT };
  let controller: any;
  let plans: any;
  // the window: it follows every chat a session patch names (session:snapshot gives a new chat a record), and marks a
  // chat whose turn ended unread when it isn't the one on screen (notifications.ts onTurnFinished, chats:patchMeta)
  const followed = new Set<string>();
  const state = new SessionStore({
    publish: (p: any) => {
      if (followed.has(p.chatId)) return;
      followed.add(p.chatId);
      if (!chats.records.has(p.chatId)) chats.ensure(p.chatId);
    },
  });
  const emit = (e: any) => {
    events.push(e);
    if (e.kind === 'notification' && e.method === 'turn/completed' && e.chatId !== viewing.chat)
      chats.patchMeta(e.chatId, { unread: true });
  };
  const iabThreads = new Set<string>();
  const tools = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    // no sage-mcp in this build: the vendor plugin is the thread's only controller
    hasTools: () => false,
    chatOf: (id: string) => controller.requestChat(id),
    nativeEnabled: () => true,
    nativeSurfaces: () => ({ chrome: false, computer: true }),
    nativeHideFor: (s: { chrome: boolean; computer: boolean }) => w.vis.forHost({ nativeChrome: s.chrome, nativeComputer: s.computer }),
    browserBackends: {
      available: () => o.iab === true,
      has: (id: string) => iabThreads.has(id),
      loaded: (id: string) => (o.iab ? iabThreads.add(id) : null),
      unloaded: (id: string) => iabThreads.delete(id),
      exited: () => iabThreads.clear(),
    },
    onLoaded: (id: string) => plans.loaded(id),
  });
  // readers in main's intercept chain resolve the new thread's chat as its answer passes (the cards' owner, the site
  // consent; the tool channel was one too, in the build the bench ran, and decided the thread's controller plan there):
  // whichever reads first, the switch's claim is already there
  const seenByIntercepts: string[] = [];
  server.intercepts.add((m: any) => {
    if (m.result?.thread?.id) seenByIntercepts.push(controller.chatOf(m.result.thread.id));
    return tools.observe(m);
  });
  const codex = new CodexAdapter({
    server,
    state,
    nativeOf: (chatId: string) => controller.ref(chatId),
    chatOf: (id: string) => controller.chatOf(id),
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit,
    observe: (msg: any) => controller.onCodexMessage(msg),
    onStopped: (chatId: string, turnId: string) => controller.codexStopped(chatId, turnId),
    tools,
    probe: null,
  });
  plans = new ControllerPlans({
    chats,
    sessions: state,
    ref: (chatId: string) => controller.ref(chatId),
    chatOf: (key: string) => controller.chatOf(key),
    inputs: planInputs({
      tools: () => w.r.list().map((t: any) => t.name),
      yourChrome: () => false,
      claude: { channel: () => true, nativeChromeOf: () => false, nativeChromeFor: () => false },
      codex: {
        channel: () => false,
        loadedPath: (id: string) => tools.loadedPath(id),
        nativeSurfaces: () => ({ chrome: false, computer: true }),
        iabAvailable: () => tools.iabAvailable(),
      },
      acp: { channel: () => false },
    }),
  });
  const held = [{ surface: 'iab', id: PANE_TAB, origin: 'agent', openedBy: 'agent', site: 'http://127.0.0.1:8800' }];
  const runner = new SwitchRunner({
    chats,
    ref: (chatId: string) => controller.ref(chatId),
    invalidate: () => controller.invalidate(),
    claim: (key: string, chatId: string) => controller.claim(key, chatId),
    unclaim: (key: string, chatId: string) => controller.unclaim(key, chatId),
    changed: () => {},
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: '/home/me',
    emit,
    git: { info: async () => ({ branch: 'main' }), status: async () => ({ files: [] }) },
    codex: {
      startThread: (params: any, opts: any) => codex.startThread(params, opts),
      ensureResumed: (id: string) => codex.ensureResumed(id),
      threadTurns: async () => ({ data: [], nextCursor: null }),
      summarize: async () => 'note',
      cwdOf: () => '/repo',
    },
    claude: {
      registerSession: () => {},
      isFresh: () => true,
      cwdOf: () => '/repo',
      accountOf: () => 'default',
      messages: async () => [],
      summarize: async () => 'note',
    },
    permissionParams: () => ({}),
    segmentEnded: (e: any) => plans.segmentEnded(e),
    held: () => held,
  });
  controller = new ChatController({ state, chats, codex, claudeTurns: {}, acpTurns: {}, switcher: runner, claude: {}, acp: {} });
  // the chat: on Claude Code, its one turn done, and the window showing it
  chats.commit({ ...chats.record(CHAT), segments: [{ ...chats.record(CHAT).segments[0], count: 1 }] });
  controller.invalidate();
  state.patch(CHAT, { turn: 'idle' });
  /** The user picks Codex in the model menu, clicks Switch, and sends the next message. */
  const switchAndSend = async () => {
    state.patch(CHAT, { pendingSwitch: { harness: 'codex', model: 'gpt-6.1-sol', modelLabel: 'GPT-6.1 Sol', mode: 'auto' } });
    controller.send(CHAT, { text: 'Now finish the task', attachments: [], opts: {} }, null);
    await settle();
  };
  /** The app-server sends a notification (or a server request, with `id`) in a read of its own. */
  const read = async (msg: any) => {
    proc.read(msg);
    await settle();
  };
  return { dir, chats, state, events, proc, server, codex, controller, plans, runner, tools, seenByIntercepts, switchAndSend, read };
}

const noRecordOf = (app: ReturnType<typeof mainApp>, id: string) => {
  assert.equal(app.chats.records.has(id), false, `no chat record keyed by ${id}`);
  assert.equal(fs.existsSync(path.join(app.dir, 'threads', `${encodeURIComponent(id)}.v2`)), false, `no ${id}.v2 file`);
};

test("CM-L11: Claude → Codex makes no chat record of the new thread: the window following every session patch and marking finished turns unread can't create one", async () => {
  const app = mainApp();
  await app.switchAndSend();
  const seg = app.chats.record(CHAT).segments.at(-1);
  assert.deepEqual([seg.kind, seg.nativeId], ['codex', NEW]);
  // main's readers ahead of the adapter already saw the thread as the chat's
  assert.deepEqual(app.seenByIntercepts, [CHAT]);
  assert.equal(app.controller.chatOf(NEW), CHAT);
  assert.equal(app.state.has(NEW), false, 'no session state of its own (the window would follow it)');
  assert.deepEqual(app.plans.unsaved.has(NEW), false, 'no controller plan of its own');
  await app.read({ method: 'turn/completed', params: { threadId: NEW, turn: { id: 'T1', status: 'completed', items: [] } } });
  noRecordOf(app, NEW);
  assert.equal(app.controller.chatOf(NEW), CHAT);
});

test('CM-L12a: after Claude → Codex the turn\'s events reach the switched chat, and its end leaves it idle (not "Working" forever)', async () => {
  const app = mainApp();
  await app.switchAndSend();
  assert.equal(app.state.get(CHAT).turn, 'running');
  await app.read({
    method: 'item/completed',
    params: { threadId: NEW, turnId: 'T1', item: { id: 'i1', type: 'agentMessage', text: 'The password is GG' } },
  });
  await app.read({ method: 'turn/completed', params: { threadId: NEW, turn: { id: 'T1', status: 'completed', items: [] } } });
  const notes = app.events.filter((e) => e.kind === 'notification' && e.params?.threadId != null);
  assert.ok(notes.length > 0);
  assert.deepEqual([...new Set(notes.map((e) => `${e.chatId}|${e.params.threadId}`))], [`${CHAT}|${CHAT}`]);
  assert.equal(app.state.get(CHAT).turn, 'idle');
  noRecordOf(app, NEW);
});

test('CM-L12b: Stop on the switched chat interrupts the new thread and the chat stops working', async () => {
  const app = mainApp();
  await app.switchAndSend();
  assert.equal(app.state.get(CHAT).turn, 'running');
  await app.controller.stopChat(CHAT);
  await settle();
  const interrupt = app.proc.sent.find((m: any) => m.method === 'turn/interrupt');
  assert.equal(interrupt?.params.threadId, NEW);
  await app.read({ method: 'turn/completed', params: { threadId: NEW, turn: { id: 'T1', status: 'interrupted', items: [] } } });
  assert.equal(app.state.get(CHAT).turn, 'idle');
  noRecordOf(app, NEW);
});

test("CM-L13: after Claude → Codex an approval the new thread asks for (a purchase's confirmation) is a card in the switched chat", async () => {
  const app = mainApp();
  await app.switchAndSend();
  await app.read({
    id: 77,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: NEW, turnId: 'T1', itemId: 'c1', command: 'place order', reason: 'Places the order' },
  });
  const req = app.events.find((e) => e.kind === 'request');
  assert.equal(req?.chatId, CHAT);
  assert.deepEqual(
    app.state.get(CHAT).approvals.map((a: any) => a.id),
    [77],
  );
  assert.equal(app.state.has(NEW), false);
  noRecordOf(app, NEW);
});

test("CM-L14a: Claude → Codex with the Browser plugin's in-app browser: the plan names it, the handoff says how to reach the held tab, and the backend lists the chat's tab", async () => {
  const app = mainApp({ iab: true });
  // the switch sheet: the pane goes from MoPilot's browser tools to the Codex Browser plugin, not to nothing
  assert.deepEqual(app.plans.preview(CHAT, 'codex').lines, [
    "After the switch, the built-in browser is controlled by the Codex Browser plugin instead of MoPilot's browser tools.",
    "After the switch, the computer is controlled by Codex Computer Use instead of MoPilot's computer use.",
  ]);
  await app.switchAndSend();
  const plan = app.chats.record(CHAT).meta.controllerPlan;
  assert.deepEqual(plan, { key: NEW, iab: 'codex-browser-plugin', cu: 'codex-computer-use', bu: null });
  const handoff = app.chats.record(CHAT).segments.at(-1).handoff.text;
  assert.match(handoff, new RegExp(`Built-in browser tab ${PANE_TAB}`));
  assert.match(handoff, /tabs\.list\(\), take the tab whose providerTabId is that id/);
  // the thread's backend serves the switched chat's pane tabs, Claude's tab among them under its pane id
  const host = {
    list: (chatId: string) => (chatId === CHAT ? [{ id: PANE_TAB, url: 'http://127.0.0.1:8800/iframe-nest-easy', title: 'Game' }] : []),
    current: (chatId: string) => (chatId === CHAT ? { id: PANE_TAB } : null),
  };
  const backend = new IabBackend({
    threadId: NEW,
    chatOf: (id: string) => app.controller.chatOf(id),
    tabs: () => host,
    grants: () => null,
  });
  const tabs = await backend.handle('getTabs', { session_id: NEW });
  assert.deepEqual(
    tabs.map((t: any) => [t.providerTabId, t.url]),
    [[PANE_TAB, 'http://127.0.0.1:8800/iframe-nest-easy']],
  );
});

test("CM-L14b: the held tabs' Codex line is only for a harness that needs it and a chat that holds a pane tab", () => {
  const tab = [{ surface: 'iab', id: PANE_TAB, origin: 'agent' }];
  const desktop = [{ surface: 'desktop', id: 'mac', origin: 'agent' }];
  assert.match(heldText(tab, 'codex'), /providerTabId/);
  assert.doesNotMatch(heldText(tab, 'claude'), /providerTabId/);
  assert.doesNotMatch(heldText(tab), /providerTabId/);
  assert.doesNotMatch(heldText(desktop, 'codex'), /providerTabId/);
  assert.equal(heldText([], 'codex'), '');
});

test("CM-L14c: without the plugin's in-app browser backend the plan says nothing controls the pane on Codex", async () => {
  const app = mainApp({ iab: false });
  assert.match(app.plans.preview(CHAT, 'codex').lines[0], /nothing controls the built-in browser/);
  await app.switchAndSend();
  assert.equal(app.chats.record(CHAT).meta.controllerPlan.iab, null);
  assert.equal(app.tools.iabAvailable(), false);
});

test('CM-L15a: a record an earlier build made for the switched thread (unread, its own plan) no longer takes its events, Stop or cards', async () => {
  const app = mainApp();
  await app.switchAndSend();
  // what the bench's profiles hold: threads/<thread id>.v2, written before the switch committed (a file of its own)
  const phantom = { ...app.chats.record(NEW), meta: { ...app.chats.record(NEW).meta, unread: true } };
  app.chats.records.set(NEW, phantom);
  app.controller.invalidate();
  assert.equal(app.controller.chatOf(NEW), CHAT);
  assert.equal(app.controller.requestChat(NEW), CHAT);
  await app.read({ id: 78, method: 'item/commandExecution/requestApproval', params: { threadId: NEW, turnId: 'T1', itemId: 'c2' } });
  assert.equal(app.events.find((e) => e.kind === 'request')?.chatId, CHAT);
  await app.read({ method: 'turn/completed', params: { threadId: NEW, turn: { id: 'T1', status: 'completed', items: [] } } });
  assert.equal(app.state.get(CHAT).turn, 'idle');
});

test('CM-L15b: the chat store refuses a record of its own for a native session that is a later segment of another chat', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-switch-store-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  const first = chats.record(CHAT).segments[0];
  chats.commit({ ...chats.record(CHAT), segments: [first, { ...first, kind: 'codex', nativeId: NEW, start: 1, count: null }] });
  assert.equal(chats.ensure(NEW), false);
  assert.equal(chats.patchMeta(NEW, { unread: true }), false);
  assert.equal(chats.records.has(NEW), false);
  // the chat itself, and a plain Codex chat keyed by its own thread, still get theirs
  assert.equal(chats.patchMeta(CHAT, { pinned: true }), true);
  assert.equal(chats.ensure('01a1aaaa-0000-7000-8000-000000000000'), true);
  // Codex → Claude: the new claude:<id> session is a later segment too
  const codexChat = '01a1bbbb-0000-7000-8000-000000000000';
  const c0 = chats.record(codexChat).segments[0];
  chats.commit({ ...chats.record(codexChat), segments: [c0, { ...c0, kind: 'claude', nativeId: 's9', start: 1 }] });
  assert.equal(chats.ensure('claude:s9'), false);
});

test("CM-L15c: the alias rule: a switch's later segment answers over a record's own first segment, in any order; the window's chatOf uses it too", () => {
  const aliases = segmentAliases([
    [NEW, [NEW]],
    [CHAT, [CHAT, NEW]],
    ['plain', ['plain']],
  ]);
  assert.equal(aliases.get(NEW), CHAT);
  assert.equal(aliases.get(CHAT), CHAT);
  assert.equal(aliases.get('plain'), 'plain');
  assert.equal(
    segmentAliases([
      [CHAT, [CHAT, NEW]],
      [NEW, [NEW]],
    ]).get(NEW),
    CHAT,
  );
  assert.equal(switchedOwner([[CHAT, [CHAT, NEW]]], NEW), CHAT);
  assert.equal(switchedOwner([[CHAT, [CHAT, NEW]]], CHAT), null);
  // a chat's own session listed again later (a switch back) is still its own
  assert.equal(switchedOwner([[NEW, [NEW, 'claude:x', NEW]]], NEW), null);
  const src = fs.readFileSync(new URL('../src/store/chats.ts', import.meta.url), 'utf8');
  assert.match(src, /aliasMap = segmentAliases\(/);
});

test("CM-L15d: an answer's hook runs ahead of main's intercept chain once, and a reader that throws costs nothing", async () => {
  const proc = scriptedProcess();
  const server = new AppServer({ spawn: () => proc });
  const seen: string[] = [];
  server.ahead.add(() => {
    throw new Error('broken reader');
  });
  server.intercepts.add((m: any) => (m.id === 'x' ? (seen.push('intercept'), true) : false));
  server.ahead.add((m: any) => seen.push(`ahead ${m.id ?? m.method}`));
  server.start();
  proc.read({ id: 'x', result: {} }, { method: 'n/1', params: {} });
  // past the reader's time budget (a busy machine) the second line comes a turn later
  await readerTurns();
  assert.deepEqual(seen, ['ahead x', 'intercept', 'ahead n/1']);
});

test('main registers the Codex tool channel with the adapter only, never in the intercept chain ahead of the answer hooks', () => {
  const src = fs.readFileSync(new URL('../electron/app/agentTools.cjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /intercepts\.add\(\s*\(m\)\s*=>\s*injection\.observe/);
  const sessions = fs.readFileSync(new URL('../electron/app/sessions.cjs', import.meta.url), 'utf8');
  assert.match(sessions, /tools: live\.codexTools,/);
});
