// A batch's stale screenshots (#3810): an image taken before a later action that changes the page becomes one text line, on the built-in browser's browser_batch and the Chrome tools' browser_batch alike; the last view of the page stays an image, and so does a screenshot followed only by actions that leave the page alone. Without this, Codex's exec printing the whole result (text(r)) carried the base64 of a stale screenshot in every later step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeTabs, OriginGrants } from './support/browser-host-tools/fixture.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');
const { changesPage, staleImages, staleAfter } = require('../electron/capabilities/browser/batchImages.cjs');

const PIXELS = Buffer.from('p'.repeat(3000)).toString('base64');

function world(chrome: boolean) {
  const grants = new OriginGrants({ file: null, anchor: () => 'full', ask: async () => ({ decision: 'deny' }) });
  grants.set('https://mail.test', 'write');
  const tabs = makeTabs();
  Object.assign(tabs.tab, { url: 'https://mail.test/inbox/42', title: 'Invoice 42', backend: { tabId: 7 } });
  tabs.impl.capture = async () => ({ width: 800, height: 600, data: PIXELS });
  const list = (chrome ? createChromeTools : createBrowserTools)({ tabs, grants, confirm: async () => true });
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const name = chrome ? 'chrome_browser_batch' : 'browser_batch';
  const batch = (actions: any[]) => list.find((t: any) => t.name === name).handler({ actions }, ctx);
  return {
    batch,
    shot: chrome ? { name: 'computer', input: { action: 'screenshot', tabId: 7 } } : { name: 'computer', input: { action: 'screenshot' } },
  };
}
const images = (out: any[]) => out.filter((c) => c.type === 'image').length;

for (const chrome of [false, true]) {
  const surface = chrome ? 'Chrome tools' : 'built-in browser';
  test(`${surface}: a screenshot before a later click is stale and becomes a line; the last one stays an image; text() of the result stays small`, async () => {
    const w = world(chrome);
    const click = chrome
      ? { name: 'computer', input: { action: 'left_click', coordinate: [10, 10], tabId: 7 } }
      : { name: 'computer', input: { action: 'left_click', coordinate: [10, 10] } };
    const out = await w.batch([w.shot, click, w.shot]);
    assert.equal(images(out), 1, 'only the last view of the page is an image');
    assert.ok(out.some((c: any) => /^\[screenshot not kept: a later action in this batch changed the page\]$/.test(c.text ?? '')));
    // what a script printing the whole result would carry: one image, not two
    assert.ok(JSON.stringify(out).length < 2 * PIXELS.length);
    assert.ok(JSON.stringify(out).length > PIXELS.length);
  });

  test(`${surface}: screenshots followed only by actions that leave the page alone stay images`, async () => {
    const w = world(chrome);
    const out = await w.batch([w.shot, w.shot]);
    assert.equal(images(out), 2);
  });
}

test('which actions change the page: the click-like computer actions and the tools that write; not screenshot, zoom, hover or reads', async () => {
  for (const a of ['left_click', 'right_click', 'double_click', 'triple_click', 'type', 'key', 'scroll', 'left_click_drag'])
    assert.equal(changesPage('computer', { action: a }), true, a);
  for (const a of ['screenshot', 'zoom', 'hover', 'wait', 'scroll_to', undefined])
    assert.equal(changesPage('chrome_computer', { action: a }), false, String(a));
  for (const n of [
    'navigate',
    'form_input',
    'file_upload',
    'upload_image',
    'resize_window',
    'handle_dialog',
    'javascript_tool',
    'browser_javascript_exec',
  ])
    assert.equal(changesPage(n, {}), true, n);
  for (const n of ['read_page', 'find', 'get_page_text', 'tabs_context_mcp']) assert.equal(changesPage(n, {}), false, n);
  const c: any[] = [{ type: 'image', data: 'x' }, { type: 'text', text: 't' }, null];
  staleImages(c);
  const kept: any[] = [{ type: 'image', data: 'x' }];
  assert.equal(await staleAfter(kept, 'navigate', {}, Promise.resolve('ok')), 'ok');
  assert.equal(kept[0].type, 'text');
  assert.deepEqual(
    c.map((x) => x?.type ?? null),
    ['text', 'text', null],
  );
});
