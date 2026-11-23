// Retired native group effects are removed only from tabs still unowned at the cleanup boundary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Groups } from '../electron/chrome-extension/src/groups.mjs';
import { fakeChromeApi } from './support/chrome-extension-kit.ts';
test('group cleanup preserves newer ownership, changed groups and unknown owners, and logs a closed tab', async () => {
  const chrome = fakeChromeApi();
  const tab = chrome.addTab({});
  const gid = await chrome.tabs.group({ tabIds: [tab.id] });
  const logs: string[] = [];
  const options = { chrome, changed: () => {}, log: (message: string) => logs.push(message) };
  await new Groups(options).discard(tab.id, gid);
  assert.equal(tab.groupId, gid, 'unknown ownership is conservative');
  let owned = false;
  const groups = new Groups({ ...options, owns: () => owned });
  await groups.discard(tab.id, -1);
  const get = chrome.tabs.get;
  chrome.tabs.get = async (id) => {
    const value = await get(id);
    owned = true;
    return value;
  };
  await groups.discard(tab.id, gid);
  assert.equal(tab.groupId, gid);
  owned = false;
  chrome.tabs.get = get;
  await groups.discard(tab.id, gid + 1);
  assert.equal(tab.groupId, gid);
  await groups.discard(tab.id, gid);
  assert.equal(tab.groupId, -1);
  chrome.fail['tabs.get'] = new Error('No such tab');
  await groups.discard(tab.id, gid);
  assert.deepEqual(logs, ['release a retired tab group']);
});
