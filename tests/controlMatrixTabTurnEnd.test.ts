// The control matrix (docs/control-plane/matrix.md), group T: what an agent is told about the turn end of the tabs it
// opens (#1621). Built-in browser tabs an agent opens close at turn end unless marked (CM-T01); every tool that opens a
// tab says so, the blank tab browser_tabs_context opens included, and browser_tabs_mark offers a mark for a tab the user
// asked to keep for a later message. Chrome keeps the chat's whole group across turns without marks. The tool specs, the
// surface note, BrowserTabs (browser-host-kit), the browser_* handlers and the host over Chrome are real; Electron and
// Chrome are fakes. The host is keyed by MoPilot's chat id, so this holds for every harness and across a switch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { drive, setup as browserHost } from './support/browser-host-kit.ts';
import { extensionWorld } from './support/chrome-extension-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { SPECS } = require('../electron/capabilities/browser/hostToolSpecs.cjs');
const { SCRIPT_SPEC } = require('../electron/capabilities/browser/script.cjs');
const { TOOLS: CHROME_TOOLS } = require('../electron/capabilities/browser/chromeTools.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { surfaceNote } = require('../electron/capabilities/contract/surfaceNote.cjs');

const worlds: any[] = [];
after(() => {
  for (const w of worlds) w.stop();
});

/** Every agent-facing browser tool description, by the name the agent sees. */
function descriptions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, spec] of Object.entries<any>(SPECS)) out[name] = spec.description;
  out.browser_script = SCRIPT_SPEC.description;
  for (const [name, spec] of Object.entries<any>(CHROME_TOOLS)) out[`chrome_${name}`] = spec.description;
  return out;
}

/** The tools whose call opens a tab of the chat: on purpose, or because the chat has none. */
const OPENERS = [
  'browser_navigate',
  'browser_tabs_context',
  'browser_tabs_create',
  'browser_script',
  'chrome_navigate',
  'chrome_tabs_context_mcp',
  'chrome_tabs_create_mcp',
];

test('CM-T07: every tool that opens a tab states its backend lifetime at turn end, the blank tab included (#1621)', () => {
  const all = descriptions();
  for (const name of OPENERS.filter((name) => name.startsWith('browser_')))
    assert.match(all[name], /close[sd]? when your turn ends/, `${name} states the built-in browser turn end`);
  // any other description that says it opens a tab states it too, so a new opener can't leave it out
  const opens =
    /\b(open|opens|opened)\b (a |an |one |the )?(new |blank |empty |new empty )?tabs?\b|\bone (is opened|opens)\b|\btabs? (opens|is opened)\b|\bgets (a tab|one)\b/i;
  const found = Object.keys(all).filter((name) => opens.test(all[name]));
  assert.deepEqual(found.sort(), [...OPENERS].sort(), 'the descriptions that say they open a tab are the openers');
  for (const name of found) assert.match(all[name], /turn ends/, `${name} opens a tab and states the turn end`);
  // the blank tab browser_tabs_context and browser_navigate open for a chat with none is one the agent opened
  assert.match(all.browser_tabs_context, /Opens a blank tab when the chat has none.*including implicit tabs, are temporary/);
  assert.match(all.browser_navigate, /Opens a tab when the chat has none.*including implicit tabs, are temporary/);
  // in the built-in browser a mark keeps it; Chrome's group keeps every tab at turn end without a mark
  for (const name of ['browser_navigate', 'browser_tabs_context', 'browser_tabs_create', 'browser_script'])
    assert.match(all[name], /mark/, `${name} says how to keep a tab`);
  for (const name of ['chrome_navigate', 'chrome_tabs_context_mcp', 'chrome_tabs_create_mcp']) {
    assert.match(all[name], /stay in this chat's group when your turn ends/, name);
    assert.match(all[name], /Explicit close removes a tab; idle, archive or clear releases the group and leaves its tabs open/, name);
    assert.doesNotMatch(all[name], /close[sd]? when your turn ends|except the one you used last/, name);
    assert.doesNotMatch(all[name], /browser_tabs_mark/, `${name} names no mark it does not have`);
  }
});

test('CM-T07: browser_tabs_mark covers a tab the user asked to keep for a later message, and asks the agent to mark every tab it says stays open', () => {
  const mark = SPECS.browser_tabs_mark;
  assert.match(mark.description, /"deliverable": .*user explicitly asks to keep it open/);
  assert.match(mark.description, /later message/);
  assert.match(mark.description, /Mark each requested tab before ending your turn and before promising it will stay open/);
  assert.match(mark.description, /later turns too/);
  // a tab or window a page opened from the agent's tab (a link, a pop-up) is one it opened too
  assert.match(mark.description, /tabs or windows pages open from temporary tabs/);
  assert.match(mark.inputSchema.properties.status.description, /later message at their request/);
  // the surface note says it once for the session, under the names it sees, only where the mark exists
  const note = surfaceNote(['browser_tabs_context', 'browser_tabs_mark'], { yourChrome: false });
  assert.match(
    note,
    /Tabs these tools open in the built-in browser, including implicit tabs and tabs or windows pages open from temporary tabs.*unmarked tabs close when your turn ends/,
  );
  assert.match(note, /browser_tabs_mark with status "deliverable" on each tab.*before your turn ends and before promising/);
  assert.doesNotMatch(surfaceNote(['browser_navigate'], { yourChrome: false }), /browser_tabs_mark/);
  assert.match(
    surfaceNote(['chrome_tabs_create_mcp'], { yourChrome: false }),
    /Tabs you open in the user's Chrome stay in this chat's group when your turn ends.*idle, archive or clear releases the group and leaves its tabs open/,
  );
  assert.doesNotMatch(surfaceNote(['desktop_left_click'], { yourChrome: false }), /Tabs you open/);
  // the older sage_browser_* tools drive one tab the chat keeps (it is not the agent's to close), in the pane or Your Chrome
  assert.doesNotMatch(surfaceNote(['sage_browser_click'], { yourChrome: false }), /Tabs you open/);
  assert.doesNotMatch(surfaceNote(['sage_browser_click'], { yourChrome: true }), /Tabs you open/);
});

/** The browser_* handlers over a real BrowserTabs, in chat `c`. */
function toolsOver(t: any) {
  const h = browserHost(t, { attachMs: 1000 });
  const grants = new OriginGrants({ anchor: () => 'default', ask: async () => ({ decision: 'allow', scope: 'chat', level: 'write' }) });
  const tools = new Map<string, any>(createBrowserTools({ tabs: h.tabs, grants }).map((x: any) => [x.name, x]));
  const ctx = { chatId: 'c', segmentId: 's1', signal: new AbortController().signal };
  const call = (name: string, args: any = {}) => drive(t, tools.get(name).handler(args, ctx));
  return { h, call };
}

test("CM-T08: #1621's journey: the blank tab tabs_context opened and a tab tabs_create opened both stay for the next message when marked, on any harness", async (t) => {
  const { h, call } = toolsOver(t);
  await call('browser_tabs_context');
  const [a] = h.tabs.list('c');
  assert.equal(a.created, true, 'the blank tab tabs_context opened is one the agent opened');
  await call('browser_tabs_create');
  const b = h.tabs.list('c').find((x: any) => x !== a);
  await drive(t, h.tabs.ready(b, 'c'));
  await call('browser_tabs_mark', { tabId: a.id, status: 'deliverable' });
  await call('browser_tabs_mark', { tabId: b.id, status: 'deliverable' });
  // message 1 ends; message 2 (the same chat on another harness after a switch: the host is keyed by the chat) ends too
  assert.deepEqual((await drive(t, h.tabs.turnEnded('c'))).closed, []);
  assert.deepEqual((await drive(t, h.tabs.turnEnded('c'))).closed, []);
  assert.deepEqual(
    h.tabs.list('c').map((x: any) => x.id),
    [a.id, b.id],
  );
});

test("CM-T08: unmarked, the turn end closes the blank tab tabs_context opened and keeps only the turn's result (what the descriptions now say)", async (t) => {
  const { h, call } = toolsOver(t);
  await call('browser_tabs_context');
  const [a] = h.tabs.list('c');
  await call('browser_tabs_create');
  const b = h.tabs.list('c').find((x: any) => x !== a);
  await drive(t, h.tabs.ready(b, 'c'));
  const { closed, kept } = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(closed, [a.id]);
  assert.deepEqual(kept, [b.id]);
});

test('CM-T08: a tab a page opened from an agent tab (a link with target=_blank) closes at the turn end unless marked, as the mark text says', async (t) => {
  const { h, call } = toolsOver(t);
  await call('browser_tabs_create');
  const [opener] = h.tabs.list('c');
  const kept = h.tabs.adoptPopup(opener.wc, h.newWC(), { asTab: true });
  const dropped = h.tabs.adoptPopup(opener.wc, h.newWC(), { asTab: true });
  assert.equal(kept.created, true, "a page's tab from the agent's tab is the agent's");
  await call('browser_tabs_mark', { tabId: kept.id, status: 'deliverable' });
  await drive(t, h.tabs.ready(opener, 'c'));
  const { closed } = await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(closed, [dropped.id]);
  assert.equal(kept.closed, false);
});

test("CM-T08: in the user's Chrome every unmarked tab stays in the same group across turns, as the descriptions say", async () => {
  const w = await extensionWorld();
  worlds.push(w);
  const images = { fromBuffer: (b: Buffer) => ({ b, isEmpty: () => false, toBitmap: () => Buffer.from([255, 255, 255, 255]) }) };
  const tabs = chromeBrowserTabs({ relay: w.channel, images, idleMs: 60_000 });
  const first = await tabs.create('c');
  const last = await tabs.create('c');
  const group = w.chrome.tabsById.get(first.wc.tabId).groupId;
  for (const tab of [last, first]) {
    await tabs.ready(tab, 'c');
    const { closed, kept } = await tabs.turnEnded('c');
    assert.deepEqual(closed, []);
    assert.deepEqual(kept.sort(), [first.id, last.id].sort());
    assert.ok([first, last].every((t) => w.chrome.tabsById.get(t.wc.tabId)?.groupId === group));
    assert.ok([first, last].every((t) => !t.wc.debugger.isAttached() && !t.result));
  }
  tabs.dispose();
});
