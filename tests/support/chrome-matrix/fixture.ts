import { waitFor } from '../waitFor.ts';
import { extensionWire } from '../extension-wire.ts';
// Shared fake SDK, Claude sessions, and Chrome-channel fixtures for browser control matrix unit cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { BU, claudeSession, switchingChat, world } from '../control-matrix-kit.ts';
import { pickStrip } from '../../../src/lib/statusStrip.ts';
import { workingInOf, workingEvents, reduceWorkingIn } from '../../../src/lib/workingIn.ts';
import { composeHandoff } from '../../../shared/handoff.mjs';
import { setup as setupTabs, tabOf as tabOfKit, flush as flushKit } from '../browser-host-kit.ts';
import { controlHandoff } from '../../../src/lib/agentNarration.ts';
import { continueMessage, MOVED_PREFIX, NO_CHROME } from '../../../shared/chromeHandoff.mjs';
import { skyProblemOfItem } from '../../../shared/skyComputerUse.mjs';

/* ---------- a fake Electron (only while electron/harness/claude/index.cjs loads) and a fake Agent SDK ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-chrome-'));
fs.writeFileSync(path.join(tmp, 'electron.cjs'), `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} } };`);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__matrixChromeQuery(args);',
    'export const deleteSession = async (id) => { globalThis.__matrixDeleted.push(id); return true; };',
    'export const tool = (name, description, schema, handler) => ({ name, description, handler });',
    "export const createSdkMcpServer = (o) => ({ type: 'sdk', ...o });",
  ].join('\n'),
);
// electron is faked only while harness/claude/index.cjs loads: the main harness (CM-B03) mocks it its own way later
let fakeElectron = true;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') return { url: pathToFileURL(path.join(tmp, 'sdk.mjs')).href, shortCircuit: true };
    if (specifier === 'electron' && fakeElectron) return { url: pathToFileURL(path.join(tmp, 'electron.cjs')).href, shortCircuit: true };
    return next(specifier, context);
  },
});
(globalThis as any).__matrixDeleted = [];

const DIALOG = {
  installed: true,
  connected: true,
  paired_browser: 'Chrome on Mac',
  urls: { reconnect: 'https://r', permissions: 'https://p' },
};

/**
 * A Claude Code CLI over the SDK: answers each prompt with a result, reads its /chrome dialog from `dialog`,
 * and, when its input ends, runs its exit hooks (Claude in Chrome closes the session's tab group) and quits.
 */
const queries: any[] = [];
(globalThis as any).__matrixChromeQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    log: [] as string[],
    quit: false,
    dialog: { ...DIALOG },
    dialogReads: 0,
    push(m: any) {
      out.push(m);
      wake();
    },
    close() {
      q.log.push('close');
      q.quit = true;
      wake();
    },
    async interrupt() {},
    async getSettings() {
      return { applied: {} };
    },
    async getChromeDialog() {
      q.dialogReads++;
      return q.dialog;
    },
    async reconnectMcpServer() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.quit) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const _m of prompt) q.push({ type: 'result', subtype: 'success' });
    q.log.push('eof', 'exit hooks');
    q.quit = true;
    wake();
  })();
  queries.push(q);
  return q;
};

const require = createRequire(import.meta.url);
const claude = require('../../../electron/harness/claude/index.cjs').createClaudeHarness();
fakeElectron = false;
const { SessionStore } = require('../../../electron/session/state.cjs');
const { SERVER } = require('../../../electron/harness/claude/chromeLink.cjs');
const { chromeLinkScope } = require('../../../electron/session/segmentScope.cjs');
const { BrowserControl } = require('../../../electron/capabilities/browser/control.cjs');
const { ChromeChannel, spawnSpec } = require('../../../electron/capabilities/browser/extension.cjs');
const { chromeHandoff, cancelChromeHandoff, chatHandoffRoute } = require('../../../electron/capabilities/browser/handoff.cjs');
const { ControllerPlans, planInputs } = require('../../../electron/session/controllerPlan.cjs');
const { toRendererSegment } = require('../../../electron/platform/chats.cjs');
const { createBrowserTools } = require('../../../electron/capabilities/browser/hostTools.cjs');
const { openSiteForRoute } = require('../../../electron/capabilities/browser/openSite.cjs');
const { watchPasskeys, PASSKEY_SIGNAL } = require('../../../electron/capabilities/browser/passkeys.cjs');

const handlers = new Map<string, (...a: any[]) => any>();
const ipc = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);
claude.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => {});
claude.timing.blankGroupMs = 20;
claude.timing.retireMs = 200;

async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what).catch(() => {});
  assert.ok(ok(), `timed out waiting for ${what}`);
}
const tick = () => new Promise((r) => setTimeout(r, 10));

/**
 * Main's chat state, fed the way electron/app/agentTools.cjs wires claude.setChromeLinkListener: through the
 * segment scope, which takes a link only from the session of the chat's current segment (`ref`).
 */
function chatState(ref: (chatId: string) => any) {
  const store = new SessionStore();
  const scope = chromeLinkScope({ sessions: store, ref, linkOf: (key: string) => claude.chromeLinkOf(key) });
  claude.setChromeLinkListener((chatId: string, link: any, key: string) => scope.report(chatId, link, key));
  return { store, scope };
}
/** What the status strip above the composer shows for a chat (src/components/thread/StatusStrip.tsx). */
const stripOf = (s: any) =>
  pickStrip({
    computer: !!s.computer,
    nativeCleanup: !!s.nativeCleanup,
    appControl: !!s.appControl?.apps.length,
    chromeLink: s.chromeLink?.dropped === true,
  });

/** Sends a message on a chat's Claude session (key claude:<session id>) with Claude in Chrome on; its CLI's query. */
async function claudeChrome(sessionId: string, chatId: string) {
  claude.setTools({ enabled: () => false, nativeChrome: () => true });
  const key = `claude:${sessionId}`;
  const before = queries.length;
  await claude.send(
    key,
    { bin: process.execPath, sessionId, resume: true, cwd: tmp, account: 'default', chatId },
    { role: 'user', content: 'hi' },
  );
  await until('the CLI', () => queries.length > before);
  return { key, q: queries[before] };
}
const INIT = { type: 'system', subtype: 'init', mcp_servers: [{ name: SERVER, status: 'connected' }] };
const chromeUse = (id: string) => ({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id, name: 'mcp__claude-in-chrome__computer', input: {} }] },
});
const chromeResult = (id: string, isError: boolean, text: string) => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] },
});

/* ---------- Your Chrome: a fake @playwright/mcp child behind the real ChromeChannel and BrowserControl ---------- */

/**
 * A fork() for ChromeChannel whose children answer MCP like @playwright/mcp: a browser_snapshot tool, and
 * every call landing on a blank tab. `gates` hold a method's answers until released.
 */
function playwright() {
  const children: any[] = [];
  const gates: Record<string, Promise<void> | null> = { 'tools/list': null, 'tools/call': null };
  const fork = () => {
    const child: any = new EventEmitter();
    child.calls = [] as string[];
    const reply = (id: number, result: any) =>
      setImmediate(() => child.emit('message', { type: 'out', data: `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n` }));
    child.postMessage = (m: any) => {
      if (m.type === 'stop') return void setImmediate(() => child.emit('exit', 0));
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      if (msg.id == null) return;
      if (msg.method === 'initialize') return reply(msg.id, {});
      const answer =
        msg.method === 'tools/list'
          ? { tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } }] }
          : { content: [{ type: 'text', text: '### Page\n- Page URL: about:blank' }] };
      if (msg.method === 'tools/call') child.calls.push(msg.params.name);
      void Promise.resolve(gates[msg.method]).then(() => reply(msg.id, answer));
    };
    child.kill = () => child.emit('exit', null);
    children.push(child);
    extensionWire(child);
    return child;
  };
  const channel = new ChromeChannel({ fork, spec: () => spawnSpec({ outputDir: tmp, env: {} }) });
  return { channel, children, gates };
}

/** The matrix world with the real browser channel switch: Your Chrome's tools come from BrowserControl. */
async function channelWorld() {
  const w = world();
  // the kit's stand-in for Your Chrome's navigate gives way to the real channel's tools
  w.r.tools.delete(BU);
  const pw = playwright();
  const switches: Record<string, boolean> = { 'shared.browser.extension': true, 'shared.browser.panelCdp': true };
  const control = new BrowserControl({
    registry: w.r,
    grants: { require: async () => {}, act: async () => {} },
    chromeGrants: { require: async () => {}, act: async () => {} },
    panel: {},
    chrome: pw.channel,
    isEnabled: (k: string) => switches[k],
  });
  // the visibility rule reads the live channel, as main's ToolVisibility does (drivesUserChrome)
  Object.defineProperty(w.state, 'yourChrome', { get: () => control.drivesUserChrome() });
  await control.configure('builtin');
  let prefs = { channel: 'builtin', profileDir: '' };
  /** The Browser settings' channel picker (electron/app/ipc/browser.cjs browser:configure). */
  const settings = async (channel: string) => {
    prefs = { channel, profileDir: '' };
    await control.configure(channel);
  };
  const handoff = (chatId: string) =>
    chromeHandoff({
      browserWindows: { owned: () => {} },
      chromeChannel: pw.channel,
      browserControl: control,
      isEnabled: () => switches['shared.browser.extension'],
      getPrefs: () => prefs,
      commitPrefs: (next: any) => (prefs = next),
      changed: () => {},
    })({ webContentsId: 7, chatId, url: 'https://task.test/work?code=4/0AY0e-g7SECRETxyz123' }, 'ui');
  const cancel = (chatId: string) =>
    cancelChromeHandoff({ browserWindows: { owned: () => {} }, chromeChannel: pw.channel }, { webContentsId: 7, chatId }, 'ui');
  return { w, pw, control, settings, handoff, cancel, prefs: () => prefs };
}
const YC = 'sage_browser_snapshot';
/** The chats whose Your Chrome instance is running or starting. */
const instances = (pw: ReturnType<typeof playwright>) => [...pw.channel.chats.keys()].sort();

const BOOKING = 'https://account.booking.com/social/consent/google';

export {
  BOOKING,
  test,
  assert,
  claudeSession,
  switchingChat,
  until,
  tick,
  channelWorld,
  YC,
  instances,
  world,
  DIALOG,
  claude,
  ipc,
  chatState,
  stripOf,
  claudeChrome,
  INIT,
  chromeUse,
  chromeResult,
  workingInOf,
  workingEvents,
  reduceWorkingIn,
  composeHandoff,
  MOVED_PREFIX,
  NO_CHROME,
  skyProblemOfItem,
  EventEmitter,
  createRequire,
  watchPasskeys,
  PASSKEY_SIGNAL,
  SessionStore,
  chatHandoffRoute,
  ControllerPlans,
  planInputs,
  toRendererSegment,
  setupTabs,
  tabOfKit,
  flushKit,
  controlHandoff,
  continueMessage,
  chromeHandoff,
  createBrowserTools,
  openSiteForRoute,
};
