// Exact memberships survive valid reconnects while retired link cleanup, reentrant admission and deferred publication stay fenced.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { world } from './support/chrome-membership-kit.mjs';
import { deferred } from './support/async-scenarios.ts';
import { memoryPairing } from './support/chrome-extension-kit.ts';

export const GUARDS = ['electron/capabilities/', 'electron/chrome-extension/', 'shared/'];
const require = createRequire(import.meta.url);
const { ChromeTabContents } = require('../electron/capabilities/browser/chromeTab.cjs');
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const suspend = (w: any) => {
  const link = w.relay.link('a');
  link.resumable = true;
  link.close('transport loss');
  return link;
};
async function setup(t: any) {
  const w = world();
  t.after(() => w.tabs.dispose());
  const a = await w.tabs.create('a');
  return { ...w, a };
}

for (const fails of [false, true]) {
  test(`live and deferred close report native ${fails ? 'failure' : 'success'} without changing identity`, async (t) => {
    const w = await setup(t);
    if (fails) w.chrome.fail['tabs.remove'] = Error('native refusal');
    await w.tabs.close('a', w.a.id);
    await tick();
    assert.equal(w.chrome.tabsById.has(w.a.wc.tabId), fails);
    const b = await w.tabs.create('a');
    suspend(w);
    await w.tabs.close('a', b.id);
    await w.relay.connect('a');
    await tick();
    assert.equal(w.chrome.tabsById.has(b.wc.tabId), fails);
  });
}

for (const retired of [false, true]) {
  test(`resume ${retired ? 'retires absent' : 'keeps identical'} membership`, async (t) => {
    const w = await setup(t);
    suspend(w);
    if (retired) w.move(w.a.wc.tabId, -1);
    await w.relay.connect('a');
    assert.equal(w.a.wc.isDestroyed(), retired);
    assert.equal(w.a.wc.resuming, false);
    if (!retired) assert.equal(w.tabs.list('a')[0], w.a);
  });
}

test('a same-chat newer receipt replaces contents and a reentrant close cannot republish them', async (t) => {
  const w = await setup(t);
  const report = () =>
    w.ports.get('a').emit(
      'message',
      JSON.stringify({
        method: 'chrome.tabs.onCreated',
        params: [
          { id: w.a.wc.tabId, groupId: 1 },
          { membership: 'new-membership', ownership: { kind: 'user_group', groupId: 1 } },
        ],
      }),
    );
  w.tabs.o.onChange = () => w.tabs.forget('a');
  report();
  await tick();
  assert.equal(w.a.wc.isDestroyed(), true);
  assert.deepEqual(w.ids('a'), []);
});

test('opener retirement during admission leaves no ghost, and native detach loses debugger control', async (t) => {
  const w = await setup(t);
  const adopt = w.tabs.adoptPopup.bind(w.tabs);
  w.tabs.adoptPopup = (opener: any, wc: any, options: any) => {
    opener.gone();
    return adopt(opener, wc, options);
  };
  const child = w.chrome.addTab({ openerTabId: w.a.wc.tabId });
  await w.sessions.onTabCreated(child);
  assert.deepEqual(w.ids('a'), []);
  const b = await w.tabs.create('a');
  b.wc.debugger.attach();
  await b.wc.debugger.ready;
  w.sessions.onDebuggerDetach({ tabId: b.wc.tabId }, 'target_closed');
  assert.equal(b.wc.debugger.isAttached(), false);
  w.sessions.onTabRemoved(b.wc.tabId);
  assert.equal(b.wc.isDestroyed(), true);
});

test('an unrecognized wrapper receipt cannot drive an otherwise owned native tab', async (t) => {
  const w = await setup(t);
  const wc = new ChromeTabContents({ relay: w.relay, chatId: 'a', tab: { id: w.a.wc.tabId, membership: 'wrong' } });
  assert.throws(() => wc.assertDrivable(), { code: 'bad_target' });
  const late = deferred();
  const pending = new ChromeTabContents({ relay: w.relay, chatId: 'a', open: late.promise });
  late.resolve({ id: w.a.wc.tabId, membership: 'wrong' });
  await assert.rejects(pending.created, { code: 'bad_target' });
  assert.equal(pending.isDestroyed(), true);
});

test('deferred old-link debugger release cannot affect a fresh wrapper after same-receipt reconnect', async (t) => {
  const w = await setup(t);
  const refresh = deferred();
  const entered = deferred();
  // Hold the post-acquisition continuation itself: closing the old socket cannot settle it early.
  w.a.wc.refresh = () => {
    entered.resolve(undefined);
    return refresh.promise;
  };
  w.a.wc.debugger.attach();
  const oldReady = w.a.wc.debugger.ready.catch(() => undefined);
  await entered.promise;
  w.a.wc.debugger.detach();
  suspend(w);
  await w.sessions.peerGone();
  await w.relay.connect('a');
  const fresh = new ChromeTabContents({ relay: w.relay, chatId: 'a', tab: w.relay.link('a').tabs.get(w.a.wc.tabId) });
  fresh.debugger.attach();
  await fresh.debugger.ready;
  refresh.resolve({});
  await oldReady;
  await w.a.wc.debugger.releasing;
  assert.equal(w.chrome.attached.has(w.a.wc.tabId), true);
  assert.equal(fresh.debugger.isAttached(), true);
});

test('create reply cannot publish into a replacement link, nor can old close erase that link', async (t) => {
  const w = await setup(t);
  const old = w.relay.link('a');
  const emit = old.ws.emit.bind(old.ws);
  const replacement = { open: true, tabs: new Map() };
  old.ws.emit = (event: string, ...args: any[]) => {
    const result = emit(event, ...args);
    if (event === 'message' && JSON.parse(args[0]).result?.id != null) w.relay.links.set('a', replacement);
    return result;
  };
  await assert.rejects(w.relay.createTab(w.relay.token('a')), { code: 'not_connected' });
  w.relay.adopt('a', old);
  w.relay.links.set('a', replacement);
  old.close('retired');
  assert.equal(w.relay.link('a'), replacement);
});

for (const boundary of ['peer-wait', 'initialized', 'old-port']) {
  test(`channel peer replacement at ${boundary} cannot upgrade or erase the next link`, async () => {
    const channel = new ChromeExtensionChannel({
      pairing: memoryPairing(),
      openPage: () => {
        throw Error('no browser');
      },
    });
    channel.start = async () => 1;
    const replacement: any = { open: true };
    let read = false;
    const peer: any = {
      memberships: true,
      get open() {
        if (boundary === 'peer-wait' && !read) {
          read = true;
          queueMicrotask(() => {
            channel.peer = replacement;
          });
        }
        return true;
      },
      send: (m: any) => {
        if (m.method !== 'session.open') return;
        const port = channel.ports.get(m.chat);
        if (boundary === 'initialized') channel.peer = replacement;
        port.emit('message', JSON.stringify({ method: 'extension.initialized' }));
      },
    };
    channel.peer = peer;
    if (boundary !== 'old-port') await assert.rejects(channel.connect('a'), { code: 'not_connected' });
    else {
      const link = await channel.connect('a');
      channel.ports.set('a', replacement);
      link.close('old');
      assert.equal(channel.ports.get('a'), replacement);
    }
  });
}

for (const fails of [false, true])
  test(`close while native creation is pending handles ${fails ? 'rejection' : 'success'} without a ghost`, async (t) => {
    const w = await setup(t);
    const wait = deferred();
    const entered = deferred();
    const create = w.chrome.tabs.create;
    w.chrome.tabs.create = async (options: any) => {
      entered.resolve(undefined);
      await wait.promise;
      return create(options);
    };
    const result = w.tabs.create('a').then(
      (tab) => ({ tab }),
      (error) => ({ error }),
    );
    await entered.promise;
    const pending = w.tabs.list('a').find((tab) => tab !== w.a);
    assert.equal(pending.wc.tabId, null);
    await w.tabs.close('a', pending.id);
    assert.equal(pending.wc.isDestroyed(), true);
    if (fails) wait.reject(Error('native create refused'));
    else wait.resolve(undefined);
    const out = await result;
    await tick();
    assert.deepEqual(w.ids('a'), [w.a.wc.tabId]);
    if (fails) assert.ok('error' in out);
    else {
      assert.ok('tab' in out);
      assert.equal(w.chrome.tabsById.has(out.tab.wc.tabId), false);
      assert.equal(w.tabs.closedTargets.get('a')?.has(out.tab.wc.tabId), false);
    }
  });

test('terminal native removal clears close suppression but retired link callbacks cannot touch the new host', async (t) => {
  const w = await setup(t);
  const old = suspend(w);
  await w.tabs.close('a', w.a.id);
  await w.relay.connect('a');
  await tick();
  assert.equal(w.tabs.closedTargets.get('a')?.has(w.a.wc.tabId), false, 'same-receipt deferred close success is terminal');
  const b = await w.tabs.create('a');
  old.emit('removed', b.wc.tabId);
  assert.equal(b.wc.isDestroyed(), false);
  const wait = deferred();
  const entered = deferred();
  const remove = w.chrome.tabs.remove;
  w.chrome.tabs.remove = async (id: number) => {
    entered.resolve(undefined);
    await wait.promise;
    return remove(id);
  };
  const closing = w.tabs.close('a', b.id);
  await entered.promise;
  w.sessions.onTabRemoved(b.wc.tabId);
  wait.resolve(undefined);
  await closing;
  await tick();
  assert.equal(w.tabs.closedTargets.get('a')?.has(b.wc.tabId), false);
});

test('a native close completing after chat disposal cannot restore close tracking', async (t) => {
  const w = await setup(t);
  const wait = deferred();
  const entered = deferred();
  const remove = w.chrome.tabs.remove;
  w.chrome.tabs.remove = async (id: number) => {
    entered.resolve(undefined);
    await wait.promise;
    return remove(id);
  };
  const closing = w.tabs.close('a', w.a.id);
  await entered.promise;
  w.tabs.dispose();
  wait.resolve(undefined);
  await closing;
  await tick();
  assert.equal(w.tabs.closedTargets.size, 0);
});
