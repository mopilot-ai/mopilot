// Page-diff baselines and structured refusal output cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ToolError, world, texts, endsWithState, code, refusal } from './fixture';

const require = createRequire(import.meta.url);

export function registerPageDiffsCases() {
  // ---------------------------------------------------------------- page diffs after actions

  const { PageSnapshots } = require('../../../electron/capabilities/browser/pageDiff.cjs');

  /** The tools with page diffs on; `w.page` is what the fake page tree reads now. */
  function diffWorld(o: Record<string, any> = {}) {
    const w: any = world({ snapshots: new PageSnapshots(), ...o });
    w.page = ['- button "Add to cart" [ref_42]', '- link "Help" [ref_43]', '- link "About" [ref_44]'];
    w.tabs.impl.readPage = async () => ({ lines: w.page, truncated: false });
    return w;
  }
  const viewOf = (out: any[]) => out[out.length - 2].text;

  test('page diffs: after a read, an action reports what changed in the tree the model saw, with its filter', async () => {
    const w = diffWorld();
    await w.call('browser_read_page', { filter: 'all', depth: 5, max_chars: 2000 });
    w.page = [
      '- button "Add to cart" [pressed] [ref_42]',
      '- dialog "Cart (1)" [ref_88]',
      '  - button "Checkout" [ref_89]',
      '- link "Help" [ref_43]',
      '- link "About" [ref_44]',
    ];
    const out = await w.call('browser_computer', { action: 'left_click', ref: 'ref_42' });
    assert.equal(
      viewOf(out),
      '<page_diff>\n~ button "Add to cart" [pressed] [ref_42]\n+ dialog "Cart (1)" [ref_88]\n+   button "Checkout" [ref_89]\n</page_diff>',
    );
    endsWithState(out);
    // the page read after the action uses the model's own read options
    assert.deepEqual(w.tabs.called('readPage').at(-1)[1], { filter: 'all', depth: 5, ref: null, maxChars: 2000 });
    // a subtree read is not a baseline; the same page again has no changes
    await w.call('browser_read_page', { ref_id: 'ref_88' });
    assert.match(
      viewOf(await w.call('browser_form_input', { ref: 'ref_42', value: 'x' })),
      /^<page_diff>No visible change \(all elements\)\.<\/page_diff>$/,
    );
  });

  test('page diffs: no baseline or another page gives the full tree; reads and screenshots add nothing', async () => {
    const w = diffWorld();
    const nav = await w.call('browser_navigate', { url: 'https://a.example/next' });
    assert.match(
      viewOf(nav),
      /^<page_tree>\nFull page tree \(no earlier read of this tab to compare with\), interactive elements in the viewport:\n- button "Add to cart" \[ref_42\]/,
    );
    for (const out of [
      await w.call('browser_read_page', {}),
      await w.call('browser_find', { query: 'Help' }),
      await w.call('browser_computer', { action: 'screenshot' }),
      await w.call('browser_computer', { action: 'hover', coordinate: [1, 1] }),
      await w.call('browser_tabs_context', {}),
    ])
      assert.doesNotMatch(texts(out).join('\n'), /<page_(?:diff|tree)>/);
    w.tabs.tab.url = 'https://a.example/elsewhere';
    assert.match(
      viewOf(await w.call('browser_computer', { action: 'key', text: 'Enter' })),
      /^<page_tree>\nFull page tree \(the tab is on another page now\)/,
    );
  });

  test('page diffs: every page-changing tool reports one; find updates the baseline', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-diff-'));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
    const w = diffWorld({ confirm: async () => true, folders: () => ({ uploads: dir, downloads: dir }) });
    await w.call('browser_read_page', {});
    w.page = ['- button "Add to cart" [disabled] [ref_42]', '- link "Help" [ref_43]', '- link "About" [ref_44]'];
    // the model saw the change through browser_find: no diff line for it after the next action
    w.tabs.impl.find = async () => ['- button "Add to cart" [disabled] [ref_42]'];
    await w.call('browser_find', { query: 'Add to cart' });
    assert.match(viewOf(await w.call('browser_computer', { action: 'scroll' })), /^<page_diff>No visible change/);
    const calls: Array<[string, any]> = [
      ['browser_computer', { action: 'type', text: 'hi' }],
      ['browser_computer', { action: 'double_click', coordinate: [1, 1] }],
      ['browser_computer', { action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [2, 2] }],
      ['browser_javascript_exec', { text: '1' }],
      ['browser_handle_dialog', { accept: true }],
      ['browser_file_upload', { paths: ['a.txt'] }],
      ['browser_tabs_create', { url: 'https://a.example/new' }],
    ];
    w.tabs.impl.navigate = async (tab: any, url: string) => ((tab.url = url), { url, title: 'T' });
    for (const [name, args] of calls) assert.match(viewOf(await w.call(name, args)), /^<page_(?:diff|tree)>/, name);
    // tabs_create without a URL acts on no page
    assert.doesNotMatch(texts(await w.call('browser_tabs_create', {})).join('\n'), /<page_/);
  });

  test('page diffs: none for a page the model may not read now, or when reading fails', async () => {
    const w = diffWorld();
    await w.call('browser_read_page', {});
    // the action ends on a site the user denied in this chat
    w.tabs.impl.click = async () => {
      w.tabs.tab.url = 'https://d.example/';
      w.grants.denied.set('c1', new Set(['https://d.example']));
    };
    let out = await w.call('browser_computer', { action: 'left_click', coordinate: [1, 1] });
    assert.equal(out.length, 2);
    // an unread high-risk site is not read; an ordinary site nobody granted is, as a page read would be
    w.tabs.tab.url = 'https://www.chase.com/';
    w.grants.riskOf = () => ({ level: 'high', credentials: false });
    w.grants.act = async () => {};
    out = await w.call('browser_computer', { action: 'key', text: 'Tab' });
    assert.equal(out.length, 2);
    delete w.grants.riskOf;
    w.tabs.tab.url = 'https://b.example/';
    out = await w.call('browser_computer', { action: 'key', text: 'Tab' });
    assert.match(viewOf(out), /^<page_tree>/);
    // a site whose read verdict asks again is not read either (the action itself is let through here)
    w.grants.peek = (_url: string, need: string) => (need === 'read' ? 'reask' : 'ok');
    const real = w.grants.require.bind(w.grants);
    w.grants.require = async () => {};
    out = await w.call('browser_computer', { action: 'key', text: 'Tab' });
    assert.equal(out.length, 2);
    w.grants.require = real;
    delete w.grants.peek;
    delete w.grants.act;
    w.tabs.impl.readPage = async () => {
      throw new ToolError('The page changed while reading it. Try again.', 'page_changed');
    };
    out = await w.call('browser_computer', { action: 'key', text: 'Tab' });
    assert.equal(out.length, 2);
  });

  test('page diffs: a batch reports one for its last acted-on tab, also when a later step fails', async () => {
    const w = diffWorld();
    await w.call('browser_read_page', {});
    w.page = [...w.page, '- link "New" [ref_45]'];
    const out = await w.call('browser_batch', {
      actions: [{ name: 'computer', input: { action: 'left_click', coordinate: [1, 1] } }, { name: 'read_console_messages' }],
    });
    assert.equal(viewOf(out), '<page_diff>\n+ link "New" [ref_45]\n</page_diff>');
    w.page = [...w.page, '- link "Newer" [ref_46]'];
    await assert.rejects(
      w.call('browser_batch', {
        actions: [{ name: 'computer', input: { action: 'left_click', coordinate: [1, 1] } }, { name: 'nope' }],
      }),
      (e: any) =>
        /failed: browser_nope is not a browser tool[^\n]*\n<page_diff>\n\+ link "Newer" \[ref_46\]\n<\/page_diff>\nSTATE c1$/.test(
          e.message,
        ),
    );
  });

  // ---------------------------------------------------------------- structured refusals

  test('refusals reach the model with a reason, retryable and next step, single tools and batch steps alike', async () => {
    const w = world();
    w.tabs.tab.url = 'https://d.example/';
    w.grants.denied.set('c1', new Set(['https://d.example']));
    await assert.rejects(w.call('browser_read_page', {}), refusal('denied', 'site_permission_denied'));
    await assert.rejects(
      world({ enabled: () => 'Paused.' }).call('browser_tabs_context', {}),
      refusal('disabled', 'browser_control_disabled'),
    );
    const t = world();
    t.tabs.impl.create = async () => {
      throw new ToolError('This chat already has 8 tabs. Close one with browser_tabs_close first.', 'limit');
    };
    await assert.rejects(t.call('browser_tabs_create', {}), refusal('limit', 'tab_limit', true));
    await assert.rejects(
      world().call('browser_batch', { actions: [{ name: 'navigate', input: { url: 'file:///etc/hosts' } }] }),
      (e: any) => code('batch_failed')(e) && /<refusal reason="scheme_blocked" retryable="false">/.test(e.message),
    );
    // a failure that is not a refusal stays plain
    const p = world();
    p.tabs.impl.click = async () => {
      throw new ToolError('Tab t1 was closed.', 'tab_closed');
    };
    await assert.rejects(p.call('browser_computer', { action: 'left_click', coordinate: [1, 1] }), (e: any) => !/<refusal/.test(e.message));
  });
}
