// Settings' Back to app: leaveSettings returns to the view Settings was opened from, and Esc counts only on Settings.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { loadStore, resetAll, resetDeletionLifetime, deleteReceipt } from './support/store-harness.ts';
import { deletionVisibility } from '../src/store/deletionVisibility.ts';
import { leavesSettings } from '../src/lib/shortcutFocus.ts';
import { noteOwner } from '../src/harness/ownership.ts';

const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;

beforeEach(() => {
  resetState();
  resetAll();
  resetDeletionLifetime();
});

test('back past every Settings page to the chat it was opened from, which forward history brings back', () => {
  noteOwner('t1', 'claude');
  set({ threads: { t1: { id: 't1' } as any }, runtime: { t1: { loaded: true } as any } });
  S.navigate({ name: 'thread', id: 't1' });
  S.navigate({ name: 'settings', section: 'general' });
  S.navigate({ name: 'settings', section: 'git' });
  S.leaveSettings();
  assert.deepEqual(st().route, { name: 'thread', id: 't1' });
  assert.deepEqual(st().back, [{ name: 'home' }]);
  assert.deepEqual(st().forward, [
    { name: 'settings', section: 'general' },
    { name: 'settings', section: 'git' },
  ]);
  S.goForward();
  assert.deepEqual(st().route, { name: 'settings', section: 'general' });
});

test('a page that is not a chat is returned to as well', () => {
  S.navigate({ name: 'scheduled' });
  S.navigate({ name: 'settings' });
  S.leaveSettings();
  assert.deepEqual(st().route, { name: 'scheduled' });
  assert.deepEqual(st().forward, [{ name: 'settings' }]);
});

test('a chat deleted or archived while Settings was open is passed over; one only absent from the sidebar is not', () => {
  deletionVisibility.accept(deleteReceipt('gone'));
  set({
    route: { name: 'settings', section: 'archived' },
    back: [{ name: 'scheduled' }, { name: 'thread', id: 'gone' }, { name: 'thread', id: 'shelved' }] as any,
    forward: [],
    claudeArchived: { shelved: 1 },
  });
  S.leaveSettings();
  assert.deepEqual(st().route, { name: 'scheduled' });
  assert.deepEqual(st().forward, [
    { name: 'thread', id: 'gone' },
    { name: 'thread', id: 'shelved' },
    { name: 'settings', section: 'archived' },
  ]);
  // a search hit or a deep link opens a chat the sidebar's loaded page doesn't hold
  noteOwner('older', 'claude');
  set({ route: { name: 'settings' }, back: [{ name: 'thread', id: 'older' }], threads: {}, runtime: { older: { loaded: true } as any } });
  S.leaveSettings();
  assert.deepEqual(st().route, { name: 'thread', id: 'older' });
});

test('with no view before Settings it goes Home, its pages kept forward, and outside Settings it does nothing', () => {
  set({ route: { name: 'settings' }, back: [{ name: 'settings', section: 'git' }], forward: [] });
  S.leaveSettings();
  assert.deepEqual(st().route, { name: 'home' });
  assert.deepEqual(st().back, []);
  assert.deepEqual(st().forward, [{ name: 'settings', section: 'git' }, { name: 'settings' }]);
  const before = { route: st().route, back: st().back, forward: st().forward };
  S.leaveSettings();
  assert.deepEqual({ route: st().route, back: st().back, forward: st().forward }, before);
});

test('Esc leaves Settings only unmodified, from the page, its sidebar or nowhere, and never from a field', () => {
  const esc = { key: 'Escape', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };
  const settings = { name: 'settings' };
  const el = (html: string) => {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.querySelector('[data-t]')!;
  };
  for (const target of [null, document.body, document.documentElement]) assert.equal(leavesSettings(esc, settings, target), true);
  for (const html of [
    '<div class="settings-page"><button data-t>Save</button></div>',
    '<aside class="settings-nav"><button data-t>Git</button></aside>',
    '<div class="settings-page"><div contenteditable="false"><span data-t></span></div></div>',
  ])
    assert.equal(leavesSettings(esc, settings, el(html)), true, html);
  for (const html of [
    '<div class="settings-page"><input data-t></div>',
    '<div class="settings-page"><textarea data-t></textarea></div>',
    '<aside class="settings-nav"><select data-t></select></aside>',
    '<div class="settings-page"><div contenteditable><b data-t></b></div></div>',
    // a side pane's chat beside Settings keeps its own Esc
    '<div class="side-pane"><button data-t>Option</button></div>',
  ])
    assert.equal(leavesSettings(esc, settings, el(html)), false, html);
  for (const mod of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey'])
    assert.equal(leavesSettings({ ...esc, [mod]: true }, settings, null), false, mod);
  assert.equal(leavesSettings({ ...esc, key: 'Enter' }, settings, null), false);
  assert.equal(leavesSettings({ ...esc, isComposing: true }, settings, null), false);
  assert.equal(leavesSettings({ ...esc, keyCode: 229 }, settings, null), false);
  assert.equal(leavesSettings(esc, { name: 'home' }, null), false);
});
