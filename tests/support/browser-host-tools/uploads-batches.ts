// Upload filesystem boundaries and batch execution cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inAppBrowserEnabled, ToolError, STATE, world, first, endsWithState, code, TODAY } from './fixture';

export function registerUploadsBatchesCases() {
  // ---------------------------------------------------------------- file upload

  function uploadWorld(o: Record<string, any> = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosttools-'));
    const uploads = path.join(base, 'uploads');
    fs.mkdirSync(path.join(uploads, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(uploads, 'dir'));
    fs.writeFileSync(path.join(uploads, 'a.txt'), 'a');
    fs.writeFileSync(path.join(uploads, 'sub', 'b.txt'), 'b');
    fs.writeFileSync(path.join(base, 'out.txt'), 'secret');
    fs.symlinkSync(path.join(base, 'out.txt'), path.join(uploads, 'link'));
    const asked: any[] = [];
    const w = world({
      folders: (chatId: string) => ({ uploads, downloads: path.join(base, 'downloads', chatId) }),
      confirm: async (_ctx: any, req: any) => (asked.push(req), o.ok ?? true),
      ...o,
    });
    const root = fs.realpathSync(uploads);
    return { ...w, base, uploads, root, asked, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
  }

  test('browser_file_upload sets files from relative and absolute paths inside the upload folder', async () => {
    const u = uploadWorld();
    try {
      const out = await u.call('browser_file_upload', { ref: 'ref_1', paths: ['a.txt', path.join(u.uploads, 'sub', 'b.txt')] });
      assert.equal(first(out), 'Set 2 files on ref_1. Tab t1 is at https://a.example/page (A page).');
      endsWithState(out);
      assert.deepEqual(u.tabs.called('setFiles'), [[u.tabs.tab, 'ref_1', [path.join(u.root, 'a.txt'), path.join(u.root, 'sub', 'b.txt')]]]);
      assert.deepEqual(u.asked, [
        { tool: 'File upload', origin: 'https://a.example', summary: 'Upload a.txt, b.txt to https://a.example' },
      ]);
      assert.deepEqual(u.tabs.called('settle'), [[u.tabs.tab, { grace: 100 }]]);

      const one = await u.call('browser_file_upload', { target: { ref: 'ref_2' }, paths: ['a.txt'] });
      assert.equal(first(one), 'Set 1 file on ref_2. Tab t1 is at https://a.example/page (A page).');

      u.tabs.tab.url = 'about:blank';
      const chooser = await u.call('browser_file_upload', { paths: ['sub/b.txt'] });
      assert.equal(first(chooser), 'Set 1 file on the file chooser. Tab t1 is at about:blank (A page).');
      assert.deepEqual(u.tabs.called('setFiles')[2], [u.tabs.tab, null, [path.join(u.root, 'sub', 'b.txt')]]);
      assert.deepEqual(u.asked[2], { tool: 'File upload', origin: 'this page', summary: 'Upload b.txt to this page' });

      const none = await u.call('browser_file_upload', {});
      assert.match(first(none), /^Set 0 files on the file chooser\./);
    } finally {
      u.cleanup();
    }
  });

  test('browser_file_upload creates a missing upload folder before resolving paths', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'hosttools-'));
    try {
      const uploads = path.join(base, 'not', 'yet');
      const w = world({ folders: () => ({ uploads, downloads: base }), confirm: async () => true });
      await assert.rejects(w.call('browser_file_upload', { paths: ['x.txt'] }), code('bad_args', /^No such file: x\.txt$/));
      assert.ok(fs.statSync(uploads).isDirectory());
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('browser_file_upload refuses missing files, files outside the folder, escaping symlinks, directories and the folder itself', async () => {
    const u = uploadWorld();
    try {
      await assert.rejects(u.call('browser_file_upload', { paths: ['nope.txt'] }), code('bad_args', /^No such file: nope\.txt$/));
      const outside = path.join(u.base, 'out.txt');
      const only = new RegExp(`^Only files inside ${u.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} can be uploaded: `);
      for (const p of [outside, 'link', 'dir', '.', '../out.txt']) {
        await assert.rejects(u.call('browser_file_upload', { paths: ['a.txt', p] }), code('bad_args', only));
      }
      assert.equal(u.tabs.called('setFiles').length, 0);
      assert.equal(u.tabs.called('run').length, 0);
      assert.equal(u.asked.length, 0);
    } finally {
      u.cleanup();
    }
  });

  test('browser_file_upload: no folders means disabled; refused or missing confirmation; Full access skips it', async () => {
    const w = world();
    await assert.rejects(w.call('browser_file_upload', { paths: ['a.txt'] }), code('disabled', /^File upload is turned off\.$/));

    const refused = uploadWorld({ ok: false });
    try {
      await assert.rejects(refused.call('browser_file_upload', { paths: ['a.txt'] }), code('denied'));
      assert.equal(refused.tabs.called('setFiles').length, 0);
    } finally {
      refused.cleanup();
    }

    const noConfirm = uploadWorld({ confirm: undefined });
    try {
      await assert.rejects(
        noConfirm.call('browser_file_upload', { paths: ['a.txt'] }),
        code('disabled', /^File upload is turned off for this chat\.$/),
      );
      noConfirm.st.anchor = 'full';
      const out = await noConfirm.call('browser_file_upload', { paths: ['a.txt'] });
      assert.match(first(out), /^Set 1 file on the file chooser\./);
    } finally {
      noConfirm.cleanup();
    }

    const ro = uploadWorld();
    try {
      ro.grants.set('https://r.example', 'read');
      ro.tabs.tab.url = 'https://r.example/';
      // the write asks (#1319 G22); the user keeps the site read only
      ro.st.answer = { decision: 'allow', scope: 'once', level: 'read' };
      await assert.rejects(ro.call('browser_file_upload', { paths: ['a.txt'] }), code('read_only'));
      assert.equal(ro.asked.length, 0);
    } finally {
      ro.cleanup();
    }
  });

  // ---------------------------------------------------------------- batch

  test('browser_batch runs steps in order with mixed text and image content', async () => {
    const w = world();
    const out = await w.call('browser_batch', {
      actions: [
        { name: 'navigate', input: { url: 'https://a.example/z' } },
        { name: 'browser_computer', input: { action: 'screenshot' } },
        { name: 'tabs_context' },
      ],
    });
    assert.equal(out.length, 6);
    assert.equal(out[0].text, '1. browser_navigate: Navigated t1 to https://a.example/z (T).');
    // a step returning content items (not a string) passes them through without the step label
    assert.match(out[1].text, /^Screenshot of t1: image 800x600\./);
    assert.deepEqual(out[2], { type: 'image', data: 'IMG', mimeType: 'image/jpeg' });
    assert.match(out[3].text, /^Screenshot ID: ss_[0-9a-f]{8}\./);
    assert.equal(out[4].text, `3. browser_tabs_context: Tabs in this chat:\n- t1 (current): "A page" https://a.example/page\n${TODAY}`);
    endsWithState(out);
  });

  test('browser_batch accepts short and prefixed names for the same tool', async () => {
    const w = world();
    await w.call('browser_batch', { actions: [{ name: 'navigate', input: { url: 'https://a.example/q' } }, { name: 'tabs_context' }] });
    await w.call('browser_batch', {
      actions: [{ name: 'browser_navigate', input: { url: 'https://a.example/q' } }, { name: 'browser_tabs_context' }],
    });
    const navs = w.tabs.called('navigate');
    assert.deepEqual(navs[0], navs[1]);
    assert.equal(navs.length, 2);
    assert.equal(w.tabs.called('list').length >= 4, true);
  });

  test('browser_batch without actions returns just the state', async () => {
    const w = world();
    assert.deepEqual(await w.call('browser_batch', {}), [{ type: 'text', text: STATE }]);
  });

  test('browser_batch stops when the turn was stopped, counting the later actions', async () => {
    const w = world();
    const ac = new AbortController();
    ac.abort();
    const ctx = { ...w.ctx, signal: ac.signal };
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'tabs_context' }, { name: 'tabs_context' }] }, ctx),
      code('batch_failed', /^1\. browser_tabs_context failed: the turn was stopped\.\nNot executed: the 1 later action\.\nSTATE c1$/),
    );
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'tabs_context' }, { name: 'tabs_context' }, { name: 'tabs_context' }] }, ctx),
      code('batch_failed', /Not executed: the 2 later actions\.\nSTATE c1$/),
    );
    assert.equal(w.tabs.called('list').length, 0);
  });

  test('browser_batch refuses unknown, nested and nameless steps', async () => {
    const w = world();
    for (const [step, name] of [
      [{ name: 'fly' }, 'browser_fly'],
      [{ name: 'batch', input: { actions: [] } }, 'browser_batch'],
      [null, 'browser_undefined'],
    ] as const) {
      await assert.rejects(
        w.call('browser_batch', { actions: [step] }),
        code('batch_failed', new RegExp(`^1\\. ${name} failed: ${name} is not a browser tool that can run in a batch\\.\\nSTATE c1$`)),
      );
    }
  });

  test('browser_batch checks each step against its schema', async () => {
    const w = world();
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'navigate', input: {} }] }),
      code('batch_failed', /^1\. browser_navigate failed: missing argument: url\n/),
    );
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'navigate', input: 'x' }] }),
      code('batch_failed', /missing argument: url/),
    );
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'computer', input: { action: 1 } }] }),
      code('batch_failed', /argument action must be string/),
    );
    assert.equal(w.tabs.called('navigate').length, 0);
  });

  test('browser_batch reports a failing step after the earlier output', async () => {
    const w = world();
    await assert.rejects(
      w.call('browser_batch', {
        actions: [
          { name: 'tabs_close', input: { tabId: 't1' } },
          { name: 'computer', input: { action: 'fly' } },
          { name: 'tabs_close', input: { tabId: 't2' } },
        ],
      }),
      code(
        'batch_failed',
        /^1\. browser_tabs_close: Closed tab t1\.\n2\. browser_computer failed: Unknown action: fly\. .*\nNot executed: the 1 later action\.\nSTATE c1$/s,
      ),
    );
    assert.deepEqual(w.tabs.called('close'), [['c1', 't1']]);
  });

  test('browser_batch reports a non-Error throw and browser control turning off mid-batch', async () => {
    const w = world();
    w.tabs.impl.close = async () => {
      throw 'boom';
    };
    await assert.rejects(
      w.call('browser_batch', { actions: [{ name: 'tabs_close', input: { tabId: 't1' } }] }),
      code('batch_failed', /^1\. browser_tabs_close failed: boom\n/),
    );

    let n = 0;
    const w2 = world({ enabled: () => (++n <= 2 ? true : 'Paused by the user.') });
    await assert.rejects(
      w2.call('browser_batch', {
        actions: [
          { name: 'tabs_close', input: { tabId: 't1' } },
          { name: 'tabs_close', input: { tabId: 't2' } },
        ],
      }),
      (e: any) =>
        code(
          'batch_failed',
          /^1\. browser_tabs_close: Closed tab t1\.\n2\. browser_tabs_close failed: Paused by the user\.\nSTATE c1$/,
        )(e) && /failed: Paused by the user\.\n<refusal reason="browser_control_disabled" retryable="false">/.test(e.message),
    );
    assert.equal(w2.tabs.called('close').length, 1);
  });

  test('browser_batch passes an inner batch_failed error through unchanged', async () => {
    const w = world();
    const inner = new ToolError('inner failure', 'batch_failed');
    w.tabs.impl.close = async () => {
      throw inner;
    };
    await assert.rejects(w.call('browser_batch', { actions: [{ name: 'tabs_close', input: { tabId: 't1' } }] }), (e: any) => e === inner);
  });

  test('the in-app browser tools follow only their remote switches, never the Your Chrome channel choice', () => {
    const flags = (on: Record<string, boolean>) => (name: string) => on[name] === true;
    // both switches on: enabled, whatever channel the user picked for sage_browser_*
    assert.equal(inAppBrowserEnabled(flags({ 'shared.browser.parityTools': true, 'shared.browser.panelCdp': true })), true);
    // either switch off: a refusal the agent can read
    assert.equal(
      inAppBrowserEnabled(flags({ 'shared.browser.parityTools': false, 'shared.browser.panelCdp': true })),
      'Browser control is turned off.',
    );
    assert.equal(
      inAppBrowserEnabled(flags({ 'shared.browser.parityTools': true, 'shared.browser.panelCdp': false })),
      'Browser control is turned off.',
    );
  });
}
