// Duplicate's main-owned token/identity boundary and Stop outcome use fake Electron pages only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PaneNavigation, registerPaneNavigation } = require('../electron/capabilities/browser/paneNavigation.cjs');
const { withLoadInterruption, stopLoading, STOP_LOADING } = require('../electron/capabilities/browser/loadInterruption.cjs');
const defer = () => {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function setup(options: any = {}) {
  const sender = new EventEmitter();
  const other = new EventEmitter();
  const session = {};
  const pages = new Map<number, any>();
  let next = 0;
  const make = (chat: string | null = 'chat', owner = sender, ses = session) => {
    const wc: any = new EventEmitter();
    Object.assign(wc, {
      id: ++next,
      chat,
      owner,
      session: ses,
      url: 'about:blank',
      destroyed: false,
      entries: [
        { url: 'https://a.test/', title: 'A' },
        { url: 'https://b.test/', title: 'B' },
        { url: 'https://c.test/', title: 'C' },
      ],
      index: 1,
      restores: [],
      isDestroyed: () => wc.destroyed,
      getURL: () => wc.url,
      close: () => {
        wc.destroyed = true;
        wc.emit('destroyed');
      },
      stop: () => wc.emit('did-stop-loading'),
    });
    // Electron 44: restore writes the entries at once and returns the current entry's load (did-finish-load or
    // did-fail-load), with a no-op rejection handler; a page that loaded anything refuses, writing nothing
    wc.navigationHistory = {
      getAllEntries: () => wc.entries,
      getActiveIndex: () => wc.index,
      length: () => wc.entries.length,
      getEntryAtIndex: (i: number) => wc.entries[i],
      restore: (state: any) => {
        wc.restores.push(state);
        const result = wc.refuse ?? wc.restoreResult ?? Promise.resolve();
        result.catch(() => undefined);
        if (!wc.refuse) Object.assign(wc, { entries: state.entries, index: state.index });
        return result;
      },
    };
    pages.set(wc.id, wc);
    return wc;
  };
  const deps = {
    page: (owner: any, id: number) => {
      const wc = pages.get(id);
      if (!wc || wc.destroyed || wc.owner !== owner) throw new Error('foreign page');
      return wc;
    },
    create: (_sender: any, _paneId: string, _source: any, chat: string | null) => (target = blank(make(chat, _sender))),
    chatOf: (chat: string) => (chat === 'native:key' ? 'chat' : chat),
    ownerOf: (wc: any) => wc.chat,
    ...options,
  };
  /** A page main just created: one empty entry, nothing loaded */
  const blank = (wc: any) => Object.assign(wc, { entries: [{ url: '', title: '' }], index: 0 });
  const nav = new PaneNavigation(deps);
  const source = make();
  let target: any;
  nav.bind(sender, 'source', source.id, 'native:key');
  return {
    sender,
    other,
    session,
    pages,
    make,
    nav,
    source,
    get target() {
      return (target ??= blank(make()));
    },
    deps,
    bind: () => nav.bind(sender, 'copy', (target ??= blank(make())).id, 'chat'),
  };
}

test('history snapshot preserves both directions/index, restores once to a distinct page and never mutates source', async () => {
  const h = setup();
  const snapshot = h.nav.capture(h.sender, 'source', 'copy');
  assert.deepEqual({ url: snapshot.url, title: snapshot.title, chat: snapshot.chat }, { url: 'https://b.test/', title: 'B', chat: 'chat' });
  h.source.entries[1].title = 'changed after capture';
  h.source.index = 2;
  h.bind();
  assert.equal(await h.nav.restore(h.sender, snapshot.token, 'copy'), true);
  assert.equal(h.target.restores[0].index, 1);
  assert.equal(h.target.restores[0].entries.length, 3);
  assert.equal(h.target.restores[0].entries[1].title, 'B');
  assert.equal(h.source.entries[1].title, 'changed after capture');
  assert.equal(h.source.restores.length, 0);
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'), /no longer available/);
  assert.equal(h.nav.copies.size, 0);
});

test('foreign windows/chats/session, wrong targets and reused page IDs cannot redeem a token', async () => {
  const h = setup();
  const snapshot = h.nav.capture(h.sender, 'source', 'copy');
  assert.throws(() => h.nav.capture(h.other, 'source', 'wrong'));
  assert.throws(() => h.nav.bind(h.other, 'source', h.source.id, 'chat'));
  assert.throws(() => h.nav.bind(h.sender, 'source', h.source.id, 'foreign'));
  assert.throws(() => h.nav.bind(h.sender, '', h.source.id, 'chat'));
  assert.throws(() => h.nav.bind(h.sender, 'bad', h.source.id, undefined));
  await assert.rejects(h.nav.restore(h.other, snapshot.token, 'copy'));
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'other'));
  h.target.chat = 'foreign';
  h.nav.bindings.get(h.sender).get('copy').chat = 'foreign';
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'));
  h.target.chat = 'chat';
  h.nav.bindings.get(h.sender).get('copy').chat = 'chat';
  h.target.session = {};
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'));
  h.target.session = h.session;
  h.target.url = 'https://already-used.test/';
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'));
  h.target.url = 'about:blank';
  const original = h.source;
  const reused = h.make();
  h.pages.set(original.id, reused);
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'));
  assert.equal(h.target.restores.length, 0);
  assert.equal(h.nav.cancel(h.other, snapshot.token), false);
  h.nav.cancel(h.sender, snapshot.token);
});

test('source/target/window retirement before the history is written closes only the partial copy; late settlement cannot publish', async () => {
  for (const retire of ['source', 'target', 'window', 'reload', 'owner']) {
    const h = setup();
    const snapshot = h.nav.capture(h.sender, 'source', 'copy');
    h.bind();
    // Electron answers the restore late, without having written the history
    const deferred = defer();
    h.target.refuse = deferred.promise;
    const restored = h.nav.restore(h.sender, snapshot.token, 'copy');
    const rejected = assert.rejects(restored);
    if (retire === 'source') h.source.close();
    if (retire === 'target') h.target.close();
    if (retire === 'window') h.sender.emit('destroyed');
    if (retire === 'reload') h.sender.emit('did-navigate');
    if (retire === 'owner') h.source.chat = 'foreign';
    deferred.reject(new Error('late refusal'));
    await rejected;
    assert.equal(h.target.destroyed, true);
    assert.equal(h.source.destroyed, retire === 'source');
    assert.equal(h.nav.copies.size, 0);
  }
});

test('the copy is done once its history is written: a slow, stopped or failed load of its page never holds or undoes it (#1362)', async () => {
  for (const settle of ['stopped', 'failed', 'finished']) {
    const h = setup();
    const snapshot = h.nav.capture(h.sender, 'source', 'copy');
    h.bind();
    // the current entry's page is still loading (a slow report): Electron's promise has not settled
    const load = defer();
    h.target.restoreResult = load.promise;
    assert.equal(await h.nav.restore(h.sender, snapshot.token, 'copy'), true);
    assert.deepEqual(
      [h.target.index, h.target.entries.map((e: any) => e.url)],
      [1, ['https://a.test/', 'https://b.test/', 'https://c.test/']],
    );
    assert.equal(h.nav.copies.size, 0);
    if (settle === 'stopped') load.reject(new Error(" (-3) loading 'https://b.test/'"));
    if (settle === 'failed') load.reject(new Error('ERR_CONNECTION_REFUSED'));
    if (settle === 'finished') load.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.target.destroyed, false, settle);
    assert.equal(h.nav.get(h.sender, 'copy').wc, h.target);
    // the source and the copy stay independent afterwards
    h.source.close();
    assert.equal(h.target.destroyed, false);
  }
});

test('a refused restore rolls back only its new page, a timeout expires the token, and a fresh attempt succeeds', async () => {
  const h = setup({ timeoutMs: 10 });
  const snapshot = h.nav.capture(h.sender, 'source', 'copy');
  h.bind();
  h.target.refuse = Promise.reject(new Error('Cannot restore history on webContents that have previously loaded a page.'));
  await assert.rejects(h.nav.restore(h.sender, snapshot.token, 'copy'), /previously loaded/);
  assert.equal(h.target.destroyed, true);
  assert.equal(h.source.destroyed, false);
  const next = h.nav.capture(h.sender, 'source', 'again');
  const again = h.target;
  h.nav.bind(h.sender, 'again', again.id, 'chat');
  assert.equal(await h.nav.restore(h.sender, next.token, 'again'), true);
  const expired = h.nav.capture(h.sender, 'source', 'expired');
  await new Promise((resolve) => setTimeout(resolve, 15));
  await assert.rejects(h.nav.restore(h.sender, expired.token, 'expired'));
});

test('invalid history/identity fails visibly; valid optional Electron entry fields and chatless panes are accepted', async () => {
  const h = setup();
  for (const entries of [null, [], [null], [{ url: 'file:///private', title: 'bad' }], [{ url: 'https://a.test/', title: 1 }]]) {
    h.source.entries = entries;
    assert.throws(() => h.nav.capture(h.sender, 'source', 'copy'));
  }
  h.source.entries = [{ url: 'https://a.test/', title: '', pageState: 'opaque native state' }];
  for (const index of [-1, 1, NaN, 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    h.source.index = index;
    assert.throws(() => h.nav.capture(h.sender, 'source', 'copy'));
  }
  h.source.index = 0;
  assert.throws(() => h.nav.capture(h.sender, 'source', 'source'));
  assert.throws(() => h.nav.capture(h.sender, 'source', null));
  const snapshot = h.nav.capture(h.sender, 'source', 'copy');
  assert.throws(() => h.nav.capture(h.sender, 'source', 'copy'));
  h.bind();
  assert.equal(h.bind(), true);
  assert.throws(() => h.nav.bind(h.sender, 'copy', h.source.id, 'chat'));
  await h.nav.restore(h.sender, snapshot.token, 'copy');
  assert.equal(h.target.restores[0].entries[0].pageState, 'opaque native state');
  const page = h.make(null);
  h.nav.bind(h.sender, 'no-chat', page.id, null);
  assert.equal(h.nav.get(h.sender, 'no-chat').chat, null);
});

test('Stop rejects an unresolved load promptly and cleans up; normal errors and a later retry stay distinct', async () => {
  const h = setup();
  const pending = defer();
  let continued = false;
  const load = withLoadInterruption(h.source, async (wait: any) => {
    await wait(pending.promise);
    continued = true;
  });
  const rejected = assert.rejects(load, { code: 'interrupted' });
  stopLoading(h.source);
  await rejected;
  pending.resolve();
  await Promise.resolve();
  assert.equal(continued, false);
  assert.equal(h.source.listenerCount(STOP_LOADING), 0);
  assert.equal(await withLoadInterruption(h.source, async (wait: any) => await wait(Promise.resolve('retry'))), 'retry');
  await assert.rejects(
    withLoadInterruption(h.source, () => {
      throw new Error('real failure');
    }),
    /real failure/,
  );
  h.source.stop = () => {
    throw new Error('stop refused');
  };
  assert.throws(() => stopLoading(h.source), /stop refused/);
});

test('registered IPC binds, captures, restores, discards and stops through the same page authority', async () => {
  const h = setup();
  const handlers = new Map<string, Function>();
  const nav = registerPaneNavigation({ handle: (name: string, fn: Function) => handlers.set(name, fn) }, h.deps);
  const call = (name: string, ...args: any[]) => handlers.get(`browser:${name}`)!({ sender: h.sender }, ...args);
  call('bindPane', 's', h.source.id, 'chat');
  const copy = call('captureHistory', 's', 't');
  call('bindPane', 't', h.target.id, 'chat');
  assert.equal(await call('restoreHistory', copy.token, 't'), true);
  assert.equal(call('discardHistory', copy.token), false);
  let stops = 0;
  h.source.on(STOP_LOADING, () => stops++);
  call('stopLoading', h.source.id);
  assert.equal(stops, 1);
  assert.equal(nav.copies.size, 0);
});

test('only the main-created target can be restored or rolled back, and per-page ownership rejects aliases', async () => {
  const h = setup();
  const unrelated = h.make();
  const snapshot = h.nav.capture(h.sender, 'source', 'copy');
  assert.throws(() => h.nav.bind(h.sender, 'copy', unrelated.id, 'chat'));
  assert.equal(unrelated.restores.length, 0);
  assert.equal(unrelated.destroyed, false);
  assert.equal(h.nav.bind(h.sender, 'alias', h.source.id, 'chat'), true);
  assert.equal(h.nav.bind(h.sender, 'unrelated', unrelated.id, 'chat'), true);
  h.nav.ownerOf = () => undefined;
  assert.throws(() => h.nav.bind(h.sender, 'other-chat', h.source.id, 'other'));
  h.nav.cancel(h.sender, snapshot.token);
  assert.equal(h.target.destroyed, true);
  assert.equal(unrelated.destroyed, false);
  const shared = setup();
  shared.nav.page = (_sender: any, id: number) => shared.pages.get(id);
  shared.nav.bind(shared.other, 'other-source', shared.source.id, 'chat');
  const otherCopy = shared.nav.capture(shared.other, 'other-source', 'other-copy');
  const firstCopy = shared.nav.capture(shared.sender, 'source', 'copy');
  assert.equal(shared.nav.cancel(shared.sender, otherCopy.token), false);
  shared.nav.cancel(shared.sender, firstCopy.token);
  shared.nav.cancel(shared.other, otherCopy.token);
});

test('native reservation failure and disposal refusal never report successful duplication', async () => {
  const h = setup();
  h.nav.create = () => {
    throw new Error('creation refused');
  };
  assert.throws(() => h.nav.capture(h.sender, 'source', 'copy'), /creation refused/);
  const invalid = h.make('other');
  h.nav.create = () => invalid;
  assert.throws(() => h.nav.capture(h.sender, 'source', 'copy'), /no longer available/);
  assert.equal(invalid.destroyed, true);
  const retry = setup();
  const snapshot = retry.nav.capture(retry.sender, 'source', 'copy');
  retry.target.close = () => {
    throw new Error('close refused');
  };
  assert.equal(retry.nav.cancel(retry.sender, snapshot.token), false);
  await assert.rejects(retry.nav.restore(retry.sender, snapshot.token, 'copy'));
});

test('opaque pane/chat identifiers retain their exact boundaries through reservation and restore', async () => {
  const h = setup();
  const chat = 'chat:"a\\b:c"';
  const page = h.make(chat);
  const source = 'pane:a:b\\"c';
  const destination = 'pane:a\\b:"c';
  h.nav.bind(h.sender, source, page.id, chat);
  const snapshot = h.nav.capture(h.sender, source, destination);
  assert.equal(snapshot.chat, chat);
  assert.equal(await h.nav.restore(h.sender, snapshot.token, destination), true);
  assert.equal(h.nav.get(h.sender, source).wc, page);
  assert.notEqual(h.nav.get(h.sender, destination).wc, page);
});
