// ACP composer mode controls keep permissions and agent modes in one menu without losing choices or failure recovery.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, settle, setSessionState, store } from './support/composer-setup.ts';

beforeEach(() => reset());

test('pending switches keep the model destination and permission slot on the same harness family', async () => {
  for (const from of ['codex', 'claude', 'kimi']) {
    store.set({
      harnessOf: { t1: from === 'kimi' ? 'codex' : from },
      basicOf: { t1: from === 'kimi' ? 'kimi' : null },
      basicHarnesses: [OPENCODE],
    });
    for (const target of ['codex', 'claude', 'acp:opencode']) {
      setSessionState('t1', { pendingSwitch: { harness: target } });
      const m = await mountComposer({ threadId: 't1' });
      try {
        if (target === 'acp:opencode') {
          assert.equal($('.perm-btn.set-by').getAttribute('aria-label'), 'Permissions');
          assert.equal($('.perm-btn.set-by').textContent, '');
          assert.match($('.perm-btn.set-by').getAttribute('aria-description')!, /next message switches/);
          assert.ok(!$('[aria-label="Change permissions"]'));
          assert.ok(!$('[aria-label="Change mode"]'));
        } else {
          assert.ok($('[aria-label="Change permissions"]'));
          assert.ok(!$('.perm-btn.set-by'));
        }
        const sent = all('send').length;
        await m.type('continue on the selected harness');
        await click($('[aria-label="Send"]'));
        await settle();
        assert.equal(all('send').length, sent + 1);
        assert.equal(last('send')![2], 'continue on the selected harness');
      } finally {
        await m.unmount();
      }
    }
  }
});

test('a reference read for a retired ACP destination cannot send; the current destination can retry', async () => {
  store.set({ basicOf: { t1: 'kimi' } });
  setSessionState('t1', { pendingSwitch: { harness: 'acp:opencode' } });
  let finish!: (value: any[]) => void;
  fx.refs = () => new Promise<any[]>((resolve) => (finish = resolve));
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('keep this request');
    await click($('[aria-label="Send"]'));
    setSessionState('t1', { pendingSwitch: { harness: 'acp:gemini' } });
    finish([]);
    await settle();
    assert.equal(all('send').length, 0);
    assert.equal(m.text, 'keep this request');
    fx.refs = async () => [];
    await click($('[aria-label="Send"]'));
    await settle();
    assert.equal(last('send')![2], 'keep this request');
    assert.equal(m.text, '');
  } finally {
    await m.unmount();
  }
});

const OPTION = {
  id: 'mode',
  name: 'Session Mode',
  category: 'mode',
  type: 'select',
  currentValue: 'build',
  options: [
    { value: 'build', name: 'build', description: 'The default agent.' },
    { value: 'mopilot-ask', name: 'mopilot-ask', description: 'Asks first' },
    { value: 'mopilot-full', name: 'mopilot-full' },
    { value: 'plan', name: 'plan', description: 'No edits' },
  ],
};
const OPENCODE = {
  id: 'opencode',
  state: 'admitted',
  catalog: { modes: null, configOptions: [OPTION] },
  permissionModes: { plan: 'read-only', 'mopilot-ask': 'default', 'mopilot-full': 'full-access' },
  agentModes: ['build'],
};
const trigger = () => $('.acp-mode-trigger');
const row = (name: string) => $$('.perm-item').find((r) => r.querySelector('.menu-title')!.textContent === name)!;

test('missing or empty modes use a quiet accessible permission indicator', async () => {
  store.set({ newBasic: 'kimi' });
  const m = await mountComposer({ threadId: null });
  try {
    const indicator = $('.perm-btn.set-by');
    assert.equal(indicator.textContent, '');
    assert.equal(indicator.getAttribute('aria-label'), 'Permissions');
    assert.equal(indicator.tabIndex, 0);
    assert.match(indicator.getAttribute('aria-description')!, /lists its modes once a chat on it opens/);
    assert.ok(!trigger());
    store.set({ basicHarnesses: [{ id: 'kimi', state: 'admitted', catalog: null }] });
    await m.rerender();
    assert.match($('.set-by').getAttribute('aria-description')!, /runs under its own permission settings/);
  } finally {
    await m.unmount();
  }
});

test('one menu contains every permission and agent mode; choices retain native values and refusal recovery', async () => {
  store.set({ newBasic: 'opencode', basicOf: { t1: 'opencode' }, basicHarnesses: [OPENCODE] });
  const m = await mountComposer({ threadId: null });
  try {
    assert.equal(trigger().textContent, 'Build');
    assert.equal($$('.composer-left .perm-btn').length, 1);
    assert.ok(!$('.set-by'));
    await click(trigger());
    assert.equal($('.perm-menu-head span').textContent, 'What Opencode can do');
    assert.deepEqual(
      $$('.acp-mode-section').map((x) => x.textContent),
      ['Permissions', 'Mode'],
    );
    assert.deepEqual(
      $$('.perm-item .menu-title').map((x) => x.textContent),
      ['Read-only', 'Ask for approval', 'Full access', 'Build'],
    );
    assert.equal(row('Read-only').querySelector('.menu-desc')!.textContent, 'No edits');
    assert.doesNotMatch($('.perm-menu').textContent, /mopilot-(ask|full)/);
    assert.equal(
      $('.perm-mode-note').textContent,
      'Build runs under Opencode’s own permission settings. Choosing a permission preset switches modes.',
    );
    assert.equal(row('Full access').querySelector('.menu-desc'), null);
    assert.equal(row('Build').querySelector('.menu-desc')!.textContent, 'The default agent.');
    assert.ok(row('Build').querySelector('.menu-check svg'));
    await click(row('Full access'));
    await settle();
    assert.equal(all('acpConfig').length, 0);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { mode: 'mopilot-full' } });
    assert.equal(trigger().textContent, 'Full access');
    await click(trigger());
    assert.equal($('.perm-mode-note'), null);
    await click(trigger());
    assert.ok(trigger().classList.contains('full-access'));
    await fire(window, new CustomEvent('open-permission-picker'));
    await click(row('Ask for approval'));
    await settle();
    assert.equal(trigger().textContent, 'Ask for approval');
  } finally {
    await m.unmount();
  }

  const live = await mountComposer({ threadId: 't1' });
  try {
    setSessionState('t1', { acp: { modes: null, configOptions: [OPTION] } });
    await live.rerender();
    assert.equal(trigger().textContent, 'Build');
    assert.equal(trigger().getAttribute('aria-description'), 'Build runs under Opencode’s own permission settings');
    await click(trigger());
    await click(row('Read-only'));
    await settle();
    assert.deepEqual(last('acpConfig'), ['acpConfig', 't1', 'mode', 'plan']);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { mode: 'plan' } });
    fx.acpRefuses = true;
    await click(trigger());
    await click(row('Full access'));
    await settle();
    assert.deepEqual(last('acpConfig'), ['acpConfig', 't1', 'mode', 'mopilot-full']);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { mode: 'plan' } });
    // Unknown and absent values remain recoverable through the complete menu.
    for (const currentValue of ['gone', null]) {
      setSessionState('t1', { acp: { modes: null, configOptions: [{ ...OPTION, currentValue }] } });
      await live.rerender();
      assert.equal(trigger().textContent, currentValue ?? 'Mode');
      await click(trigger());
      assert.equal($$('.perm-item').length, 4);
      if (currentValue) assert.match($('.perm-mode-note').textContent, /gone runs under Opencode’s own permission settings/);
      else assert.equal($('.perm-mode-note'), null);
      await click(trigger());
    }
  } finally {
    await live.unmount();
  }
});

test('native session modes work with agent-only, permission-only and mixed catalogs', async () => {
  store.set({ basicOf: { t1: 'kimi' }, basicHarnesses: [{ id: 'kimi', state: 'admitted', agentModes: ['code', 'plan'] }] });
  const m = await mountComposer({ threadId: 't1' });
  try {
    setSessionState('t1', {
      acp: {
        modes: {
          currentModeId: 'plan',
          availableModes: [
            { id: 'code', name: 'code', description: 'Edits files' },
            { id: 'plan', name: 'Plan' },
          ],
        },
      },
    });
    await m.rerender();
    assert.equal(trigger().textContent, 'Plan');
    assert.equal(trigger().getAttribute('aria-label'), 'Change mode');
    await fire(window, new CustomEvent('open-permission-picker'));
    assert.equal($('.perm-mode-note'), null);
    assert.deepEqual(
      $$('.perm-item .menu-title').map((x) => x.textContent),
      ['Code', 'Plan'],
    );
    assert.ok(!row('Plan').querySelector('.menu-desc'));
    await click(row('Code'));
    await settle();
    assert.deepEqual(last('acpMode'), ['acpMode', 't1', 'code']);
    assert.deepEqual(store.get().prefs.basicDefaults, { kimi: { mode: 'code' } });
    store.set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] });
    await m.rerender();
    assert.equal(trigger().getAttribute('aria-label'), 'Change permissions');
    await click(trigger());
    assert.equal($$('.perm-item').length, 2);
    assert.equal($('.perm-mode-note'), null, 'unmapped native modes do not advertise permission presets');
  } finally {
    await m.unmount();
  }
});

test('a disappeared or replaced mode control retires its open menu and shortcut ownership', async () => {
  store.set({ newBasic: 'opencode', basicHarnesses: [OPENCODE] });
  const m = await mountComposer({ threadId: null });
  try {
    await click(trigger());
    assert.ok($('.perm-menu'));
    store.set({ basicHarnesses: [{ ...OPENCODE, catalog: null }] });
    await m.rerender();
    assert.ok(!$('.perm-menu'));
    assert.ok($('.set-by'));
    store.set({ basicHarnesses: [OPENCODE] });
    await m.rerender();
    assert.ok(!$('.perm-menu'), 'restored declarations do not reopen the retired menu');
    await fire(document.body, new CustomEvent('open-permission-picker'));
    assert.ok(!$('.perm-menu'), 'a different composer cannot take the shortcut');
    await click(trigger());
    store.set({ newBasic: 'kimi', basicHarnesses: [{ ...OPENCODE, id: 'kimi' }] });
    await m.rerender();
    assert.ok(!$('.perm-menu'), 'switching harness retires the old menu');
    await click(trigger());
    assert.ok($('.perm-menu'), 'the replacement control still opens');
  } finally {
    await m.unmount();
  }
});
