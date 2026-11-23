// The agent's Stop and Duplicate in the built-in browser (#1362): browser_navigate "stop" and browser_tabs_create's duplicate
// (hostTabTools.cjs) over a real BrowserTabs and OriginGrants, with view tabs main spawns and fake pages that copy history
// as Electron 44 does (browser-host-kit.ts); the shared history copy itself (historyCopy.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, tabOf, drive, flush } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { readHistory, restoreHistory } = require('../electron/capabilities/browser/historyCopy.cjs');
const { PaneViews } = require('../electron/capabilities/browser/views.cjs');

/** Makes a fake webContents a view tab, as main's PaneViews makes the pages it spawns (browserHostViews.test.ts). */
function asView(wc: any) {
  const v = new PaneViews({
    WebContentsView: class {
      webContents: any;
      constructor(o: any) {
        this.webContents = o.webContents;
      }
      setBounds() {}
    },
    BrowserWindow: class {
      contentView = { addChildView() {}, removeChildView() {} };
      isDestroyed() {
        return false;
      }
      setContentSize() {}
      destroy() {}
    },
    session: () => null,
    partition: () => 'persist:browser',
    windowOf: () => null,
  });
  return v.adopt(wc).wc;
}
/** A view main spawns for chat tabs; a duplicate's gets its history first, as app/browserTools.cjs spawnView writes it. */
const spawnView = (hh: any, history?: any) => {
  const wc = asView(hh.newWC({ type: 'window', prefs: { sandbox: true, contextIsolation: true } }));
  Object.assign(wc, { url: history ? '' : 'about:blank', getZoomFactor: () => 1 });
  if (history) restoreHistory(wc, history).catch(() => undefined);
  return wc;
};

const A = 'https://shop.test/a';
const B = 'https://shop.test/b';
const LIST = 'https://shop.test/list';

const code = (c: string, re?: RegExp) => (e: any) => {
  assert.ok(e instanceof ToolError, `expected a ToolError, got ${e?.stack || e}`);
  assert.equal(e.code, c);
  if (re) assert.match(e.message, re);
  return true;
};
const textOf = (r: any) => (r ?? []).map((c: any) => c.text ?? '').join('\n');

/**
 * Chat `c` with a tab on LIST after A and B; new tabs are views main spawns (url '' when they load nothing), unless
 * `views` is off, when they are pane <webview>s that loaded about:blank. `ask` answers a site card.
 */
function app(t: any, { views = true, ask = async (): Promise<any> => ({ decision: 'allow', scope: 'chat', level: 'write' }) } = {}) {
  const spawned: any[] = [];
  const h = setup(t, {
    spawn: views
      ? (_chatId: string, hh: any, history?: any) => {
          const wc = spawnView(hh, history);
          spawned.push(wc);
          return wc;
        }
      : undefined,
  });
  // a view tab is shown by binding its page, never by a new page for its key (views.cjs)
  if (views) h.autoAttach = false;
  const wc = h.newWC();
  Object.assign(wc, {
    url: LIST,
    entries: [
      { url: A, title: 'A' },
      { url: B, title: 'B' },
      { url: LIST, title: 'List' },
    ],
    index: 2,
  });
  const source = tabOf(h, 'tab_5050aa', 'c', wc);
  const asked: string[] = [];
  const grants = new OriginGrants({
    anchor: () => 'default',
    ask: async (q: any) => (asked.push(q.origin), ask()),
    confirmAction: async () => true,
  });
  grants.allowInChat('c', 'https://shop.test', 'write');
  const tools = new Map(createBrowserTools({ tabs: h.tabs, grants }).map((x: any) => [x.name, x]));
  const call = (name: string, args: any, chatId = 'c') =>
    drive(t, (tools.get(name) as any).handler(args, { chatId, segmentId: 's1', signal: new AbortController().signal }));
  return { h, wc, source, grants, asked, call, spawned, tools };
}

/** The copy's page finishes loading. */
const finish = (wc: any) => {
  wc.loading = false;
  wc.emit('did-stop-loading');
};

test('browser_navigate "stop" ends a loading page and keeps it; a page that is not loading says so; no site card', async (t) => {
  const { wc, call, asked } = app(t);
  wc.loading = true;
  const out = textOf(await call('browser_navigate', { url: 'stop', tabId: 'tab_5050aa' }));
  assert.match(out, /^Stopped loading tab_5050aa; it keeps what loaded so far\. Tab tab_5050aa is at https:\/\/shop\.test\/list/);
  assert.equal(wc.stops, 1);
  const idle = textOf(await call('browser_navigate', { url: 'stop' }));
  assert.match(idle, /^tab_5050aa was not loading\./);
  assert.equal(wc.stops, 1);
  assert.deepEqual(asked, []);
});

test('duplicate: a new tab of the chat beside its source, with the history copied and its page loaded again; the tabs stay independent', async (t) => {
  const { h, source, call, spawned } = app(t);
  const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
  await flush();
  await flush();
  const [copy] = spawned;
  assert.ok(copy, 'a view main spawned with nothing loaded');
  assert.deepEqual(
    copy.restores[0].entries.map((e: any) => e.url),
    [A, B, LIST],
  );
  assert.equal(copy.restores[0].index, 2);
  finish(copy);
  const out = textOf(await pending);
  const tab = h.tabs.current('c');
  assert.notEqual(tab, source);
  assert.equal(tab.wc, copy);
  assert.match(
    out,
    new RegExp(`^Duplicated tab_5050aa as ${tab.id}, with its back/forward history \\(3 pages\\)\\. ${tab.id} is now the current tab\\.`),
  );
  // beside its source in the pane, opened by the agent (it closes at the turn end unless marked), not taking over the pane
  assert.deepEqual(h.log.open.at(-1), ['c', { tabKey: tab.id, focus: false, owner: h.owner, after: 'tab_5050aa' }]);
  assert.equal(tab.openedByAgent, true);
  // independent: the copy's own history moves without the source's
  assert.equal(tab.wc.navigationHistory.getActiveIndex(), 2);
  copy.index = 0;
  assert.equal(source.wc.index, 2);
  assert.notEqual(tab.wc, source.wc);
});

test("duplicate of the chat's original tab with one page: placed beside it, and the result counts one page", async (t) => {
  const { h, call, spawned } = app(t);
  const wc = h.newWC();
  Object.assign(wc, { url: A, entries: [{ url: A, title: 'A' }], index: 0 });
  // the chat's original tab has no key (null): the pane finds it as the chat's tab without one
  const original = tabOf(h, null, 'c', wc);
  assert.equal(original.legacy, true);
  const pending = call('browser_tabs_create', { duplicate: original.id });
  while (!spawned.length) await flush();
  finish(spawned[0]);
  assert.match(textOf(await pending), /with its back\/forward history \(1 page\)\./);
  assert.equal(h.log.open.at(-1)[1].after, null);
});

test("duplicate: a slow page's copy stays when its load times out, fails or the user stops it", async (t) => {
  {
    const { h, call, spawned } = app(t);
    const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
    const out = textOf(await pending);
    assert.match(out, /The page is still loading\.$/m);
    assert.equal(h.tabs.list('c').length, 2);
    assert.equal(spawned[0].destroyed, false);
  }
  {
    const { h, call, spawned } = app(t);
    const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
    await flush();
    await flush();
    spawned[0].emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', LIST, true);
    finish(spawned[0]);
    assert.match(textOf(await pending), /Couldn't load this page: the site's address wasn't found \(ERR_NAME_NOT_RESOLVED\)/m);
    assert.equal(h.tabs.list('c').length, 2);
  }
  {
    const { h, call, spawned } = app(t);
    const { stopLoading } = require('../electron/capabilities/browser/loadInterruption.cjs');
    const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
    await flush();
    await flush();
    stopLoading(spawned[0]);
    await assert.rejects(pending, code('interrupted', /The user stopped this page loading/));
    assert.equal(h.tabs.list('c').length, 2, 'the copy stays for the user');
  }
});

test('duplicate with pane views off: the copy opens the same page, says the history was not copied', async (t) => {
  const { h, call } = app(t, { views: false });
  h.newWC = ((make) => (opts: any) => {
    const wc = make(opts);
    // the pane's <webview> attaches before its blank page commits: no address yet
    wc.url = '';
    wc.handlers['Page.navigate'] = (p: any) => ((wc.url = p.url), {});
    return wc;
  })(h.newWC);
  const pending = call('browser_tabs_create', { duplicate: 'tab_5050aa' });
  const out = textOf(await pending);
  const tab = h.tabs.current('c');
  assert.match(
    out,
    new RegExp(
      `^Navigated ${tab.id} to ${LIST}.*The back/forward history of tab_5050aa could not be copied here: Back starts from this page\\.$`,
      'm',
    ),
  );
  assert.equal(tab.wc.restores.length, 0);
});

test('duplicate with pane views off: a copy whose page could not open is closed, and the call says why', async (t) => {
  const { h, call } = app(t, { views: false });
  h.newWC = ((make) => (opts: any) => {
    const wc = make(opts);
    wc.handlers['Page.navigate'] = () => ({ errorText: 'net::ERR_CONNECTION_REFUSED' });
    return wc;
  })(h.newWC);
  await assert.rejects(call('browser_tabs_create', { duplicate: 'tab_5050aa' }), code('failed', /ERR_CONNECTION_REFUSED/));
  assert.equal(h.log.close.length, 1);
  assert.deepEqual(
    h.tabs.list('c').map((x: any) => x.id),
    ['tab_5050aa'],
  );
});

test("duplicate refusals: no page yet, both url and duplicate, another chat's tab, a denied site, a tab that moved while asked", async (t) => {
  {
    const { wc, call, h } = app(t);
    wc.entries = [{ url: 'chrome://settings', title: '' }];
    wc.index = 0;
    await assert.rejects(
      call('browser_tabs_create', { duplicate: 'tab_5050aa' }),
      code('bad_args', /has no history that can be copied \(only web pages can be\)/),
    );
    await assert.rejects(call('browser_tabs_create', { duplicate: 'tab_5050aa', url: A }), code('bad_args', /url or duplicate, not both/));
    await assert.rejects(
      call('browser_tabs_create', { duplicate: 'tab_5050aa' }, 'other'),
      code('bad_args', /No tab tab_5050aa in this chat/),
    );
    assert.equal(h.tabs.list('c').length, 1);
  }
  {
    // the page is on a site this chat denied: the copy goes through the same check as a navigation, and opens nothing
    const other = app(t, { ask: async () => ({ decision: 'deny', scope: 'chat' }) });
    const ctx = { chatId: 'c', segmentId: 's1' };
    await assert.rejects(other.grants.require('https://elsewhere.test/', 'read', ctx, {}));
    Object.assign(other.wc, { entries: [{ url: 'https://elsewhere.test/', title: 'E' }], index: 0, url: 'https://elsewhere.test/' });
    await assert.rejects(other.call('browser_tabs_create', { duplicate: 'tab_5050aa' }), (e: any) => e instanceof ToolError);
    assert.equal(other.h.tabs.list('c').length, 1);
    assert.equal(other.spawned.length, 0);
  }
  {
    // the user's page moved to another site while the card was up
    const moved = app(t, {
      ask: async () => {
        // the page started loading another site (its committed address is still the bank's)
        moved.wc.entries = [{ url: 'https://other.test/', title: 'O' }];
        moved.wc.index = 0;
        return { decision: 'allow', scope: 'chat', level: 'write' };
      },
    });
    // a high-risk site asks for every page, the tab's own included
    Object.assign(moved.wc, { entries: [{ url: 'https://www.chase.com/acct', title: 'E' }], index: 0, url: 'https://www.chase.com/acct' });
    await assert.rejects(
      moved.call('browser_tabs_create', { duplicate: 'tab_5050aa' }),
      code('tab_changed', /moved while the user was being asked/),
    );
    assert.equal(moved.spawned.length, 0);
  }
});

test('duplicate: a copy that never got its history is closed before anything is sent to it, and the call says why', async (t) => {
  const { h, call, spawned } = app(t);
  // Electron refuses the history, writing nothing, and the view stays a page that loaded nothing
  h.tabs.o.spawn = (_chatId: string, history: any) => {
    const wc = spawnView(h);
    wc.url = '';
    wc.navigationHistory.restore = () => {
      const p = Promise.reject(new Error('Cannot restore history on webContents that have previously loaded a page.'));
      p.catch(() => undefined);
      return p;
    };
    restoreHistory(wc, history).catch(() => undefined);
    spawned.push(wc);
    return wc;
  };
  await assert.rejects(call('browser_tabs_create', { duplicate: 'tab_5050aa' }), code('failed', /could not be copied to a new tab/));
  assert.equal(h.log.close.length, 1);
  // no debugger command reached the page that loaded nothing (it would never answer)
  assert.equal(spawned[0].debugger.calls.length, 0);
  assert.deepEqual(
    h.tabs.list('c').map((x: any) => x.id),
    ['tab_5050aa'],
  );
});

test("loaded: a duplicate's first load is waited for as a navigation's: done already, closed meanwhile, or past the deadline", async (t) => {
  const { h, source } = app(t);
  source.wc.ops.state = () => ({ quietMs: 1000 });
  // already loaded: the page settles
  assert.deepEqual(await drive(t, h.tabs.loaded(source)), { url: LIST, title: '' });
  // closed while it loads
  source.wc.loading = true;
  const closed = drive(t, h.tabs.loaded(source));
  await flush();
  source.wc.emit('destroyed');
  await assert.rejects(closed, code('tab_closed', /closed while loading/));
  // the deadline passed as the load ended: it settles rather than saying it still loads
  const late = app(t);
  late.source.wc.ops.state = () => ({ quietMs: 1000 });
  late.source.wc.loading = true;
  const pending = drive(t, late.h.tabs.loaded(late.source), { max: 4000, step: 100 });
  for (let i = 0; i < 5; i++) await flush();
  t.mock.timers.tick(19_999);
  late.source.wc.loading = false;
  assert.deepEqual(await pending, { url: LIST, title: '' });
});

test("PaneViews.create: a duplicate's view gets its history before main tracks it, and loads no page of its own", async () => {
  const order: string[] = [];
  const copy = { entries: [{ url: A, title: 'A' }], index: 0 };
  const page = (refuse: boolean) => ({
    loadURL: () => (order.push('loadURL'), Promise.resolve()),
    on: () => undefined,
    once: () => undefined,
    setVisualZoomLevelLimits: () => undefined,
    navigationHistory: {
      restore: () => {
        order.push('restore');
        const p = refuse ? Promise.reject(new Error('refused')) : new Promise<void>(() => {});
        p.catch(() => undefined);
        return p;
      },
      length: () => 1,
      getActiveIndex: () => 0,
      getEntryAtIndex: () => ({ url: refuse ? '' : A }),
    },
  });
  let refuse = false;
  const views = new PaneViews({
    WebContentsView: class {
      webContents = page(refuse);
      setBounds() {}
    },
    BrowserWindow: class {
      contentView = { addChildView() {}, removeChildView() {} };
      isDestroyed() {
        return false;
      }
      setContentSize() {}
      destroy() {}
    },
    session: () => null,
    partition: () => 'persist:browser',
    windowOf: () => null,
    onCreated: () => order.push('tracked'),
  });
  views.create({ partition: 'p', url: 'about:blank', history: copy });
  views.create({ partition: 'p', url: 'about:blank' });
  refuse = true;
  views.create({ partition: 'p', history: copy });
  await flush();
  assert.deepEqual(order, ['restore', 'tracked', 'tracked', 'loadURL', 'restore', 'tracked']);
});

test("historyCopy: only web histories are read; a restore counts once the entries are the page's, whatever its load does", async () => {
  const page = (entries: any, index: any) => ({ navigationHistory: { getAllEntries: () => entries, getActiveIndex: () => index } });
  for (const [entries, index] of [
    [null, 0],
    [[], 0],
    [[{ url: A, title: 'A' }], 1],
    [[{ url: A, title: 'A' }], -1],
    [[{ url: A, title: 'A' }], 0.5],
    [[null], 0],
    [[{ url: A }], 0],
    [[{ url: 'file:///etc/hosts', title: 'f' }], 0],
  ])
    assert.equal(readHistory(page(entries, index)), null, JSON.stringify([entries, index]));
  const copy = readHistory(
    page(
      [
        { url: 'about:blank', title: '' },
        { url: A, title: 'A', pageState: 'x' },
      ],
      1,
    ),
  );
  assert.deepEqual(copy, {
    entries: [
      { url: 'about:blank', title: '' },
      { url: A, title: 'A', pageState: 'x' },
    ],
    index: 1,
  });

  /** A page whose restore writes `wrote` (null: nothing) and returns `load`. */
  const target = (wrote: any, load: Promise<void>) => {
    let entries = [{ url: '', title: '' }];
    let index = 0;
    return {
      navigationHistory: {
        length: () => entries.length,
        getActiveIndex: () => index,
        getEntryAtIndex: (i: number) => entries[i],
        restore: () => {
          load.catch(() => undefined);
          if (wrote) ({ entries, index } = wrote);
          return load;
        },
      },
    };
  };
  const never = new Promise<void>(() => {});
  await restoreHistory(target(copy, never), copy);
  await restoreHistory(target(copy, Promise.reject(new Error(' (-3) loading'))), copy);
  await assert.rejects(restoreHistory(target(null, Promise.reject(new Error('previously loaded'))), copy), /previously loaded/);
  await assert.rejects(restoreHistory(target(null, Promise.resolve()), copy), /could not be copied/);
  // the same length, another place or other pages are no copy
  await assert.rejects(restoreHistory(target({ ...copy, index: 0 }, Promise.resolve()), copy), /could not be copied/);
  await assert.rejects(
    restoreHistory(target({ entries: [{ url: 'about:blank' }, { url: B }], index: 1 }, Promise.resolve()), copy),
    /could not be copied/,
  );
  await assert.rejects(restoreHistory(target({ entries: [{ url: A }], index: 0 }, Promise.resolve()), copy), /could not be copied/);
});
