// The page-tree switch for the chrome_* tools (#1699 gap 1, shared.browser.chromePageTree): navigate and a computer click
// also answer with the page's interactive elements, as the ChatGPT extension's goto and click do, so no read_page is
// needed after them. Off, the answers are as before; a tree that can't be read leaves the action's answer alone.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pageChrome, playExtension } from './support/chrome-relay-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBrowserTabs } = require('../electron/capabilities/browser/chromeHost.cjs');
const { createChromeTools, PREFIX } = require('../electron/capabilities/browser/chromeTools.cjs');

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
const grants = {
  anchor: () => 'full',
  peek: () => 'ok',
  require: async () => undefined,
  riskOf: () => ({ level: 'normal' }),
  act: async () => undefined,
};
const text = (out: any[]) => out.map((c) => c.text).join('\n');

function world(
  pageTree: boolean | (() => boolean),
  tree: any = { lines: ['button "Check out" [ref_1]'], truncated: false },
  pageText: boolean | (() => boolean) = false,
) {
  const x = playExtension();
  pageChrome(x);
  // the page agent answers every call with a quiet visible page and, for read_page, these lines
  x.chrome.cdp['Runtime.evaluate'] = (p: any) =>
    String(p.expression).includes('navigator.userAgent')
      ? { result: { value: 'Chrome/140' } }
      : { result: { value: { value: { quietMs: 1000, visibility: 'visible', ...tree }, seq: 0 } } };
  const r = new ChromeRelay({ openPage: x.openPage, connectMs: 2000, commandMs: 1000 });
  relays.push(r);
  const tabs = chromeBrowserTabs({ relay: r, images: { fromBuffer: () => image() } });
  const tools = new Map<string, any>(
    createChromeTools({
      tabs,
      grants,
      pageTree: typeof pageTree === 'function' ? pageTree : () => pageTree,
      pageText: typeof pageText === 'function' ? pageText : () => pageText,
    }).map((t: any) => [t.name.slice(PREFIX.length), t]),
  );
  const call = (name: string, args: any = {}) => tools.get(name).handler(args, { chatId: 'c', segmentId: 's' });
  return { call, tabs };
}

test('page tree on: navigate answers with the page’s interactive elements, without a second browser_state', async () => {
  const { call, tabs } = world(true);
  await call('tabs_context_mcp');
  const id = tabs.current('c').wc.tabId;
  const out = text(await call('navigate', { url: 'https://example.com/', tabId: id }));
  assert.match(out, /Navigated \d+ to https:\/\/example\.com\//);
  assert.match(
    out,
    /The page now \(no read_page needed unless you need more\): Page \d+: Example Domain .*interactive elements.*\nbutton "Check out" \[ref_1\]/,
  );
  assert.equal(out.match(/<browser_state>/g)?.length, 1, "the tree's own state block is left out");
  // a click answers with it too
  assert.match(text(await call('computer', { action: 'left_click', coordinate: [10, 10], tabId: id })), /The page now \(/);
});

test('page tree off, or a tool other than navigate and a click: answers as before', async () => {
  let on = false;
  const { call, tabs } = world(() => on);
  await call('tabs_context_mcp');
  const id = tabs.current('c').wc.tabId;
  assert.doesNotMatch(text(await call('navigate', { url: 'https://example.com/', tabId: id })), /The page now/);
  on = true;
  assert.doesNotMatch(text(await call('get_page_text', { tabId: id })), /The page now/);
  assert.doesNotMatch(text(await call('computer', { action: 'scroll', coordinate: [10, 10], tabId: id })), /The page now/);
});

test('page tree on: a tree that can’t be read, or reads empty, leaves the action’s answer alone', async () => {
  const broken = world(true, { lines: undefined });
  await broken.call('tabs_context_mcp');
  const id = broken.tabs.current('c').wc.tabId;
  const out = text(await broken.call('navigate', { url: 'https://example.com/', tabId: id }));
  assert.match(out, /Navigated/);
  assert.doesNotMatch(out, /The page now/);
});

test('page tree default: on for every harness, and the flag turns it off (remote config or MOPILOT_FLAGS)', () => {
  const { DEFAULTS, parseOverride } = require('../electron/platform/flags.cjs');
  assert.equal(DEFAULTS['shared.browser.chromePageTree'], true);
  assert.deepEqual(parseOverride('shared.browser.chromePageTree=0'), { 'shared.browser.chromePageTree': false });
  // the app's Chrome setup reads it on every call: off, navigate answers without the tree (tests above, pageTree false)
  const appRelay = require('../electron/app/chromeRelay.cjs');
  const seen: string[] = [];
  const r = appRelay.setupChromeRelay({
    registry: { register: (t: any) => (seen.push(t.name), () => undefined) },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: (k: string) => k !== 'shared.browser.chromePageTree',
  });
  assert.ok(seen.includes('chrome_navigate'));
  r.stop();
});

test('page text on (#3810): navigate and a click also answer with the start of the page’s text, bounded; off, or with a text that can’t be read, they do not', async () => {
  const withText = { lines: ['button "Check out" [ref_1]'], truncated: false, text: 'Dear Dario, please change your name. '.repeat(100) };
  const { call, tabs } = world(true, withText, true);
  await call('tabs_context_mcp');
  const id = tabs.current('c').wc.tabId;
  const asked: number[] = [];
  const read = tabs.pageText.bind(tabs);
  tabs.pageText = (tab: any, n: number) => (asked.push(n), read(tab, n));
  const out = text(await call('navigate', { url: 'https://example.com/', tabId: id }));
  assert.deepEqual(asked, [1500], 'the page agent is asked for about 1.5k characters');
  assert.match(out, /The page now \(/);
  const slice = out.slice(out.indexOf("The page's text (start): "));
  assert.match(slice, /^The page's text \(start\): [\s\S]*Dear Dario, please change your name\./);
  assert.equal(out.match(/<browser_state>/g)?.length, 1, 'no second state block');
  assert.match(text(await call('computer', { action: 'left_click', coordinate: [10, 10], tabId: id })), /The page's text \(start\)/);
  // the text alone, without the tree, and off
  const only = world(false, withText, true);
  await only.call('tabs_context_mcp');
  const oid = only.tabs.current('c').wc.tabId;
  const alone = text(await only.call('navigate', { url: 'https://example.com/', tabId: oid }));
  assert.match(alone, /The page's text \(start\)/);
  assert.doesNotMatch(alone, /The page now/);
  const off = world(true, withText, false);
  await off.call('tabs_context_mcp');
  assert.doesNotMatch(
    text(await off.call('navigate', { url: 'https://example.com/', tabId: off.tabs.current('c').wc.tabId })),
    /The page's text/,
  );
  // a page whose text can't be read leaves the answer alone
  const broken = world(true, withText, true);
  await broken.call('tabs_context_mcp');
  const bid = broken.tabs.current('c').wc.tabId;
  broken.tabs.pageText = async () => {
    throw new Error('page gone');
  };
  const got = text(await broken.call('navigate', { url: 'https://example.com/', tabId: bid }));
  assert.match(got, /Navigated/);
  assert.match(got, /The page now/, 'the tree still comes');
  assert.doesNotMatch(got, /The page's text/);
});

test('page text default: off, and a flag turns it on (remote config or MOPILOT_FLAGS)', () => {
  const { DEFAULTS, parseOverride } = require('../electron/platform/flags.cjs');
  assert.equal(DEFAULTS['shared.browser.chromePageText'], false);
  assert.deepEqual(parseOverride('shared.browser.chromePageText=1'), { 'shared.browser.chromePageText': true });
});

test('a navigate call reports where its time went: gate, load, settle and the page tree (#3810)', async () => {
  const { within } = require('../electron/capabilities/contract/callPhases.cjs');
  const { call, tabs } = world(true);
  await call('tabs_context_mcp');
  const id = tabs.current('c').wc.tabId;
  const phases: Record<string, [number, number]> = {};
  await within(phases, () => call('navigate', { url: 'https://example.com/', tabId: id }));
  for (const k of ['gate', 'load', 'settle', 'tree']) assert.ok(phases[k] && phases[k][1] >= 1, `${k}: ${JSON.stringify(phases)}`);
});
