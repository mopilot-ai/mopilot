// Popup grouping continuations retain the exact extension session and tab ownership across asynchronous Chrome APIs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';

async function setup() {
  const chrome = fakeChromeApi();
  const sent: any[] = [];
  const logged: string[] = [];
  const s = new Sessions({ chrome, send: (m: any) => sent.push(m), log: (what: string) => logged.push(what) });
  await s.open('chat-a', {});
  const root = await s.command('chat-a', 'chrome.tabs.create', [{}], 0);
  const tab = chrome.addTab({ openerTabId: root.id });
  const created = () => sent.filter((m) => m.method === 'chrome.tabs.onCreated' && m.params[0].id === tab.id);
  return { chrome, sent, logged, s, root, tab, created };
}

for (const retire of ['close', 'replace', 'remove', 'release', 'transfer']) {
  for (const fails of [false, true]) {
    test(`popup group lookup finishes ${fails ? 'with rejection' : 'successfully'} after ${retire}: no old grouping or publication`, async () => {
      const { chrome, s, tab, created } = await setup();
      const wait = deferred();
      const entered = deferred();
      chrome.tabGroups.get = () => {
        entered.resolve(undefined);
        return wait.promise;
      };
      const pending = s.onTabCreated(tab);
      await entered.promise;
      if (retire === 'close' || retire === 'replace') {
        await s.close('chat-a');
        if (retire === 'replace') await s.open('chat-a', {});
      } else if (retire === 'remove') s.onTabRemoved(tab.id);
      else {
        s.onDebuggerDetach({ tabId: tab.id }, 'canceled_by_user');
        if (retire === 'transfer') {
          await s.open('chat-b', {});
          s.chats.get('chat-b')!.groupId = 77;
          s.onTabUpdated(tab.id, { groupId: 77 }, { ...tab, groupId: 77 });
        }
      }
      const before = chrome.log.length;
      if (fails) wait.reject(new Error('group went away'));
      else wait.resolve({});
      await pending;
      assert.equal(
        created().some((m) => m.chat === 'chat-a'),
        false,
      );
      assert.equal(
        chrome.log.slice(before).some((call) => call[0] === 'tabs.group'),
        false,
      );
      assert.equal(s.grouping.has(tab.id), false);
      assert.equal(s.owner.get(tab.id), retire === 'transfer' ? 'chat-b' : undefined);
    });
  }
}

for (const hasGroup of [false, true]) {
  test(`popup ${hasGroup ? 'existing' : 'new'} group mutation finishes after removal: no later metadata or publication`, async () => {
    const { chrome, s, tab, created } = await setup();
    if (!hasGroup) s.chats.get('chat-a')!.groupId = null;
    const wait = deferred<number>();
    const entered = deferred();
    chrome.tabs.group = () => {
      entered.resolve(undefined);
      return wait.promise;
    };
    const pending = s.onTabCreated(tab);
    await entered.promise;
    s.onTabRemoved(tab.id);
    const before = chrome.log.length;
    wait.resolve(88);
    await pending;
    assert.equal(created().length, 0);
    assert.equal(
      chrome.log.slice(before).some((call) => call[0] === 'tabGroups.update'),
      false,
    );
    assert.equal(s.grouping.has(tab.id), false);
  });
}

test('popup grouping combines siblings and survives a turn advance, peer loss and duplicate event', async () => {
  const { chrome, s, tab, root, created } = await setup();
  const wait = deferred();
  chrome.tabGroups.get = () => wait.promise;
  const pending = s.onTabCreated(tab);
  const sibling = chrome.addTab({ openerTabId: root.id });
  const other = s.onTabCreated(sibling);
  await s.onTabCreated(tab);
  s.advance('chat-a', 1);
  await s.peerGone();
  wait.resolve({});
  await Promise.all([pending, other]);
  assert.equal(created().length, 1);
  assert.equal(s.owner.get(tab.id), 'chat-a');
  assert.equal(s.owner.get(sibling.id), 'chat-a');
  assert.equal(chrome.tabsById.get(tab.id).groupId, root.groupId);
});

test('a grouping failure still reports the owned popup, and a later popup can group', async () => {
  const { chrome, s, tab, root, created, logged } = await setup();
  chrome.fail['tabs.group'] = new Error('popup window has no tab groups');
  await s.onTabCreated(tab);
  assert.equal(created().length, 1);
  assert.ok(logged.includes('group a tab'));
  delete chrome.fail['tabs.group'];
  const retry = chrome.addTab({ openerTabId: root.id });
  await s.onTabCreated(retry);
  assert.equal(s.owner.get(retry.id), 'chat-a');
  assert.equal(chrome.tabsById.get(retry.id).groupId, root.groupId);
});

for (const boundary of ['lookup', 'create', 'group']) {
  for (const replacement of [false, true]) {
    test(`tab creation cannot publish ownership after session ${replacement ? 'replacement' : 'close'} during ${boundary}`, async () => {
      const { chrome, s } = await setup();
      const wait = deferred<any>();
      const entered = deferred<any>();
      const original = boundary === 'lookup' ? chrome.tabGroups.get : boundary === 'create' ? chrome.tabs.create : chrome.tabs.group;
      let opened: any;
      const held = async (arg: any) => {
        opened = await original(arg);
        entered.resolve(undefined);
        await wait.promise;
        return opened;
      };
      if (boundary === 'lookup') chrome.tabGroups.get = held;
      else if (boundary === 'create') chrome.tabs.create = held;
      else chrome.tabs.group = held;
      const pending = s.command('chat-a', 'chrome.tabs.create', [{}], 0);
      await entered.promise;
      await s.close('chat-a');
      if (replacement) await s.open('chat-a', {});
      const before = chrome.log.length;
      wait.resolve(undefined);
      await assert.rejects(pending, /closed|no longer belongs/);
      assert.equal([...s.owner.values()].includes('chat-a'), false);
      if (boundary === 'lookup')
        assert.equal(
          chrome.log.slice(before).some((call) => call[0] === 'tabs.create'),
          false,
        );
      if (boundary === 'create') assert.equal(chrome.tabsById.has(opened.id), false, 'unused created tab is closed');
    });
  }
}

test('failed retirement cleanup reports the failure without reclaiming or returning the new tab', async () => {
  const { chrome, s, logged } = await setup();
  const wait = deferred<any>();
  chrome.tabs.create = () => wait.promise;
  const pending = s.command('chat-a', 'chrome.tabs.create', [{}], 0);
  // The existing group lookup completes before the creation waits.
  await Promise.resolve(undefined);
  await Promise.resolve(undefined);
  await s.close('chat-a');
  chrome.fail['tabs.remove'] = new Error('Chrome went away');
  wait.resolve(chrome.addTab());
  await assert.rejects(pending, /session closed/);
  assert.ok(logged.includes('close a tab opened for a retired chat'));
  assert.equal(s.owner.size, 0);
});

test('closing retires ownership before detach waits; removal events and a replacement session stay safe', async () => {
  const { chrome, s, root } = await setup();
  const second = await s.command('chat-a', 'chrome.tabs.create', [{}], 0);
  await s.command('chat-a', 'chrome.debugger.attach', [{ tabId: root.id }], 0);
  await s.command('chat-a', 'chrome.debugger.attach', [{ tabId: second.id }], 0);
  const wait = deferred<any>();
  chrome.debugger.detach = () => wait.promise;
  const pending = s.close('chat-a');
  assert.equal(s.owner.has(root.id), false);
  assert.doesNotThrow(() => s.onTabRemoved(root.id));
  await s.open('chat-a', {});
  s.chats.get('chat-a')!.groupId = 77;
  s.onTabUpdated(second.id, { groupId: 77 }, { ...second, groupId: 77 });
  const before = chrome.log.length;
  wait.resolve(undefined);
  await pending;
  assert.equal(s.owner.get(second.id), 'chat-a');
  assert.ok(chrome.log.slice(before).every((call) => call[0] !== 'tabs.ungroup' || !call[1].includes(second.id)));
});

for (const failed of [false, true]) {
  test(`retired session replay ${failed ? 'rejection' : 'success'} cannot publish or drop replacement ownership`, async () => {
    const { chrome, s, root, sent } = await setup();
    await s.command('chat-a', 'chrome.tabs.create', [{}], 0);
    const wait = deferred<any>();
    chrome.tabs.get = () => wait.promise;
    const pending = s.open('chat-a', {});
    await s.close('chat-a');
    await s.open('chat-a', {});
    s.chats.get('chat-a')!.groupId = 77;
    s.onTabUpdated(root.id, { groupId: 77 }, { ...root, groupId: 77 });
    const before = sent.length;
    if (failed) wait.reject(new Error('tab unavailable'));
    else wait.resolve(root);
    await pending;
    assert.equal(sent.length, before);
    assert.equal(s.owner.get(root.id), 'chat-a');
  });
}

for (const close of [false, true]) {
  test(`late creation preserves a tab the user transferred to another session, original ${close ? 'closed' : 'live'}`, async () => {
    const { chrome, s } = await setup();
    await s.open('chat-b', {});
    const other = await s.command('chat-b', 'chrome.tabs.create', [{}], 0);
    const wait = deferred<any>();
    const entered = deferred<any>();
    const create = chrome.tabs.create;
    let opened: any;
    chrome.tabs.create = async (options: any) => {
      opened = await create(options);
      entered.resolve(undefined);
      await wait.promise;
      return opened;
    };
    const pending = s.command('chat-a', 'chrome.tabs.create', [{}], 0);
    await entered.promise;
    s.onTabUpdated(opened.id, { groupId: other.groupId }, { ...opened, groupId: other.groupId });
    if (close) await s.close('chat-a');
    wait.resolve(undefined);
    await assert.rejects(pending, /no longer belongs/);
    assert.equal(s.owner.get(opened.id), 'chat-b');
    assert.equal(chrome.tabsById.has(opened.id), true);
  });
}

for (const how of ['pane', 'chrome']) {
  test(`closing the tab a popup came from (${how}) closes only that tab: the popup stays the chat’s (#1777)`, async () => {
    const { chrome, sent, s, tab, root, created } = await setup();
    await s.onTabCreated(tab);
    assert.equal(created().length, 1);
    // the pane's close goes through the chat's command; the user's own close in Chrome only reports the removal
    if (how === 'pane') await s.command('chat-a', 'chrome.tabs.remove', [root.id], 0);
    else chrome.tabsById.delete(root.id);
    s.onTabRemoved(root.id);
    assert.equal(chrome.tabsById.has(tab.id), true);
    assert.equal(s.owner.get(tab.id), 'chat-a');
    assert.equal(s.owner.has(root.id), false);
    assert.deepEqual(
      sent.filter((m) => m.method === 'chrome.tabs.onRemoved').map((m) => m.params[0]),
      how === 'pane' ? [] : [root.id],
    );
    assert.deepEqual(
      chrome.log.filter((call) => call[0] === 'tabs.remove').map((call) => call[1]),
      how === 'pane' ? [root.id] : [],
    );
  });
}
