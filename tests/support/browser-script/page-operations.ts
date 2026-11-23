// Browser-script page-operations unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IMAGES_MAX, ToolError, code, ops } from './fixture';

export function registerPageOperationsCases() {
  test('tab operations: binding, new tabs, lists, navigation, info, selection and marks', async () => {
    const { d, tabs, navs, gates } = ops();
    assert.deepEqual(await d('tab.resolve', {}), { id: 't1' });
    assert.deepEqual(await d('tabs.new', {}), { id: 't3' });
    assert.deepEqual(await d('tabs.new', { url: 'https://n.test' }), { id: 't3' });
    assert.deepEqual(navs, ['https://n.test']);
    assert.deepEqual(await d('tabs.list', {}), [
      { id: 't1', title: 'A', url: 'https://a.test/', current: true },
      { id: 't2', title: 'B', url: 'https://b.test/', current: false },
    ]);
    assert.deepEqual(await d('tabs.selected', {}), { id: 't1' });
    assert.deepEqual(await d('tabs.get', { id: 't2' }), { id: 't2' });
    await assert.rejects(d('tabs.get', { id: 'missing' }), code('bad_args'));
    assert.deepEqual(await d('tab.goto', { tab: 't1', url: 'https://a.test/x' }), { url: 'https://a.test/', title: 'A' });
    for (const op of ['back', 'forward', 'reload']) assert.equal(await d(`tab.${op}`, { tab: 't1' }), 'Navigated t1');
    assert.deepEqual(navs.slice(1), ['https://a.test/x', 'back', 'forward', 'reload']);
    assert.deepEqual(gates, [], 'navigations ask for their own site permission');
    assert.equal(await d('tab.close', { tab: 't2' }), null);
    assert.deepEqual(tabs.called('close'), [['c1', 't2']]);
    assert.equal(await d('tab.title', { tab: 't2' }), 'B');
    assert.equal(await d('tab.url', { tab: 't1' }), 'https://a.test/');
    assert.equal(await d('tab.select', { tab: 't2' }), null);
    assert.equal(await d('tab.mark', { tab: 't1', status: 'deliverable' }), null);
    assert.deepEqual([tabs.called('select'), tabs.called('mark')], [[['c1', 't2']], [['c1', 't1', 'deliverable']]]);
    tabs.list_ = [];
    assert.equal(await d('tabs.selected', {}), null);
  });

  test('screenshots: the viewport, a clip or the full page, kept for the result, at most six', async () => {
    const { d, tabs, images, gates } = ops();
    assert.deepEqual(await d('tab.screenshot', { tab: 't1' }), { screenshot: 1, tab: 't1', width: 400, height: 300 });
    await d('tab.screenshot', { tab: 't1', clip: { x: 10, y: 20, width: 30, height: 40 }, scale: 0.5 });
    assert.deepEqual(await d('tab.screenshot', { tab: 't1', fullPage: true }), { screenshot: 3, tab: 't1', width: 1280, height: 4000 });
    assert.deepEqual(
      tabs.called('capture').map((c) => c[2]),
      [
        { region: null, scale: undefined },
        { region: [10, 20, 40, 60], scale: 0.5 },
      ],
    );
    assert.deepEqual(
      images.map((i) => [i.what, i.data]),
      [
        ['viewport', 'IMG'],
        ['clip', 'IMG'],
        ['full page', 'FULL'],
      ],
    );
    assert.deepEqual(gates, ['read', 'read', 'read']);
    for (let i = images.length; i < IMAGES_MAX; i++) await d('tab.screenshot', { tab: 't1' });
    await assert.rejects(d('tab.screenshot', { tab: 't1' }), code('limit', /at most 6 screenshots/));
  });

  test('dialogs: the open one, or null; answering accepts or dismisses it; actions on a blocked tab point at getJsDialog', async () => {
    const { d, tabs } = ops();
    assert.equal(await d('tab.dialog', { tab: 't1' }), null);
    tabs.tab.dialog = { type: 'confirm', message: 'Sure?', defaultPrompt: '' };
    assert.deepEqual(await d('tab.dialog', { tab: 't1' }), { type: 'confirm', message: 'Sure?', defaultValue: '' });
    assert.deepEqual(tabs.called('ready').at(-1)[2], { allowDialog: true });
    assert.equal(await d('tab.dialog.answer', { tab: 't1', accept: true, text: 'x' }), 'Accepted.');
    // the answer goes only to the dialog the approval was about (null: no page dialog of MoPilot's)
    assert.deepEqual(tabs.called('handleDialog').at(-1).slice(1), [true, 'x', null]);
    tabs.tab.dialog = { type: 'prompt', message: 'Name?', defaultPrompt: '', own: 5 };
    await d('tab.dialog.answer', { tab: 't1', accept: true, text: 'Ada' });
    assert.deepEqual(tabs.called('handleDialog').at(-1).slice(1), [true, 'Ada', 5]);
    tabs.tab.dialog = { type: 'confirm', message: 'Sure?', defaultPrompt: '' };
    assert.equal(await d('tab.dialog.answer', { tab: 't1' }), 'Dismissed.');
    tabs.tab.dialog = null;
    assert.equal(await d('tab.dialog.answer', { tab: 't1', accept: true }), 'Accepted.');
    tabs.impl.ready = async () => {
      throw new ToolError('A confirm dialog is open in t1: "Sure?". Answer it with browser_handle_dialog first.', 'dialog_open');
    };
    await assert.rejects(
      d('tab.goto', { tab: 't1', url: 'x' }),
      code(
        'dialog_open',
        /^A confirm dialog is open in t1: "Sure\?"\. Answer it first: const d = await tab\.getJsDialog\(\); await d\.accept\(\) \(or d\.dismiss\(\)\)\.$/,
      ),
    );
    tabs.impl.ready = async () => {
      throw new ToolError('The user took over t1.', 'taken_over');
    };
    await assert.rejects(
      d('tab.title', { tab: 't1' }).then(() => d('tab.goto', { tab: 't1', url: 'x' })),
      code('taken_over', /^The user took over t1\.$/),
    );
  });

  test('page waits, snapshots, page JavaScript (confirmed) and console logs', async () => {
    const { d, tabs, gates, confirms } = ops({ budget: 5000 });
    assert.equal(await d('tab.waitForLoadState', { tab: 't1', state: 'networkidle', timeoutMs: 999 }), null);
    await d('tab.waitForLoadState', { tab: 't1', state: 'bogus' });
    assert.deepEqual(
      tabs.called('waitForLoad').map((c) => c.slice(1)),
      [
        ['networkidle', 999],
        ['load', 5000],
      ],
    );
    assert.equal(await d('tab.domSnapshot', { tab: 't1' }), '- button "Go" [ref_1]');
    assert.deepEqual(tabs.called('readPage')[0][1], { filter: 'all', depth: 40, ref: null, maxChars: 50000 });
    tabs.impl.readPage = async () => ({ lines: ['a'], truncated: true });
    assert.equal(await d('tab.domSnapshot', { tab: 't1' }), 'a\n[Truncated at 50,000 characters.]');
    assert.deepEqual(await d('tab.evaluate', { tab: 't1', expression: 'document.title' }), { a: 1 });
    assert.equal(tabs.called('exec')[0][1], '(async () => JSON.stringify({ v: await (document.title\n) }))()');
    tabs.impl.exec = async () => '{}';
    assert.equal(await d('tab.evaluate', { tab: 't1', expression: 'void 0' }), null);
    tabs.impl.exec = async () => 'undefined';
    assert.equal(await d('tab.evaluate', { tab: 't1', expression: 'x' }), null);
    assert.deepEqual(confirms, ['document.title', 'void 0', 'x']);
    assert.deepEqual(await d('tab.logs', { tab: 't1', onlyErrors: true, pattern: 'oo', limit: 5 }), [
      { level: 'error', text: 'oops', at: '1970-01-01T00:00:00.000Z', source: 'x.js:1' },
    ]);
    await d('tab.logs', { tab: 't1' });
    assert.deepEqual(
      tabs.called('console').map((c) => c[1]),
      [
        { onlyErrors: true, pattern: 'oo', limit: 5 },
        { onlyErrors: false, pattern: null, limit: 100 },
      ],
    );
    assert.deepEqual(gates, ['read', 'read', 'write', 'write', 'write', 'read', 'read']);
    const refused = ops({ refuse: true });
    await assert.rejects(refused.d('tab.evaluate', { tab: 't1', expression: '1' }), code('denied'));
    assert.equal(refused.tabs.called('exec').length, 0);
  });
}
