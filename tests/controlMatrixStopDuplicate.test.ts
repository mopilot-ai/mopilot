// The control matrix's Stop and Duplicate cases (docs/control-plane/matrix/K.md, #1362): the agent's browser_navigate
// "stop" and browser_tabs_create duplicate reach the chat's own tabs the same way from Claude Code, a Codex thread, a
// chat that switched harness and an ACP session; the user's Duplicate in the pane is done once the history is copied.
// The Registry, the tool channels, BrowserTabs, OriginGrants and PaneNavigation are real; pages are fakes that copy
// history as Electron 44 does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { world, claudeSession, codexConnection, switchingChat, acpSession } from './support/control-matrix-kit.ts';
import { setup, tabOf, drive, flush } from './support/browser-host-kit.ts';
import { waitFor } from './support/waitFor.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { PaneViews } = require('../electron/capabilities/browser/views.cjs');
const { PaneNavigation } = require('../electron/capabilities/browser/paneNavigation.cjs');
const { restoreHistory } = require('../electron/capabilities/browser/historyCopy.cjs');
const { inAppBrowserNote, notesWithoutBrowserTools } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');

const A = 'https://shop.test/a';
const LIST = 'https://shop.test/list';

/** A fake page made a view tab, as main's PaneViews makes the pages it spawns. */
function spawnView(h: any, history?: any) {
  const v = new PaneViews({
    WebContentsView: class {
      webContents: any;
      constructor(o: any) {
        this.webContents = o.webContents;
      }
      setBounds() {}
    },
    BrowserWindow: class {
      contentView = { addChildView() {}, removeChildView() {} };
      isDestroyed() {
        return false;
      }
      setContentSize() {}
      destroy() {}
    },
    session: () => null,
    partition: () => 'persist:browser',
    windowOf: () => null,
  });
  const wc = v.adopt(h.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } })).wc;
  // a duplicate's view gets its history first, as app/browserTools.cjs spawnView writes it
  Object.assign(wc, { url: history ? '' : 'about:blank', getZoomFactor: () => 1 });
  if (history) restoreHistory(wc, history).catch(() => undefined);
  return wc;
}

/** The kit's routing world with the real browser_* tools over a BrowserTabs whose chat `c` has a tab on LIST after A. */
function app(t: any) {
  const spawned: any[] = [];
  const h = setup(t, { spawn: (_c: string, hh: any, history?: any) => (spawned.push(spawnView(hh, history)), spawned.at(-1)) });
  h.autoAttach = false;
  const wc = h.newWC();
  Object.assign(wc, {
    url: LIST,
    entries: [
      { url: A, title: 'A' },
      { url: LIST, title: 'List' },
    ],
    index: 1,
  });
  tabOf(h, 'tab_5050aa', 'c', wc);
  const w = world();
  for (const n of ['browser_navigate', 'browser_tabs_context']) w.r.tools.delete(n);
  const grants = new OriginGrants({ anchor: () => 'default', ask: async () => null, confirmAction: async () => true });
  grants.allowInChat('c', 'https://shop.test', 'write');
  for (const tool of createBrowserTools({ tabs: h.tabs, grants })) w.r.register(tool);
  return { h, w, wc, spawned };
}

const textOf = (r: any) => (r?.content ?? r ?? []).map((c: any) => c.text ?? '').join('\n');

/** Chat `c`'s calls from a Claude Code session, a Codex thread, the chat before and after a switch, and an ACP session. */
async function harnesses(w: any) {
  const claude = claudeSession(w, { chatId: 'c', segmentId: 'claude-1' });
  const codex = codexConnection(w, () => 'c');
  const cx = await codex.session((await codex.startThread()).thread.id);
  const sw = switchingChat(w);
  sw.startOnClaude('c');
  const before = sw.claudeNow('c');
  const after = await sw.codex.session((await sw.switchTo('c', 'codex')).nativeId);
  return {
    'Claude Code': (name: string, args: any) => claude.call(name, args),
    Codex: (name: string, args: any) => cx.call(name, args),
    'Claude Code before the switch': (name: string, args: any) => before.call(name, args),
    'Codex after the switch': (name: string, args: any) => after.call(name, args),
  } as Record<string, (name: string, args: any) => Promise<any>>;
}

/**
 * The same app on real time for an ACP session, whose tool channel is a real socket: virtual time ends first. `drive`
 * then only awaits.
 */
async function overAcp(t: any) {
  t.mock.timers.reset();
  const real = { mock: { timers: { enable() {}, tick() {} } } };
  const a = app(real);
  const acp = await acpSession(a.w, { chatId: 'c' });
  return { ...a, call: (name: string, args: any) => acp.call(name, args) };
}

test('CM-K32: browser_navigate "stop" ends the load of the chat\'s tab and keeps its page, from every harness (#1362)', async (t) => {
  const { w, wc } = app(t);
  for (const [harness, call] of Object.entries(await harnesses(w))) {
    wc.loading = true;
    const stops = wc.stops;
    const out = textOf(await drive(t, call('browser_navigate', { url: 'stop', tabId: 'tab_5050aa' })));
    assert.match(out, /^Stopped loading tab_5050aa; it keeps what loaded so far\./, harness);
    assert.equal(wc.stops, stops + 1, harness);
    assert.equal(wc.url, LIST, harness);
    assert.match(textOf(await drive(t, call('browser_navigate', { url: 'stop' }))), /^tab_5050aa was not loading\./, harness);
  }
  const acp = await overAcp(t);
  acp.wc.loading = true;
  assert.match(textOf(await acp.call('browser_navigate', { url: 'stop', tabId: 'tab_5050aa' })), /^Stopped loading tab_5050aa/, 'ACP');
  assert.equal(acp.wc.stops, 1, 'ACP');
});

test('CM-K33: browser_tabs_create duplicate copies a tab of the chat beside it with its history, from every harness (#1362)', async (t) => {
  const { h, w, spawned } = app(t);
  for (const [harness, call] of Object.entries(await harnesses(w))) {
    const before = spawned.length;
    const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
    await waitFor(() => spawned.length !== before, 'the duplicate tab to spawn', { step: flush });
    const copy = spawned.at(-1);
    copy.loading = false;
    copy.emit('did-stop-loading');
    const out = textOf(await drive(t, pending));
    const tab = h.tabs.current('c');
    assert.match(out, new RegExp(`^Duplicated tab_5050aa as ${tab.id}, with its back/forward history \\(2 pages\\)\\.`), harness);
    assert.deepEqual([tab.chatId, tab.wc, tab.openedByAgent], ['c', copy, true], harness);
    assert.deepEqual(
      copy.restores[0],
      {
        entries: [
          { url: A, title: 'A' },
          { url: LIST, title: 'List' },
        ],
        index: 1,
      },
      harness,
    );
    assert.equal(h.log.open.at(-1)[1].after, 'tab_5050aa', harness);
    await drive(t, h.tabs.close('c', tab.id));
  }
  // another chat's tab is no source
  const c2 = claudeSession(w, { chatId: 'c2', segmentId: 'claude-2' });
  assert.match(textOf(await drive(t, c2.call('browser_tabs_create', { duplicate: 'tab_5050aa' }))), /No tab tab_5050aa in this chat/);
  assert.equal(h.tabs.list('c2').length, 0);
  const acp = await overAcp(t);
  // an ACP session has no tool search: browser_tabs_create is in its "tabs" group, run at once through the more tool (G2)
  assert.match(textOf(await acp.call('browser_tabs_create', { duplicate: 'tab_5050aa' })), /is not loaded in this session/, 'ACP');
  const pending = acp.call('browser_more_tools', { call: 'browser_tabs_create', arguments: { duplicate: 'tab_5050aa' } });
  while (!acp.spawned.length) await flush();
  acp.spawned[0].loading = false;
  acp.spawned[0].emit('did-stop-loading');
  assert.match(textOf(await pending), /^Duplicated tab_5050aa as tab_[0-9a-f]+, with its back\/forward history \(2 pages\)\./, 'ACP');
  assert.equal(acp.h.tabs.current('c').wc, acp.spawned[0], 'ACP');
  // a native Codex thread whose Browser plugin drives the pane too is told that only browser_* stop and duplicate (its
  // tab API has neither), by the tab id the plugin lists as providerTabId
  for (const chrome of [true, false]) {
    const note = inAppBrowserNote('sage', chrome, true).value;
    assert.match(note, /browser_navigate with url "stop", or browser_tabs_create with duplicate set to the tab's providerTabId/);
  }
  assert.doesNotMatch(inAppBrowserNote('sage', true, false).value, /providerTabId/);
});

test("CM-K34: the user's Duplicate is done once the history is copied: a slow, stopped or failed load of the copy never undoes it (#1362)", async () => {
  const sender = new EventEmitter();
  const pages = new Map<number, any>();
  let id = 0;
  const page = (entries: any[], index: number) => {
    const wc: any = Object.assign(new EventEmitter(), { id: ++id, session: 's', url: '', destroyed: false, entries, index });
    Object.assign(wc, {
      isDestroyed: () => wc.destroyed,
      getURL: () => wc.url,
      close: () => ((wc.destroyed = true), wc.emit('destroyed')),
      navigationHistory: {
        getAllEntries: () => wc.entries,
        getActiveIndex: () => wc.index,
        length: () => wc.entries.length,
        getEntryAtIndex: (i: number) => wc.entries[i],
        // Electron 44: written at once; the promise is the page's load, which a slow report never finishes
        restore: (s: any) => {
          Object.assign(wc, { entries: s.entries, index: s.index });
          const load = new Promise<void>((_ok, fail) => wc.once('fail', fail));
          load.catch(() => undefined);
          return load;
        },
      },
    });
    pages.set(wc.id, wc);
    return wc;
  };
  const source = page(
    [
      { url: A, title: 'A' },
      { url: 'https://shop.test/report', title: 'Report' },
    ],
    1,
  );
  let target: any;
  const nav = new PaneNavigation({
    page: (_s: any, n: number) => pages.get(n),
    create: () => (target = page([{ url: '', title: '' }], 0)),
    chatOf: (c: string) => c,
    ownerOf: () => 'c',
  });
  nav.bind(sender, 'source', source.id, 'c');
  const { token } = nav.capture(sender, 'source', 'copy');
  nav.bind(sender, 'copy', target.id, 'c');
  assert.equal(await nav.restore(sender, token, 'copy'), true, 'done while the report still loads');
  target.emit('fail', new Error(" (-3) loading 'https://shop.test/report'"));
  await flush();
  assert.equal(target.destroyed, false);
  assert.equal(nav.get(sender, 'copy').wc, target);
});

test("CM-K35: a native Codex thread whose Browser plugin drives the pane without browser_* is sent to the pane's own Stop and Duplicate, never to computer use on MoPilot (#1362)", () => {
  const iab = { available: () => true, has: (id: string) => id === 'th', loaded: () => null };
  /** The note on the thread's first turn/start, as main's CodexToolInjection writes it. */
  const note = (o: any) => {
    const inj = new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/bin/sage-mcp',
      socketPath: '/tmp/s.sock',
      harnessPid: () => 1,
      nativeEnabled: () => true,
      nativeSurfaces: () => ({ chrome: false, computer: true }),
      browserBackends: iab,
      chromeInstances: () => null,
      ...o,
    });
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    inj.observe({ id: 1, result: { thread: { id: 'th' } } });
    return inj.turnContext('th')?.context.value ?? '';
  };
  const userControls =
    /You cannot do those two yourself: ask the user to click Stop in the pane's toolbar, or Duplicate in the tab's right-click menu, and carry on with the rest of the task/;
  const noSelf =
    /Never use Computer Use on MoPilot \(the app named MoPilot, its window, chat list or pane controls\) to reach the pane: computer use never controls MoPilot, and MoPilot stops a turn whose program names it\./;
  // no sage-mcp in this run (a checkout that never built it), or sage-mcp without browser_* (a kill switch): the pane's controls
  for (const [why, o] of [
    ['no sage-mcp', { hasTools: () => false }],
    ['no browser_*', { visibleTools: () => ['web_fetch'] }],
  ] as const) {
    const value = note(o);
    assert.match(value, /In the Browser plugin's "iab" browser while its name is "MoPilot In-app Browser"/, why);
    // the plugin's iab browser stays the way to the pane: only the two actions go to the user
    assert.match(value, /it is how you open, read and act on pages in the pane, so use it for the task as usual/, why);
    assert.match(value, /Only two pane actions are not in its tab API: stopping a page that keeps loading, and duplicating a tab/, why);
    assert.match(value, userControls, why);
    assert.match(value, /Open the same URL in a new tab only when the user wants the page and not its history/, why);
    assert.match(value, noSelf, why);
    assert.doesNotMatch(value, /browser_navigate with url "stop"/, why);
  }
  // with browser_*: they stop and duplicate, and computer use on MoPilot is still never the way
  const tools = note({ visibleTools: () => ['browser_navigate', 'browser_tabs_create'] });
  assert.match(tools, /browser_navigate with url "stop"/);
  assert.match(tools, noSelf);
  assert.doesNotMatch(tools, userControls);
  // a thread whose plugin has no iab backend (the pane is not its browser) is told none of it
  assert.deepEqual(notesWithoutBrowserTools(null, 'CHROME RULE', false), ['CHROME RULE']);
  // the pane's payments, its limits and its bot-check rule (#1615)
  assert.equal(notesWithoutBrowserTools(null, null, true).length, 3);
});
