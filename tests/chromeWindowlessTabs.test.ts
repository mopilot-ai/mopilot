// A Chrome with no normal window open (#3714): the extension's tab opens (src/openTab.mjs) make an unfocused window
// instead of failing with "No current window", for a chat's tab (src/sessions.mjs) and the worker's own pages.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
import { deferred } from './support/async-scenarios.ts';
import { Sessions } from '../electron/chrome-extension/src/sessions.mjs';
import { tabOpener } from '../electron/chrome-extension/src/openTab.mjs';

const logged: string[] = [];
const note = (what: string) => logged.push(what);
const calls = (chrome: any, name: string) => chrome.log.filter(([n]: any[]) => n === name);
const windowless = () => {
  const chrome: any = fakeChromeApi();
  chrome.windowIds.clear();
  return chrome;
};

test('a chat tab in a windowless Chrome opens in a new unfocused window, owned and grouped', async () => {
  const chrome = windowless();
  const sent: any[] = [];
  const sessions: any = new Sessions({ chrome, send: (m: any) => sent.push(m), log: () => {}, storage: null });
  await sessions.open('a', {});
  const tab = await sessions.command('a', 'chrome.tabs.create', [{ url: 'https://vendor.example/quote' }], 0);
  assert.deepEqual(calls(chrome, 'windows.create'), [
    ['windows.create', { url: 'https://vendor.example/quote', focused: false, type: 'normal' }],
  ]);
  assert.equal(chrome.tabsById.get(tab.id).url, 'https://vendor.example/quote');
  assert.equal(sessions.owner.get(tab.id), 'a');
  assert.ok(tab.groupId >= 0);
  assert.equal(chrome.tabsById.get(tab.id).groupId, tab.groupId);
  // the next tab goes into the window now open, with no second window
  const next = await sessions.command('a', 'chrome.tabs.create', [{}], 0);
  assert.equal(calls(chrome, 'windows.create').length, 1);
  assert.equal(chrome.tabsById.get(next.id).windowId, chrome.tabsById.get(tab.id).windowId);
});

test('with a window open nothing changes: one tabs.create, no window made', async () => {
  const chrome: any = fakeChromeApi();
  const open = tabOpener(chrome, note);
  const tab = await open({ url: 'about:blank', active: false });
  assert.equal(tab.windowId, 1);
  assert.deepEqual(calls(chrome, 'tabs.create'), [['tabs.create', { url: 'about:blank', active: false }]]);
  assert.equal(calls(chrome, 'windows.create').length, 0);
});

test('overlapping opens in a windowless Chrome share the one window being made', async () => {
  const chrome = windowless();
  const gate = deferred();
  const create = chrome.windows.create;
  chrome.windows.create = async (o: any) => {
    await gate.promise;
    return create(o);
  };
  const open = tabOpener(chrome, note);
  const first = open({ url: 'https://a.example/' });
  const second = open({ url: 'https://b.example/', active: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gate.resolve(undefined);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls(chrome, 'windows.create').length, 1);
  assert.equal(a.windowId, b.windowId);
  assert.equal(chrome.tabsById.get(b.id).url, 'https://b.example/');
  assert.deepEqual(calls(chrome, 'tabs.create').at(-1), [
    'tabs.create',
    { url: 'https://b.example/', active: false, windowId: a.windowId },
  ]);
  // once made, a later windowless state makes a new one again
  chrome.windowIds.clear();
  await open({ url: 'https://c.example/' }, { focused: true });
  assert.deepEqual(calls(chrome, 'windows.create').at(-1), [
    'windows.create',
    { url: 'https://c.example/', focused: true, type: 'normal' },
  ]);
});

test('a window Chrome returns without its tab gets the tab opened in it', async () => {
  const chrome = windowless();
  chrome.windows.create = async () => {
    chrome.windowIds.add(9);
    return { id: 9 };
  };
  const tab = await tabOpener(chrome, note)({ url: 'https://a.example/', active: false });
  assert.equal(tab.windowId, 9);
  assert.deepEqual(calls(chrome, 'tabs.create').at(-1), ['tabs.create', { url: 'https://a.example/', active: false, windowId: 9 }]);
});

test('other failures are not taken for a windowless Chrome', async () => {
  const chrome = windowless();
  const open = tabOpener(chrome, note);
  // a named window that is gone: its own error, no window made
  await assert.rejects(open({ url: 'about:blank', windowId: 4 }), /No window with id: 4/);
  chrome.windowIds.add(1);
  chrome.fail['tabs.create'] = new Error('Tabs cannot be edited right now (user may be dragging a tab).');
  await assert.rejects(open({ url: 'about:blank' }), /dragging/);
  chrome.fail['tabs.create'] = 'No current window';
  chrome.windowIds.clear();
  // a bare string rejection is read too; a failing window creation is the open's error, and the next open tries again
  chrome.windows.create = async () => {
    throw new Error('Browser is shutting down');
  };
  await assert.rejects(open({ url: 'about:blank' }), /shutting down/);
  await assert.rejects(open({ url: 'about:blank' }), /shutting down/);
});

test('a chat session closed while its window was being made gets no tab', async () => {
  const chrome = windowless();
  const gate = deferred();
  const create = chrome.windows.create;
  chrome.windows.create = async (o: any) => {
    await gate.promise;
    return create(o);
  };
  const sessions: any = new Sessions({ chrome, send: () => {}, log: () => {}, storage: null });
  await sessions.open('a', {});
  const pending = sessions.command('a', 'chrome.tabs.create', [{}], 0);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await sessions.close('a');
  gate.resolve(undefined);
  await assert.rejects(pending, /closed while its Chrome tab was opening/);
  assert.equal([...chrome.tabsById.values()].filter((t: any) => t.url === 'about:blank').length, 0);
});

test('an overlapping open whose shared window closed with its first tab opens a window of its own', async () => {
  const chrome = windowless();
  const gate = deferred();
  const create = chrome.windows.create;
  chrome.windows.create = async (o: any) => {
    const made = await create(o);
    await gate.promise;
    return made;
  };
  const open = tabOpener(chrome, note);
  const first = open({ url: 'https://a.example/' });
  const second = open({ url: 'https://b.example/', active: false });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const a = [...chrome.tabsById.values()].find((t: any) => t.url === 'https://a.example/');
  // the first tab's chat retired it before the overlapping open landed: its window closes with it
  await chrome.tabs.remove(a.id);
  gate.resolve(undefined);
  await first;
  const b = await second;
  assert.equal(chrome.tabsById.get(b.id).url, 'https://b.example/');
  assert.notEqual(b.windowId, a.windowId);
  assert.equal(calls(chrome, 'windows.create').length, 2);
  assert.ok(logged.includes('open a tab in the window opened for a windowless Chrome'));
});

test('an overlapping open whose shared window failed to open tries a window of its own', async () => {
  const chrome = windowless();
  const gate = deferred();
  const create = chrome.windows.create;
  let first = true;
  chrome.windows.create = async (o: any) => {
    if (!first) return create(o);
    first = false;
    await gate.promise;
    throw new Error('Browser window could not be created');
  };
  const open = tabOpener(chrome, note);
  const failed = open({ url: 'https://a.example/' });
  const second = open({ url: 'https://b.example/' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gate.resolve(undefined);
  await assert.rejects(failed, /could not be created/);
  const b = await second;
  assert.equal(chrome.tabsById.get(b.id).url, 'https://b.example/');
});
