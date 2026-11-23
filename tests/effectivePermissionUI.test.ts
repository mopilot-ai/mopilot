// Permission controls and warnings follow native restrictions before saved settings, without borrowing a pending switch's source state.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, click } from './support/composer-kit.ts';
import { act } from 'react';
import { mountComposer, reset, setSessionState, store } from './support/composer-setup.ts';

beforeEach(() => reset());

test('Codex collaboration Plan mode keeps the native sandbox permission, and saved choices wait for acknowledgment', async () => {
  store.set({ chatConfig: { t1: { permission: 'full-access' } } });
  setSessionState('t1', { plan: true, permission: 'default' });
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal($('[aria-label="Change permissions"]').textContent, 'Ask for approval');
    await click($('[aria-label="Change permissions"]'));
    assert.match($('.perm-menu').textContent!, /Full access applies to your next message/);
    await click($('.perm-item.full-access'));
    assert.equal($('[aria-label="Change permissions"]').textContent, 'Ask for approval');
    await act(() => setSessionState('t1', { plan: true, permission: 'full-access' }));
    assert.equal($('[aria-label="Change permissions"]').textContent, 'Full access');
    assert.ok($('.fa-banner'));
  } finally {
    await m.unmount();
  }
});

test('a saved linked plan is described as next-message intent until native permission confirms it', async () => {
  store.set({ chatConfig: { t1: { permission: 'plan' } } });
  setSessionState('t1', { permission: 'default' });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('[aria-label="Change permissions"]'));
    assert.match($('.perm-menu').textContent!, /Plan mode applies to your next message/);
  } finally {
    await m.unmount();
  }
});

for (const harness of ['codex', 'claude']) {
  test(`${harness}: native Plan mode overrides Full access and clears after the native mode changes`, async () => {
    store.set({ harnessOf: { t1: harness }, chatConfig: { t1: { permission: 'full-access' } } });
    setSessionState('t1', { permission: 'plan' });
    const m = await mountComposer({ threadId: 't1' });
    try {
      assert.equal($('[aria-label="Change permissions"]').textContent, 'Plan mode');
      assert.equal($('.fa-banner'), null);
      await click($('[aria-label="Change permissions"]'));
      assert.match($('.perm-menu').textContent!, /after Plan mode ends/);
      await click($('.perm-item.full-access'));
      assert.equal($('[aria-label="Change permissions"]').textContent, 'Plan mode', 'a saved choice is not a native acknowledgment');
      await act(() => setSessionState('t1', { permission: 'bypassPermissions', plan: false }));
      await m.rerender();
      assert.equal($('[aria-label="Change permissions"]').textContent, 'Full access');
      assert.ok($('.fa-banner'));
    } finally {
      await m.unmount();
    }
  });

  test(`${harness}: active read-only mode survives a desired permission change and another chat's mode`, async () => {
    store.set({ harnessOf: { t1: harness }, chatConfig: { t1: { permission: 'full-access' } } });
    setSessionState('t1', { permission: 'read-only' });
    setSessionState('other', { permission: 'full-access' });
    const m = await mountComposer({ threadId: 't1' });
    try {
      assert.equal($('[aria-label="Change permissions"]').textContent, 'Read-only');
      assert.equal($('.fa-banner'), null);
      await act(() => setSessionState('t1', { pendingSwitch: { harness: harness === 'claude' ? 'codex' : 'claude' } }));
      await m.rerender();
      assert.equal($('[aria-label="Change permissions"]').textContent, 'Full access');
    } finally {
      await m.unmount();
    }
  });
}
