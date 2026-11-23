// Chrome tool and Codex backend inventories use the same fresh destination tab and preserve chat-scoped permission checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { world } from './support/chrome-membership-kit.mjs';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { ChromeBackend } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');

test('one observed transfer updates both consumer lists without inheriting source marks, refs, selection or grants', async (t) => {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  const b = await w.tabs.create('b');
  const id = a.wc.tabId;
  a.mark = 'deliverable';
  a.refFrame.set('ref_1', 'source-session');
  a.result = true;
  a.wc.url = 'https://private.example/';
  w.chrome.tabsById.get(id).url = a.wc.url;
  const asked: any[] = [];
  const grants = new OriginGrants({
    ask: async (q: any) => {
      asked.push(q);
      return { decision: 'deny' };
    },
  });
  grants.chatGrants.set('a', new Map([['https://private.example', 'write']]));
  grants.denied.set('b', new Set(['https://private.example']));
  const tools = new Map<string, any>(createChromeTools({ tabs: w.tabs, grants }).map((tool: any) => [tool.name, tool]));
  const backend = new ChromeBackend({ threadId: 'thread-b', chatOf: () => 'b', tabs: () => w.tabs, grants: () => grants });
  w.move(id, w.chrome.tabsById.get(b.wc.tabId).groupId);
  const transferred = w.tabs.list('b').find((tab) => tab.wc.tabId === id);
  assert.ok(transferred);
  assert.notEqual(transferred.id, a.id);
  assert.notEqual(transferred.queue, a.queue);
  assert.equal(transferred.mark, null);
  assert.equal(transferred.refFrame.size, 0);
  assert.equal(transferred.signin, null);
  assert.equal(transferred.result, false);
  assert.equal(transferred.openedByAgent, false);
  assert.equal(w.tabs.current('b'), b);
  assert.equal(w.chrome.attached.size, 0);
  const listed = await tools.get('chrome_tabs_context_mcp').handler({}, { chatId: 'b', segmentId: 's' });
  assert.match(JSON.stringify(listed), new RegExp(String(id)));
  const source = await tools.get('chrome_tabs_context_mcp').handler({ createIfEmpty: false }, { chatId: 'a', segmentId: 's' });
  assert.match(JSON.stringify(source), /no tab group/);
  const rows = await backend.handle('getTabs', { session_id: 'thread-b' });
  assert.equal(rows.length, 2);
  const row = rows.find((tab: any) => tab.url === a.wc.url);
  assert.ok(row);
  await assert.rejects(backend.handle('attach', { session_id: 'thread-b', tabId: row.id }), /denied|declined|blocked|did not allow/i);
  await assert.rejects(
    tools.get('chrome_get_page_text').handler({ tabId: id }, { chatId: 'b', segmentId: 's' }),
    /denied|declined|blocked|did not allow/i,
  );
  assert.equal(asked.length, 0, 'the destination denial remains effective without another card');
  assert.equal(grants.chatGrants.has('b'), false, 'the source chat grant was not inherited');
  assert.equal(grants.peek(a.wc.url, 'read', { chatId: 'a', segmentId: 's' }), 'ok');
  assert.equal(
    w.chrome.log.some(([name, , method]) => name === 'debugger.sendCommand' && method === 'Page.navigate'),
    false,
  );
  const retained = await w.tabs.turnEnded('b');
  assert.equal(retained.kept.length, 2, 'manual and created tabs keep ordinary all-tab turn retention');
});
