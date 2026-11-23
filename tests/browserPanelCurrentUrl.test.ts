// PanelBrowser.currentUrl (electron/capabilities/browser/cdp.cjs): what a chat's panel tab shows, read without opening
// one, for MoMo's trust gate (#2283): none before a tab attaches or after it went away, its page's URL while it lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PanelBrowser } = require('../electron/capabilities/browser/cdp.cjs');

function fakeWc(o: Record<string, any> = {}) {
  const wc: any = new EventEmitter();
  Object.assign(wc, { id: Math.floor(Math.random() * 1e6), destroyed: false, type: 'webview', prefs: {}, url: 'about:blank' }, o);
  wc.isDestroyed = () => wc.destroyed;
  wc.getType = () => wc.type;
  wc.getLastWebPreferences = () => wc.prefs;
  wc.getURL = () => wc.url;
  return wc;
}

test('currentUrl reads the chat’s tab without opening one', () => {
  const panelSession = { name: 'persist:browser' };
  const ui = fakeWc({ type: 'window', session: { name: 'default' } });
  const guest = fakeWc({ session: panelSession, hostWebContents: ui });
  const opened: string[] = [];
  const panel = new PanelBrowser({ appContents: () => [ui], panelSession: () => panelSession, open: (id: string) => opened.push(id) });
  assert.equal(panel.currentUrl('c1'), null);
  panel.attach('c1', guest, ui);
  guest.url = 'https://bank.example/';
  assert.equal(panel.currentUrl('c1'), 'https://bank.example/');
  guest.destroyed = true;
  assert.equal(panel.currentUrl('c1'), null, 'a tab that went away shows nothing');
  assert.deepEqual(opened, [], 'never opens a tab');
});
