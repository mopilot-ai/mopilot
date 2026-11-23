// Shared control-world imports, fake module hooks and the main turn-lifecycle rig.
import { test } from 'node:test';

import assert from 'node:assert/strict';

import fs from 'node:fs';

import os from 'node:os';

import path from 'node:path';

import { createRequire, registerHooks } from 'node:module';

import { pathToFileURL } from 'node:url';

import { CU, IAB, claudeInterrupt, switchingChat, world } from '../control-matrix-kit.ts';

import { flush, drive, setup as browserHost, tabOf } from '../browser-host-kit.ts';

import { NOTES, rig } from '../desktop-kit.ts';
import { tick } from '../async-scenarios.ts';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-life-'));

fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);

fs.writeFileSync(path.join(tmp, 'sdk.mjs'), 'export const query = (args) => globalThis.__lifeQuery(args);\n');

const fakeModules: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };

registerHooks({
  resolve(specifier, context, next) {
    if (fakeModules[specifier]) return { url: pathToFileURL(path.join(tmp, fakeModules[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

const require = createRequire(import.meta.url);

const { SessionStore } = require('../../../electron/session/state.cjs');

const { ChatController } = require('../../../electron/session/controller.cjs');

const { turnLedger } = require('../../../electron/capabilities/turnEnd.cjs');

const { CodexAdapter } = require('../../../electron/harness/codex.cjs');

const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');

const { CodexToolInjection } = require('../../../electron/capabilities/channels/codexConfig.cjs');

const { ControlIndicator } = require('../../../electron/capabilities/controlIndicator.cjs');

const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await tick();
};

const within = (p: Promise<any>, ms = 1000) => Promise.race([p, new Promise((r) => setTimeout(() => r('still running'), ms))]);

const msg = (text: string) => ({ text, attachments: [], opts: { human: true } });

function mainApp(
  o: { tabs?: (chatId: string) => any; cu?: (chatId: string) => any; codex?: any; surfaces?: { chrome: boolean; computer: boolean } } = {},
) {
  const w = world();
  const sw = switchingChat(w, { surfaces: o.surfaces });
  const ends = { tabs: [] as string[], cu: [] as string[] };
  const tabsTurnEnded = (chatId: string) => (ends.tabs.push(chatId), o.tabs?.(chatId));
  const cuTurnEnded = (chatId: string) => (ends.cu.push(chatId), Promise.resolve(o.cu?.(chatId)));
  let controller: any;
  // the turn-end wiring sessions.cjs builds: the browser and desktop steps, the Registry, the controller's lookup
  const turnEnds = turnLedger({
    steps: [(chatId: string) => tabsTurnEnded(chatId), (chatId: string) => cuTurnEnded(chatId)],
    abortChat: (chatId: string, why: string) => w.r.abortChat(chatId, why),
    chatOf: (id: string) => controller.chatOf(id),
    running: (chatId: string) => state.has(chatId) && ['running', 'awaitingUser'].includes(state.get(chatId).turn),
    tracked: (chatId: string) => state.has(chatId),
  });
  const state = new SessionStore({ publish: (p: any) => turnEnds.sessionPatch(p) });
  const starts: string[][] = [];
  const stops: string[][] = [];
  let turns = 0;
  const claudeTurns = {
    // ClaudeAdapter.startTurn sends through controller.claudeSend, which marks the turn running
    startTurn: async (chatId: string, ref: any, item: any) => {
      starts.push(['claude', chatId, ref.key]);
      await controller.claudeSend(chatId, ref.key, {}, { text: item.text }, null, {});
      return { started: true };
    },
    steer: async () => ({ started: true }),
    // Stop on Claude interrupts the CLI, which cancels its running calls (the SDK's per-call signal); its
    // result (an interrupted turn) arrives later: claudeResult()
    stop: async (chatId: string) => {
      stops.push(['claude', chatId]);
      const ref = controller.ref(chatId);
      controller.onClaudeControl(ref.key, 'interrupt');
      claudeInterrupt(ref.id);
    },
    // as the real ClaudeAdapter: its channel cancels each call itself
    cancelsToolCalls: true,
    crashed: () => {},
    peerCapabilities: () => ({ messaging: false, read: false, steer: true }),
  };
  const codex = o.codex ?? {
    startTurn: async (chatId: string, ref: any) => (starts.push(['codex', chatId, ref.id]), { started: true, turnId: `T${++turns}` }),
    steer: async () => ({ started: true }),
    startGoal: async () => ({ started: true }),
    // Stop on Codex sends turn/interrupt; the app-server's turn/completed arrives later: codexMessage()
    stopTurn: async (chatId: string) => (stops.push(['codex', chatId]), true),
    peerCapabilities: () => ({ messaging: false, read: false, steer: true }),
  };
  controller = new ChatController({
    state,
    chats: sw.chats,
    codex,
    claudeTurns,
    acpTurns: {},
    switcher: sw.runner,
    claude: { send: async () => {} },
    acp: {},
    ...turnEnds.hooks,
  });
  // PeerRuntime takes ChatController.onFinished over (peerRuntime.cjs): main's onFinished never runs
  const finished: any[] = [];
  controller.onFinished = (e: any) => void finished.push(e);
  /** CodexAdapter's observe hook, as sessions.cjs sets it. */
  const observe = (m: any) => {
    controller.onCodexMessage(m);
    turnEnds.codexMessage(m);
  };
  const switchTo = async (chatId: string, harness: 'claude' | 'codex') => {
    const seg = await sw.switchTo(chatId, harness);
    // main's SwitchRunner calls controller.invalidate (sessions.cjs:236); the kit's runner does not
    controller.invalidate();
    return seg;
  };
  return {
    w,
    sw,
    state,
    controller,
    ends,
    starts,
    stops,
    finished,
    observe,
    switchTo,
    turnEnds,
    /** A chat started on Codex: its id is its first thread's. */
    codexChat: async () => (await sw.codex.startThread()).thread.id as string,
    /** A chat started on Claude Code, session s0. */
    claudeChat: (chatId: string) => (sw.startOnClaude(chatId, 's0'), controller.invalidate(), chatId),
    send: async (chatId: string, text = 'go') => {
      const r = controller.send(chatId, msg(text), null);
      await settle();
      return r;
    },
    claudeEvent: (key: string, e: any) => controller.onClaudeEvent({ key, ...e }),
    /** The Claude CLI's result for the turn (`interrupted`: the result after an interrupt). */
    claudeResult: (key: string, interrupted = false) =>
      controller.onClaudeEvent({
        key,
        kind: 'message',
        msg: interrupted
          ? { type: 'result', subtype: 'error_during_execution', is_error: true }
          : { type: 'result', subtype: 'success', result: 'done' },
      }),
    codexCompleted: (threadId: string, turnId: string, status = 'completed') =>
      observe({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status } } }),
    turn: (chatId: string) => state.get(chatId).turn as string,
  };
}

export {
  test,
  assert,
  fs,
  os,
  path,
  createRequire,
  registerHooks,
  pathToFileURL,
  CU,
  IAB,
  claudeInterrupt,
  switchingChat,
  world,
  flush,
  drive,
  browserHost,
  tabOf,
  NOTES,
  rig,
  tmp,
  fakeModules,
  require,
  SessionStore,
  ChatController,
  turnLedger,
  CodexAdapter,
  ToolSessions,
  CodexToolInjection,
  ControlIndicator,
  tick,
  settle,
  within,
  msg,
  mainApp,
};
