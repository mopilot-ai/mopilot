// Tool tiers (G2, #3571): a session without a tool search of its own lists each surface's core and loads the rest in groups
// (electron/capabilities/mcp/toolTiers.cjs), through ToolSessions' per-session state and the shared channel handler (socket.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, tiers, textOf, answerToolRequest, ToolSessions, ToolSocket, Registry, realSpecs } from './support/tool-tiers-kit.ts';

const require = createRequire(import.meta.url);
const { CORE_HOST } = require('../electron/capabilities/mcp/toolLoading.cjs');
const { placement } = require('../electron/capabilities/contract/hostServers.cjs');
const { savePageTree, savedSummary, FILE_MAX, PREVIEW_CHARS } = require('../electron/capabilities/browser/pageTreeFile.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

test('every browser, Chrome and desktop tool is in the core or exactly one group, and every group names real tools', () => {
  const names = realSpecs().map((s) => s.name);
  const grouped = new Map<string, string>();
  // the app surface's tools are registered all over main (tests/controlMatrixAppTiers.test.ts)
  for (const [surface, s] of Object.entries<any>(tiers.SURFACES).filter(([surface]) => surface !== 'app'))
    for (const [id, g] of Object.entries<any>(s.groups))
      for (const t of g.tools) {
        assert.ok(names.includes(t), `${surface}/${id} names ${t}, which is not a tool`);
        assert.equal(grouped.has(t), false, `${t} is in two groups`);
        grouped.set(t, `${surface}/${id}`);
      }
  const core = [...tiers.CORE.browser, ...tiers.CORE.desktop];
  for (const t of core) assert.equal(tiers.groupOf(t), null, `${t} is core and grouped`);
  for (const n of names) assert.ok(core.includes(n) || grouped.has(n), `${n} is in neither the core nor a group`);
  assert.deepEqual(tiers.groupOf('browser_tabs_mark'), { surface: 'browser', group: 'tabs' });
  assert.equal(tiers.moreSurface('desktop_more_tools'), 'desktop');
  assert.equal(tiers.moreSurface('browser_navigate'), null);
});

test("Claude's always-loaded core is the tiers' core under the names Claude sees, so a switch keeps the same first tools", () => {
  // the user's Chrome's core is Claude's mopilot_chrome core, which loads up front only while Chrome is the chosen browser
  const presented = [...tiers.CORE.browser, ...tiers.SURFACES.browser.groups.chrome.tools, ...tiers.CORE.desktop].map((n) =>
    placement(n, 'sage_x'),
  );
  const byServer: Record<string, string[]> = {};
  for (const p of presented) (byServer[p.server] ??= []).push(p.name);
  // a server with no core (the desktop since G11) has no entry
  for (const server of Object.keys(CORE_HOST))
    assert.deepEqual([...CORE_HOST[server]].sort(), [...(byServer[server] ?? [])].sort(), server);
});

test('moreTool: groups with a visible tool, in a fixed order; none when the session sees no deferred tool', () => {
  const visible = new Set(['browser_tabs_mark', 'chrome_gif_creator', 'browser_navigate']);
  const more = tiers.moreTool('browser', visible);
  assert.equal(more.name, 'browser_more_tools');
  assert.deepEqual(more.inputSchema.properties.load.items.enum, ['tabs', 'chrome_capture']);
  assert.match(more.description, /tabs \(list, open, close, switch and keep built-in browser tabs\); chrome_capture/);
  assert.match(more.description, /mopilot:built-in-browser skill/);
  assert.deepEqual(tiers.moreTool('browser', new Set(['browser_more_tools'])), tiers.moreTool('browser', new Set(['browser_more_tools'])));
  assert.equal(tiers.moreTool('desktop', visible), null);
});

test('tieredList: the core and the loaded groups, then each surface that defers something gets its more tool', () => {
  const tools = ['browser_navigate', 'browser_tabs_mark', 'browser_get_page_text', 'design_quickstart'].map((name) => ({ name }));
  // an app tool no group names waits in the app surface's `other` group (G10)
  assert.deepEqual(
    tiers.tieredList(tools, new Set()).map((t: any) => t.name),
    ['browser_navigate', 'browser_more_tools', 'app_more_tools'],
  );
  assert.deepEqual(
    tiers.tieredList(tools, new Set(['browser/tabs', 'app/other'])).map((t: any) => t.name),
    ['browser_navigate', 'browser_tabs_mark', 'design_quickstart', 'browser_more_tools', 'app_more_tools'],
  );
});

test('moreCall: listing, loading and running, and every malformed input answered as an error that runs nothing', () => {
  const visible = new Set(['browser_tabs_mark', 'browser_tabs_create', 'browser_get_page_text']);
  const describe = (n: string) => ({
    description:
      n === 'browser_tabs_mark' ? 'Mark a tab. More.' : n === 'browser_tabs_create' ? 'Open a tab\nsecond line' : 'No period here',
    inputSchema: { type: 'object' },
  });
  const listing = tiers.moreCall('browser_more_tools', null, visible, describe);
  assert.match(
    listing.answer,
    /^tabs: list, open, close.*\n- browser_tabs_create: Open a tab\n- browser_tabs_mark: Mark a tab\.\n\npage: /s,
  );
  assert.match(listing.answer, /- browser_get_page_text: No period here$/);
  assert.deepEqual(tiers.moreCall('browser_more_tools', ['x'], visible, describe), listing);
  const loaded = tiers.moreCall('browser_more_tools', { load: 'tabs' }, visible, describe);
  assert.deepEqual(loaded.load, ['browser/tabs']);
  assert.match(loaded.answer, /^Loaded tabs: listed from your next turn\./);
  assert.deepEqual(
    JSON.parse(loaded.answer.split('\n')[1]).map((t: any) => t.name),
    ['browser_tabs_create', 'browser_tabs_mark'],
  );
  assert.equal(tiers.moreCall('browser_more_tools', { load: ['tabs', 'nope'] }, visible, describe).error, true);
  assert.match(tiers.moreCall('browser_more_tools', { load: [] }, visible, describe).answer, /Unknown group: \(none\)/);
  assert.deepEqual(tiers.moreCall('browser_more_tools', { call: 'browser_tabs_mark', arguments: { status: 'x' } }, visible, describe), {
    run: 'browser_tabs_mark',
    args: { status: 'x' },
  });
  assert.deepEqual(tiers.moreCall('browser_more_tools', { call: 'browser_tabs_mark' }, visible, describe), {
    run: 'browser_tabs_mark',
    args: {},
  });
  for (const bad of [
    { call: 7 },
    { call: 'browser_navigate' },
    { call: 'desktop_type' },
    { call: 'browser_tabs_close' },
    { call: 'browser_tabs_mark', arguments: [] },
    { call: 'browser_tabs_mark', arguments: 'x' },
  ])
    assert.equal(tiers.moreCall('browser_more_tools', bad, visible, describe).error, true, JSON.stringify(bad));
  assert.match(tiers.moreCall('browser_more_tools', { call: 7 }, visible, describe).answer, /^call is not a tool/);
  assert.match(
    tiers.moreCall('browser_more_tools', { call: 'browser_tabs_mark', arguments: 'x' }, visible, describe).answer,
    /arguments must be an object/,
  );
  // null arguments are no arguments
  assert.deepEqual(tiers.moreCall('browser_more_tools', { call: 'browser_tabs_mark', arguments: null }, visible, describe).args, {});
  assert.match(tiers.moreCall('desktop_more_tools', {}, visible, describe).answer, /^desktop_more_tools has no tools in this session/);
  // a tool with no description is listed by name alone
  assert.match(
    tiers.moreCall('browser_more_tools', {}, visible, () => ({ description: undefined as any, inputSchema: {} })).answer,
    /- browser_tabs_mark: $/m,
  );
});

test('notLoaded: a structured refusal naming the group and the call that loads it', () => {
  const r = tiers.notLoaded('desktop_left_click');
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, {
    error: 'tool_not_loaded',
    tool: 'desktop_left_click',
    group: 'pointer',
    loadWith: { tool: 'desktop_more_tools', arguments: { load: ['pointer'] } },
  });
  assert.match(r.content[0].text, /desktop_more_tools \{"call": "desktop_left_click"/);
});

test('ToolSessions: groups loaded in a turn are callable at once and listed after the turn commits; a new session starts with none', () => {
  const s = new ToolSessions();
  const changed: any[] = [];
  s.on('tools-changed', (e: any) => changed.push(e.key));
  assert.equal(s.loadGroups('missing', ['browser/tabs']), false);
  s.open('a', { chatId: 'c1', segmentId: 'seg-a', tiered: true });
  assert.equal(s.get('a').tiered, true);
  s.loadGroups('a', ['browser/tabs']);
  assert.deepEqual([...s.get('a').loaded], []);
  assert.deepEqual([...s.get('a').callable], ['browser/tabs']);
  s.commitTurn('other');
  s.commitTurn('c1', 'another-thread');
  assert.deepEqual(changed, []);
  s.commitTurn('c1');
  assert.deepEqual([...s.get('a').loaded], ['browser/tabs']);
  assert.deepEqual(changed, ['a']);
  // loading a group already listed changes nothing at the next commit
  s.loadGroups('a', ['browser/tabs']);
  s.commitTurn('c1');
  assert.deepEqual(changed, ['a']);
  // a resume (rotate) keeps the groups; a new session under the key starts with none
  s.rotate('a', { tiered: true });
  assert.deepEqual([...s.get('a').loaded], ['browser/tabs']);
  s.open('a', { chatId: 'c1', tiered: true });
  assert.deepEqual([...s.get('a').loaded], []);
  assert.equal(new ToolSessions().open('x').serverName.startsWith('sage_'), true);
});

test('ToolSessions.commitTurn: a suspended session commits without telling anyone; a chat that cannot be read yet is skipped', () => {
  const s = new ToolSessions();
  const changed: any[] = [];
  s.on('tools-changed', (e: any) => changed.push(e.key));
  s.open('susp', { chatId: 'c', tiered: true });
  s.loadGroups('susp', ['desktop/pointer']);
  s.suspend('susp');
  s.open('lost', {
    chatId: () => {
      throw new Error('not recorded yet');
    },
    tiered: true,
  });
  s.loadGroups('lost', ['desktop/pointer']);
  s.commitTurn('c');
  assert.deepEqual([...s.byKey.get('susp').loaded], ['desktop/pointer']);
  assert.deepEqual([...s.byKey.get('lost').pending], ['desktop/pointer']);
  assert.deepEqual(changed, []);
});

test('answerToolRequest: an untiered session (Claude Code, a Codex that defers itself) lists and runs every tool as before', async () => {
  const w = world();
  w.sessions.open('k', { chatId: 'c', segmentId: 's' });
  const names = await w.list('k');
  assert.ok(names.includes('desktop_left_click') && !names.includes('desktop_more_tools'));
  assert.equal(textOf(await w.call('k', 'desktop_cursor_position')), 'ran desktop_cursor_position');
  // a more tool is no tool for it
  assert.equal((await w.call('k', 'browser_more_tools')).isError, true);
});

test('answerToolRequest: a session object without tier fields (an older snapshot) lists no group and refuses deferred tools', async () => {
  const w = world();
  const ask = (msg: any, session: any) => answerToolRequest({ registry: w.registry, session, calls: new Map(), msg });
  const listed = (await ask({ id: 1, method: 'tools/list' }, { chatId: 'c', segmentId: 's', tiered: true })) as any;
  assert.ok(!listed.result.tools.some((t: any) => t.name === 'browser_tabs_mark'));
  const refused = (await ask(
    { id: 2, method: 'tools/call', params: { name: 'browser_tabs_mark', arguments: {} } },
    { chatId: 'c', segmentId: 's', tiered: true },
  )) as any;
  assert.equal(refused.result.structuredContent.error, 'tool_not_loaded');
  // with no sessions to record it, a load still answers and lists nothing new
  const load = (await ask(
    { id: 3, method: 'tools/call', params: { name: 'browser_more_tools', arguments: { load: ['tabs'] } } },
    { key: 'k', chatId: 'c', segmentId: 's', tiered: true },
  )) as any;
  assert.match(load.result.content[0].text, /^Loaded tabs/);
});

test("answerToolRequest: a more tool answers even when the session's rule hides its surface's prefix; hidden tools still refuse first", async () => {
  const w = world();
  // browser parity off: browser_* hidden, chrome_* shown
  w.sessions.open('k', {
    chatId: 'c',
    segmentId: 's',
    tiered: true,
    hide: (n: string) => n.startsWith('browser_') && n !== 'browser_more_tools',
  });
  const names = await w.list('k');
  assert.ok(names.includes('browser_more_tools') && !names.includes('browser_navigate'));
  // Chrome is not the chosen browser: its core waits in the chrome group like the rest of its tools (G11)
  assert.equal(names.includes('chrome_navigate'), false);
  const groups = textOf(await w.call('k', 'browser_more_tools'));
  assert.match(groups, /^chrome: the user's Chrome: tabs, navigation/m);
  assert.match(groups, /chrome_page/);
  assert.doesNotMatch(groups, /^tabs:/m);
  w.sessions.open('h', { chatId: 'c', segmentId: 's', tiered: true, hide: (n: string) => n.startsWith('desktop_') });
  const hidden = await w.call('h', 'desktop_left_click');
  assert.equal(hidden.structuredContent, undefined, 'a hidden tool is refused as hidden, not as not loaded');
  assert.equal((await w.call('h', 'desktop_more_tools')).isError, true);
});

test('ToolSocket: a turn retiring commits loaded groups and sends list_changed to that session only; close stops both', async () => {
  const registry = new Registry();
  const sessions = new ToolSessions();
  const sock = new ToolSocket({ sessions, registry });
  const a = sessions.open('a', { chatId: 'c', segmentId: 'th-a', tiered: true });
  sessions.open('b', { chatId: 'c', segmentId: 'th-b', tiered: true });
  const written: Record<string, string[]> = { a: [], b: [], gone: [] };
  const conn = (k: string, digest: string | null, destroyed = false) => ({
    digest,
    socket: { destroyed, write: (l: string) => written[k].push(l), destroy() {} },
    calls: new Map(),
  });
  const digestOf = (key: string) => sessions.byKey.get(key).digest;
  sock.conns.add(conn('a', digestOf('a')));
  sock.conns.add(conn('b', digestOf('b')));
  sock.conns.add(conn('gone', digestOf('a'), true));
  sessions.loadGroups('a', ['browser/tabs']);
  sessions.loadGroups('b', ['browser/tabs']);
  // one Codex thread's turn ends: only that thread's session is committed
  registry.turns.retireTurn('c', 'th-a');
  assert.deepEqual(
    written.a.map((l) => JSON.parse(l)),
    [{ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }],
  );
  assert.deepEqual([written.b, written.gone], [[], []]);
  assert.deepEqual([...sessions.get('b').loaded], []);
  assert.ok(a.token);
  // listen() subscribes again without doubling the commits
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tiers-'));
  process.env.TMPDIR = dir;
  await sock.listen().catch(() => null);
  sessions.loadGroups('b', ['desktop/pointer']);
  registry.turns.retire('c');
  assert.equal(written.b.length, 1);
  sock.close();
  sessions.loadGroups('b', ['desktop/keyboard']);
  registry.turns.retire('c');
  assert.equal(written.b.length, 1, 'closed: nothing more is committed or sent');
  // a registry without turn tokens (a bare fake) commits nothing and needs nothing to stop
  const bare = new ToolSocket({ sessions: new ToolSessions(), registry: { list: () => [] } });
  bare.close();
});

test('pageTreeFile: the whole tree saved to the folder with a summary; no folder answers null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tree-'));
  const lines = [
    'button "Send" [ref_1]',
    'link "A" [ref_2]',
    'link "B" [ref_3]',
    '"plain text"',
    '  button "X" [ref_4]',
    'textbox "Q" [ref_5]',
  ];
  const out = savePageTree({ folder: path.join(dir, 'dl'), tabId: 'tab/1', head: 'Page tab_1', lines, truncated: false, now: () => 42 });
  const file = path.join(fs.realpathSync(dir), 'dl', 'page-tab_1-42.txt');
  assert.equal(fs.readFileSync(file, 'utf8'), `Page tab_1\n${lines.join('\n')}\n`);
  assert.match(out, new RegExp(`6 lines, \\d+ characters\\) is saved to ${file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`));
  assert.match(out, /Roles: button 2, link 2, textbox 1\./);
  // equal counts sort by name, whichever came first
  for (const order of [
    ['heading "H"', 'img "I"'],
    ['img "I"', 'heading "H"'],
  ])
    assert.match(savedSummary({ head: 'h', lines: order, file: '/f', truncated: false }), /Roles: heading 1, img 1\./);
  assert.equal(savePageTree({ folder: null, tabId: 't', head: 'h', lines, truncated: false }), null);
  const long = savedSummary({ head: 'h', lines: ['"' + 'x'.repeat(PREVIEW_CHARS + 10) + '"'], file: '/f', truncated: true });
  assert.match(long, new RegExp(`cut at ${FILE_MAX.toLocaleString('en-US')}`));
  assert.doesNotMatch(long, /Roles:/);
  assert.match(long, /…$/);
});

test('browser_read_page: save_to and a tree above the limit go to the download folder; without a folder the cut tree stays', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rp-'));
  const tab: any = { id: 't1', url: 'https://shop.test/', title: 'Shop', kind: 'tab', chatId: 'c' };
  const reads: any[] = [];
  const tabs: any = {
    resolve: async () => tab,
    run: async (_t: any, fn: () => any) => fn(),
    ready: async () => ({ w: 800, h: 600 }),
    list: () => [tab],
    readPage: async (_t: any, o: any) => (
      reads.push(o.maxChars), { lines: ['button "Go" [ref_1]'], truncated: o.maxChars < 100000 && big }
    ),
    state: () => 'STATE',
  };
  let big = false;
  const grants = new OriginGrants({
    browser: 'iab',
    anchor: () => 'full',
    ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }),
  });
  grants.set('https://shop.test', 'write');
  const make = (folders: any) => {
    const h = createBrowserTools({ tabs, grants, folders }).find((t: any) => t.name === 'browser_read_page').handler;
    return async (args: any, c: any) => {
      const out = await h(args, c);
      return typeof out === 'string' ? out : out[0].text;
    };
  };
  const ctx = { chatId: 'c', segmentId: 's' };
  const withFolder = make(() => ({ uploads: path.join(dir, 'up'), downloads: path.join(dir, 'down') }));
  assert.match(await withFolder({}, ctx), /^Page t1: Shop.*\nbutton "Go" \[ref_1\]$/s);
  assert.deepEqual(reads, [50000]);
  assert.match(await withFolder({ save_to: true }, ctx), /is saved to .*page-t1-\d+\.txt/);
  assert.deepEqual(reads, [50000, 50000], 'a tree read whole is saved without reading it again');
  big = true;
  assert.match(await withFolder({}, ctx), /is saved to /);
  assert.match(await make(null)({}, ctx), /Output truncated at the 50,000-character limit/);
  assert.match(await make(() => null)({ save_to: true }, ctx), /button "Go"/);
});
