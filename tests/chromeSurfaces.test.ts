// The user's Chrome over MoPilot's relay as each harness sees it (B2, design D5): Claude in Chrome-shaped chrome_* tools
// (chromeTools.cjs) on the mopilot_chrome server, the Codex Browser plugin's "extension" backend (chromeBackend.cjs) and its
// thread note, the visibility rule, and main's setup (app/chromeRelay.cjs). The relay and host are real; the extension and
// Chrome are fakes on loopback (tests/support/chrome-relay-kit.ts).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { pageChrome, playExtension, until } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const {
  createChromeTools,
  registerChromeTools,
  CHROME_TOOL_NAMES,
  NOT_OFFERED,
  PREFIX,
  TOOLS,
} = require('../electron/capabilities/browser/chromeTools.cjs');
const {
  ChromeBackend,
  chromeBackendNote,
  combineBackends,
  mainChromeBackends,
  NAME,
} = require('../electron/capabilities/browser/chromeBackend.cjs');
const { IabBackends, encodeFrame, FrameDecoder } = require('../electron/capabilities/browser/iabBackend.cjs');
const { isToolHidden, hiddenToolMessage, ToolVisibility } = require('../electron/capabilities/visibility.cjs');
const { CodexToolInjection, IN_APP_BROWSER_CONTEXT } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { setupChromeRelay } = require('../electron/app/chromeRelay.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const relays: any[] = [];
after(() => {
  for (const r of relays) r.stop();
});
const image = (w = 800, h = 600): any => ({
  isEmpty: () => false,
  toBitmap: () => Buffer.from([255, 255, 255, 255]),
  resize: (o: any) => image(o.width, o.height),
  toJPEG: () => Buffer.from('jpeg'),
  getSize: () => ({ width: w, height: h }),
});
const images = { fromBuffer: () => image() };
const grants = {
  anchor: () => 'full',
  peek: () => 'ok',
  require: async () => undefined,
  riskOf: () => ({ level: 'normal' }),
  act: async () => undefined,
};
const text = (out: any[]) => out.map((c) => c.text).join('\n');

function chromeWorld() {
  const x = playExtension();
  pageChrome(x);
  const r = new ChromeRelay({ openPage: x.openPage, connectMs: 2000, commandMs: 1000 });
  relays.push(r);
  const tabs = chromeBrowserTabs({ relay: r, images });
  const tools = new Map<string, any>(createChromeTools({ tabs, grants }).map((t: any) => [t.name.slice(PREFIX.length), t]));
  const ctx = { chatId: 'c', segmentId: 's' };
  const call = (name: string, args: any = {}) => tools.get(name).handler(args, ctx);
  return { x, r, tabs, tools, call, ctx };
}

/* ------------------------------------------------------------------ chrome_* tools */

test('chromeTools: Claude in Chrome’s names and argument shapes, with numeric tab ids and its own required lists', () => {
  const { tools } = chromeWorld();
  assert.deepEqual([...tools.keys()], Object.keys(TOOLS));
  assert.deepEqual(
    CHROME_TOOL_NAMES,
    Object.keys(TOOLS).map((n) => `chrome_${n}`),
  );
  const s = (n: string) => tools.get(n).schema;
  assert.equal(s('computer').properties.tabId.type, 'number');
  assert.deepEqual(s('computer').required, ['action', 'tabId']);
  assert.deepEqual(s('navigate').required, ['url']);
  assert.equal(s('tabs_close_mcp').properties.tabId.type, 'integer');
  assert.deepEqual(Object.keys(s('tabs_create_mcp').properties), []);
  assert.equal(s('javascript_tool').properties.action.type, 'string');
  assert.deepEqual(s('javascript_tool').required, ['text', 'tabId']); // its one action may be left out (#1699)
  assert.equal(s('tabs_context_mcp').properties.createIfEmpty.type, 'boolean');
  assert.equal(s('browser_batch').properties.actions.type, 'array');
  assert.equal(tools.get('computer').policy, 'act');
  assert.equal(tools.get('read_page').policy, 'observe');
  assert.equal(tools.get('browser_batch').policy, 'act');
  for (const t of tools.values()) {
    assert.equal(t.authorizesItself, true);
    assert.doesNotMatch(t.description, /built-in browser|browser_(?!batch)\w+/, `${t.name} speaks of the user's Chrome`);
  }
  // upload_image attaches a screenshot by its id (#1530): Claude in Chrome's required list, and the file input as ref
  assert.deepEqual(s('upload_image').required, ['imageId', 'tabId']);
  assert.deepEqual(Object.keys(s('upload_image').properties).sort(), ['coordinate', 'filename', 'imageId', 'ref', 'tabId']);
  assert.deepEqual(s('file_upload').required, ['ref', 'tabId']);
  assert.equal(s('file_upload').properties.screenshots.type, 'array');
  assert.equal(tools.get('upload_image').policy, 'act');
  for (const n of ['shortcuts_list', 'shortcuts_execute', 'switch_browser', 'list_connected_browsers', 'select_browser']) {
    assert.ok(NOT_OFFERED[n]);
    assert.equal(tools.has(n), false);
  }
});

test('chromeTools: tabs_context_mcp opens the group unless createIfEmpty is false; results use Chrome tab ids and these tools’ names', async () => {
  const { r, call, tabs } = chromeWorld();
  assert.match(text(await call('tabs_context_mcp', { createIfEmpty: false })), /without createIfEmpty: false/);
  assert.equal(r.connected('c'), false, 'nothing connects with createIfEmpty: false');
  const out = text(await call('tabs_context_mcp')); // the first call opens the group (#1699)
  const chromeId = tabs.current('c').wc.tabId;
  assert.match(out, new RegExp(`- ${chromeId} \\(current\\)`));
  assert.doesNotMatch(out, /tab_[0-9a-f]{6}/);
  const nav = text(await call('navigate', { url: 'https://example.com/', tabId: chromeId }));
  assert.match(nav, new RegExp(`^Navigated ${chromeId} to https://example.com/`));
  // an id that is not this chat's tab, and an id the text names that was never this chat's, stay as they are
  await assert.rejects(
    call('navigate', { url: 'https://example.com/', tabId: 99999 }),
    (e: any) => e.code === 'bad_args' && /tabs_context_mcp/.test(e.message),
  );
  const created = text(await call('tabs_create_mcp', { url: 'https://ignored.test/' }));
  assert.match(created, /^Created new tab with tabId: \d+\./);
  const second = tabs.current('c').wc.tabId;
  const closed = text(await call('tabs_close_mcp', { tabId: second }));
  assert.match(closed, new RegExp(`^Closed tab ${second}\\.`));
});

test('chromeTools: javascript_tool takes only its one action, or none; console and network keep what they read (clear is ignored)', async () => {
  const { call, tabs, x } = chromeWorld();
  await call('tabs_context_mcp', { createIfEmpty: true });
  const id = tabs.current('c').wc.tabId;
  await assert.rejects(call('javascript_tool', { action: 'run', text: '1', tabId: id }), (e: any) => e.code === 'bad_args');
  x.chrome.cdp['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : p.contextId
        ? { result: { value: { value: { quietMs: 1000, visibility: 'visible' }, seq: 0 } } }
        : { result: { type: 'number', value: 42 } };
  const js = text(await call('javascript_tool', { text: '6*7', tabId: id }));
  assert.match(js, /42/);
  const con = text(await call('read_console_messages', { tabId: id, clear: true }));
  assert.match(con, /No console messages in \d+/);
});

test('chromeTools: screenshots stay images; ids no tab of the chat has, and no tab id, pass through', async () => {
  const { call, tabs, x, tools, ctx } = chromeWorld();
  await call('tabs_context_mcp', { createIfEmpty: true });
  const id = tabs.current('c').wc.tabId;
  const state = { quietMs: 1000, visibility: 'visible', w: 800, h: 600, vw: 800, vh: 600, dpr: 1, sx: 0, sy: 0 };
  x.chrome.cdp['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : p.contextId
        ? { result: { value: { value: state, seq: 0 } } }
        : { result: { type: 'string', value: 'tab_abcdef12' } };
  x.chrome.cdp['Page.captureScreenshot'] = { data: Buffer.from('png').toString('base64') };
  const shot = await call('computer', { action: 'screenshot', tabId: id });
  assert.ok(shot.some((c: any) => c.type === 'image'));
  assert.match(text(await call('javascript_tool', { action: 'javascript_exec', text: 'x', tabId: id })), /tab_abcdef12/);
  assert.match(text(await call('get_page_text', { tabId: null })), new RegExp(`${id}`));
  assert.ok(Array.isArray(await tools.get('tabs_context_mcp').handler(undefined, ctx)));
});

test('chromeTools: browser_batch runs in order and stops at the first failure; it cannot be nested', async () => {
  const { call, tabs, tools, ctx } = chromeWorld();
  await call('tabs_context_mcp', { createIfEmpty: true });
  const id = tabs.current('c').wc.tabId;
  const ok = text(
    await call('browser_batch', {
      actions: [
        { name: 'navigate', input: { url: 'https://example.com/', tabId: id } },
        { name: 'tabs_context_mcp', input: {} },
      ],
    }),
  );
  assert.match(ok, /Navigated/);
  assert.match(ok, /Tabs in this chat/);
  const failed = (re: RegExp) => (e: any) => e.code === 'batch_failed' && re.test(e.message);
  await assert.rejects(
    call('browser_batch', {
      actions: [
        { name: 'tabs_context_mcp', input: {} },
        { name: 'browser_batch', input: {} },
        { name: 'navigate', input: { url: 'https://never.test/' } },
      ],
    }),
    failed(
      /^Tabs in this chat[\s\S]*\nAction 2 \(browser_batch\) failed: browser_batch is not one of these tools \(browser_batch cannot be nested\)\. Not run: the 1 later action\.$/,
    ),
  );
  await assert.rejects(
    call('browser_batch', { actions: [null] }),
    failed(/^Action 1 \(undefined\) failed: undefined is not one of these tools\.$/),
  );
  // each input is checked against its tool's schema before it runs
  await assert.rejects(
    call('browser_batch', {
      actions: [
        { name: 'navigate', input: {} },
        { name: 'find', input: {} },
        { name: 'find', input: {} },
      ],
    }),
    failed(/^Action 1 \(navigate\) failed: .*url.* Not run: the 2 later actions\.$/),
  );
  // Stop ends the batch before its next action
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    tools.get('browser_batch').handler({ actions: [{ name: 'tabs_context_mcp', input: {} }] }, { ...ctx, signal: ac.signal }),
    failed(/the turn was stopped/),
  );
  assert.deepEqual(await call('browser_batch', {}), []);
});

test('chromeTools: refusals name tabs and tools as Claude knows them; other errors pass as they are', async () => {
  const { call, tabs } = chromeWorld();
  await call('tabs_context_mcp', { createIfEmpty: true });
  const t = tabs.current('c');
  t.takenOver = true;
  await assert.rejects(call('navigate', { url: 'https://example.com/', tabId: t.wc.tabId }), (e: any) => {
    assert.equal(e.code, 'taken_over');
    assert.match(e.message, new RegExp(`took over ${t.wc.tabId} `));
    assert.doesNotMatch(e.message, /tab_[0-9a-f]{6}/);
    return true;
  });
  t.takenOver = false;
  tabs.resolve = async () => {
    throw new TypeError('boom');
  };
  await assert.rejects(call('navigate', { url: 'https://example.com/' }), (e: any) => e instanceof TypeError && e.message === 'boom');
});

test('chromeTools: every call refuses while the switch is off, with its reason or a default one', async () => {
  const { tabs } = chromeWorld();
  for (const [enabled, re] of [
    [() => 'Off for now.', /^Off for now\.$/],
    [() => false, /^Chrome control is turned off\.$/],
  ] as const) {
    const t = createChromeTools({ tabs, grants, enabled }).find((x: any) => x.name === 'chrome_tabs_context_mcp');
    await assert.rejects(t.handler({}, { chatId: 'c', segmentId: 's' }), (e: any) => e.code === 'disabled' && re.test(e.message));
  }
});

test('chromeTools: registered and unregistered as a set', () => {
  const r = new Registry();
  const { tabs } = chromeWorld();
  const off = registerChromeTools(r, { tabs, grants });
  assert.ok(r.has('chrome_navigate') && r.has('chrome_browser_batch'));
  off();
  assert.equal(r.has('chrome_navigate'), false);
});

/* ------------------------------------------------------------------ visibility */

test('visibility: chrome_* are shown only while the relay is on, and never beside another Chrome controller', () => {
  assert.equal(isToolHidden('chrome_navigate', {}), true);
  assert.equal(isToolHidden('chrome_navigate', { chromeRelay: true }), false);
  assert.equal(isToolHidden('chrome_navigate', { chromeRelay: true, nativeChrome: true }), true);
  assert.equal(isToolHidden('chrome_navigate', { chromeRelay: true, drivesUserChrome: true }), true);
  assert.match(
    hiddenToolMessage('chrome_navigate', { nativeChrome: true, chromeBy: 'Claude in Chrome' }),
    /controlled by Claude in Chrome/,
  );
  assert.match(hiddenToolMessage('chrome_navigate', { nativeChrome: true }), /controls the user's Chrome itself/);
  assert.match(
    hiddenToolMessage('chrome_navigate', { drivesUserChrome: true }),
    /Your Chrome is the browser channel; use the sage_browser_\* tools/,
  );
  assert.equal(hiddenToolMessage('chrome_navigate', {}), 'chrome_navigate is unavailable in this session.');
  const reg = new Registry();
  const flags = new Set(['shared.browser.chromeRelay']);
  const vis = new ToolVisibility({ registry: reg, isEnabled: (k: string) => flags.has(k) });
  assert.equal(vis.facts().chromeRelay, false, 'not registered');
  reg.register({ name: 'chrome_navigate', policy: 'observe', handler: () => 'x' });
  assert.equal(vis.facts().chromeRelay, true);
  assert.equal(vis.hides('chrome_navigate'), false);
  flags.clear();
  assert.equal(vis.hides('chrome_navigate'), true, 'switched off live');
});

/* ------------------------------------------------------------------ the Codex extension backend */

test('chromeBackend: getInfo is a session-scoped chrome-family extension backend for the thread, with Browser.user off', () => {
  const b = new ChromeBackend({
    threadId: 'th-1',
    chatOf: (x: string) => x,
    tabs: () => null,
    grants: () => null,
    flavor: 'prod',
    version: '9',
  });
  assert.deepEqual(b.info(), {
    apiSupportOverrides: { 'Browser.user': false, 'Tab.markDeliverable': true, 'Tab.markHandoff': true },
    name: NAME,
    version: '9',
    type: 'extension',
    family: 'chrome',
    discoveryScope: 'session',
    blobDownloadsSupported: false,
    capabilities: { browser: [], tab: [] },
    metadata: { codexAppBuildFlavor: 'prod', codexSessionId: 'th-1' },
  });
  const bare = new ChromeBackend({ threadId: 'th-2', chatOf: (x: string) => x, tabs: () => null, grants: () => null });
  assert.deepEqual(bare.info().metadata, { codexSessionId: 'th-2' });
  const note = chromeBackendNote('th-1');
  assert.match(note, /"MoPilot Chrome"/);
  assert.match(note, /metadata\.codexSessionId is "th-1"/);
  assert.match(note, /Don't call agent\.browsers\.get\("chrome"\)/);
});

test('chromeBackend: a thread’s backend listens only when the plugin env lists extension backends, and answers getInfo over its socket', async () => {
  // a short folder: a unix socket path has a length limit
  const dir = fs.mkdtempSync('/tmp/cbe-');
  const env = { backends: ['iab'], flavor: null, version: null };
  const m = new IabBackends({
    Backend: ChromeBackend,
    kind: 'extension',
    tabs: () => ({ list: () => [] }),
    grants: () => grants,
    chatOf: (id: string) => `chat:${id}`,
    harnessPid: () => 1,
    enabled: () => true,
    pluginEnv: () => env,
    dir,
    verify: async () => null,
  });
  try {
    assert.equal(m.available(), false);
    assert.equal(await m.loaded('th-1'), null);
    env.backends.push('extension');
    const file = await m.loaded('th-1');
    assert.ok(file && m.has('th-1'));
    const socket = net.connect(file);
    const dec = new FrameDecoder();
    const got = new Promise<any>((res) => socket.on('data', (c: Buffer) => dec.push(c).forEach(res)));
    socket.write(encodeFrame({ jsonrpc: '2.0', id: 1, method: 'getInfo', params: { session_id: 'th-1' } }));
    const reply = await got;
    assert.equal(reply.result.type, 'extension');
    assert.equal(reply.result.family, 'chrome');
    socket.destroy();
  } finally {
    m.exited();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chromeBackend: combined backends load, unload and exit together; the first answers available()', async () => {
  const log: string[] = [];
  const fake = (name: string, avail: boolean) => ({
    available: () => avail,
    has: (id: string) => avail && id === 't',
    loaded: async (id: string, o?: any) => log.push(`${name}+${id}${o?.parent ? `<${o.parent}` : ''}`),
    unloaded: (id: string) => log.push(`${name}-${id}`),
    exited: () => log.push(`${name}!`),
  });
  const c = combineBackends(fake('iab', true), fake('chrome', false));
  assert.equal(c.available(), true);
  assert.equal(c.has('t'), true);
  assert.equal(c.has('u'), false);
  await c.loaded('t', { parent: 'p' });
  c.unloaded('t');
  c.exited();
  assert.deepEqual(log, ['iab+t<p', 'chrome+t<p', 'iab-t', 'chrome-t', 'iab!', 'chrome!']);
});

test("chromeBackend: main's Chrome backends read the relay's host and grants, both switches and the plugin env", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-be-main-'));
  try {
    const dir = path.join(home, '.codex', 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: { cua_repl: { env: { BROWSER_USE_AVAILABLE_BACKENDS: 'iab,extension' } } } }),
    );
    const live: any = { chromeRelay: { tabs: { t: 1 }, grants: { g: 1 } }, controller: { chatOf: (id: string) => `chat:${id}` } };
    const server: any = { proc: { pid: 5 } };
    const flags = new Set(['shared.browser.chromeRelay']);
    const m = mainChromeBackends({ live, server, isFlagEnabled: (k: string) => flags.has(k), shellEnv: { childEnv: () => ({}) }, home });
    assert.equal(m.Backend, ChromeBackend);
    assert.equal(m.kind, 'extension');
    assert.equal(m.o.tabs(), live.chromeRelay.tabs);
    assert.equal(m.o.grants(), live.chromeRelay.grants);
    assert.equal(m.o.chatOf('t'), 'chat:t');
    assert.equal(m.o.harnessPid(), 5);
    assert.equal(m.o.enabled(), false, 'native Codex is off');
    flags.add('native.codex.enabled');
    assert.equal(m.o.enabled(), false, 'with the relay on, the chrome_* tools replace it (CM-Z33)');
    assert.deepEqual(m.o.pluginEnv().backends, ['iab', 'extension']);
    assert.deepEqual(
      mainChromeBackends({
        live,
        server,
        isFlagEnabled: () => true,
        shellEnv: { childEnv: () => ({ CODEX_HOME: path.join(home, 'none') }) },
      }).o.pluginEnv().backends,
      [],
    );
    live.chromeRelay = null;
    live.controller = null;
    server.proc = null;
    assert.equal(m.o.tabs(), null);
    assert.equal(m.o.grants(), undefined);
    assert.equal(m.o.chatOf('t'), 't');
    assert.equal(m.o.harnessPid(), undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('codexConfig: a native thread with MoPilot’s Chrome backend is told which browser that is; a failing note is only noted', () => {
  const sessions = new ToolSessions();
  let note: (id: string) => string | null = (id) => (id === 'th-1' ? chromeBackendNote(id) : null);
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => true,
    visibleTools: () => ['sage_debug_echo'],
    chromeNote: (id: string) => note(id),
  });
  let rid = 0;
  const load = (threadId: string) => {
    const id = ++rid;
    inj.outgoing({ id, method: 'thread/start', params: {} });
    inj.observe({ id, result: { thread: { id: threadId } } });
  };
  load('th-1');
  load('th-2');
  const ctx = inj.turnContext('th-1');
  assert.equal(ctx.key, IN_APP_BROWSER_CONTEXT);
  assert.match(ctx.context.value, /MoPilot Chrome/);
  // MoPilot's note replaces the rule for picking the vendor's Chrome: one instruction, never two
  assert.doesNotMatch(ctx.context.value, /Selecting Chrome in the Browser plugin/);
  // no MoPilot backend: the thread is told how to pick the user's Chrome among the vendor's backends (CM-W)
  const other = inj.turnContext('th-2');
  assert.match(other.context.value, /Selecting Chrome in the Browser plugin/, 'no backend, the vendor selection note');
  assert.doesNotMatch(other.context.value, /MoPilot Chrome/);
  note = () => {
    throw new Error('gone');
  };
  // a note that fails is only noted, and the thread falls back to the vendor selection note
  assert.match(inj.turnContext('th-1').context.value, /Selecting Chrome in the Browser plugin/);
  assert.ok(recentIgnored().some((e: any) => /Chrome backend note/.test(e.context)));
});

/* ------------------------------------------------------------------ main's setup */

test('app chromeRelay: setup uses the Chrome site table it is given, registers the chrome_* tools behind the switch, and stops', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-relay-app-'));
  try {
    const registry = new Registry();
    registry.setApprover(() => true);
    const flags = new Set(['shared.browser.chromeRelay']);
    const opened: any[] = [];
    const chromeGrants: any = { browser: 'chrome', peek: () => 'ok', turnEnded: () => undefined };
    const s = setupChromeRelay({
      registry,
      grants: chromeGrants,
      token: () => 'tok',
      profileDir: () => 'Profile 1',
      images,
      isFlagEnabled: (k: string) => flags.has(k),
      open: async (url: string, o: any) => opened.push([url, o]),
    });
    relays.push(s.relay);
    assert.ok(registry.has('chrome_navigate'));
    assert.equal(s.grants, chromeGrants);
    assert.equal(s.relay.o.clientName('0123456789abcdef'), 'MoPilot');
    assert.equal(s.relay.o.token(), 'tok');
    // the connect page opens through `open`, in the profile; the relay never connects here (no extension)
    s.relay.connectMs = 50;
    await assert.rejects(s.relay.connect('c'));
    assert.match(opened[0][0], /token=tok/);
    assert.deepEqual(opened[0][1], { profileDir: 'Profile 1' });
    assert.match(JSON.stringify(await registry.invoke('c', 's', 'chrome_tabs_context_mcp', { createIfEmpty: false })), /no tab group/);
    flags.clear();
    const res = await registry.invoke('c', 's', 'chrome_tabs_context_mcp', {});
    assert.match(JSON.stringify(res), /Chrome control through MoPilot is turned off/);
    s.stop();
    assert.equal(registry.has('chrome_navigate'), false);
    assert.equal(s.relay.server, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the relay keeps a chat’s tabs when a tab Chrome closes is the only one left', async () => {
  const { call, tabs, x } = chromeWorld();
  await call('tabs_context_mcp', { createIfEmpty: true });
  const id = tabs.current('c').wc.tabId;
  x.connections[0].event('chrome.tabs.onRemoved', id);
  await until(() => tabs.list('c').length === 0);
  assert.match(text(await call('tabs_context_mcp', { createIfEmpty: false })), /no tab group/);
});
