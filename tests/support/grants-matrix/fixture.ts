import { extensionWire } from '../extension-wire.ts';
// Shared fake browser, Chrome channel, desktop, and switching-chat fixtures for grants matrix unit cases.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { BU, fakeSdk, switchingChat, world, z } from '../control-matrix-kit.ts';
import { NOTES, fakeHelper, resolveEntry } from '../desktop-kit.ts';
import { fakeBin, fakes, flush, lastQuery, load } from '../electron-claude.ts';

const require = createRequire(import.meta.url);
const { ToolError } = require('../../../electron/capabilities/contract/registry.cjs');
const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');
const { OriginGrants } = require('../../../electron/capabilities/browser/origins.cjs');
const { createBrowserTools } = require('../../../electron/capabilities/browser/hostTools.cjs');
const { BrowserTabs } = require('../../../electron/capabilities/browser/host.cjs');
const { IabBackend } = require('../../../electron/capabilities/browser/iabBackend.cjs');
const { pluginSiteConsent } = require('../../../electron/capabilities/browser/pluginConsent.cjs');
const { chatAnchorOf } = require('../../../electron/capabilities/anchor.cjs');
const { ChromeChannel, chromeTools, spawnSpec } = require('../../../electron/capabilities/browser/extension.cjs');
const { GrantStore } = require('../../../electron/capabilities/grants.cjs');
const { ComputerUse } = require('../../../electron/capabilities/tools/computer.cjs');
const { DesktopControl } = require('../../../electron/capabilities/tools/desktop.cjs');
const { hostTurnEnd, codexTurnEndedChat } = require('../../../electron/capabilities/turnEnd.cjs');
const { sdkMcpServers } = require('../../../electron/capabilities/mcp/sdkMcp.cjs');
const { placement } = require('../../../electron/capabilities/contract/hostServers.cjs');
const { ChatController } = require('../../../electron/session/controller.cjs');

/** A MoPilot tool the Registry's approval hook guards (no card of its own). */
const ACT = 'matrix_act';
const SAGE = 'sage_aaaaaaaaaaaa';

/* ---------- the world: real browser, Your Chrome and computer-use tools over fakes ---------- */

/** The chat's tabs in the browser pane (BrowserTabs' API, keyed by chat), with its real per-tab queue. */
function fakeTabs() {
  let n = 0;
  const byChat = new Map<string, any[]>();
  const events: string[] = [];
  const held: { click: Promise<void> | null } = { click: null };
  const list = (chatId: string) => byChat.get(chatId) ?? [];
  const tab = (chatId: string) => {
    const dbg = Object.assign(new EventEmitter(), { isAttached: () => true });
    const t: any = { id: `tab-${++n}`, chatId, url: 'about:blank', title: '', kind: 'tab', queue: Promise.resolve(), frames: new Map() };
    t.wc = t.backend = { isDestroyed: () => false, debugger: dbg };
    t.attach = async () => {};
    t.hold = () => {};
    t.rendererGone = () => false;
    t.agent = async () => ({ count: 0 });
    t.send = async (method: string) => (events.push(`plugin ${method}`), {});
    return t;
  };
  const tabs: any = {
    byChat,
    events,
    held,
    o: {},
    list,
    current: (chatId: string) => list(chatId)[0] ?? null,
    create: async (chatId: string) => {
      const t = tab(chatId);
      byChat.set(chatId, [...list(chatId), t]);
      return t;
    },
    resolve: async (chatId: string, id: string | null) => {
      if (!id) return list(chatId)[0] ?? tabs.create(chatId);
      const t = list(chatId).find((x) => x.id === id);
      if (!t) throw new ToolError(`No tab ${id} in this chat.`, 'bad_args');
      return t;
    },
    // the real per-tab queue: actions on one tab never interleave
    run: BrowserTabs.prototype.run,
    // the plugin's actions count for the turn's result tab
    acted: () => {},
    awaitUser: async (_tab: any, p: Promise<any>) => p,
    ready: async () => ({ w: 800, h: 600 }),
    navigate: async (t: any, url: string) => {
      t.url = url;
      return { url, title: '' };
    },
    historyTarget: () => null,
    point: async (_t: any, _st: any, target: any) => ({ x: target.coordinate?.[0] ?? 0, y: target.coordinate?.[1] ?? 0 }),
    click: async (t: any) => {
      events.push(`browser_* click ${t.id} start`);
      if (held.click) await held.click;
      events.push(`browser_* click ${t.id} end`);
    },
    settle: async () => {},
    intent: async () => null,
    select: (chatId: string, id: string) => list(chatId).find((x) => x.id === id),
    state: (chatId: string) => `<browser_state chat="${chatId}"/>`,
  };
  return tabs;
}

/** Playwright MCP children answering as Your Chrome does: every page result names its URL. */
function fakeFork() {
  const children: any[] = [];
  const fork = () => {
    const child: any = new EventEmitter();
    let url = 'about:blank';
    const reply = (msg: any) => setImmediate(() => child.emit('message', { type: 'out', data: JSON.stringify(msg) + '\n' }));
    child.postMessage = (m: any) => {
      if (m.type === 'stop') return setImmediate(() => child.emit('exit', 0));
      if (m.type !== 'in') return;
      const msg = JSON.parse(m.data);
      if (msg.method === 'initialize') reply({ id: msg.id, result: {} });
      else if (msg.method === 'tools/call') {
        if (msg.params.name === 'browser_navigate') url = msg.params.arguments.url;
        reply({ id: msg.id, result: { content: [{ type: 'text', text: `Page URL: ${url}` }] } });
      }
    };
    child.kill = () => child.emit('exit', null);
    children.push(child);
    extensionWire(child);
    return child;
  };
  return { fork, children };
}

type Answer = { decision: string; scope?: string; level?: string; remember?: boolean; apps?: string[] } | null;

/**
 * One app: the kit's routing world with the real browser_*, Your Chrome, computer_* and desktop_* tools
 * registered in it, the site grants, the computer-use grant store over the chat store, the desktop lock,
 * and the host turn end main runs (electron/main.cjs hostTurnEnded + browserTools' grants.turnEnded).
 */
function matrix(o: { surfaces?: { chrome: boolean; computer: boolean }; computerParity?: boolean } = {}) {
  const w = world();
  // the kit's stand-ins give way to the real tools
  for (const n of [
    'browser_navigate',
    'browser_tabs_context',
    'desktop_click',
    'desktop_screenshot',
    BU,
    'computer_click',
    'computer_screenshot',
  ])
    w.r.tools.delete(n);
  if (o.computerParity === false) w.flags['shared.computerUse.parityTools'] = false;
  // the kit's channels call tools without arguments: the arguments of the next call of each tool are added here
  const argsFor = new Map<string, any>();
  const invoke = w.r.invoke.bind(w.r);
  w.r.invoke = (c: string, s: string, n: string, a: any, opt: any) => invoke(c, s, n, { ...(argsFor.get(n) ?? {}), ...(a ?? {}) }, opt);

  const sw = switchingChat(w, { surfaces: o.surfaces });
  /** the chat's live permission mode, as SessionState keeps it */
  const perms = new Map<string, string>();
  const ref = (chatId: string) => {
    const seg = sw.chats.record(chatId).segments.at(-1);
    return { kind: seg.kind, id: seg.nativeId };
  };
  const st: { siteAnswer: Answer; anchor: (ctx: any) => string } = {
    siteAnswer: { decision: 'allow', scope: 'chat', level: 'write' },
    // as main wires it (electron/app/browserTools.cjs): the chat's live mode, else the app default
    anchor: ({ chatId }: any) =>
      chatAnchorOf(chatId, {
        sessions: { get: (id: string) => ({ permission: perms.get(id) ?? null }) },
        controller: { ref },
        prefs: () => ({ permission: 'default' }),
      }),
  };
  const siteAsks: any[] = [];
  const siteAnswers: Answer[] = [];
  const confirms: any[] = [];
  const grants = new OriginGrants({
    anchor: (ctx: any) => st.anchor(ctx),
    ask: async (q: any) => (siteAsks.push(q), siteAnswers.length ? siteAnswers.shift() : st.siteAnswer),
    confirmAction: async (q: any) => (confirms.push(q), true),
  });
  const tabs = fakeTabs();
  for (const t of createBrowserTools({ tabs, grants })) w.r.register(t);

  const forks = fakeFork();
  const chrome = new ChromeChannel({ fork: forks.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
  const schemas = [
    { name: 'browser_navigate', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
    { name: 'browser_snapshot', inputSchema: { type: 'object', properties: {} } },
  ];
  for (const t of chromeTools({ channel: chrome, grants, schemas })) w.r.register(t);

  w.r.register({
    name: ACT,
    policy: 'act',
    handler: async (_a: any, ctx: any) => (w.calls.push({ tool: ACT, chatId: ctx.chatId, segmentId: ctx.segmentId }), 'acted'),
  });

  const helper = fakeHelper();
  helper.releaseControl = async () => ({ ok: true });
  helper.glowStart = async () => ({ ok: true });
  helper.glowStop = async () => ({ ok: true });
  helper.resolved.set('Notes', resolveEntry(NOTES));
  const cuAsks: any[] = [];
  const cuAnswers: Record<string, Answer> = {
    computerAccessSet: { decision: 'allow' },
    computerTakeover: { decision: 'allow' },
    computerConfirm: { decision: 'allow' },
    computerAccess: { decision: 'allow', scope: 'chat', level: 'click' },
  };
  const broker = { ask: async (chatId: string, kind: string, params: any) => (cuAsks.push({ chatId, kind, params }), cuAnswers[kind]) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-grants-'));
  const store = new GrantStore({ file: path.join(dir, 'computer.json'), chats: sw.chats });
  const cu = new ComputerUse({
    helper,
    grants: store,
    broker,
    // as computerUse.cjs wires it: the controller's chat lookup, read at call time
    chatOf: (id: string) => sw.chatOf(id),
    session: (chatId: string) => ({ permission: perms.get(chatId) ?? 'default' }),
    harness: (chatId: string) => ref(chatId).kind,
    settleMs: 0,
    waitMs: 0,
    pollMs: 1,
  });
  const desktop = new DesktopControl({ helper, cu, grants: store, broker, hostPids: async () => new Set([1]), settleMs: 0, verifyMs: 0 });
  for (const t of [...cu.tools(), ...desktop.tools()]) w.r.register(t);

  const turnEnded = hostTurnEnd([(chatId: string) => grants.turnEnded(chatId), (chatId: string) => desktop.turnEnded(chatId)]);

  /** A Claude Code session's call path (the SDK servers harness/claude/sessions.cjs injects), with arguments and a fresh tool-use id each call. */
  let toolUse = 0;
  const claude = (owner: { chatId: string; segmentId: string }, { nativeChrome = false } = {}) => {
    const hide = nativeChrome ? (n: string) => w.vis.forHost({ nativeChrome: true })(n) === true : null;
    const servers = sdkMcpServers({ sdk: fakeSdk, z, registry: w.r, serverName: SAGE, owner, hide });
    const find = (name: string) => {
      const p = placement(name, SAGE);
      return servers.get(p.server)?.tools.find((t: any) => t.name === p.name);
    };
    const call = async (name: string, args: any = {}) => {
      const t = find(name);
      assert.ok(t, `${name} is presented to this Claude session`);
      return t.handler(args, { _meta: { 'claudecode/toolUseId': `toolu_${++toolUse}` } });
    };
    return Object.assign(call, { owner, has: (name: string) => !!find(name) });
  };
  /** The Claude session the chat's current segment runs, owned as controller.claudeSend owns it. */
  const claudeNow = (chatId: string, o2: { nativeChrome?: boolean } = {}) => {
    const seg = sw.chats.record(chatId).segments.at(-1);
    assert.equal(seg.kind, 'claude');
    return claude({ chatId: sw.chatOf(`claude:${seg.nativeId}`), segmentId: seg.nativeId }, o2);
  };
  /** A Codex thread's call path: its sage-mcp session over the real ToolSocket. */
  const codex = async (threadId: string) => {
    const s = await sw.codex.session(threadId);
    const call = async (name: string, args: any = {}) => {
      argsFor.set(name, args);
      try {
        return await s.call(name);
      } finally {
        argsFor.delete(name);
      }
    };
    return Object.assign(call, { owner: s.owner, has: (name: string) => s.tools.includes(name) });
  };
  /** Gives the chat Notes on the desktop and a screenshot to aim at, through `call`. */
  const desktopReady = async (call: Caller) => {
    ok(await call('desktop_request_access', { apps: ['Notes'], reason: 'test' }));
    ok(await call('desktop_screenshot', {}));
  };
  return {
    w,
    sw,
    st,
    perms,
    ref,
    grants,
    siteAsks,
    siteAnswers,
    confirms,
    tabs,
    chrome,
    forks,
    helper,
    cu,
    desktop,
    store,
    cuAsks,
    cuAnswers,
    turnEnded,
    claude,
    claudeNow,
    codex,
    desktopReady,
    done: () => {
      chrome.stopAll();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
type Caller = (name: string, args?: any) => Promise<any>;
type Matrix = ReturnType<typeof matrix>;

const textOf = (r: any) =>
  (r?.content ?? [])
    .filter((c: any) => c.type === 'text')
    .map((c: any) => c.text)
    .join('\n');
const ok = (r: any) => (assert.ok(!r?.isError, `expected success, got: ${textOf(r)}`), r);
const refused = (r: any, re: RegExp) => {
  assert.equal(r?.isError, true, `expected a refusal, got: ${textOf(r)}`);
  assert.match(textOf(r), re);
};
const asksFor = (m: Matrix) => m.siteAsks.map((q) => `${q.chatId} ${q.origin}`);
const tabChats = (m: Matrix) => [...m.tabs.byChat.entries()].filter(([, l]) => l.length).map(([c, l]) => `${c}:${l.length}`);

/**
 * A chat started on Codex (its id is its first thread's), and one started on Claude (its own session id per chat).
 */
async function onCodex(m: Matrix) {
  const { thread } = await m.sw.codex.startThread();
  return thread.id as string;
}
function onClaude(m: Matrix, chatId = 'chat-1') {
  const rec = m.sw.chats.record(chatId);
  m.sw.chats.commit({ ...rec, segments: [{ ...rec.segments[0], kind: 'claude', nativeId: `s-${chatId}`, count: 0 }] });
  return chatId;
}

export {
  describe,
  test,
  assert,
  BU,
  flush,
  IabBackend,
  codexTurnEndedChat,
  matrix,
  ok,
  refused,
  tabChats,
  onCodex,
  onClaude,
  NOTES,
  pluginSiteConsent,
  chatAnchorOf,
  ACT,
  asksFor,
  fakeBin,
  fakes,
  lastQuery,
  load,
  ToolSessions,
  ChatController,
};
export type { Caller };
