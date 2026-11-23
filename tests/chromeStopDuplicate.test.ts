// Stop and Duplicate on the user's Chrome route (#1362): a Chrome tab stops its load over CDP (chromeTab.cjs), and the
// chrome_* tools take no argument their schema leaves out, so tabs_create_mcp never duplicates or navigates (chromeTools.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ChromeTabContents } = require('../electron/capabilities/browser/chromeTab.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');

test('chromeTab: stop asks Chrome to stop loading the tab, over the relay', async () => {
  const calls: any[] = [];
  const relay = {
    token: (chatId: string) => ({ chatId, turn: 0 }),
    link: () => ({ tabs: new Set([5]) }),
    attach: async () => undefined,
    cdp: async (_tok: any, target: any, method: string, params: any) => (calls.push([target.tabId, method, params]), {}),
  };
  const wc = new ChromeTabContents({ relay, chatId: 'c', tab: { id: 5, url: 'https://a.test/', title: 'A' } });
  await wc.debugger.attach();
  calls.length = 0;
  wc.stop();
  await new Promise((resolve) => setImmediate(resolve));
  // after the attach's own reads of the tab
  assert.deepEqual(calls.at(-1), [5, 'Page.stopLoading', {}]);
  assert.equal(calls.filter((c) => c[1] === 'Page.stopLoading').length, 1);
});

test('chromeTools: tabs_create_mcp takes neither a URL nor a duplicate; navigate offers stop', async () => {
  const seen: string[] = [];
  const tab = { id: 'tab_aaaaaa', url: 'about:blank', title: '', backend: { tabId: 7 } };
  const tabs = {
    list: () => [tab],
    current: () => tab,
    state: () => '',
    create: async () => (seen.push('create'), tab),
    resolve: async () => {
      seen.push('resolve');
      throw new Error('a duplicate was taken');
    },
    run: async () => {
      seen.push('run');
      throw new Error('a URL was taken');
    },
  };
  const tools = new Map(createChromeTools({ tabs, grants: {} }).map((t: any) => [t.name.replace(/^chrome_/, ''), t]));
  const out = await (tools.get('tabs_create_mcp') as any).handler(
    { url: 'https://ignored.test/', duplicate: '7' },
    { chatId: 'c', segmentId: 's' },
  );
  assert.match(out[0].text, /^Created new tab with tabId: 7\./);
  assert.deepEqual(seen, ['create']);
  assert.deepEqual(Object.keys((tools.get('tabs_create_mcp') as any).schema.properties), []);
  assert.match((tools.get('navigate') as any).description, /"stop" a page that is still loading/);
});
