// Renderer Duplicate ordering, same-chat ownership, independent page identity, cancellation and retries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserDuplication } from '../src/lib/browserDuplicate.ts';
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const defer = () => {
  let resolve!: (value?: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function setup(patch: any = {}, apiPatch: any = {}) {
  let state: any = {
    paneTabs: [
      { id: 'before', kind: 'file' },
      { id: 'source', kind: 'browser', url: 'https://a.test/', title: 'A', ownerChat: 'chat', ...patch },
      { id: 'after', kind: 'file' },
    ],
    paneActive: 'source',
    diffPanel: { open: true },
  };
  const calls: any[] = [];
  const api: any = {
    bindPane: async (...args: any[]) => {
      calls.push(['bind', ...args]);
      return true;
    },
    captureHistory: async (...args: any[]) => {
      calls.push(['capture', ...args]);
      return { token: 'token', url: 'https://snapshot.test/', title: 'Snapshot', chat: 'chat' };
    },
    restoreHistory: async (...args: any[]) => {
      calls.push(['restore', ...args]);
      return true;
    },
    discardHistory: async (...args: any[]) => {
      calls.push(['discard', ...args]);
      return true;
    },
    ...apiPatch,
  };
  const d = new BrowserDuplication({
    get: () => state,
    set: (fn) => {
      state = { ...state, ...fn(state) };
    },
    api,
    chatOf: (id) => (id === 'native:key' ? 'chat' : id),
    timeoutMs: 100,
  });
  const release = d.bind('source', 1, 'partition-original', 'chat');
  const get = () => state;
  const update = (patch: any) => {
    state = { ...state, ...patch };
  };
  const copy = () => state.paneTabs.find((tab: any) => tab.id.startsWith('browser-'));
  const mount = () => d.bind(copy().id, 2, 'partition-original', copy().ownerChat ?? null);
  return { d, api, calls, get, update, copy, mount, release };
}

test('Duplicate inserts/focuses right of source with copied stable owner, fresh agent key and same partition', async () => {
  for (const source of [{}, { agentChat: 'native:key', agentTab: 'tab_aaaaaa' }]) {
    const h = setup(source);
    const pending = h.d.duplicate('source');
    assert.equal(h.d.duplicate('source'), pending);
    await flush();
    const copy = h.copy();
    assert.ok(copy.id !== 'source');
    assert.equal(copy.ownerChat, 'chat');
    assert.equal(copy.url, 'https://snapshot.test/');
    assert.equal(copy.browserPartition, 'partition-original');
    assert.equal(copy.restoring, true);
    assert.deepEqual(
      h.get().paneTabs.map((tab: any) => tab.id),
      ['before', 'source', copy.id, 'after'],
    );
    assert.equal(h.get().paneActive, copy.id);
    if (source.agentChat) {
      assert.equal(copy.agentChat, 'chat');
      assert.match(copy.agentTab, /^tab_[a-f0-9]{16}$/);
      assert.notEqual(copy.agentTab, source.agentTab);
    }
    h.mount();
    await pending;
    assert.equal(h.copy().restoring, false);
    assert.equal(h.get().paneTabs[1].duplicating, false);
    assert.equal(h.calls.filter((call) => call[0] === 'capture').length, 1);
    assert.equal(h.calls.filter((call) => call[0] === 'restore').length, 1);
  }
});

test("a failed Duplicate's notice closes: dismissError clears only that tab's error (#1523)", () => {
  const h = setup({ duplicateError: 'Could not duplicate this tab. Try again.' });
  h.d.dismissError('source');
  const source = h.get().paneTabs.find((tab: any) => tab.id === 'source');
  assert.equal(source.duplicateError, undefined);
  assert.equal(source.url, 'https://a.test/');
});

test('blank tabs duplicate without page/history, while absent, unavailable and wrong-chat pages fail safely', async () => {
  const blank = setup({ url: '' });
  await blank.d.duplicate('source');
  assert.equal(blank.copy().url, '');
  assert.equal(
    blank.calls.some((call) => call[0] === 'capture'),
    false,
  );
  await blank.d.duplicate('missing');
  const gone = setup();
  gone.release();
  await gone.d.duplicate('source');
  assert.match(gone.get().paneTabs[1].duplicateError, /Could not duplicate/);
  const wrong = setup({ ownerChat: 'other' });
  await wrong.d.duplicate('source');
  assert.equal(wrong.copy(), undefined);
  const global = setup({ ownerChat: undefined, url: '' });
  await global.d.duplicate('source');
  assert.equal(global.copy().ownerChat, undefined);
});

test('failure removes only its provisional copy, retains independent writes/focus and allows retry', async () => {
  const h = setup(
    {},
    {
      restoreHistory: async () => {
        throw new Error('failed');
      },
    },
  );
  const pending = h.d.duplicate('source');
  await flush();
  h.mount();
  h.update({
    paneTabs: [...h.get().paneTabs, { id: 'independent', kind: 'browser', url: 'https://other.test/' }],
    paneActive: 'independent',
  });
  await pending;
  assert.equal(h.copy(), undefined);
  assert.equal(h.get().paneActive, 'independent');
  assert.equal(h.get().paneTabs.at(-1).id, 'independent');
  assert.match(h.get().paneTabs[1].duplicateError, /Try again/);
  h.api.restoreHistory = async () => true;
  const retry = h.d.duplicate('source');
  await flush();
  h.mount();
  await retry;
  assert.ok(h.copy());
  assert.equal(h.get().paneTabs[1].duplicateError, undefined);
});

test('capture/registration/restore false, rejection and owner switch cannot publish a successful copy', async () => {
  for (const stage of ['bind-false', 'bind-reject', 'capture', 'wrong-chat', 'target-false', 'restore-false', 'switch']) {
    const h = setup();
    if (stage === 'bind-false' || stage === 'bind-reject') {
      h.api.bindPane = async () => {
        if (stage === 'bind-reject') throw new Error('bind');
        return false;
      };
      h.d.bind('source', 10, 'partition-original', 'chat');
    }
    if (stage === 'capture')
      h.api.captureHistory = async () => {
        throw new Error('capture');
      };
    if (stage === 'wrong-chat')
      h.api.captureHistory = async () => ({ token: 'bad', url: 'https://bad.test/', title: 'Bad', chat: 'foreign' });
    if (stage === 'restore-false') h.api.restoreHistory = async () => false;
    const pending = h.d.duplicate('source');
    await flush();
    if (h.copy()) {
      if (stage === 'target-false') h.api.bindPane = async () => false;
      if (stage === 'switch')
        h.update({ paneTabs: h.get().paneTabs.map((tab: any) => (tab.id === 'source' ? { ...tab, ownerChat: 'other' } : tab)) });
      h.mount();
    }
    await pending;
    assert.equal(h.copy(), undefined, stage);
    assert.equal(h.get().paneTabs[1].duplicating, false);
  }
});

test('closing/replacing source during any await retires late success/rejection and clears only its own copy', async () => {
  for (const stage of ['capture', 'target', 'restore'])
    for (const rejects of [false, true]) {
      const deferred = defer();
      const h = setup();
      if (stage === 'capture') h.api.captureHistory = () => deferred.promise;
      if (stage === 'restore') h.api.restoreHistory = () => deferred.promise;
      const pending = h.d.duplicate('source');
      await flush();
      if (stage === 'restore') {
        h.mount();
        await flush();
      }
      h.release();
      h.update({
        paneTabs: h.get().paneTabs.filter((tab: any) => tab.id !== 'source'),
        ...(stage === 'capture' ? { paneActive: 'after' } : {}),
      });
      await pending;
      if (rejects) deferred.reject(new Error('late'));
      else deferred.resolve({ token: 'late', chat: 'chat' });
      if (stage === 'target') deferred.promise.catch(() => {});
      await flush();
      assert.equal(h.copy(), undefined);
      assert.equal(h.get().paneTabs.length, 2);
      assert.notEqual(h.get().paneActive, 'source');
    }
});

test('closing the provisional target, expiring, or deleting the source before insertion leaves no stuck state', async () => {
  const h = setup();
  const pending = h.d.duplicate('source');
  await flush();
  const unmount = h.mount();
  unmount();
  await pending;
  assert.equal(h.copy(), undefined);
  const timed = setup();
  const expires = timed.d.duplicate('source');
  await expires;
  assert.equal(timed.copy(), undefined);
  assert.equal(timed.get().paneTabs[1].duplicating, false);
  const removed = setup();
  removed.api.captureHistory = async () => {
    removed.update({ paneTabs: [] });
    return { token: 'token', url: 'https://a.test/', chat: 'chat' };
  };
  await removed.d.duplicate('source');
  assert.deepEqual(removed.get().paneTabs, []);
  assert.equal(removed.get().diffPanel.open, false);
});

test('page rebinding retires a pending generation, stale cleanup cannot unbind the replacement, and late capture cannot clear retry', async () => {
  const old = defer();
  const h = setup({}, { captureHistory: () => old.promise });
  const first = h.d.duplicate('source');
  await flush();
  h.d.bind('source', 3, 'partition-original', 'chat');
  h.release();
  await first;
  assert.equal(h.get().paneTabs[1].duplicating, false);
  h.api.captureHistory = async () => ({ token: 'new', url: 'https://new.test/', title: 'New', chat: 'chat' });
  const second = h.d.duplicate('source');
  await flush();
  h.d.bind('source', 3, 'partition-original', 'chat');
  const copy = h.copy();
  old.resolve({ token: 'old', url: 'https://old.test/', title: 'Old', chat: 'chat' });
  await flush();
  assert.equal(h.get().paneTabs[1].duplicating, true);
  assert.equal(h.copy().id, copy.id);
  h.mount();
  await second;
  assert.equal(h.copy().url, 'https://new.test/');
});

test('chatless loaded pages, default deadline and last-tab rollback retain usable state', async () => {
  const h = setup({ ownerChat: undefined });
  h.d.bind('source', 1, 'partition-original', null);
  h.api.captureHistory = async () => ({ token: 'global', url: 'https://a.test/', title: 'A', chat: null });
  const pending = h.d.duplicate('source');
  await flush();
  h.mount();
  await pending;
  assert.equal(h.copy().restoring, false);
  assert.equal(h.copy().ownerChat, undefined);
  let state: any = { paneTabs: [{ id: 'only', kind: 'browser', url: 'https://a.test/' }], paneActive: 'only', diffPanel: { open: true } };
  const d = new BrowserDuplication({
    get: () => state,
    set: (fn) => {
      state = { ...state, ...fn(state) };
    },
    api: h.api,
    chatOf: (id) => id,
  });
  const release = d.bind('only', 4, 'partition-original', null);
  const last = d.duplicate('only');
  await flush();
  state.paneTabs = state.paneTabs.filter((tab: any) => tab.id !== 'only');
  release();
  await last;
  assert.equal(state.paneActive, '');
  assert.equal(state.diffPanel.open, false);
});

test('a source removed by a competing state write cannot insert an orphan copy', async () => {
  let state: any = { paneTabs: [{ id: 'blank', kind: 'browser', url: '' }], paneActive: 'blank', diffPanel: { open: true } };
  const h = setup();
  const d = new BrowserDuplication({
    get: () => state,
    set: (fn) => {
      state.paneTabs = [];
      state = { ...state, ...fn(state) };
    },
    api: h.api,
    chatOf: (id) => id,
  });
  assert.throws(() => d.duplicate('blank'), /Could not duplicate/);
  assert.deepEqual(state.paneTabs, []);
});

test('replacing a provisional target aborts only that copy and unrelated page rebinding preserves the source operation', async () => {
  const h = setup();
  h.d.bind('unrelated', 8, 'partition-original', 'chat');
  const pending = h.d.duplicate('source');
  await flush();
  h.d.bind('unrelated', 9, 'partition-original', 'chat');
  h.mount();
  h.d.bind(h.copy().id, 10, 'partition-original', 'chat');
  await pending;
  assert.equal(h.copy(), undefined);
  assert.equal(h.get().paneTabs[1].duplicating, false);
});

test('independent duplicates settle in either order; one failure cannot erase the other copy or a separate user edit', async () => {
  for (const order of [
    ['source', 'other'],
    ['other', 'source'],
  ]) {
    const h = setup();
    h.update({ paneTabs: [...h.get().paneTabs, { id: 'other', kind: 'browser', url: 'https://other.test/', ownerChat: 'chat' }] });
    h.d.bind('other', 11, 'partition-original', 'chat');
    const captures = { source: defer(), other: defer() };
    const restores = { source: defer(), other: defer() };
    h.api.captureHistory = (id: keyof typeof captures) => captures[id].promise;
    h.api.restoreHistory = (token: keyof typeof restores) => restores[token].promise;
    const source = h.d.duplicate('source');
    const other = h.d.duplicate('other');
    await flush();
    let pageId = 20;
    for (const id of order) {
      captures[id as keyof typeof captures].resolve({ token: id, url: `https://${id}.test/`, title: id, chat: 'chat' });
      await flush();
      const copy = h.get().paneTabs.find((tab: any) => tab.id.startsWith('browser-') && tab.title === id);
      h.d.bind(copy.id, ++pageId, 'partition-original', 'chat');
      await flush();
    }
    h.update({ paneTabs: [...h.get().paneTabs, { id: 'user-edit', kind: 'file' }], paneActive: 'user-edit' });
    for (const id of order) {
      if (id === 'source') restores.source.reject(new Error('load failed'));
      else restores.other.resolve(true);
      await flush();
    }
    await Promise.all([source, other]);
    const copies = h.get().paneTabs.filter((tab: any) => tab.id.startsWith('browser-'));
    assert.equal(copies.length, 1);
    assert.equal(copies[0].title, 'other');
    assert.equal(copies[0].restoring, false);
    assert.equal(
      h.get().paneTabs.findIndex((tab: any) => tab.id === copies[0].id),
      h.get().paneTabs.findIndex((tab: any) => tab.id === 'other') + 1,
    );
    assert.equal(h.get().paneActive, 'user-edit');
    assert.equal(h.get().paneTabs.at(-1).id, 'user-edit');
  }
});

test("a copy finished after the user moved to another chat mounts behind and leaves that chat's pane as it is", async () => {
  let state: any = {
    paneTabs: [{ id: 'blank', kind: 'browser', url: '', ownerChat: 'a' }],
    paneActive: 'other',
    diffPanel: { open: false },
  };
  let onScreen = 'b';
  const d = new BrowserDuplication({
    get: () => state,
    set: (fn) => {
      state = { ...state, ...fn(state) };
    },
    api: setup().api,
    chatOf: (id) => id,
    shows: (tab) => tab.ownerChat === onScreen,
  });
  d.bind('blank', 5, 'partition-original', 'a');
  await d.duplicate('blank');
  assert.equal(state.paneTabs.length, 2);
  assert.equal(state.paneTabs[1].ownerChat, 'a');
  assert.equal(state.paneActive, 'other');
  assert.equal(state.diffPanel.open, false);
  // back on chat "a", a copy comes to the front of its open pane
  onScreen = 'a';
  await d.duplicate('blank');
  assert.equal(state.paneTabs.length, 3);
  assert.equal(state.paneActive, state.paneTabs[1].id);
  assert.equal(state.diffPanel.open, true);
});
