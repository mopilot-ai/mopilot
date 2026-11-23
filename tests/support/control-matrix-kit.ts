// The control matrix kit (docs/control-plane/matrix.md): one world of in-app browser (IAB), computer use (CU) and
// browser use (BU) tools, and the channels Claude Code sessions, Codex threads and a chat that switches harness
// reach them through. The routing modules are real; the harnesses and the tools' work are fakes.
import { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../../electron/capabilities/contract/registry.cjs');
const { ToolVisibility, CLAUDE_IN_CHROME_HOST, hideRule } = require('../../electron/capabilities/visibility.cjs');
const { ToolSessions } = require('../../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../../electron/capabilities/mcp/socket.cjs');
const { ToolHttp } = require('../../electron/capabilities/httpMcp.cjs');
const { SessionMcp } = require('../../electron/capabilities/channels/sessionMcp.cjs');
const { sdkMcpServers } = require('../../electron/capabilities/mcp/sdkMcp.cjs');
const { CodexToolInjection } = require('../../electron/capabilities/channels/codexConfig.cjs');
const { SwitchRunner } = require('../../electron/session/switch.cjs');
const { ChatsStore, toRendererSegment, nativeIdsOf } = require('../../electron/platform/chats.cjs');
const { segmentAliases } = require('../../shared/segmentAlias.mjs');

/* ---------- the shared world: one tool per surface, recording who called it ---------- */

export const IAB = 'browser_navigate';
export const CU = 'desktop_click';
export const BU = 'sage_browser_navigate';

export type Call = { tool: string; chatId: string; segmentId: string };

/**
 * A Registry with the in-app browser, desktop and Your Chrome tools (plus the probes the visibility rule
 * looks for), the app's switches on, and the browser channel the user picked (`state.yourChrome`).
 * `hold` makes a tool wait until released, to look at what is running when the user presses Stop.
 */
export function world() {
  const r = new Registry();
  const calls: Call[] = [];
  const approvals: string[] = [];
  r.setApprover(({ chatId, tool }: { chatId: string; tool: string }) => (approvals.push(`${chatId} ${tool}`), true));
  const held = new Map<string, () => void>();
  for (const name of [IAB, 'browser_tabs_context', CU, 'desktop_screenshot', BU, 'computer_click', 'computer_screenshot']) {
    r.register({
      name,
      policy: name.includes('click') ? 'act' : 'observe',
      handler: async (_args: any, ctx: { chatId: string; segmentId: string; signal: AbortSignal }) => {
        calls.push({ tool: name, chatId: ctx.chatId, segmentId: ctx.segmentId });
        if (held.has(name))
          await new Promise<void>((resolve, reject) => {
            held.set(name, resolve);
            ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
          });
        return `ran ${name}`;
      },
    });
  }
  const flags: Record<string, boolean> = {
    'shared.browser.parityTools': true,
    'shared.computerUse.enabled': true,
    'shared.computerUse.parityTools': true,
  };
  // computerUnavailable: why MoPilot's computer use can't work here (the health record's reason), else null
  const state = { yourChrome: false, computerUnavailable: null as string | null };
  const vis = new ToolVisibility({
    registry: r,
    isEnabled: (k: string) => !!flags[k],
    drivesUserChrome: () => state.yourChrome,
    computerUnavailable: () => state.computerUnavailable,
  });
  r.setHidden(
    (n: string) => vis.hides(n),
    (n: string) => vis.message(n),
  );
  return {
    r,
    vis,
    flags,
    state,
    calls,
    approvals,
    hold: (name: string) => held.set(name, () => {}),
    release: (name: string) => held.get(name)?.(),
  };
}
export type World = ReturnType<typeof world>;

/* ---------- the capability health record (electron/capabilities/capabilityHealth.cjs) ---------- */

export type ComputerCase = 'ready' | 'off' | 'missing' | 'packaged-missing' | 'windows' | 'error' | 'permission' | 'unknown';

/**
 * A health snapshot as main builds it, from plain facts through the real record functions: computer use on
 * MoPilot's helper (`computer`), Your Chrome chosen and working (`yourChrome`: true, false, or
 * 'unloaded' when chosen but its tools didn't load, 'noExtension' when the Playwright Extension is missing),
 * and each harness family's tool channel (all on unless given).
 */
export function healthOf(
  o: {
    computer?: ComputerCase;
    yourChrome?: boolean | 'unloaded' | 'noExtension';
    channels?: Partial<Record<'claude' | 'codex' | 'acp', boolean>>;
  } = {},
) {
  const { computerHealth, yourChromeHealth } = require('../../electron/capabilities/capabilityHealth.cjs');
  const c = o.computer ?? 'ready';
  const helper = {
    path: '/Applications/MoPilot.app/Contents/Helpers/MoPilot.app',
    installed: c !== 'missing' && c !== 'packaged-missing' && c !== 'windows',
    packaged: c === 'packaged-missing',
    platform: c === 'windows' ? 'win32' : 'darwin',
    running: c === 'ready' || c === 'permission',
    version: c === 'ready' ? '1.0' : null,
    error: c === 'error' ? 'open failed (1)' : null,
  };
  const permissions =
    c === 'unknown' || c === 'error' ? null : { accessibility: true, screenRecording: c !== 'permission', inputMonitoring: false };
  const yc = o.yourChrome ?? false;
  return {
    computer: computerHealth({ enabled: c !== 'off', helper, permissions }),
    yourChrome: yourChromeHealth({
      chosen: yc !== false,
      active: yc !== false && yc !== 'unloaded',
      extension: yc === true ? '0.0.83' : null,
      extensionUrl: 'https://chromewebstore.google.com/detail/playwright-extension/x',
    }),
    channels: { claude: true, codex: true, acp: true, ...o.channels },
  };
}

/* ---------- Claude Code's channel: the SDK servers one CLI process gets ---------- */

export const fakeSdk = {
  tool: (name: string, _d: string, _s: any, handler: Function) => ({ name, handler }),
  createSdkMcpServer: ({ name, tools }: any) => ({ name, tools }),
};
export const z = { fromJSONSchema: (s: any) => s };

/**
 * The tools a Claude Code session presents (by Registry name) and a way to call them, built the way
 * harness/claude/sessions.cjs builds them: owner = the chat the controller sends for, segment = the session's key ('claude:<id>');
 * with Claude in Chrome on (`nativeChrome`), the host's hide rule for that session.
 */
export function claudeSession(w: World, owner: { chatId: string; segmentId: string }, { nativeChrome = false } = {}) {
  // main's hideTool (app/agentTools.cjs), as harness/claude/sessions.cjs gives it to the session
  const hideTool = w.vis.forHost(CLAUDE_IN_CHROME_HOST);
  const hide = nativeChrome ? hideRule(hideTool, hideTool.message) : null;
  const servers = sdkMcpServers({ sdk: fakeSdk, z, registry: w.r, serverName: 'sage_aaaaaaaaaaaa', owner, hide });
  const byRegistryName = new Map<string, Function>();
  // the host servers present short names; map them back by asking each handler which Registry tool it runs
  for (const s of servers.values()) for (const t of s.tools) byRegistryName.set(registryNameOf(s.name, t.name, w.r), t.handler);
  let calls = 0;
  return {
    tools: [...byRegistryName.keys()].sort(),
    call: async (name: string, args: any = {}) => {
      const h = byRegistryName.get(name);
      assert.ok(h, `${name} is presented to this Claude session`);
      // the SDK's per-call cancel: the CLI aborts it when it interrupts the turn (claudeInterrupt)
      const ac = new AbortController();
      const running = claudeCalls.get(owner.segmentId) ?? new Set<AbortController>();
      claudeCalls.set(owner.segmentId, running.add(ac));
      try {
        // a new tool-use id per call, as the CLI gives: the Registry answers a repeated id from its cache
        return await h(args, { _meta: { 'claudecode/toolUseId': `toolu_${name}_${++calls}` }, signal: ac.signal });
      } finally {
        running.delete(ac);
      }
    },
  };
}
/** Claude sessions' calls still running, by session id (one CLI process). */
const claudeCalls = new Map<string, Set<AbortController>>();
/** The CLI interrupting its turn: the SDK aborts each running call's signal, as the MCP cancel does. */
export function claudeInterrupt(sessionId: string) {
  for (const ac of claudeCalls.get(sessionId) ?? []) ac.abort();
}
/** mopilot_browser/navigate → browser_navigate, mopilot_computer/left_click → desktop_click, sage_x/tool → tool. */
export function registryNameOf(server: string, short: string, registry?: { list(o?: { all?: boolean }): { name: string }[] }) {
  const { HOST_SERVER_NAMES } = require('../../electron/capabilities/mcp/sdkMcp.cjs');
  if (!Object.values(HOST_SERVER_NAMES).includes(server)) return short;
  const { placement } = require('../../electron/capabilities/contract/hostServers.cjs');
  for (const { name } of registry?.list({ all: true }) ?? []) {
    const p = placement(name, 'sage_aaaaaaaaaaaa');
    if (p.server === server && p.name === short) return name;
  }
  throw new Error(`no Registry tool is presented as ${server}/${short}`);
}

/* ---------- Codex's channel: sage-mcp sessions the thread injection opens ---------- */

const cleanup: (() => void)[] = [];
after(() => cleanup.forEach((f) => f()));

/** Talks to a ToolSocket as sage-mcp does for a Codex thread. */
export async function sageMcpClient(socketPath: string, token: string) {
  const sock = net.createConnection(socketPath);
  cleanup.push(() => sock.destroy());
  sock.setEncoding('utf8');
  const waiting = new Map<number, (m: any) => void>();
  let buf = '';
  sock.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      waiting.get(m.id)?.(m);
    }
  });
  let next = 1;
  const request = (method: string, params: any = {}) =>
    new Promise<any>((resolve) => {
      const id = next++;
      waiting.set(id, resolve);
      sock.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  assert.ok((await request('hello', { token, pid: process.pid })).result, 'sage-mcp hello accepted');
  return { request };
}

/**
 * An ACP session's tools as main gives them in session/new (channels/sessionMcp.cjs): sage-mcp over the tool socket,
 * or main's http endpoint (`http`) for a harness that takes no stdio MCP server (Copilot CLI). `list` reads tools/list,
 * `call` runs one tool as the harness would; the session is charged to `chatId` on segment `acp-seg`.
 */
export async function acpSession(w: World, { chatId = 'acp-chat', http = false, segmentId = 'acp-seg' } = {}) {
  const sessions = new ToolSessions();
  const socket = new ToolSocket({ sessions, registry: w.r, verifyPeer: async () => null });
  const web = new ToolHttp({ sessions, registry: w.r, verifyPeer: async () => null });
  cleanup.push(
    () => socket.close(),
    () => web.close(),
  );
  const channel = new SessionMcp({ sessions, socket, http: web, command: '/bin/sage-mcp' });
  const key = segmentId === 'acp-seg' ? `acp:${chatId}` : `acp:${chatId}:${segmentId}`;
  const { mcpServers } = await channel.prepare(key, { harnessPid: 1, chatId, segmentId, http });
  const entry = mcpServers[0];
  let request: (method: string, params?: any) => Promise<any>;
  if (entry.type === 'http') {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    for (const h of entry.headers) headers[h.name] = h.value;
    let next = 1;
    request = async (method, params = {}) => {
      const res = await fetch(entry.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }) });
      const session = res.headers.get('mcp-session-id');
      if (session) headers['Mcp-Session-Id'] = session;
      return res.json();
    };
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'acp-test', version: '1' } });
  } else {
    const env = Object.fromEntries(entry.env.map((e: { name: string; value: string }) => [e.name, e.value]));
    request = (await sageMcpClient(env.SAGE_MCP_SOCKET, env.SAGE_MCP_TOKEN)).request;
  }
  const list = async () => ((await request('tools/list')).result.tools.map((t: any) => t.name) as string[]).sort();
  return { list, call: async (name: string, args: any = {}) => (await request('tools/call', { name, arguments: args })).result };
}

/**
 * A Codex app-server connection as main runs it: every request passes CodexToolInjection.outgoing and
 * every response its observe, in that order (harness/codexConnection.cjs). `surfaces` is what the
 * vendor plugin can serve on this Mac (native.codex.enabled and NativeAvailability.codexSurfaces()).
 */
export function codexConnection(w: World, chatOf: (id: string) => string, surfaces = { chrome: false, computer: false }) {
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    hasTools: () => true,
    chatOf,
    nativeEnabled: () => surfaces.chrome || surfaces.computer,
    nativeSurfaces: () => surfaces,
    nativeHideFor: (s: { chrome: boolean; computer: boolean }) => w.vis.forHost({ nativeChrome: s.chrome, nativeComputer: s.computer }),
    // the Codex this kit stands in for (codex-cli 0.166) defers MCP tools itself, so its threads list every tool (G2 tiers)
    defersMcpTools: () => true,
  });
  const socket = new ToolSocket({ sessions, registry: w.r, verifyPeer: async () => null });
  cleanup.push(() => socket.close?.());
  let listening: Promise<string> | null = null;
  const socketPath = () => (listening ??= socket.listen());
  let id = 0;
  let nextThread = 0;
  const tokens = new Map<string, string>();
  const send = (method: string, params: any, threadId: string, onAnswer?: (id: string) => void) => {
    const msg = inj.outgoing({ id: ++id, method, params });
    const server = Object.values((msg.params?.config?.mcp_servers ?? {}) as Record<string, any>).find((s) => s?.env?.SAGE_MCP_TOKEN);
    // Codex 0.164 spawns the thread from this request's config even when it is still loaded (#2500): no sage-mcp in
    // it, no sage-mcp for the thread
    if (server) tokens.set(threadId, server.env.SAGE_MCP_TOKEN);
    else tokens.delete(threadId);
    // the answer's hook runs before the tool channel sees the answer (codexConnection.cjs onServer)
    onAnswer?.(threadId);
    inj.observe({ id, result: { thread: { id: threadId } } });
  };
  return {
    sessions,
    inj,
    /** codex.startThread: a new thread, its id chosen by the app-server */
    startThread: async (_params?: any, opts?: { onThread?: (id: string) => void }) => {
      const threadId = `cx-${++nextThread}`;
      send('thread/start', {}, threadId, opts?.onThread);
      return { thread: { id: threadId } };
    },
    resume: (threadId: string) => send('thread/resume', { threadId }, threadId),
    /** Codex unloads an idle thread (codexLeases lets go after 5 s) */
    unload: (threadId: string) => inj.observe({ method: 'thread/closed', params: { threadId } }),
    /** What sage-mcp sees for the thread over the real ToolSocket: its tool list, its owner, and a call */
    session: async (threadId: string) => {
      const token = tokens.get(threadId);
      const s = sessions.resolve(token);
      assert.ok(s, `thread ${threadId} has a live sage-mcp session`);
      const c = await sageMcpClient(await socketPath(), token!);
      const listed = (await c.request('tools/list')).result.tools.map((t: any) => t.name).sort();
      return {
        owner: { chatId: s.chatId, segmentId: s.segmentId },
        tools: listed as string[],
        /** `meta`: the call's `_meta`, as Codex sends it (its turn metadata names the thread the call came from) */
        call: async (name: string, args: any = {}, meta?: any) =>
          (await c.request('tools/call', { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) })).result,
      };
    },
  };
}

/* ---------- a chat that switches harness: the controller's chat lookup over the real chat store ---------- */

/**
 * A chat store, the SwitchRunner and controller.chatOf as main has them: chatOf maps a native session
 * (Codex thread id, or claude:<session id>) to the chat whose segments name it, else the key itself.
 */
export function switchingChat(
  w: World,
  o: {
    surfaces?: { chrome: boolean; computer: boolean };
    segmentEnded?: (e: { chatId: string; from: any; to: any }) => void;
    /** the targets the chat holds (TargetLeases.held), which the handoff record lists */
    held?: (chatId: string) => any[];
  } = {},
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-matrix-'));
  const chats = new ChatsStore(path.join(dir, 'threads'));
  /** native sessions a switch is starting, claimed for their chat before the segment is committed (controller.claim) */
  const claims = new Map<string, string>();
  // main's alias rule (shared/segmentAlias.mjs): a switch's later segment answers over a record keyed by its id
  const chatOf = (key: string) => segmentAliases(nativeIdsOf(chats.records)).get(key) ?? claims.get(key) ?? key;
  const codex = codexConnection(w, chatOf, o.surfaces);
  const claudeKeys: string[] = [];
  const runner = new SwitchRunner({
    chats,
    ref: (id: string) => {
      const seg = chats.record(id).segments.at(-1);
      return { kind: seg.kind, id: seg.nativeId, instance: null, key: toRendererSegment(seg).nativeId };
    },
    invalidate: () => {},
    claim: (key: string, chatId: string) => claims.set(key, chatId),
    unclaim: (key: string, chatId: string) => claims.get(key) === chatId && claims.delete(key),
    changed: () => {},
    prefs: () => ({ permission: 'default', serviceTier: null, claudeBin: null }),
    home: '/home/me',
    emit: () => {},
    git: { info: async () => ({ branch: 'main' }), status: async () => ({ files: [] }) },
    codex: {
      startThread: codex.startThread,
      ensureResumed: async () => {},
      threadTurns: async () => ({ data: [], nextCursor: null }),
      summarize: async () => 'note',
      cwdOf: () => '/repo',
    },
    claude: {
      registerSession: (key: string) => claudeKeys.push(key),
      isFresh: () => false,
      cwdOf: () => '/repo',
      accountOf: () => 'default',
      messages: async () => [],
      summarize: async () => 'note',
    },
    permissionParams: () => ({}),
    // main's segment-end wiring (electron/app/sessions.cjs), when a test gives it
    segmentEnded: o.segmentEnded,
    held: o.held,
  });
  /** Starts the chat on Claude Code (its own session id), as a chat created from the Claude picker is. */
  const startOnClaude = (chatId: string, sessionId = `s0-${chatId}`) => {
    const first = chats.record(chatId).segments[0];
    chats.commit({ ...chats.record(chatId), segments: [{ ...first, kind: 'claude', nativeId: sessionId, count: 0 }] });
  };
  const switchTo = async (chatId: string, harness: 'claude' | 'codex') => {
    const r = await runner.perform(chatId, { harness, model: 'm', modelLabel: 'M', mode: 'workspace' });
    assert.equal(r.ready, true, `switched ${chatId} to ${harness}`);
    return chats.record(chatId).segments.at(-1);
  };
  /** The Claude session the chat's current segment runs: owner as controller.claudeSend gives it. */
  const claudeNow = (chatId: string, nativeChrome = false) => {
    const seg = chats.record(chatId).segments.at(-1);
    assert.equal(seg.kind, 'claude');
    return claudeSession(w, { chatId: chatOf(`claude:${seg.nativeId}`), segmentId: seg.nativeId }, { nativeChrome });
  };
  return { chats, chatOf, codex, runner, claudeKeys, startOnClaude, switchTo, claudeNow };
}

export const owners = (calls: Call[]) => calls.map((c) => `${c.tool}@${c.chatId}`);

/* ---------- a Codex app-server stand-in for the adapter (electron/harness/codex.cjs) ---------- */

/**
 * The app-server process as the Codex adapter sees it: requests are answered by `handlers` on the next
 * tick (a throw answers with an error), except the methods in `hold`, which wait for `release`. `notify`
 * and `ask` send a notification or a server request to the adapter.
 */
export function fakeAppServer(handlers: Record<string, (p: any) => any>, hold = new Set<string>()) {
  const s = {
    listeners: new Set<(e: any) => void>(),
    sent: [] as any[],
    held: [] as any[],
    proc: {},
    start() {},
    send(m: any) {
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      if (hold.has(m.method)) return void s.held.push(m);
      setImmediate(() => s.reply(m));
    },
    reply(m: any) {
      try {
        const h = handlers[m.method];
        s.emit({ kind: 'message', msg: { id: m.id, result: h ? h(m.params) : {} } });
      } catch (e: any) {
        s.emit({ kind: 'message', msg: { id: m.id, error: { code: -32600, message: e.message } } });
      }
    },
    /** Answers the held requests of `method`, in order. */
    release(method: string) {
      const due = s.held.filter((m) => m.method === method);
      s.held = s.held.filter((m) => m.method !== method);
      for (const m of due) s.reply(m);
    },
    emit(e: any) {
      for (const l of s.listeners) l(e);
    },
    notify(method: string, params: any) {
      s.emit({ kind: 'message', msg: { method, params } });
    },
    ask(id: string | number, method: string, params: any) {
      s.emit({ kind: 'message', msg: { id, method, params } });
    },
    /** the request methods the adapter sent */
    methods: () => s.sent.filter((m) => m.method).map((m) => m.method as string),
    /** the plugin calls the adapter made: [thread, tool, hook, session] */
    hooks: () =>
      s.sent
        .filter((m) => m.method === 'mcpServer/tool/call')
        .map((m) => [
          m.params.threadId,
          m.params.tool,
          m.params.arguments?.hook_event_name ?? null,
          m.params.arguments?.session_id ?? null,
        ]),
    /** the answers the adapter gave to server requests */
    answers: () => s.sent.filter((m) => m.id != null && !m.method),
  };
  return s;
}
