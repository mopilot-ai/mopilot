// Control-matrix cases for attaching a screenshot of a Chrome page to a form from a native Codex thread whose Browser plugin
// drives the user's Chrome through MoPilot's Chrome backend (#1539): browser_save_screenshot takes the plugin's Chrome
// tab by its providerTabId and saves it into the chat's upload folder for chooser.setFiles; the other Chrome controllers
// get an accurate refusal with a next step.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeTabs, OriginGrants, ToolError, code } from './support/browser-host-tools/fixture.ts';
import { browserToolSpecs } from './support/tool-specs.ts';

export const GUARDS = ['electron/app/', 'electron/capabilities/', 'shared/'];

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { chromeScreenshots } = require('../electron/capabilities/browser/chromeScreenshots.cjs');
const { ScreenshotShelf, SUBFOLDER } = require('../electron/capabilities/browser/hostScreenshots.cjs');
const { inAppBrowserNote } = require('../electron/capabilities/channels/codexThreadContracts.cjs');
const { chromeBackendNote } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { chromeScreenshotHint, screenshotUploadHint } = require('../electron/capabilities/browser/iabBackend/protocol.cjs');
const { setupChromeRelay } = require('../electron/app/chromeRelay.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');

const bases: string[] = [];
after(() => {
  for (const b of bases) fs.rmSync(b, { recursive: true, force: true });
});

const PANE = Buffer.from('jpeg-bytes-of-the-pane-page').toString('base64');
const CHROME = Buffer.from('jpeg-bytes-of-the-chrome-page').toString('base64');
const ID = /Screenshot ID: (ss_[0-9a-f]{8})\./;

/** A fake host whose resolve answers only its own tab ids, as BrowserTabs.resolve does. */
function host(id: string, url: string, data: string) {
  const tabs = makeTabs();
  Object.assign(tabs.tab, { id, url, title: 'Page', backend: { tabId: 7 } });
  tabs.impl.resolve = async (_chatId: string, tabId: unknown) => {
    if (tabId == null || tabId === id) return tabs.tab;
    throw new ToolError(`No tab ${String(tabId)} in this chat. Call browser_tabs_context to list this chat's tabs.`, 'bad_args');
  };
  tabs.impl.capture = async () => ({ width: 800, height: 600, data });
  return tabs;
}

/**
 * The browser_* tools over the pane (tab_p1) with browser_save_screenshot's Chrome saver over the chat's Chrome group
 * (tab_c1, Chrome's own site table), and the chrome_* tools on the same Chrome host and shelf.
 */
function world(
  o: { enabled?: () => true | string; chromeRoute?: (chatId: string) => string | null; denyChrome?: boolean; toolsOn?: () => boolean } = {},
) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'chromeshot-'));
  bases.push(base);
  const uploads = path.join(base, 'uploads', 'c1');
  const folders = () => ({ uploads, downloads: path.join(base, 'downloads') });
  const pane = host('tab_p1', 'https://docs.test/a', PANE);
  const chrome = host('tab_c1', 'https://mail.test/inbox/42', CHROME);
  const grants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({ decision: 'deny' }) });
  grants.set('https://docs.test', 'write');
  const chromeGrants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({ decision: 'deny' }) });
  chromeGrants.set('https://mail.test', 'write');
  // a high-risk page asks before anything reads it, and the user says no
  if (o.denyChrome) chrome.tab.url = 'https://www.chase.com/accounts';
  chromeGrants.set('https://tracker.test', 'write');
  const asks: any[] = [];
  const confirm = async (_ctx: any, req: any) => (asks.push(req), true);
  const shelf = new ScreenshotShelf();
  const chromeShots = chromeScreenshots({
    tabs: chrome,
    grants: chromeGrants,
    folders,
    shelf,
    enabled: o.enabled ?? (() => true),
    ...(o.toolsOn ? { toolsOn: o.toolsOn } : {}),
  });
  const tools = createBrowserTools({ tabs: pane, grants, folders, confirm, chromeShots, chromeRoute: o.chromeRoute ?? null });
  const chromeTools = createChromeTools({ tabs: chrome, grants: chromeGrants, folders, confirm, shelf });
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const call = (name: string, args: any = {}) => tools.find((t: any) => t.name === name).handler(args, ctx);
  const callChrome = (name: string, args: any = {}) => chromeTools.find((t: any) => t.name === `chrome_${name}`).handler(args, ctx);
  return { uploads, pane, chrome, asks, call, callChrome };
}
const textOf = (out: any[]) =>
  out
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

test("CM-B32: a native Codex thread on MoPilot's Chrome backend saves its Chrome tab with browser_save_screenshot and is told to pass the file to setFiles; the id outlives a switch", async () => {
  const w = world();
  const out = await w.call('browser_save_screenshot', { tabId: 'tab_c1', name: 'invoice' });
  const file = path.join(fs.realpathSync(w.uploads), SUBFOLDER, 'invoice.jpg');
  // the Chrome page, captured on the Chrome host: the pane is not touched
  assert.equal(fs.readFileSync(file, 'base64'), CHROME);
  assert.equal(w.chrome.called('capture').length, 1);
  assert.deepEqual(w.pane.called('capture'), []);
  const text = textOf(out);
  assert.match(
    text,
    new RegExp(`^Saved a screenshot of the viewport of tab_c1 \\(800x600\\) to ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.`),
  );
  assert.match(
    text,
    /Pass that file's path to chooser\.setFiles\(\.\.\.\) on the Browser plugin's Chrome tab \(MoPilot's Chrome\), as for any file; the user confirms each upload\. Tab tab_c1 is at https:\/\/mail\.test\/inbox\/42/,
  );
  // the id line says the same, never the pane's browser_file_upload
  const id = (text.match(ID) || [])[1];
  assert.ok(id);
  assert.match(text, new RegExp(`Screenshot ID: ${id}\\. Pass that file's path to chooser\\.setFiles`));
  assert.doesNotMatch(text, /browser_file_upload/);
  assert.deepEqual(
    out.filter((c: any) => c.type === 'image'),
    [{ type: 'image', data: CHROME, mimeType: 'image/jpeg' }],
  );

  // the chat switches to Claude Code or ACP: chrome_upload_image attaches the same screenshot, after the upload card
  w.chrome.tab.url = 'https://tracker.test/new';
  await w.callChrome('upload_image', { imageId: id, ref: 'ref_3', tabId: 7 });
  assert.deepEqual(w.chrome.called('setFiles'), [[w.chrome.tab, 'ref_3', [file]]]);
  assert.equal(w.asks.length, 1);

  // the pane's own tab, and no tab at all, stay the pane's
  const own = await w.call('browser_save_screenshot', { tabId: 'tab_p1' });
  assert.match(
    textOf(own),
    /of tab_p1 .*Attach it with browser_file_upload \(paths: \[that file\], or screenshots: \["ss_[0-9a-f]{8}"\]\)/,
  );
  assert.match(textOf(own), /To attach it to a file input, give it in browser_file_upload's screenshots\./);
  await w.call('browser_save_screenshot', {});
  assert.equal(w.pane.called('capture').length, 2);
  assert.equal(w.chrome.called('capture').length, 1);
});

test("CM-B32b: a Chrome tab's screenshot reads through Chrome's site table and its switch; an unknown tab names the chat's other Chrome controller and what to do", async () => {
  // Chrome's own table: a site it doesn't allow is not captured, and the refusal names Chrome
  const denied = world({ denyChrome: true });
  await assert.rejects(denied.call('browser_save_screenshot', { tabId: 'tab_c1' }), (e: any) => {
    assert.equal(e.code, 'denied');
    assert.match(e.message, /browser="chrome"/);
    return true;
  });
  assert.deepEqual(denied.chrome.called('capture'), []);
  assert.equal(fs.existsSync(path.join(denied.uploads, SUBFOLDER)), false);

  // MoPilot serves the user's Chrome no more: the switch's reason, nothing captured
  const off = world({ enabled: () => 'Chrome control through MoPilot is turned off.' });
  await assert.rejects(
    off.call('browser_save_screenshot', { tabId: 'tab_c1' }),
    code('disabled', /^Chrome control through MoPilot is turned off\./),
  );
  const offBool = world({ enabled: () => false as any });
  await assert.rejects(offBool.call('browser_save_screenshot', { tabId: 'tab_c1' }), code('disabled', /^Chrome control is turned off\./));
  assert.deepEqual(off.chrome.called('capture'), []);

  // an id neither browser has: as before, unless the chat's Chrome is another controller's (vendor plugin, Claude in Chrome)
  const plain = world();
  await assert.rejects(plain.call('browser_save_screenshot', { tabId: 'tab_x9' }), code('bad_args', /^No tab tab_x9 in this chat\.[^]*$/));
  await assert.rejects(plain.call('browser_save_screenshot', { tabId: 'tab_x9' }), (e: any) => !/This chat's browser is/.test(e.message));
  const vendor = world({ chromeRoute: () => 'the Codex Browser plugin in your Chrome' });
  await assert.rejects(vendor.call('browser_save_screenshot', { tabId: '42' }), (e: any) => {
    assert.equal(e.code, 'bad_args');
    assert.match(
      e.message,
      /^No tab 42 in this chat\. Call browser_tabs_context to list this chat's tabs\. This chat's browser is the Codex Browser plugin in your Chrome, whose tabs browser_save_screenshot can't capture\. To attach a screenshot of a page there, use that controller's own screenshot upload where it has one, or open the page in the built-in browser \(browser_navigate\) and save it there; otherwise ask the user to attach the file\./,
    );
    return true;
  });
  // a refusal that is not about the tab passes through unchanged
  const busy = world({ chromeRoute: () => 'Claude in Chrome' });
  busy.pane.impl.resolve = async () => {
    throw new ToolError('This chat already has 10 tabs.', 'limit');
  };
  await assert.rejects(busy.call('browser_save_screenshot', { tabId: 'tab_x9' }), code('limit', /^This chat already has 10 tabs\.$/));
});

test("CM-B32e: a Chrome tab named by Chrome's own id (as chrome_tabs_context_mcp lists it) is saved too; with the chrome_* tools on, the result says to attach it with them", async () => {
  const { checkArgs } = require('../electron/capabilities/contract/registry.cjs');
  const spec = browserToolSpecs().find((t: any) => t.name === 'browser_save_screenshot');
  // a number passes the tool's own schema (the shipped VM run: "argument tabId must be string")
  assert.equal(checkArgs(spec.inputSchema, { tabId: 7 }), null);
  assert.equal(checkArgs(spec.inputSchema, { tabId: 'tab_c1' }), null);
  let toolsOn = true;
  const w = world({ toolsOn: () => toolsOn });
  for (const tabId of [7, '7']) {
    const text = textOf(await w.call('browser_save_screenshot', { tabId }));
    // the tab is named as the caller named it, never by the host's own id
    assert.match(text, /^Saved a screenshot of the viewport of 7 \(800x600\) to /);
    assert.doesNotMatch(text, /tab_c1/);
    const id = (text.match(ID) || [])[1];
    assert.match(
      text,
      new RegExp(
        `Attach it with chrome_upload_image \\(imageId: "${id}", ref: the file input\\) or chrome_file_upload \\(screenshots: \\["${id}"\\]\\); the user confirms each upload\\. Tab 7 is at https://mail\\.test/inbox/42`,
      ),
    );
    assert.match(text, new RegExp(`Screenshot ID: ${id}\\. Attach it with chrome_upload_image`));
  }
  assert.equal(w.chrome.called('capture').length, 2);
  assert.deepEqual(w.pane.called('capture'), []);
  // the chrome_* tools off (MoPilot's Chrome backend): the plugin's setFiles
  toolsOn = false;
  assert.match(textOf(await w.call('browser_save_screenshot', { tabId: 7 })), /Pass that file's path to chooser\.setFiles/);
  // a saved name that contains the host id keeps it in the path; the tab is still named by Chrome's id
  const named = textOf(await w.call('browser_save_screenshot', { tabId: 7, name: 'tab_c1-invoice' }));
  assert.match(named, /^Saved a screenshot of the viewport of 7 \(800x600\) to \S+\/screenshots\/tab_c1-invoice\.jpg\. /);
  assert.ok(fs.existsSync(path.join(fs.realpathSync(w.uploads), SUBFOLDER, 'tab_c1-invoice.jpg')));
  // a refusal names the tab the caller's way too
  w.chrome.tab.dialog = { type: 'alert' };
  w.chrome.impl.ready = async () => {
    throw new ToolError('An alert dialog is open on tab tab_c1.', 'dialog_open');
  };
  await assert.rejects(w.call('browser_save_screenshot', { tabId: 7 }), code('dialog_open', /^An alert dialog is open on tab 7\./));
  // another number, or one that only looks like the host id, is no tab of either browser
  await assert.rejects(w.call('browser_save_screenshot', { tabId: 8 }), code('bad_args', /^No tab 8 in this chat\./));
  await assert.rejects(w.call('browser_save_screenshot', { tabId: 'tab_c' }), code('bad_args', /^No tab tab_c in this chat\./));
});

test("CM-B32c: a Codex thread on MoPilot's Chrome backend is told how to save its Chrome tab; a thread on the vendor's Chrome is not", () => {
  const hint = chromeScreenshotHint('sage');
  assert.match(hint, /browser_save_screenshot of the sage MCP server \(tabId: the plugin's Chrome tab's providerTabId/);
  assert.match(
    hint,
    /pass the file path it returns to chooser\.setFiles\. Save it while the tab still shows that page: the plugin's own screenshots are images, not files, and a later save captures what the tab shows then\.$/,
  );
  const own = chromeBackendNote('th-1');
  for (const iab of [true, false]) {
    const note = inAppBrowserNote('sage', true, iab, null, own).value;
    assert.ok(note.endsWith(hint), `said once, last (iab: ${iab})`);
    assert.equal(note.split(hint).length, 2);
    // the vendor's Chrome (no backend note): only the pane's hint, where the plugin has the pane
    const vendor = inAppBrowserNote('sage', true, iab, null, null).value;
    assert.ok(!vendor.includes(hint));
    assert.equal(vendor.includes(screenshotUploadHint('sage')), iab);
  }
});

test('CM-B32d: main serves the Chrome saver while either Chrome path is on, on the chrome_* tools’ shelf', async () => {
  const on = new Set<string>();
  const registry = new Registry();
  const s = setupChromeRelay({
    registry,
    grants: { browser: 'chrome', peek: () => 'ok', turnEnded: () => undefined, riskOf: () => ({ level: 'normal' }) },
    token: () => 'tok',
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: (k: string) => on.has(k),
    open: async () => undefined,
  });
  try {
    // no such tab in the chat's Chrome group: the pane keeps the id
    assert.equal(s.screenshots('c', 'tab_c1'), null);
    s.tabs.list = () => [{ id: 'tab_c1' }];
    const save = s.screenshots('c', 'tab_c1');
    assert.equal(typeof save, 'function');
    await assert.rejects(save({ tabId: 'tab_c1' }, { chatId: 'c' }), code('disabled', /Chrome control through MoPilot is turned off/));
    // a native Codex thread's plugin on MoPilot's Chrome backend (the chrome_* tools off): past the switch, to the tab
    on.add('native.codex.enabled').add('codex.browser.chromeExtension');
    // the Chrome host itself answers: it has no such tab really (only the list was faked)
    await assert.rejects(save({ tabId: 'tab_c1' }, { chatId: 'c' }), code('bad_args', /^No tab tab_c1 in this chat/));
  } finally {
    s.stop();
  }
});
