// Site-permission contract unit cases for site-tables.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OriginGrants,
  BROWSERS,
  BrowserControl,
  browserPlace,
  siteRows,
  addTarget,
  ROOT,
  ctx,
  grantsFor,
  fs,
  os,
  path,
} from './fixture.ts';

export function registerSiteTables() {
  test('CM-P01: the in-app browser and Your Chrome keep separate site tables; a site allowed in one still asks in the other', async () => {
    const iabGrants = grantsFor('iab');
    const chrome = grantsFor('chrome');
    iabGrants.g.set('https://shop.test', 'write');
    // Your Chrome's tools are behind Chrome's own table, whatever the built-in browser allows
    const inst: any = {
      url: 'https://shop.test/',
      needsSnapshot: false,
      async call(name: string, args: any) {
        if (name === 'browser_navigate') inst.url = args.url;
        if (name === 'browser_evaluate') return { content: [{ type: 'text', text: 'no intent' }] };
        return { content: [{ type: 'text', text: `Page URL: ${inst.url}` }] };
      },
    };
    const registry = {
      defs: new Map<string, any>(),
      register(t: any) {
        registry.defs.set(t.name, t);
        return () => registry.defs.delete(t.name);
      },
    };
    const schemas = [{ name: 'browser_click', inputSchema: { type: 'object', properties: { target: { type: 'string' } } } }];
    const bc = new BrowserControl({
      registry,
      grants: iabGrants.g,
      chromeGrants: chrome.g,
      panel: {},
      chrome: { tools: async () => schemas, instance: async () => inst, stopAll() {} },
      isEnabled: () => true,
    });
    await bc.configure('chrome');
    await registry.defs.get('sage_browser_click').handler({ ref: 'e1' }, ctx);
    assert.deepEqual(
      chrome.asked.map((a) => [a.browser, a.origin, a.need]),
      [['chrome', 'https://shop.test', 'write']],
    );
    assert.equal(iabGrants.asked.length, 0, "the built-in browser's grant opened nothing in Chrome");
    // and the other way round: a Chrome grant doesn't cover the built-in browser
    assert.equal(chrome.g.get('https://shop.test'), null, 'a chat answer, not saved');
    chrome.g.set('https://only-chrome.test', 'write');
    assert.equal(iabGrants.g.peek('https://only-chrome.test/', 'write', ctx), 'ask');
    // every table names a known browser
    assert.deepEqual(BROWSERS, ['iab', 'chrome']);
    assert.throws(() => new OriginGrants({ browser: 'safari', ask: async () => null }), /Unknown browser/);
    assert.equal(new OriginGrants({ ask: async () => null }).browser, 'iab');
  });

  test('CM-P02: grants saved before the split stay the in-app browser’s; Your Chrome starts with none and asks again', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-p02-'));
    try {
      fs.writeFileSync(path.join(dir, 'browser-sites.json'), JSON.stringify({ origins: { 'https://bank.test': 'write' } }));
      const inApp = new OriginGrants({ browser: 'iab', file: path.join(dir, 'browser-sites.json'), ask: async () => null });
      const chrome = new OriginGrants({ browser: 'chrome', file: path.join(dir, 'browser-sites-chrome.json'), ask: async () => null });
      assert.equal(inApp.get('https://bank.test'), 'write');
      assert.deepEqual(chrome.list(), []);
      chrome.set('https://mail.test', 'read');
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'browser-sites-chrome.json'), 'utf8')).origins, {
        'https://mail.test': 'read',
      });
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'browser-sites.json'), 'utf8')).origins, { 'https://bank.test': 'write' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // main makes exactly these two tables, each with its own file (electron/app/browserSiteTables.cjs)
    const src = fs.readFileSync(new URL('electron/app/browserSiteTables.cjs', ROOT), 'utf8');
    assert.match(src, /new OriginGrants\(\{\s*browser: 'iab',\s*file: path\.join\(dir, 'browser-sites\.json'\)/);
    assert.match(src, /new OriginGrants\(\{\s*browser: 'chrome',\s*file: path\.join\(dir, 'browser-sites-chrome\.json'\)/);
  });

  test('CM-P03: site and action cards name their browser ("in your Chrome, signed in"), and Settings shows each table', async () => {
    const chrome = grantsFor('chrome');
    await chrome.g.require('https://mail.test/', 'read', ctx);
    await chrome.g.act('https://mail.test/', ctx, { tool: 'click', sensitive: { verb: 'send a message' } });
    assert.equal(chrome.asked[0].browser, 'chrome');
    assert.equal(chrome.confirmed[0].browser, 'chrome');
    assert.equal(browserPlace('chrome'), 'in your Chrome, signed in');
    assert.equal(browserPlace('iab'), 'in the built-in browser');
    assert.equal(browserPlace(undefined), null);
    const rows = siteRows(null, {
      iab: [{ origin: 'https://a.test', level: 'write' }],
      chrome: [{ origin: 'https://a.test', level: 'read' }],
    });
    assert.deepEqual(rows[0].mopilot, { iab: 'write', chrome: 'read' });
    assert.deepEqual(addTarget('chrome:read'), { mopilot: 'read', browser: 'chrome' });
    assert.deepEqual(addTarget('plugin:deny'), { codex: 'deny' });
  });

  /* ---------- D4: Your Chrome gets the built-in browser's checks on writes ---------- */

  /** A Your Chrome instance whose page answers browser_evaluate with `intent` and shows `snapshot`. */
}
