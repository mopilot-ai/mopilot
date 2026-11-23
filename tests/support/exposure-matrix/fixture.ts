// Shared controller, fake SDK, availability, and socket fixtures for exposure matrix unit cases.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  BU,
  CU,
  IAB,
  type World,
  claudeSession,
  codexConnection,
  healthOf,
  registryNameOf,
  sageMcpClient,
  world,
} from '../control-matrix-kit.ts';
import { waitFor } from '../waitFor.ts';

const require = createRequire(import.meta.url);
const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../../../electron/capabilities/mcp/socket.cjs');
const { SessionMcp } = require('../../../electron/capabilities/channels/sessionMcp.cjs');
const {
  CodexToolInjection,
  NATIVE_CUA_PLUGIN,
  IN_APP_BROWSER_CONTEXT,
} = require('../../../electron/capabilities/channels/codexConfig.cjs');
const { NativeAvailability } = require('../../../electron/capabilities/nativeAvailability.cjs');
const { createBrowserTools, inAppBrowserEnabled } = require('../../../electron/capabilities/browser/hostTools.cjs');

/* ---------- what main registers under the remote switches ---------- */

const BROWSER_TOOLS = [IAB, 'browser_tabs_context'];
const DESKTOP_TOOLS = [CU, 'desktop_screenshot'];
const COMPUTER_TOOLS = ['computer_click', 'computer_screenshot'];
const FLAG = {
  browserParity: 'shared.browser.parityTools',
  computer: 'shared.computerUse.enabled',
  computerParity: 'shared.computerUse.parityTools',
};

/**
 * The kit's world registers every tool; main does not. browser_* are registered at startup only when
 * shared.browser.parityTools is on (electron/app/browserTools.cjs), computer_* while shared.computerUse.enabled
 * is on and desktop_* while it and shared.computerUse.parityTools are (computerUse.cjs sync, run again on
 * every flag change by app/flags.cjs). Unregistering is what Registry.register's undo does: tools.delete.
 */
function registration(w: World) {
  const parked = new Map<string, unknown>();
  const set = (name: string, on: boolean) => {
    if (on && parked.has(name)) {
      w.r.tools.set(name, parked.get(name));
      parked.delete(name);
    } else if (!on && w.r.tools.has(name)) {
      parked.set(name, w.r.tools.get(name));
      w.r.tools.delete(name);
    }
  };
  const sync = () => {
    const on = !!w.flags[FLAG.computer];
    for (const n of COMPUTER_TOOLS) set(n, on);
    for (const n of DESKTOP_TOOLS) set(n, on && !!w.flags[FLAG.computerParity]);
  };
  return {
    sync,
    startup() {
      for (const n of BROWSER_TOOLS) set(n, !!w.flags[FLAG.browserParity]);
      sync();
    },
  };
}

/**
 * The real browser_tabs_context in place of the kit's fake, behind the in-app browser's remote switches
 * (inAppBrowserEnabled, read at every call); `ran` records each call that got past them.
 */
function realTabsContext(w: World) {
  const ran: string[] = [];
  const tabs = {
    list: () => [{ id: 't1', url: 'about:blank', title: '' }],
    current: () => null,
    create: async () => {},
    // asked once, at the end of each call that ran
    state: (chatId: string) => (ran.push(chatId), 'state'),
    onTurnEnd: () => () => {},
  };
  w.flags['shared.browser.panelCdp'] = true;
  const tool = createBrowserTools({ tabs, grants: {}, enabled: () => inAppBrowserEnabled((k: string) => !!w.flags[k]) }).find(
    (t: any) => t.name === 'browser_tabs_context',
  );
  w.r.tools.delete('browser_tabs_context');
  w.r.register(tool);
  return ran;
}

/* ---------- an ACP (basic tier) session's sage-mcp: SessionMcp over a real ToolSocket, no hide ---------- */

const sockets: { close(): void }[] = [];
after(() => sockets.forEach((s) => s.close()));

async function acpSession(w: World, chatId = 'acp-chat') {
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: w.r, verifyPeer: async () => null });
  sockets.push(socket);
  const acp = new SessionMcp({ sessions, socket, command: '/bin/sage-mcp' });
  const { mcpServers } = await acp.prepare(`acp:${chatId}`, { harnessPid: 1, chatId, segmentId: 'acp-seg' });
  const env = Object.fromEntries(mcpServers[0].env.map((e: { name: string; value: string }) => [e.name, e.value]));
  const c = await sageMcpClient(env.SAGE_MCP_SOCKET, env.SAGE_MCP_TOKEN);
  const tools = async () => ((await c.request('tools/list')).result.tools.map((t: any) => t.name) as string[]).sort();
  return {
    tools: await tools(),
    list: tools,
    call: async (name: string) => (await c.request('tools/call', { name, arguments: {} })).result,
  };
}

/* ---------- one session of each kind, and what serves each surface for it ---------- */

type Surfaces = { chrome: boolean; computer: boolean };
type Harness = { label: string; kind: 'claude' | 'codex' | 'acp'; nativeChrome?: boolean; surfaces?: Surfaces };

const HARNESSES: Harness[] = [
  { label: 'Claude', kind: 'claude', nativeChrome: false },
  { label: 'Claude with Claude in Chrome', kind: 'claude', nativeChrome: true },
  { label: 'Codex managed', kind: 'codex', surfaces: { chrome: false, computer: false } },
  { label: 'Codex native Chrome only', kind: 'codex', surfaces: { chrome: true, computer: false } },
  { label: 'Codex native computer only', kind: 'codex', surfaces: { chrome: false, computer: true } },
  { label: 'Codex fully native', kind: 'codex', surfaces: { chrome: true, computer: true } },
  { label: 'ACP sage-mcp', kind: 'acp' },
];

/** The registry tools the session is given, and which surfaces its harness's own (vendor) controller serves. */
async function offered(w: World, h: Harness): Promise<{ tools: string[]; vendor: Surfaces }> {
  if (h.kind === 'claude')
    return {
      tools: claudeSession(w, { chatId: 'c', segmentId: 's' }, { nativeChrome: !!h.nativeChrome }).tools,
      vendor: { chrome: !!h.nativeChrome, computer: false },
    };
  if (h.kind === 'codex') {
    const cx = codexConnection(w, (id) => id, { ...h.surfaces! });
    const { thread } = await cx.startThread();
    return { tools: (await cx.session(thread.id)).tools, vendor: { ...h.surfaces! } };
  }
  return { tools: (await acpSession(w)).tools, vendor: { chrome: false, computer: false } };
}

const has = (tools: string[], prefix: string) => tools.some((t) => t.startsWith(prefix));

/** The controllers each surface has in this session. */
function controllers(tools: string[], vendor: Surfaces, yourChrome: boolean) {
  return {
    // the in-app browser: browser_*, or sage_browser_* while they drive the pane (the built-in channel)
    iab: [has(tools, 'browser_'), !yourChrome && has(tools, 'sage_browser_')].filter(Boolean).length,
    cu: [has(tools, 'desktop_'), has(tools, 'computer_'), vendor.computer].filter(Boolean).length,
    // the user's Chrome: sage_browser_* on Your Chrome, or the harness's own (Claude in Chrome, Codex's Browser plugin)
    bu: [yourChrome && has(tools, 'sage_browser_'), vendor.chrome].filter(Boolean).length,
  };
}

const bools = [false, true];
const flagCombos = bools.flatMap((browserParity) =>
  bools.flatMap((computer) => bools.map((computerParity) => ({ browserParity, computer, computerParity }))),
);

function setFlags(w: World, f: { browserParity: boolean; computer: boolean; computerParity: boolean }) {
  w.flags[FLAG.browserParity] = f.browserParity;
  w.flags[FLAG.computer] = f.computer;
  w.flags[FLAG.computerParity] = f.computerParity;
}

/* ====================================================================== */
/* Claude Code sessions as electron/harness/claude/index.cjs starts them                 */
/* ====================================================================== */

// a fake Electron (userData in a temp folder) and a fake Agent SDK whose query() records its options
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-x-'));
fs.writeFileSync(
  path.join(tmp, 'electron.cjs'),
  `module.exports = { app: { getPath: () => ${JSON.stringify(tmp)} }, safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => String(b).slice(4) } };`,
);
fs.writeFileSync(
  path.join(tmp, 'sdk.mjs'),
  [
    'export const query = (args) => globalThis.__matrixExposureQuery(args);',
    'export const tool = (name, description, schema, handler, extra) => ({ name, description, handler, extra });',
    "export const createSdkMcpServer = (o) => ({ type: 'sdk', ...o });",
  ].join('\n'),
);
const fakes: Record<string, string> = { electron: 'electron.cjs', '@anthropic-ai/claude-agent-sdk': 'sdk.mjs' };
registerHooks({
  resolve(specifier, context, next) {
    if (fakes[specifier]) return { url: pathToFileURL(path.join(tmp, fakes[specifier])).href, shortCircuit: true };
    return next(specifier, context);
  },
});

/** One CLI process: answers each prompt with a result, ends when closed. */
const queries: any[] = [];
(globalThis as any).__matrixExposureQuery = ({ prompt, options }: { prompt: AsyncIterable<any>; options: any }) => {
  const out: any[] = [];
  let wake = () => {};
  const q: any = {
    options,
    closed: false,
    close() {
      q.closed = true;
      wake();
    },
    async interrupt() {},
    async setPermissionMode() {},
    async getSettings() {
      return { applied: {} };
    },
    async applyFlagSettings() {},
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (out.length) yield out.shift();
        else if (q.closed) return;
        else await new Promise<void>((r) => (wake = r));
      }
    },
  };
  (async () => {
    for await (const m of prompt) {
      out.push({ type: 'result', subtype: 'success', echo: m.message.content });
      wake();
    }
  })();
  queries.push(q);
  return q;
};

const claudeMod = require('../../../electron/harness/claude/index.cjs').createClaudeHarness();
const handlers = new Map<string, (...a: any[]) => any>();
claudeMod.register({ handle: (name: string, fn: any) => handlers.set(name, fn) }, () => {});
const ipc = (name: string, ...args: any[]) => handlers.get(name)!({}, ...args);

async function until(what: string, ok: () => boolean) {
  await waitFor(ok, what).catch(() => undefined);
  assert.ok(ok(), `timed out waiting for ${what}`);
}

let serial = 0;
/** Sends a prompt on a chat's key; returns the CLI process that took it (a new one, or the live one). */
async function send(key: string, extra: any = {}) {
  const before = queries.length;
  const sid = key.slice('claude:'.length);
  await claudeMod.send(
    key,
    { bin: process.execPath, sessionId: sid, resume: true, cwd: tmp, account: 'default', chatId: `chat-${sid}`, ...extra },
    { role: 'user', content: 'hi' },
  );
  if (queries.length > before) return { q: queries[before], fresh: true };
  return { q: null, fresh: false };
}
const newKey = () => `claude:x-${++serial}`;

/** The registry tools a CLI process was started with, by Registry name. */
const presented = (q: any, w: World) =>
  Object.entries(q.options.mcpServers ?? {})
    .flatMap(([server, s]: [string, any]) => s.tools.map((t: any) => registryNameOf(server, t.name, w.r)))
    .sort();
const chromeArg = (q: any) => (q.options.extraArgs && 'chrome' in q.options.extraArgs ? '--chrome' : '--no-chrome');

/** The CLI login the account list reports for the default account. */
async function withLogin<T>(authMethod: string | null, fn: () => Promise<T>) {
  const accounts = claudeMod.identity.accounts();
  const view = accounts.view.bind(accounts);
  accounts.view = () => ({ ...view(), accounts: [{ id: 'default', authMethod }] });
  try {
    return await fn();
  } finally {
    accounts.view = view;
  }
}

const claudeFacts = (ready: boolean) => ({
  platform: 'darwin',
  codex: {
    runtime: { present: false, source: null, app: null },
    sky: { present: false, path: null, version: null, bundled: null, source: null, canonical: null },
    chrome: { host: false, extension: false, ready: false },
  },
  claude: { chrome: { host: ready, extension: ready, ready } },
});

/** main's claude.setTools wiring (app/agentTools.cjs) over this world and a NativeAvailability probe. */
function wireClaude(w: World, o: { ready?: boolean } = {}) {
  const probe = { facts: claudeFacts(o.ready ?? true) };
  const na = new NativeAvailability({
    probe: () => probe.facts,
    live: () => ({
      codexNative: false,
      claudeFlag: !!w.flags['native.claude.chrome'],
      claudeEligible: () => false,
      // MoPilot's own surfaces as the capability health record has them
      health: healthOf({ yourChrome: w.state.yourChrome, computer: w.state.computerUnavailable ? 'missing' : 'ready' }),
    }),
    install: async () => {},
  });
  const sessions = new ToolSessions();
  w.flags['native.claude.chrome'] = true;
  w.flags['channel.claude.sdkMcp'] = true;
  claudeMod.setTools({
    registry: w.r,
    sessions,
    enabled: () => !!w.flags['channel.claude.sdkMcp'],
    nativeChrome: () => !!w.flags['native.claude.chrome'] && na.claudeChromeReady(),
    hideTool: w.vis.forHost({ nativeChrome: true }),
  });
  return { na, probe, sessions };
}

const closeAll = async (keys: string[]) => {
  for (const k of keys) await ipc('claude:control', k, 'close');
};

/* ====================================================================== */
/* CM-X03: the tool channels' own switches                                 */
/* ====================================================================== */

/** A CodexToolInjection as agentTools.cjs builds it, over this world. */
function injection(w: World, o: { hasTools?: boolean; surfaces?: () => Surfaces; degradedNote?: any } = {}) {
  const sessions = new ToolSessions();
  const surfaces = o.surfaces ?? (() => ({ chrome: false, computer: false }));
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => o.hasTools ?? true,
    nativeEnabled: () => true,
    nativeSurfaces: surfaces,
    nativeHideFor: (s: Surfaces) => w.vis.forHost({ nativeChrome: s.chrome, nativeComputer: s.computer }),
    degradedNote: o.degradedNote,
    visibleTools: () => w.r.list().map((t: any) => t.name),
  });
  let id = 0;
  /** Sends a request through the injection and answers it as the app-server would; returns what went out. */
  const load = (method: string, threadId: string, extra: { helper?: boolean } = {}) => {
    const msg = { id: ++id, method, params: method === 'thread/start' ? { cwd: '/repo' } : { threadId } };
    const out = inj.outgoing(msg, extra);
    inj.observe({ id, result: { thread: { id: threadId } } });
    return { msg, out };
  };
  return { inj, sessions, load };
}
const sageServers = (out: any) =>
  Object.entries(out.params?.config?.mcp_servers ?? {}).filter(([, s]: [string, any]) => s?.env?.SAGE_MCP_TOKEN);
const pluginOf = (out: any) => out.params?.config?.plugins?.[NATIVE_CUA_PLUGIN]?.enabled;

/* ====================================================================== */
/* CM-X04: availability changes while a session runs                       */
/* ====================================================================== */

const codexFacts = (o: { runtime?: boolean; sky?: boolean; chrome?: boolean }) => ({
  platform: 'darwin',
  codex: {
    runtime: { present: o.runtime ?? true, source: 'chatgpt-app', app: '/Applications/ChatGPT.app' },
    sky: {
      present: o.sky ?? true,
      path: '/Applications/Codex Computer Use.app',
      version: '1.0',
      bundled: null,
      source: null,
      canonical: null,
    },
    chrome: { host: true, extension: o.chrome ?? true, ready: o.chrome ?? true },
  },
  claude: { chrome: { host: false, extension: false, ready: false } },
});

/** NativeAvailability over a probe the test changes, as Codex's surfaces for the kit's connection. */
function codexAvailability(w: World, initial: Parameters<typeof codexFacts>[0]) {
  const probe = { facts: codexFacts(initial) };
  const na = new NativeAvailability({
    probe: () => probe.facts,
    live: () => ({
      codexNative: true,
      claudeFlag: false,
      claudeEligible: () => false,
      // MoPilot's own surfaces as the capability health record has them
      health: healthOf({ yourChrome: w.state.yourChrome, computer: w.state.computerUnavailable ? 'missing' : 'ready' }),
    }),
    install: async () => {},
  });
  // read at each thread load (the getters ask the probe's cached answer then)
  const surfaces = {
    get chrome() {
      return na.codexSurfaces().chrome;
    },
    get computer() {
      return na.codexSurfaces().computer;
    },
  };
  return { na, probe, surfaces };
}

const textOf = (r: any) => r.content.map((c: any) => c.text).join('\n');

export {
  describe,
  test,
  assert,
  BU,
  CU,
  IAB,
  codexConnection,
  world,
  has,
  controllers,
  claudeMod,
  send,
  newKey,
  presented,
  chromeArg,
  withLogin,
  claudeFacts,
  wireClaude,
  closeAll,
  codexFacts,
  codexAvailability,
  ToolSessions,
  ToolSocket,
  SessionMcp,
  sockets,
  injection,
  sageServers,
  pluginOf,
  ipc,
  until,
  IN_APP_BROWSER_CONTEXT,
  registration,
  acpSession,
  bools,
  flagCombos,
  setFlags,
  claudeSession,
  FLAG,
  realTabsContext,
  HARNESSES,
  offered,
  textOf,
};
export type { World, Surfaces };
