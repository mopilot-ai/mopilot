// Shared fake app-server, desktop lock, adapter, and sandbox fixtures for Sky matrix unit cases.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { codexConnection, fakeAppServer, world } from '../control-matrix-kit.ts';
import { controlStep, narrationContexts, turnNarrationPriors } from '../../../src/lib/agentNarration.ts';
import { workingInOf } from '../../../src/lib/workingIn.ts';
import { nativeAppAnswer, nativeAppApproval } from '../../../src/harness/elicitation.ts';
import { tick } from '../async-scenarios.ts';

const require = createRequire(import.meta.url);
const { setupComputerUse } = require('../../../electron/capabilities/computerUse.cjs');
const { NativeDesktopHolds } = require('../../../electron/capabilities/nativeDesktopHold.cjs');
const { guarded } = require('../../../electron/capabilities/contract/actionGuard.cjs');
const { Registry } = require('../../../electron/capabilities/contract/registry.cjs');
const { CodexAdapter } = require('../../../electron/harness/codex.cjs');
const { NATIVE_CLEANUP_WAIT_MS } = require('../../../electron/harness/codexConnection.cjs');
const { NativeCodexLifecycle, chatCleanupState } = require('../../../electron/capabilities/contract/codexLifecycle.cjs');
const { CodexThreadParents, codexParentLinks } = require('../../../electron/capabilities/contract/codexParents.cjs');
const { SessionStore } = require('../../../electron/session/state.cjs');
const { ChatController } = require('../../../electron/session/controller.cjs');
const { ChatsStore } = require('../../../electron/platform/chats.cjs');
const { cuaProgramUse, cuaAssignments } = require('../../../shared/cuaProgram.mjs');
const { vendorProblem } = require('../../../shared/skyComputerUse.mjs');
const { VENDOR_SOURCES } = require('../../../shared/vendorErrors.mjs');

const dirs: string[] = [];
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-sky-'));
  dirs.push(d);
  return d;
};
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

/* ---------- the app-server's messages ---------- */

const js = (threadId: string, turnId: string, code: string, id = `${turnId}-js`, status = 'inProgress', extra: any = {}) => ({
  threadId,
  turnId,
  item: { type: 'mcpToolCall', server: 'cua_repl', tool: 'js', id, arguments: { code }, status, ...extra },
});
const turn = (threadId: string, id: string, status = 'completed') => ({ threadId, turn: { id, status } });
const NOTES = "const notes = await cua.getApp('Notes');\nawait notes.click([10, 10]);";
const BROWSER = "const tab = await cua.createBrowserTab('chrome');\nawait tab.goto('https://example.com');";

/* ---------- main's wiring: computer use, the Codex adapter and its observe, Stop ---------- */

/**
 * setupComputerUse and the Codex adapter as main wires them (electron/app/agentTools.cjs, sessions.cjs): the
 * adapter's observe feeds the native holds, Esc and Stop interrupt the chat's Codex turn, and a native program
 * that finds the desktop taken stops its own turn. `nat-a` runs in chat-a, `nat-b` in chat-b, both native.
 */
function governed(o: { parity?: boolean; helperBusy?: boolean } = {}) {
  const native = new Set(['nat-a', 'nat-b']);
  const parents = new CodexThreadParents();
  const chatOf = (id: string) => ({ 'nat-a': 'chat-a', 'nat-b': 'chat-b' })[id] ?? id;
  const requestChat = (id: string) => chatOf(parents.rootOf(id));
  const server = fakeAppServer({ initialize: () => ({ userAgent: 'fake' }), 'mcpServer/tool/call': () => ({ content: [] }) });
  const state = new SessionStore();
  const events: any[] = [];
  let runtime: any = null;
  const adapter = new CodexAdapter({
    server,
    state,
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat === 'chat-a' ? 'nat-a' : 'nat-b', key: chat }),
    chatOf,
    emit: (e: any) => events.push(e),
    observe: (msg: any) => runtime.nativeHolds.observe(msg),
    tools: {
      outgoing: (m: any) => m,
      observe() {},
      exited() {},
      setUserServers() {},
      parents,
      isNativeThread: (id: string) => native.has(parents.rootOf(id)),
      isLoadedThread: (id: string) => native.has(id),
    },
    probe: null,
    log: () => {},
    // a Stop that reset the plugin's JS kernel (sessions.cjs)
    onNativeReset: (threadId: string) => runtime.nativeHolds.reset(threadId),
  });
  const stopped: string[] = [];
  const busy: any[] = [];
  const flags: Record<string, boolean> = { 'shared.computerUse.enabled': true, 'shared.computerUse.parityTools': o.parity === true };
  runtime = setupComputerUse({
    ipcMain: { handle() {} },
    registry: new Registry(),
    flags: { isEnabled: (k: string) => !!flags[k] },
    chats: { records: new Map(), get: () => null, patchMeta: () => true },
    controller: { chatOf, ref: () => ({ kind: 'codex' }), viewing: () => true, isSubagentCall: () => false },
    sessions: { get: (id: string) => state.get(id), patch: (id: string, p: any) => state.patch(id, p) },
    userData: tmp(),
    packaged: false,
    broadcast: () => {},
    // Stop and Esc, as controller.stopChat sends it on a Codex chat
    stop: async (chatId: string) => {
      stopped.push(chatId);
      const thread = chatId === 'chat-a' ? 'nat-a' : 'nat-b';
      await adapter.request('turn/interrupt', { threadId: thread, turnId: adapter.turnOf.get(thread) });
    },
    nativeThread: (id: string) => native.has(parents.rootOf(id)),
    requestChat,
    subagentThread: (id: string) => parents.parentOf(id) != null,
    onNativeBusy: (threadId: string, turnId: string, chatId: string, holder: string | null) => {
      busy.push([threadId, turnId, chatId, holder]);
      adapter.request('turn/interrupt', { threadId, turnId });
    },
    // as agentTools.cjs: a sub-agent thread is stopped here; the chat's own thread by its Stop
    onNativeStop: (threadId: string, turnId: string) => {
      if (chatOf(threadId) === threadId) adapter.request('turn/interrupt', { threadId, turnId });
    },
  });
  // the helper is a fake: nothing launches; its control lock is recorded (another app or profile may hold it)
  const helper = runtime.helper;
  // a launch fails the same way everywhere, whether or not this checkout has built the helper (it opened the real one
  // where it was built, and the test process never exited)
  helper.start = async () => {
    throw new Error('the fake helper never launches');
  };
  const helperCalls: string[] = [];
  for (const m of ['releaseControl', 'releaseInput', 'glowStop']) helper[m] = async () => (helperCalls.push(m), { ok: true });
  helper.acquireControl = async (holder: string) => {
    helperCalls.push(`acquireControl ${holder}`);
    if (o.helperBusy) throw Object.assign(new Error('the desktop is in use by Other Profile'), { reason: 'lock_busy' });
    return { ok: true };
  };
  const notify = (method: string, params: any) => server.notify(method, params);
  return { adapter, server, state, runtime, cu: runtime.cu, events, stopped, busy, parents, notify, helperCalls };
}

/** ComputerUse's lock as the holds use it: in-process, with the helper's lock behind it. */
function fakeLock(o: { controlling?: string | null; app?: string | null; onActivity?: (c: string, a: any) => void } = {}) {
  const lock: any = {
    controlling: o.controlling ?? null,
    liveHolder: () => lock.controlling,
    app: o.app ?? null,
    onActivity: o.onActivity ?? (() => {}),
    helper: { acquireControl: async () => ({}) },
    holder: () => 'MoPilot',
    closed: false,
    epochs: 0,
    epoch: () => lock.epochs,
    release: async (chatId: string) => {
      if (lock.controlling !== chatId) return;
      lock.controlling = null;
      lock.app = null;
    },
  };
  return lock;
}

/* ---------- the Codex adapter alone: lifecycle, held requests, strips ---------- */

function adapterRig(o: { handlers?: Record<string, (p: any) => any>; hold?: string[]; chatOf?: Record<string, string> } = {}) {
  const parents = new CodexThreadParents();
  const roots = new Set(['nat', 'old', 'new']);
  const map: Record<string, string> = { nat: 'chat', old: 'chat', new: 'chat', ...o.chatOf };
  const server = fakeAppServer(
    { initialize: () => ({ userAgent: 'fake' }), 'mcpServer/tool/call': () => ({ content: [] }), ...o.handlers },
    new Set(o.hold ?? []),
  );
  const state = new SessionStore();
  const events: any[] = [];
  const seen: any[] = [];
  const adapter = new CodexAdapter({
    server,
    state,
    nativeOf: () => ({ kind: 'codex', id: 'nat', key: 'chat' }),
    chatOf: (id: string) => map[id] ?? id,
    emit: (e: any) => events.push(e),
    observe: (msg: any) => seen.push(msg),
    tools: {
      outgoing: (m: any) => m,
      observe() {},
      exited() {},
      setUserServers() {},
      parents,
      // as the injection answers: a sub-agent runs with its native root's plugin
      isNativeThread: (id: string) => roots.has(parents.rootOf(id)),
      isLoadedThread: (id: string) => roots.has(id),
    },
    probe: null,
    log: () => {},
  });
  const requests = () => events.filter((e) => e.kind === 'request').map((e) => e.request.id);
  const toasts = () => events.filter((e) => e.kind === 'toast').map((e) => e.text);
  return { adapter, server, state, events, seen, parents, requests, toasts, notify: server.notify.bind(server) };
}

export {
  test,
  assert,
  path,
  controlStep,
  nativeAppAnswer,
  nativeAppApproval,
  SessionStore,
  ChatController,
  ChatsStore,
  tmp,
  settle,
  js,
  turn,
  NOTES,
  BROWSER,
  adapterRig,
  NATIVE_CLEANUP_WAIT_MS,
  NativeCodexLifecycle,
  chatCleanupState,
  CodexThreadParents,
  cuaAssignments,
  NativeDesktopHolds,
  guarded,
  governed,
  fakeLock,
  narrationContexts,
  turnNarrationPriors,
  workingInOf,
  vendorProblem,
  VENDOR_SOURCES,
  codexConnection,
  world,
  codexParentLinks,
  mock,
  cuaProgramUse,
};
