// Control-matrix cases for file uploads in the user's Chrome (group Z): a refusal names the extension that serves the chat, and
// a Codex thread is told how to see that an upload worked (bu3: the Codex plugin relayed the ChatGPT extension's fix).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { extensionWorld } from './support/chrome-extension-kit.ts';
import { playExtension } from './support/chrome-relay-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];

const require = createRequire(import.meta.url);
const { ChromeRelay } = require('../electron/capabilities/browser/chromeRelay.cjs');
const { chromeBackendNote } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { UPLOAD_HINT } = require('../electron/capabilities/browser/iabBackend/protocol.cjs');
const { inAppBrowserNote } = require('../electron/capabilities/channels/codexThreadContracts.cjs');

const stops: (() => void)[] = [];
after(() => {
  for (const s of stops) s();
});
const code = (c: string, re?: RegExp) => (e: any) => e?.code === c && (!re || re.test(e.message));
/** What chrome.debugger.sendCommand rejects with when the extension may not read local files. */
const NOT_ALLOWED = () => new Error('{"code":-32000,"message":"Not allowed"}');

test('CM-Z27: a file upload Chrome refuses for want of file access says which extension to give it, the one serving the chat', async () => {
  // MoPilot's own extension
  const w = await extensionWorld();
  stops.push(w.stop);
  await w.channel.connect('c');
  const started = w.channel.token('c');
  const tab = await w.channel.createTab(started);
  const tok = { ...started, membership: tab.membership };
  await w.channel.attach(tok, tab.id);
  w.chrome.cdp['DOM.setFileInputFiles'] = NOT_ALLOWED();
  const upload = () => w.channel.cdp(tok, { tabId: tab.id }, 'DOM.setFileInputFiles', { backendNodeId: 7, files: ['/tmp/r.txt'] });
  await assert.rejects(upload(), (e: any) => {
    assert.equal(e.code, 'file_access');
    assert.match(e.message, /click Details under "MoPilot", and turn on "Allow access to file URLs"/);
    // never the vendor's own wording, which the Codex plugin would replace with the ChatGPT extension's fix
    assert.notEqual(e.message, 'Not allowed');
    assert.doesNotMatch(e.message, /ChatGPT/);
    return true;
  });
  // any other refusal of an upload, and the same words from another command, pass through as Chrome said them
  w.chrome.cdp['DOM.setFileInputFiles'] = new Error('No node with given id found');
  await assert.rejects(upload(), code('failed', /No node with given id found$/));
  w.chrome.cdp['DOM.setFileInputFiles'] = {};
  await upload();
  w.chrome.cdp['Page.navigate'] = NOT_ALLOWED();
  await assert.rejects(w.channel.cdp(tok, { tabId: tab.id }, 'Page.navigate', { url: 'https://a.test/' }), code('failed', /Not allowed/));

  // the Playwright Extension behind MoPilot's relay names itself
  const x = playExtension();
  const relay = new ChromeRelay({ openPage: x.openPage, connectMs: 2000, commandMs: 1000 });
  stops.push(() => relay.stop());
  const link = await relay.connect('p');
  const ptok = relay.token('p');
  x.chrome.cdp['DOM.setFileInputFiles'] = NOT_ALLOWED();
  await assert.rejects(
    relay.cdp(ptok, { tabId: link.connectTab }, 'DOM.setFileInputFiles', { backendNodeId: 1, files: ['/tmp/r.txt'] }),
    code('file_access', /click Details under "Playwright Extension"/),
  );
});

test("CM-Z28: a Codex thread on MoPilot's browsers is told how to tell an upload worked: the input's value, never the plugin element's missing files, and not the ChatGPT extension's fix", () => {
  // bu3: setFiles had attached the file, but evaluate()'s read-only element has no `files`, so the model read [] and
  // relayed the plugin's troubleshooting for the ChatGPT extension
  assert.match(UPLOAD_HINT, /`el\.files` reads empty/);
  assert.match(UPLOAD_HINT, /check the input's `value` \(it reads C:\\fakepath\\<file name>/);
  assert.match(UPLOAD_HINT, /troubleshooting about the ChatGPT browser extension does not apply/);
  // the user's Chrome through MoPilot's extension, and the in-app browser served to the plugin, say it
  assert.ok(chromeBackendNote('th-1').endsWith(UPLOAD_HINT));
  for (const chrome of [true, false]) assert.ok(inAppBrowserNote('sage', chrome, true).value.endsWith(UPLOAD_HINT));
  // once, when the thread has both MoPilot's Chrome backend and the in-app one
  const both = inAppBrowserNote('sage', true, true, null, chromeBackendNote('th-1')).value;
  assert.equal(both.split(UPLOAD_HINT).length, 2);
  // where the plugin has no MoPilot browser (browser_* only, or the vendor's own Chrome) it isn't said
  for (const chrome of [true, false])
    assert.doesNotMatch(inAppBrowserNote('sage', chrome, false).value, /File uploads with the Browser plugin/);
});
