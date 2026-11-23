// Browser navigation permissions and tab lifecycle cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { browserToolSpecs, world, first, endsWithState, code, TODAY } from './fixture';

export function registerNavigationCases() {
  // ---------------------------------------------------------------- navigation and site permission

  test('browser_navigate on the same origin does not ask and passes tab ids through', async () => {
    const w = world();
    const out = await w.call('browser_navigate', { url: 'a.example/other', tabId: 'tA' });
    assert.equal(first(out), 'Navigated t1 to https://a.example/other (T).');
    endsWithState(out);
    assert.deepEqual(w.tabs.called('resolve')[0], ['c1', 'tA']);
    assert.deepEqual(w.tabs.called('navigate'), [[w.tabs.tab, 'https://a.example/other']]);
    assert.deepEqual(w.tabs.called('ready')[0], [w.tabs.tab, 'c1']);
    assert.equal(w.tabs.called('run').length, 1);
    assert.equal(w.st.asks.length, 0);

    await w.call('browser_navigate', { url: 'https://a.example/x', tab_id: 'tB' });
    assert.deepEqual(w.tabs.called('resolve')[1], ['c1', 'tB']);
    await w.call('browser_navigate', { url: 'https://a.example/y' });
    assert.deepEqual(w.tabs.called('resolve')[2], ['c1', null]);
  });

  test('browser_navigate on the same origin without any grant still skips the question', async () => {
    const w = world();
    w.tabs.tab.url = 'https://e.example/1';
    const out = await w.call('browser_navigate', { url: 'https://e.example/2' });
    assert.equal(first(out), 'Navigated t1 to https://e.example/2 (T).');
    assert.equal(w.st.asks.length, 0);
  });

  test('within the same site, a high-risk page or a URL with credentials still asks', async () => {
    const w = world();
    w.st.answer = { decision: 'allow', scope: 'once', level: 'read' };
    // an ordinary page of a site: no card; its security settings (high risk, per path): a card
    w.tabs.tab.url = 'https://myaccount.google.com/';
    await w.call('browser_navigate', { url: 'https://myaccount.google.com/personal-info' });
    assert.equal(w.st.asks.length, 0);
    await w.call('browser_navigate', { url: 'https://myaccount.google.com/security' });
    assert.equal(w.st.asks.length, 1);
    assert.equal(w.st.asks[0].origin, 'https://myaccount.google.com');
    // a name and password in the address ask every time, however the site was allowed
    w.tabs.tab.url = 'https://a.example/';
    await w.call('browser_navigate', { url: 'https://admin:pw@a.example/' });
    assert.equal(w.st.asks.length, 2);
  });

  test('browser_navigate to a new origin asks, offering read and write', async () => {
    const w = world();
    const out = await w.call('browser_navigate', { url: 'https://b.example/' });
    assert.equal(first(out), 'Navigated t1 to https://b.example/ (T).');
    assert.deepEqual(w.st.asks, [{ chatId: 'c1', segmentId: 's1', browser: 'iab', origin: 'https://b.example', need: 'write' }]);
  });

  test('browser_navigate to a loopback origin can be allowed for good to read only, never to write', async () => {
    const w = world();
    w.st.answer = { decision: 'allow', scope: 'always', level: 'write' };
    await w.call('browser_navigate', { url: 'localhost:3000' });
    assert.deepEqual(w.tabs.called('navigate')[0][1], 'http://localhost:3000/');
    assert.equal(w.st.asks[0].allowAlways, 'read');
    assert.equal(w.grants.get('http://localhost:3000'), null);
    // counted for the chat: a second navigation there does not ask again
    w.tabs.tab.url = 'https://a.example/page';
    await w.call('browser_navigate', { url: 'http://localhost:3000/b' });
    assert.equal(w.st.asks.length, 1);
  });

  test('a site denied in this chat stays denied, even for a same-origin navigation', async () => {
    const w = world();
    w.st.answer = { decision: 'deny' };
    await assert.rejects(w.call('browser_navigate', { url: 'https://d.example/' }), code('denied', /did not allow https:\/\/d\.example/));
    assert.equal(w.tabs.called('navigate').length, 0);
    w.tabs.tab.url = 'https://d.example/x';
    await assert.rejects(w.call('browser_navigate', { url: 'https://d.example/y' }), code('denied'));
    assert.equal(w.st.asks.length, 1);
    assert.equal(w.tabs.called('navigate').length, 0);
    // reading the denied page is refused too
    await assert.rejects(w.call('browser_read_page', {}), code('denied', /^The user did not allow https:\/\/d\.example in this chat\.$/));
    assert.equal(w.tabs.called('readPage').length, 0);
  });

  test('a cross-origin redirect needs its own grant; refused, the tab goes to about:blank', async () => {
    const w = world();
    w.tabs.impl.navigate = async (_tab: any, url: string) =>
      url === 'about:blank' ? { url } : { url: 'https://evil.example/landing', title: 'Evil' };
    w.st.answers = [{ decision: 'allow', scope: 'chat', level: 'write' }, { decision: 'deny' }];
    await assert.rejects(w.call('browser_navigate', { url: 'https://b.example/' }), code('denied', /evil\.example/));
    assert.deepEqual(
      w.st.asks.map((a: any) => a.origin),
      ['https://b.example', 'https://evil.example'],
    );
    assert.deepEqual(
      w.tabs.called('navigate').map((c: any) => c[1]),
      ['https://b.example/', 'about:blank'],
    );
  });

  test('a refused redirect still reports the refusal when leaving the page fails', async () => {
    const w = world();
    w.tabs.impl.navigate = async (_tab: any, url: string) => {
      if (url === 'about:blank') throw new Error('tab gone');
      return { url: 'https://evil.example/', title: '' };
    };
    w.st.answers = [{ decision: 'allow', scope: 'once', level: 'write' }, { decision: 'deny' }];
    await assert.rejects(w.call('browser_navigate', { url: 'https://b.example/' }), code('denied'));
    assert.equal(w.tabs.called('navigate').length, 2);
  });

  test('an allowed cross-origin redirect reports where it landed and the note', async () => {
    const w = world();
    w.tabs.impl.navigate = async () => ({ url: 'https://c.example/home', title: 'Home', note: 'A download started.' });
    const out = await w.call('browser_navigate', { url: 'https://b.example/' });
    assert.equal(first(out), 'Navigated t1 to https://c.example/home (Home). A download started.');
    assert.equal(w.st.asks.length, 2);
  });

  test('navigating to about:blank needs no permission', async () => {
    const w = world();
    w.tabs.impl.navigate = async () => ({ url: 'about:blank', title: '' });
    const out = await w.call('browser_navigate', { url: 'about:blank' });
    assert.equal(first(out), 'Navigated t1 to about:blank.');
    assert.equal(w.st.asks.length, 0);
  });

  test('Full access allows a new origin without asking', async () => {
    const w = world();
    w.st.anchor = 'full';
    await w.call('browser_navigate', { url: 'https://new.example/' });
    assert.equal(w.st.asks.length, 0);
  });

  test('browser_navigate back, forward and reload go through history and gate the target', async () => {
    const w = world();
    let out = await w.call('browser_navigate', { url: 'back' });
    assert.equal(first(out), 'Navigated t1 to https://a.example/prev (Prev).');
    assert.deepEqual(w.tabs.called('historyTarget')[0], [w.tabs.tab, 'back']);
    assert.deepEqual(w.tabs.called('history')[0], [w.tabs.tab, 'back']);
    assert.equal(w.tabs.called('navigate').length, 0);

    out = await w.call('browser_navigate', { url: 'reload' });
    assert.equal(w.tabs.called('historyTarget').length, 1);
    assert.deepEqual(w.tabs.called('history')[1], [w.tabs.tab, 'reload']);

    w.tabs.impl.historyTarget = () => 'https://f.example/next';
    w.tabs.impl.history = async () => ({ url: 'https://f.example/next', title: '' });
    out = await w.call('browser_navigate', { url: 'forward' });
    assert.equal(first(out), 'Navigated t1 to https://f.example/next.');
    assert.deepEqual(
      w.st.asks.map((a: any) => a.origin),
      ['https://f.example'],
    );

    w.tabs.impl.historyTarget = () => null;
    await assert.rejects(w.call('browser_navigate', { url: 'back' }), code('bad_args', /no page to go back to/));
  });

  test('browser_navigate rejects a non-http URL', async () => {
    const w = world();
    await assert.rejects(w.call('browser_navigate', { url: 'file:///etc/passwd' }), code('bad_url'));
  });

  // ---------------------------------------------------------------- tabs_*

  test('browser_tabs_context lists the tabs with markers and the folders, made before they are named (#1570)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-context-'));
    const up = path.join(base, 'up', 'c1');
    const down = path.join(base, 'down', 'c1');
    const w = world({
      folders: (chatId: string) => ({ uploads: path.join(base, 'up', chatId), downloads: path.join(base, 'down', chatId) }),
    });
    w.tabs.list_.push({ id: 't3', url: '', title: 'Pop\nup', kind: 'popup', mark: 'handoff' });
    const out = await w.call('browser_tabs_context');
    assert.equal(
      first(out),
      'Tabs in this chat:\n- t1 (current): "A page" https://a.example/page\n- t3 (popup window) [handoff]: "Pop up" about:blank' +
        `\nUpload folder (browser_file_upload reads only from here; save or copy a file into it to upload it): ${up}\nDownloads from tabs you drive are saved to: ${down}\n${TODAY}`,
    );
    endsWithState(out);
    assert.equal(w.tabs.called('create').length, 0);
    // an agent writes the file it uploads straight into the folder it was told about
    assert.ok(fs.statSync(up).isDirectory());
    assert.ok(fs.statSync(down).isDirectory());
    fs.rmSync(base, { recursive: true, force: true });
  });

  test('browser_tabs_context names no folder it could not make, and says so (#1570)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-context-'));
    try {
      const file = path.join(base, 'not-a-folder');
      fs.writeFileSync(file, '');
      for (const folders of [
        () => ({ uploads: path.join(file, 'up'), downloads: path.join(base, 'down') }),
        () => ({ uploads: path.join(base, 'up'), downloads: path.join(file, 'down') }),
      ]) {
        const out = first(await world({ folders }).call('browser_tabs_context'));
        assert.match(
          out,
          /^Tabs in this chat:\n- t1 \(current\): "A page" https:\/\/a\.example\/page\nNo upload folder: ENOTDIR.*browser_file_upload can't be used in this chat\.\nToday is /s,
        );
        assert.doesNotMatch(out, /Upload folder \(|saved to:/);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("browser_tabs_context names no downloads folder for a host that saves none there (the user's Chrome, #1570)", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'tabs-context-'));
    try {
      const up = path.join(base, 'up');
      const out = first(await world({ folders: () => ({ uploads: up, downloads: null }) }).call('browser_tabs_context'));
      assert.equal(
        out,
        `Tabs in this chat:\n- t1 (current): "A page" https://a.example/page\nUpload folder (browser_file_upload reads only from here; save or copy a file into it to upload it): ${up}\n${TODAY}`,
      );
      assert.ok(fs.statSync(up).isDirectory());
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('browser_tabs_context without folders, and with folders returning nothing', async () => {
    for (const folders of [undefined, () => null]) {
      const w = world({ folders });
      assert.equal(
        first(await w.call('browser_tabs_context')),
        `Tabs in this chat:\n- t1 (current): "A page" https://a.example/page\n${TODAY}`,
      );
    }
  });

  test('browser_tabs_context opens a focused tab when the chat has none', async () => {
    const w = world();
    w.tabs.list_.length = 0;
    const out = await w.call('browser_tabs_context');
    assert.deepEqual(w.tabs.called('create'), [['c1', { focus: true }]]);
    assert.equal(first(out), `Tabs in this chat:\n- t2 (current): "" about:blank\n${TODAY}`);

    const w2 = world();
    w2.tabs.list_.length = 0;
    w2.tabs.impl.create = async () => ({ id: 't9' });
    assert.equal(first(await w2.call('browser_tabs_context')), `No tabs in this chat.\n${TODAY}`);
  });

  test('browser_tabs_create opens an unfocused tab, optionally loading a URL', async () => {
    const w = world();
    let out = await w.call('browser_tabs_create');
    assert.equal(first(out), 'Created new tab with tabId: t2. It is now the current tab.');
    assert.deepEqual(w.tabs.called('create'), [['c1', { focus: false }]]);
    assert.equal(w.tabs.called('navigate').length, 0);

    out = await w.call('browser_tabs_create', { url: 'https://a.example/n' });
    assert.equal(first(out), 'Created new tab with tabId: t2. It is now the current tab. Navigated t2 to https://a.example/n (T).');
    const nav = w.tabs.called('navigate')[0];
    assert.equal(nav[0].id, 't2');
    assert.equal(nav[1], 'https://a.example/n');
    assert.equal(w.tabs.called('run').length, 1);
    endsWithState(out);
  });

  test('browser_tabs_close, browser_tabs_select and browser_tabs_mark', async () => {
    const w = world();
    assert.equal(first(await w.call('browser_tabs_close', { tabId: 't1' })), 'Closed tab t1.');
    assert.deepEqual(w.tabs.called('close'), [['c1', 't1']]);

    assert.equal(
      first(await w.call('browser_tabs_select', { tabId: 't1' })),
      'Switched to tab t1. Tab t1 is at https://a.example/page (A page).',
    );
    w.tabs.impl.select = () => ({ id: 't9', url: '', title: '' });
    assert.equal(first(await w.call('browser_tabs_select', { tabId: 't9' })), 'Switched to tab t9. Tab t9 is at about:blank.');
    assert.deepEqual(w.tabs.called('select')[1], ['c1', 't9']);

    const out = await w.call('browser_tabs_mark', { tabId: 't1', status: 'deliverable' });
    assert.equal(
      first(out),
      'Marked t1 as deliverable: it stays open after this turn for the user, including a later message in this chat.',
    );
    assert.deepEqual(w.tabs.called('mark'), [['c1', 't1', 'deliverable']]);
    endsWithState(out);
    assert.equal(
      first(await w.call('browser_tabs_mark', { tabId: 't1', status: 'handoff' })),
      'Marked t1 as handoff: it stays open after this turn and is handed to the user to continue. Tell them what to do there.',
    );
    assert.deepEqual(w.tabs.called('mark')[1], ['c1', 't1', 'handoff']);
    const spec = browserToolSpecs().find((s: any) => s.name === 'browser_tabs_mark');
    assert.deepEqual(spec.inputSchema.properties.status.enum, ['deliverable', 'handoff']);
    assert.match(spec.inputSchema.properties.status.description, /"deliverable": keep the tab open for the user as the result/);
    assert.match(spec.description, /"handoff": the user must continue in the tab themselves/);
  });
}
