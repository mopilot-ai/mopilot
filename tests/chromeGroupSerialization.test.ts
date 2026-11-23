// Concurrent explicit creates and popup adoption share one group and report each tab’s actual membership.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
async function world({ storage = false } = {}) {
  const chrome: any = fakeChromeApi();
  const createTab = chrome.tabs.create,
    getTab = chrome.tabs.get;
  chrome.tabs.create = async (options) => structuredClone(await createTab(options));
  chrome.tabs.get = async (id) => structuredClone(await getTab(id));
  const sent: any[] = [],
    logged: string[] = [];
  const sessions: any = new Sessions({
    chrome,
    send: (m) => sent.push(m),
    log: (m) => logged.push(m),
    storage: storage ? chrome.storage.session : null,
  });
  await sessions.open('a', { title: 'A' });
  const create = (chat = 'a') => sessions.command(chat, 'chrome.tabs.create', [{}], 0);
  return { chrome, sessions, sent, logged, create };
}
const creations = (chrome: any) => chrome.log.filter(([name, arg]: any) => name === 'tabs.group' && arg.groupId === undefined);
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve(undefined);
};

test('first concurrent creates return their actual single shared group', async () => {
  const { chrome, create } = await world();
  const tabs = await Promise.all([create(), create()]);
  assert.deepEqual(
    tabs.map((tab) => chrome.tabsById.get(tab.id).groupId),
    tabs.map((tab) => tab.groupId),
  );
  assert.equal(creations(chrome).length, 1);
});

test('two popup siblings rebuilding a lost retained group create only one replacement', async () => {
  const { chrome, sessions, create, sent } = await world();
  const root = await create();
  chrome.groups.delete(root.groupId);
  const popups = [chrome.addTab({ openerTabId: root.id }), chrome.addTab({ openerTabId: root.id })];
  await Promise.all(popups.map((tab) => sessions.onTabCreated(tab)));
  const reports = sent.filter((m) => m.method === 'chrome.tabs.onCreated').map((m) => m.params[0]);
  assert.deepEqual(
    reports.map((t) => t.groupId),
    popups.map((t) => chrome.tabsById.get(t.id).groupId),
  );
  assert.equal(new Set(popups.map((t) => chrome.tabsById.get(t.id).groupId)).size, 1);
});

test('delayed old create-window lookup rejection cannot clear a newer canonical group', async () => {
  const { chrome, sessions, create } = await world();
  const first = await create();
  chrome.groups.delete(first.groupId);
  const oldLookup = deferred();
  const get = chrome.tabGroups.get;
  let firstLookup = true;
  chrome.tabGroups.get = (id) => {
    if (firstLookup) {
      firstLookup = false;
      return oldLookup.promise;
    }
    return get(id);
  };
  const old = create();
  const newer = await create();
  oldLookup.reject(new Error('the original group was closed'));
  const older = await old;
  assert.equal(older.groupId, newer.groupId);
  assert.equal(sessions.chats.get('a').groupId, newer.groupId);
});

test('failed existing-group join reports the new tab as ungrouped', async () => {
  const { chrome, create } = await world();
  await create();
  chrome.fail['tabs.group'] = new Error('popup window has no groups');
  const tab = await create();
  assert.equal(tab.groupId, chrome.tabsById.get(tab.id).groupId);
});

test('metadata rejection retains the successfully allocated group and allows a later join', async () => {
  const { chrome, sessions, create, logged } = await world();
  chrome.fail['tabGroups.update'] = new Error('metadata failed');
  const first = await create();
  delete chrome.fail['tabGroups.update'];
  const next = await create();
  assert.equal(first.groupId, next.groupId);
  assert.equal(sessions.chats.get('a').groupId, first.groupId);
  assert.equal(creations(chrome).length, 1);
  assert.ok(logged.includes('group a tab'));
});

test('first allocation rejection allows another create to establish the group', async () => {
  const { chrome, sessions, create } = await world();
  chrome.fail['tabs.group'] = new Error('transient group failure');
  const first = await create();
  delete chrome.fail['tabs.group'];
  const next = await create();
  assert.equal(first.groupId, -1);
  assert.ok(next.groupId > 0);
  assert.equal(sessions.owner.get(first.id), 'a');
});

test('released and re-adopted same-session popup invalidates the older grouping operation', async () => {
  const { chrome, sessions, create } = await world();
  const root = await create();
  const tab = chrome.addTab({ openerTabId: root.id });
  const first = deferred(),
    next = deferred();
  let calls = 0;
  chrome.tabGroups.get = () => (++calls === 1 ? first.promise : next.promise);
  const older = sessions.onTabCreated(tab);
  sessions.onDebuggerDetach({ tabId: tab.id }, 'detached');
  const newer = sessions.onTabCreated(tab);
  const before = chrome.log.filter(([name]) => name === 'tabs.group').length;
  first.resolve({});
  await older;
  const oldWrites = chrome.log.filter(([name]) => name === 'tabs.group').length - before;
  next.resolve({});
  await newer;
  assert.equal(oldWrites, 0, 'a newer lease does not revive an old membership operation');
});

test('one blocked chat does not block another chat group', async () => {
  const { chrome, sessions, create } = await world();
  await sessions.open('b', {});
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
  const pending = create();
  await entered.promise;
  const independent = await create('b');
  assert.ok(independent.groupId > 0);
  go.resolve(undefined);
  await pending;
});

test('replacement session with the same chat id progresses while old group acknowledgement is held', async () => {
  const { chrome, sessions, create } = await world();
  const entered = deferred(),
    go = deferred();
  const group = chrome.tabs.group;
  let first = true;
  chrome.tabs.group = async (options) => {
    const id = await group(options);
    if (first) {
      first = false;
      entered.resolve(undefined);
      await go.promise;
    }
    return id;
  };
  const pending = create().then(
    () => null,
    (error) => error,
  );
  await entered.promise;
  await sessions.close('a');
  await sessions.open('a', {});
  const replacement = await create();
  go.resolve(undefined);
  assert.match((await pending).message, /closed|no longer belongs/);
  assert.equal(chrome.tabsById.get(replacement.id).groupId, replacement.groupId);
  assert.equal(sessions.owner.get(replacement.id), 'a');
});

test('peer loss and turn advance retain pending grouping rather than cancel accepted tab membership', async () => {
  const { chrome, sessions, create } = await world();
  const entered = deferred(),
    go = deferred();
  const group = chrome.tabs.group;
  chrome.tabs.group = async (options) => {
    entered.resolve(undefined);
    await go.promise;
    return group(options);
  };
  const pending = create();
  await entered.promise;
  sessions.advance('a', 1);
  await sessions.peerGone();
  go.resolve(undefined);
  const tab = await pending;
  assert.equal(chrome.tabsById.get(tab.id).groupId, sessions.chats.get('a').groupId);
  assert.equal(sessions.owner.get(tab.id), 'a');
});

test('retained group and both membership entries restore after a completed concurrent pair', async () => {
  const { chrome, sessions, create } = await world({ storage: true });
  const tabs = await Promise.all([create(), create()]);
  await flush();
  const saved = chrome.store.session.sessions.a;
  const again: any = new Sessions({ chrome, send: () => {}, log: () => {}, storage: chrome.storage.session });
  await again.restore();
  assert.equal(saved.groupId, sessions.chats.get('a').groupId);
  assert.deepEqual(
    [...again.chats.get('a').tabs],
    tabs.map((t) => t.id),
  );
  assert.ok(tabs.every((t) => chrome.tabsById.get(t.id).groupId === saved.groupId));
});

for (const order of [
  [0, 1, 2],
  [2, 1, 0],
]) {
  test(`create replies in order ${order.join(',')} combine explicit and popup tabs in one group`, async () => {
    const { chrome, sessions, create, sent } = await world();
    const gates = [deferred<any>(), deferred<any>(), deferred<any>()];
    const opened: any[] = [];
    chrome.tabs.create = () => {
      const tab = chrome.addTab({ windowId: 7 });
      opened.push(tab);
      return gates[opened.length - 1].promise;
    };
    const promises = [create(), create(), create()];
    gates[order[0]].resolve({ ...opened[order[0]] });
    const first = await promises[order[0]];
    const popup = chrome.addTab({ openerTabId: first.id, windowId: 2 });
    const adopted = sessions.onTabCreated({ ...popup });
    for (const index of order.slice(1)) gates[index].resolve({ ...opened[index] });
    const replies = await Promise.all(promises);
    await adopted;
    assert.equal(creations(chrome).length, 1);
    assert.ok(replies.every((tab) => tab.groupId === first.groupId));
    assert.equal(sent.at(-1).params[0].groupId, first.groupId);
    assert.equal(sessions.chats.get('a').tabs.size, 4);
    // The fake models only membership. Chrome owns the physical cross-window movement semantics.
  });
}

test('failed create opens nothing, failed fallback rejects only its caller, and queued successor remains usable', async () => {
  const { chrome, sessions, create } = await world();
  chrome.fail['tabs.create'] = new Error('cannot create');
  await assert.rejects(create(), /cannot create/);
  assert.equal(sessions.owner.size, 0);
  delete chrome.fail['tabs.create'];
  const group = chrome.tabs.group;
  let first = true;
  chrome.tabs.group = async (options) => {
    if (first) {
      first = false;
      throw new Error('cannot group');
    }
    return group(options);
  };
  chrome.fail['tabs.get'] = new Error('tab unavailable');
  const pending = create();
  const next = create();
  await assert.rejects(pending, /tab unavailable/);
  const tab = await next;
  assert.ok(tab.groupId >= 0);
  assert.equal(sessions.owner.size, 2, 'uncertain read does not silently drop an opened tab');
  assert.equal(chrome.log.filter(([name]) => name === 'tabs.create').length, 3, 'no duplicate creates on fallback failure');
});

for (const observed of [undefined, null, -1, 0, 71]) {
  test(`failed grouping reports observed optional membership ${String(observed)}`, async () => {
    const { chrome, create } = await world();
    chrome.fail['tabs.group'] = new Error('window cannot group');
    const get = chrome.tabs.get;
    chrome.tabs.get = async (id) => ({ ...(await get(id)), groupId: observed });
    const tab = await create();
    assert.equal(tab.groupId, observed == null ? -1 : observed);
  });
}

test('storage rejection retains acknowledged tabs and permits later successful saving without reopening', async () => {
  const { chrome, sessions, create, logged } = await world({ storage: true });
  chrome.fail['storage.session.set'] = new Error('storage unavailable');
  const first = await create();
  await flush();
  assert.ok(logged.includes('save the sessions'));
  assert.equal(sessions.owner.get(first.id), 'a');
  delete chrome.fail['storage.session.set'];
  const second = await create();
  await flush();
  assert.deepEqual(chrome.store.session.sessions.a.tabs, [first.id, second.id]);
  assert.equal(chrome.store.session.sessions.a.groupId, first.groupId);
  assert.equal(chrome.log.filter(([name]) => name === 'tabs.create').length, 2);
});

for (const response of [null, {}, { id: 999, groupId: 71 }]) {
  test(`failed grouping cannot report a missing or different fallback tab (${JSON.stringify(response)})`, async () => {
    const { chrome, create } = await world();
    chrome.fail['tabs.group'] = new Error('cannot group');
    chrome.tabs.get = async () => response;
    await assert.rejects(create(), /did not return the tab/);
  });
}

test('zero is a valid acknowledged group id and stays canonical for later joins', async () => {
  const { chrome, sessions, create } = await world();
  const group = chrome.tabs.group;
  chrome.tabs.group = (options) => group({ ...options, groupId: options.groupId ?? 0 });
  const tabs = await Promise.all([create(), create()]);
  assert.deepEqual(
    tabs.map((tab) => tab.groupId),
    [0, 0],
  );
  assert.equal(sessions.chats.get('a').groupId, 0);
  assert.equal(chrome.groups.get(0).title, 'A');
});
