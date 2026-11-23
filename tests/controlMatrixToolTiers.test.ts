// Control matrix group X, tool tiers (G2, #3571): what each harness lists of MoPilot's browser, Chrome and desktop tools
// at session start, how a harness without a tool search loads the rest (at the next turn boundary, or at once through a
// more tool's call), Codex's native deferral, a switch's new segment and Claude Code's ToolSearch core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { world, tiers, textOf, listChars } from './support/tool-tiers-kit.ts';

const require = createRequire(import.meta.url);
const { SessionMcp } = require('../electron/capabilities/channels/sessionMcp.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { sdkMcpServers } = require('../electron/capabilities/mcp/sdkMcp.cjs');
const { mcpTool } = require('../electron/capabilities/mcp/socket.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

/** An ACP session's tool channel, as main runs it (its socket faked: no harness connects). */
function acp(w: ReturnType<typeof world>) {
  const socket: any = new EventEmitter();
  socket.listen = async () => '/tmp/sock';
  return new SessionMcp({ sessions: w.sessions, socket, command: 'sage-mcp' });
}

/** A Codex thread's tool channel; `defers`: this Codex defers MCP tools behind its own tool search. */
function codex(w: ReturnType<typeof world>, defers?: boolean) {
  const inj = new CodexToolInjection({
    sessions: w.sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    chatOf: () => 'chat',
    ...(defers === undefined ? {} : { defersMcpTools: () => defers }),
  });
  /** Starts a thread; returns its tool session key once the app-server named it. */
  const start = (threadId: string, id = 1) => {
    inj.outgoing({ id, method: 'thread/start', params: {} });
    inj.observe({ id, result: { thread: { id: threadId } } });
    return [...w.sessions.byKey.values()].find((s: any) => s.segmentId === threadId).key as string;
  };
  return { inj, start };
}

/** Claude's SDK servers for the same registry: tool name -> alwaysLoad, by presented full name. */
function claudeLoading(w: ReturnType<typeof world>) {
  const sdk = {
    tool: (name: string, _d: string, _s: unknown, _h: unknown, options: any) => ({ name, options }),
    createSdkMcpServer: (o: any) => o,
  };
  const servers = sdkMcpServers({
    sdk,
    z: { fromJSONSchema: (s: unknown) => s },
    registry: w.registry,
    serverName: 'sage_aaaaaaaaaaaa',
    owner: { chatId: 'chat', segmentId: 's' },
  });
  const out = new Map<string, boolean>();
  for (const [server, cfg] of servers as Map<string, any>) for (const t of cfg.tools) out.set(`${server}/${t.name}`, t.options.alwaysLoad);
  return out;
}

const CORE = [...tiers.CORE.browser, ...tiers.CORE.desktop];

test('CM-X15: an ACP session lists only the core and the two more tools from its first list, at a fraction of the full list', async () => {
  const w = world();
  const { serverName } = await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  assert.ok(serverName);
  const names = await w.list('acp1');
  assert.deepEqual(names.filter((n) => !n.endsWith('_more_tools')).sort(), [...CORE].sort());
  assert.deepEqual(
    names.filter((n) => n.endsWith('_more_tools')),
    ['browser_more_tools', 'desktop_more_tools'],
  );
  // the fixed cost the model carries on every request (o200k tokens are about a quarter of these characters)
  const tiered = ((await w.ask('acp1', 'tools/list')) as any).result.tools;
  const full = w.registry.list({ chatId: 'chat' }).map(mcpTool);
  assert.ok(listChars(tiered) <= 0.4 * listChars(full), `${listChars(tiered)} of ${listChars(full)} characters`);
  const browser = tiered.filter((t: any) => t.name.startsWith('browser_'));
  // these schemas run about 4.3 characters per o200k token (13,408 characters were 3,101 tokens): 14,000 keeps it under 3.3k
  assert.ok(
    listChars(browser) <= 14_000,
    `the built-in browser's fixed schemas are ${listChars(browser)} characters (3.3k tokens at most)`,
  );
});

test('CM-X16: a deferred tool called before its group is loaded is refused with how to load it, and nothing runs', async () => {
  const w = world();
  await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  const { start } = codex(w, false);
  const thread = start('th-1');
  for (const [key, name] of [
    ['acp1', 'browser_tabs_mark'],
    ['acp1', 'desktop_left_click'],
    ['acp1', 'chrome_javascript_tool'],
    [thread, 'desktop_app_scroll'],
    [thread, 'browser_request_signin'],
    [thread, 'chrome_tabs_create_mcp'],
  ]) {
    const r = await w.call(key, name, {});
    assert.equal(r.isError, true, name);
    assert.equal(r.structuredContent.error, 'tool_not_loaded', name);
    assert.match(textOf(r), new RegExp(`${r.structuredContent.loadWith.tool} \\{"load": \\["${r.structuredContent.group}"\\]\\}`));
  }
  assert.deepEqual(w.calls, []);
});

test("CM-X17: a more tool's call runs a deferred tool at once, mid-turn, and the list does not change until the turn ends", async () => {
  const w = world();
  await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  const before = await w.list('acp1');
  // a CAPTCHA hand-off and a deliverable tab cannot wait for the next turn
  const signin = await w.call('acp1', 'browser_more_tools', {
    call: 'browser_request_signin',
    arguments: { reason: 'Complete the CAPTCHA' },
  });
  assert.equal(textOf(signin), 'ran browser_request_signin');
  const scroll = await w.call('acp1', 'desktop_more_tools', { call: 'desktop_app_scroll', arguments: { app: 'Notes', dy: 3 } });
  assert.equal(textOf(scroll), 'ran desktop_app_scroll');
  const chrome = await w.call('acp1', 'browser_more_tools', { call: 'chrome_get_page_text', arguments: { tabId: 1 } });
  assert.equal(textOf(chrome), 'ran chrome_get_page_text');
  assert.deepEqual(
    w.calls.map((c) => [c.name, c.chatId, c.segmentId]),
    [
      ['browser_request_signin', 'chat', 'acp1'],
      ['desktop_app_scroll', 'chat', 'acp1'],
      ['chrome_get_page_text', 'chat', 'acp1'],
    ],
  );
  assert.deepEqual(await w.list('acp1'), before);
  // a call into another surface's groups, or of a core tool, is no call for this more tool
  assert.equal((await w.call('acp1', 'browser_more_tools', { call: 'desktop_type', arguments: {} })).isError, true);
  assert.equal(w.calls.length, 3);
});

test('CM-X18: a group loaded during a turn is listed from the next turn, and the harness is told the list changed', async () => {
  const w = world();
  const sock = w.sock;
  await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  const sent: string[] = [];
  sock.conns.add({
    digest: w.sessions.byKey.get('acp1').digest,
    socket: { destroyed: false, write: (l: string) => sent.push(l), destroy() {} },
    calls: new Map(),
  });
  const loaded = await w.call('acp1', 'desktop_more_tools', { load: ['pointer', 'keyboard'] });
  assert.match(textOf(loaded), /^Loaded pointer, keyboard: listed from your next turn/);
  assert.ok(JSON.parse(textOf(loaded).split('\n')[1]).some((t: any) => t.name === 'desktop_left_click' && t.inputSchema));
  assert.ok(!(await w.list('acp1')).includes('desktop_left_click'), 'not mid-turn');
  // loaded tools are callable by name at once, though the harness lists them only from the next turn
  assert.equal(textOf(await w.call('acp1', 'desktop_type', { text: 'hi' })), 'ran desktop_type');
  w.registry.turns.retire('chat');
  const next = await w.list('acp1');
  assert.ok(next.includes('desktop_left_click') && next.includes('desktop_hold_key') && !next.includes('desktop_read_clipboard'));
  assert.deepEqual(
    sent.map((l) => JSON.parse(l).method),
    ['notifications/tools/list_changed'],
  );
  sock.close();
});

test("CM-X19: Codex's native deferral decides tiers: a Codex that defers lists every tool, one that does not (or says nothing) gets tiers", async () => {
  for (const [defers, tiered] of [
    [true, false],
    [false, true],
    [undefined, true],
  ] as const) {
    const w = world();
    const key = codex(w, defers).start('th-1');
    const names = await w.list(key);
    assert.equal(w.sessions.get(key).tiered, tiered, `defers ${defers}`);
    assert.equal(names.includes('desktop_left_click'), !tiered);
    assert.equal(names.includes('desktop_more_tools'), tiered);
  }
  // main reads it from the app-server's experimentalFeature/list (codex-cli 0.166: tool_search_always_defer_mcp_tools on)
  const wiring = fs.readFileSync(new URL('../electron/app/agentTools.cjs', import.meta.url), 'utf8');
  assert.match(
    wiring,
    /defersMcpTools: \(\) => live\.codex\?\.negotiated\?\.flags\?\.\['features\.tool_search_always_defer_mcp_tools'\] === true/,
  );
});

test("CM-X20: a Codex sub-agent's turn ending commits only its own thread's groups, never its parent's mid-turn", async () => {
  const w = world();
  const { start } = codex(w, false);
  const parent = start('th-parent', 1);
  const child = start('th-child', 2);
  await w.call(parent, 'browser_more_tools', { load: ['tabs'] });
  await w.call(child, 'browser_more_tools', { load: ['tabs'] });
  w.registry.turns.retireTurn('chat', 'th-child');
  assert.ok((await w.list(child)).includes('browser_tabs_mark'));
  assert.ok(!(await w.list(parent)).includes('browser_tabs_mark'), "the parent's turn is still running");
  w.registry.turns.retireTurn('chat', 'th-parent');
  assert.ok((await w.list(parent)).includes('browser_tabs_mark'));
  // a resume of the same thread keeps what it loaded
  codex(w, false).inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th-parent' } });
  assert.ok((await w.list(parent)).includes('browser_tabs_mark'));
});

test("CM-X21: a switch's new segment starts from the core: groups loaded on the old segment are recomputed for the new one", async () => {
  const w = world();
  const channel = acp(w);
  // Codex (no native deferral) loads a group and its turn ends
  const thread = codex(w, false).start('th-1');
  await w.call(thread, 'desktop_more_tools', { load: ['clipboard'] });
  w.registry.turns.retireTurn('chat', 'th-1');
  assert.ok((await w.list(thread)).includes('desktop_read_clipboard'));
  // the chat switches to an ACP harness: its new session lists the core again
  await channel.prepare('acp-seg', { harnessPid: 1, chatId: 'chat', segmentId: 'acp-seg' });
  assert.ok(!(await w.list('acp-seg')).includes('desktop_read_clipboard'));
  assert.ok((await w.list('acp-seg')).includes('desktop_more_tools'));
  // and an ACP session resumed (a switch back) keeps what it had loaded
  await w.call('acp-seg', 'desktop_more_tools', { load: ['teach'] });
  w.registry.turns.retire('chat');
  await channel.prepare('acp-seg', { harnessPid: 1, chatId: 'chat', segmentId: 'acp-seg', resume: true });
  assert.ok((await w.list('acp-seg')).includes('desktop_teach_step'));
});

test('CM-X21a: mixed pair Claude Code → ACP: both start from the same core, Claude through ToolSearch and ACP through tiers', async () => {
  const w = world();
  const claude = claudeLoading(w);
  const claudeCore = [...claude].filter(([, always]) => always).map(([n]) => n);
  assert.equal(claudeCore.length, CORE.length);
  await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  const acpCore = (await w.list('acp1')).filter((n) => !n.endsWith('_more_tools'));
  assert.deepEqual(acpCore.length, claudeCore.length);
  // every tool ACP lists has the same tool always loaded on Claude, under Claude's names
  for (const n of acpCore) {
    const bare = n
      .replace(/^browser_(?!script)/, '')
      .replace(/^chrome_/, '')
      .replace(/^desktop_/, '');
    assert.ok(
      claudeCore.some((c) => c.endsWith(`__${bare}`) || c.endsWith(`/${bare}`)),
      `${n} is not always loaded on Claude`,
    );
  }
});

test('CM-X21b: a group loaded mid-turn, then a switch before the turn ends: the old session ends with it, the new one has the core', async () => {
  const w = world();
  const thread = codex(w, false).start('th-1');
  await w.call(thread, 'browser_more_tools', { load: ['history'] });
  // the switch ends the old segment's session before its turn's end is reported
  w.sessions.end(thread);
  await acp(w).prepare('acp-seg', { harnessPid: 1, chatId: 'chat', segmentId: 'acp-seg' });
  w.registry.turns.retire('chat');
  assert.ok(!(await w.list('acp-seg')).includes('browser_history_search'));
  assert.equal(w.sessions.get(thread), null);
});

test('CM-X22: a Claude Code session always loads exactly the core; every other tool waits behind ToolSearch, with no more tools', () => {
  const w = world();
  const claude = claudeLoading(w);
  assert.ok(![...claude.keys()].some((n) => n.endsWith('more_tools')));
  const deferred = [...claude].filter(([, always]) => !always).map(([n]) => n);
  assert.equal(deferred.length, claude.size - CORE.length);
  for (const n of [
    'mopilot_browser/tabs_mark',
    'mopilot_computer/left_click',
    'mopilot_chrome/get_page_text',
    'mopilot_computer/app_scroll',
  ])
    assert.ok(deferred.includes(n), n);
});

test('CM-X22a: a Claude Code session is never tiered: its socket list and calls are the whole set, and nothing is refused as not loaded', async () => {
  const w = world();
  w.sessions.open('claude-key', { chatId: 'chat', segmentId: 's', shared: 'claude' });
  const names = await w.list('claude-key');
  assert.ok(names.includes('desktop_left_click') && !names.includes('browser_more_tools'));
  assert.equal(textOf(await w.call('claude-key', 'browser_tabs_mark', { tabId: 't', status: 'deliverable' })), 'ran browser_tabs_mark');
});

test('CM-X23: with no window open, a turn ending in main (the turn tokens retiring) commits loaded groups', async () => {
  const w = world();
  await acp(w).prepare('acp1', { harnessPid: 1, chatId: 'chat', segmentId: 'acp1' });
  await w.call('acp1', 'browser_more_tools', { load: 'devtools' });
  // a Stop retires the chat's turn the same way (Registry.abortChat)
  w.registry.abortChat('chat', 'stopped');
  assert.ok((await w.list('acp1')).includes('browser_read_console_messages'));
});

test("CM-X24: read_page offers save_to on the built-in browser and the user's Chrome, and a tree above the limit is saved, not cut", async () => {
  const stub = { tabs: { list: () => [] }, grants: {} };
  const iab = createBrowserTools(stub).find((t: any) => t.name === 'browser_read_page');
  const chrome = createChromeTools(stub).find((t: any) => t.name === 'chrome_read_page');
  for (const t of [iab, chrome]) assert.equal(t.schema.properties.save_to.type, 'boolean', t.name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmx24-'));
  const tab: any = { id: 't1', url: 'https://shop.test/', title: 'Shop', kind: 'tab', chatId: 'c' };
  const lines = Array.from({ length: 3000 }, (_, i) => `link "Item ${i}" [ref_${i}]`);
  const tabs: any = {
    resolve: async () => tab,
    run: async (_t: any, fn: () => any) => fn(),
    ready: async () => ({ w: 800, h: 600 }),
    list: () => [tab],
    readPage: async (_t: any, o: any) => {
      const fit = lines.filter((_, i) => i * 30 < o.maxChars);
      return { lines: fit, truncated: fit.length < lines.length };
    },
    state: () => 'STATE',
  };
  const grants = new OriginGrants({
    browser: 'iab',
    anchor: () => 'full',
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
  });
  grants.set('https://shop.test', 'write');
  const tool = createBrowserTools({ tabs, grants, folders: () => ({ uploads: dir, downloads: dir }) }).find(
    (t: any) => t.name === 'browser_read_page',
  );
  const out = await tool.handler({ max_chars: 1000 }, { chatId: 'c', segmentId: 's' });
  const text = typeof out === 'string' ? out : out[0].text;
  const file = /is saved to (\S+\.txt)\./.exec(text)![1];
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 3001);
  assert.match(text, /3,000 lines/);
  assert.doesNotMatch(text, /Output truncated/);
});

test('CM-X25: two sessions with the same facts list byte-identical tools, so the cached prompt prefix holds; loading changes it once', async () => {
  const w = world();
  const channel = acp(w);
  await channel.prepare('a', { harnessPid: 1, chatId: 'chat-a', segmentId: 'a' });
  await channel.prepare('b', { harnessPid: 1, chatId: 'chat-b', segmentId: 'b' });
  const json = async (k: string) => JSON.stringify(((await w.ask(k, 'tools/list')) as any).result.tools);
  assert.equal(await json('a'), await json('b'));
  await w.call('a', 'browser_more_tools', { load: ['tabs'] });
  await w.call('b', 'browser_more_tools', { load: ['tabs'] });
  w.registry.turns.retire('chat-a');
  w.registry.turns.retire('chat-b');
  assert.equal(await json('a'), await json('b'));
});
