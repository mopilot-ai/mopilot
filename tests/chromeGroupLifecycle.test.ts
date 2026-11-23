// Independent deterministic probes for exact-session Chrome group ownership, using copied API snapshots.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve(undefined);
};
async function setup({ root = false, storage = false } = {}) {
  const chrome: any = fakeChromeApi();
  for (const api of ['create', 'get']) {
    const original = chrome.tabs[api];
    chrome.tabs[api] = async (...args) => structuredClone(await original(...args));
  }
  const originalGet = chrome.tabGroups.get;
  chrome.tabGroups.get = async (...args) => structuredClone(await originalGet(...args));
  const sent: any[] = [],
    logged: string[] = [];
  const sessions: any = new Sessions({
    chrome,
    send: (m) => sent.push(structuredClone(m)),
    log: (m) => logged.push(m),
    storage: storage ? chrome.storage.session : null,
  });
  await sessions.open('a', {});
  const create = (chat = 'a') => sessions.command(chat, 'chrome.tabs.create', [{}], 0);
  return { chrome, sessions, sent, logged, create, root: root ? await create() : null };
}
const counts = (chrome, method) => chrome.log.filter(([name]) => name === method);
const claimed = (sent, id) => sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === id);

test('copied snapshots: three concurrent creates share one physical and reported group', async () => {
  const { chrome, sessions, create } = await setup();
  const tabs = await Promise.all([create(), create(), create()]);
  const canonical = sessions.chats.get('a').groupId;
  assert.ok(canonical >= 0);
  assert.equal(counts(chrome, 'tabs.group').filter(([, o]) => o.groupId === undefined).length, 1);
  for (const tab of tabs) {
    assert.equal(tab.groupId, canonical);
    assert.equal(chrome.tabsById.get(tab.id).groupId, canonical);
  }
});

test('copied snapshots: failed popup join publishes its actual preexisting group', async () => {
  const { chrome, sessions, root, sent } = await setup({ root: true });
  const tab = structuredClone(chrome.addTab({ openerTabId: root.id, groupId: 99, windowId: 7 }));
  chrome.fail['tabs.group'] = new Error('unsupported popup window');
  await sessions.onTabCreated(tab);
  assert.equal(claimed(sent, tab.id).length, 1);
  assert.equal(claimed(sent, tab.id)[0].params[0].groupId, 99);
  assert.equal(sessions.owner.get(tab.id), 'a');
  assert.equal(sessions.chats.get('a').groupId, root.groupId);
});

for (const withRoot of [false, true]) {
  test(`user move of queued popup retires it before dispatch, canonical initially ${withRoot ? 'present' : 'absent'}`, async () => {
    const { chrome, sessions, create, root, sent } = await setup({ root: withRoot });
    const entered = deferred(),
      go = deferred();
    const group = chrome.tabs.group;
    let first = true;
    chrome.tabs.group = async (options) => {
      if (first) {
        first = false;
        entered.resolve(undefined);
        await go.promise;
      }
      return group(options);
    };
    const firstPending = create();
    await entered.promise;
    const opener = root?.id ?? [...sessions.owner.keys()][0];
    const tab = structuredClone(chrome.addTab({ openerTabId: opener }));
    const pending = sessions.onTabCreated(tab);
    chrome.tabsById.get(tab.id).groupId = 99;
    sessions.onTabUpdated(tab.id, { groupId: 99 }, { ...tab, groupId: 99 });
    const ownerAfterMove = sessions.owner.get(tab.id);
    go.resolve(undefined);
    await Promise.all([firstPending, pending]);
    assert.equal(ownerAfterMove, undefined);
    assert.equal(chrome.tabsById.get(tab.id).groupId, 99);
    assert.equal(claimed(sent, tab.id).length, 0);
    assert.ok(counts(chrome, 'tabs.group').every(([, o]) => !o.tabIds.includes(tab.id)));
  });
}

test('user move after native mutation while metadata waits retires ownership immediately', async () => {
  const { chrome, sessions, create } = await setup();
  const entered = deferred(),
    go = deferred();
  chrome.tabGroups.update = async () => {
    entered.resolve(undefined);
    await go.promise;
  };
  const pending: Promise<any> = create().then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  await entered.promise;
  const tabId = [...sessions.owner.keys()][0];
  const tab = chrome.tabsById.get(tabId);
  tab.groupId = 99;
  sessions.onTabUpdated(tabId, { groupId: 99 }, { ...tab });
  const retained = sessions.owner.has(tabId);
  go.resolve(undefined);
  const result = await pending;
  assert.equal(retained, false);
  assert.match(result.error?.message ?? '', /no longer belongs|closed/);
  assert.equal(tab.groupId, 99);
});

test('canonical group is persisted before a metadata request that never completes', async () => {
  const { chrome, create } = await setup({ storage: true });
  const entered = deferred(),
    go = deferred();
  chrome.tabGroups.update = async () => {
    entered.resolve(undefined);
    await go.promise;
  };
  const pending = create();
  await entered.promise;
  await tick();
  const saved = structuredClone(chrome.store.session.sessions);
  go.resolve(undefined);
  const tab = await pending;
  assert.equal(saved.a.groupId, tab.groupId);
  assert.ok(saved.a.tabs.includes(tab.id));
});

for (const boundary of ['queued', 'lookup', 'mutation', 'metadata']) {
  test(`same-session ABA at ${boundary} allows exactly the new popup generation to publish`, async () => {
    const { chrome, sessions, root, sent } = await setup({ root: true });
    const entered = deferred(),
      go = deferred();
    const tab = structuredClone(chrome.addTab({ openerTabId: root.id }));
    let blocker;
    if (boundary === 'queued') {
      const original = chrome.tabs.group;
      let first = true;
      chrome.tabs.group = async (options) => {
        if (first) {
          first = false;
          entered.resolve(undefined);
          await go.promise;
        }
        return original(options);
      };
      const sibling = structuredClone(chrome.addTab({ openerTabId: root.id }));
      blocker = sessions.onTabCreated(sibling);
      await entered.promise;
    } else if (boundary === 'lookup') {
      const original = chrome.tabGroups.get;
      let first = true;
      chrome.tabGroups.get = async (id) => {
        if (first) {
          first = false;
          entered.resolve(undefined);
          await go.promise;
        }
        return original(id);
      };
    } else if (boundary === 'mutation') {
      const original = chrome.tabs.group;
      let first = true;
      chrome.tabs.group = async (options) => {
        const result = await original(options);
        if (first) {
          first = false;
          entered.resolve(undefined);
          await go.promise;
        }
        return result;
      };
    } else {
      sessions.chats.get('a').groupId = null;
      const original = chrome.tabGroups.update;
      let first = true;
      chrome.tabGroups.update = async (...args) => {
        if (first) {
          first = false;
          entered.resolve(undefined);
          await go.promise;
        }
        return original(...args);
      };
    }
    const older = sessions.onTabCreated(tab);
    if (boundary !== 'queued') await entered.promise;
    sessions.onDebuggerDetach({ tabId: tab.id }, 'detached');
    const newer = sessions.onTabCreated({ ...tab });
    go.resolve(undefined);
    await Promise.all([older, newer, blocker]);
    assert.equal(claimed(sent, tab.id).length, 1);
    assert.equal(sessions.owner.get(tab.id), 'a');
    assert.equal(claimed(sent, tab.id)[0].params[0].groupId, chrome.tabsById.get(tab.id).groupId);
    assert.equal(sessions.grouping.has(tab.id), false);
  });
}

test('restore reuses an existing canonical group without serializing in-memory queue or token state', async () => {
  const { chrome, create, sessions } = await setup({ storage: true });
  const tabs = await Promise.all([create(), create()]);
  await tick();
  assert.deepEqual(Object.keys(chrome.store.session.sessions.a).sort(), ['attached', 'groupId', 'memberships', 'tabs', 'title']);
  const restored: any = new Sessions({ chrome, send: () => {}, log: () => {}, storage: chrome.storage.session });
  await restored.restore();
  const next = await restored.command('a', 'chrome.tabs.create', [{}], 0);
  assert.equal(next.groupId, tabs[0].groupId);
  assert.equal(counts(chrome, 'tabs.group').filter(([, o]) => o.groupId === undefined).length, 1);
  assert.equal(restored.chats.get('a').groupId, sessions.chats.get('a').groupId);
});

for (const returned of [undefined, null, -1, NaN, '7']) {
  test(`invalid tabs.group result ${String(returned)} cannot poison the canonical group or a later retry`, async () => {
    const { chrome, sessions, create } = await setup();
    const group = chrome.tabs.group;
    let first = true;
    chrome.tabs.group = async (options) => {
      if (first) {
        first = false;
        return returned;
      }
      return group(options);
    };
    const failed = await create();
    const canonical = sessions.chats.get('a').groupId;
    assert.ok(canonical === null || (Number.isInteger(canonical) && canonical >= 0));
    assert.equal(failed.groupId, chrome.tabsById.get(failed.id).groupId);
    const next = await create();
    assert.equal(next.groupId, chrome.tabsById.get(next.id).groupId);
    assert.ok(Number.isInteger(sessions.chats.get('a').groupId) && sessions.chats.get('a').groupId >= 0);
  });
}

test('one group lookup rejection can be followed by successful queued allocation without poisoning unrelated sessions', async () => {
  const { chrome, sessions, create, root } = await setup({ root: true });
  await sessions.open('b', {});
  chrome.groups.delete(root.groupId);
  const get = chrome.tabGroups.get;
  const gate = deferred(),
    entered = deferred();
  let first = true;
  chrome.tabGroups.get = async (id) => {
    if (first) {
      first = false;
      entered.resolve(undefined);
      return gate.promise;
    }
    return get(id);
  };
  const older = create();
  await entered.promise;
  const newer = await create();
  const other = await create('b');
  gate.reject(new Error('old window gone'));
  const old = await older;
  assert.equal(old.groupId, newer.groupId);
  assert.notEqual(other.groupId, newer.groupId);
});

for (const retired of [false, true]) {
  test(`popup failure fallback read rejection ${retired ? 'after release' : 'for vanished tab'} does not escape a Chrome event listener`, async () => {
    const { chrome, sessions, root, sent } = await setup({ root: true });
    const tab = structuredClone(chrome.addTab({ openerTabId: root.id }));
    chrome.fail['tabs.group'] = new Error('could not group tab');
    const entered = deferred(),
      go = deferred();
    chrome.tabs.get = async (id) => {
      entered.resolve(undefined);
      await go.promise;
      throw new Error(`No tab with id: ${id}.`);
    };
    const pending = sessions.onTabCreated(tab);
    const settled = Promise.allSettled([pending]);
    await entered.promise;
    if (retired) sessions.onTabRemoved(tab.id);
    else chrome.tabsById.delete(tab.id);
    go.resolve(undefined);
    const [result] = await settled;
    assert.equal(result.status, 'fulfilled');
    assert.equal(claimed(sent, tab.id).length, 0);
  });
}

for (const deleted of [false, true]) {
  test(`mixed explicit create and popup descendants share one FIFO allocation when canonical ${deleted ? 'was deleted' : 'is initially absent'}`, async () => {
    const { chrome, sessions, root, create, sent } = await setup({ root: deleted });
    if (deleted) chrome.groups.delete(root.groupId);
    const entered = deferred(),
      go = deferred();
    const group = chrome.tabs.group;
    const order: number[] = [];
    let first = true;
    chrome.tabs.group = async (options) => {
      order.push(options.tabIds[0]);
      if (first) {
        first = false;
        entered.resolve(undefined);
        await go.promise;
      }
      return group(options);
    };
    const firstCreate = create();
    await entered.promise;
    const opener = root?.id ?? [...sessions.owner.keys()][0];
    const popup = structuredClone(chrome.addTab({ openerTabId: opener }));
    const pendingPopup = sessions.onTabCreated(popup);
    const descendant = structuredClone(chrome.addTab({ openerTabId: popup.id }));
    const pendingDescendant = sessions.onTabCreated(descendant);
    const lastCreate = create();
    await tick();
    const idsBefore = [...sessions.owner.keys()];
    go.resolve(undefined);
    const [firstTab, , , lastTab] = await Promise.all([firstCreate, pendingPopup, pendingDescendant, lastCreate]);
    assert.deepEqual(order, [firstTab.id, popup.id, descendant.id, lastTab.id]);
    assert.ok(idsBefore.includes(descendant.id), 'popup ownership is synchronous before grouping dispatch');
    const canonical = sessions.chats.get('a').groupId;
    for (const id of order) assert.equal(chrome.tabsById.get(id).groupId, canonical);
    assert.equal(firstTab.groupId, canonical);
    assert.equal(lastTab.groupId, canonical);
    assert.equal(claimed(sent, popup.id).length, 1);
    assert.equal(claimed(sent, descendant.id).length, 1);
    assert.equal(counts(chrome, 'tabs.group').filter(([, o]) => o.groupId === undefined).length, deleted ? 2 : 1);
  });
}

for (const boundary of ['group', 'fallback']) {
  for (const retire of ['close', 'remove', 'transfer']) {
    test(`retirement during ${boundary} completion (${retire}) cannot resume old grouping`, async () => {
      const { chrome, sessions, root, sent } = await setup({ root: true });
      const tab = structuredClone(chrome.addTab({ openerTabId: root.id }));
      const entered = deferred(),
        go = deferred<any>();
      if (boundary === 'group') {
        chrome.tabs.group = () => {
          entered.resolve(undefined);
          return go.promise;
        };
      } else {
        chrome.fail['tabs.group'] = new Error('cannot group');
        chrome.tabs.get = () => {
          entered.resolve(undefined);
          return go.promise;
        };
      }
      const pending = sessions.onTabCreated(tab);
      await entered.promise;
      assert.equal(sessions.grouping.has(tab.id), boundary === 'group');
      if (retire === 'close') await sessions.close('a');
      else sessions.onTabRemoved(tab.id);
      if (retire === 'transfer') {
        await sessions.open('b', {});
        sessions.chats.get('b').groupId = 90;
        sessions.onTabUpdated(tab.id, { groupId: 90 }, { ...tab, groupId: 90 });
      }
      const before = chrome.log.length;
      if (boundary === 'group') go.reject(new Error('retired mutation failed'));
      else go.resolve({ ...tab, groupId: 88 });
      await pending;
      assert.equal(claimed(sent, tab.id).filter((m) => m.chat === 'a').length, 0);
      assert.equal(sessions.owner.get(tab.id), retire === 'transfer' ? 'b' : undefined);
      assert.equal(chrome.log.length, before, 'no retired read, metadata update or grouping follows');
    });
  }
}

test('old group cleanup cannot remove a replacement session’s active mutation marker', async () => {
  const { chrome, sessions, root, sent } = await setup({ root: true });
  const tab = structuredClone(chrome.addTab({ openerTabId: root.id }));
  const oldEntered = deferred(),
    oldGo = deferred<number>(),
    nextEntered = deferred(),
    nextGo = deferred<number>();
  let calls = 0;
  chrome.tabs.group = () => {
    if (++calls === 1) {
      oldEntered.resolve(undefined);
      return oldGo.promise;
    }
    nextEntered.resolve(undefined);
    return nextGo.promise;
  };
  const older = sessions.onTabCreated(tab);
  await oldEntered.promise;
  await sessions.close('a');
  await sessions.open('a', {});
  sessions.chats.get('a').groupId = 91;
  chrome.groups.set(91, { id: 91, windowId: 1 });
  sessions.onTabUpdated(root.id, { groupId: 91 }, { ...root, groupId: 91 });
  const newer = sessions.onTabCreated(tab);
  await nextEntered.promise;
  oldGo.resolve(root.groupId);
  await older;
  assert.equal(sessions.grouping.has(tab.id), true);
  sessions.onTabUpdated(tab.id, { groupId: -1 }, { ...tab, groupId: -1 });
  assert.equal(sessions.owner.get(tab.id), 'a', 'replacement native event is still suppressed');
  nextGo.resolve(91);
  await newer;
  assert.equal(sessions.grouping.has(tab.id), false);
  assert.equal(claimed(sent, tab.id).length, 1);
  assert.equal(claimed(sent, tab.id)[0].params[0].groupId, 91);
});
