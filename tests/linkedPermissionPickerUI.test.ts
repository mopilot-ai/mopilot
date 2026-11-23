// A linked chat's permission picker displays its own saved mode, preserves it across global-default changes and lets the user change it explicitly.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, fire } from './support/composer-kit.ts';
import { all, fx, last, mountComposer, reset, store } from './support/composer-setup.ts';

beforeEach(() => reset());
const W = window as any;

test('permission picker: current mode, the list with details, Learn more, and choosing', async () => {
  const m = await mountComposer({ threadId: 't1' });
  try {
    const btn = () => $('[aria-label="Change permissions"]');
    assert.equal(btn().textContent, 'Ask for approval');
    await click(btn());
    assert.equal($('.perm-menu-head span').textContent, 'What Codex can do');
    assert.deepEqual(
      $$('.perm-item .menu-title').map((x) => x.textContent),
      ['Read-only', 'Ask for approval', 'Approve for me', 'Full access'],
    );
    assert.ok($$('.perm-item')[1].querySelector('.menu-check svg'));
    // a real link (Tab reaches it, Enter opens it) that opens in the system browser
    assert.equal($('.perm-menu-head a').getAttribute('href'), 'https://developers.openai.com/codex/security');
    await click($('.perm-menu-head a'));
    assert.deepEqual(last('openLink'), ['openLink', 'https://developers.openai.com/codex/security']);
    await click($$('.perm-item')[0]);
    assert.deepEqual(last('prefs'), ['prefs', { permission: 'read-only' }]);
    assert.ok(!$('.perm-menu'));
    assert.equal(btn().textContent, 'Read-only');
    await fire(window, new W.Event('open-permission-picker'));
    assert.ok($('.perm-menu'));
    // an unknown saved mode shows as the default row
    store.set((s: any) => ({ prefs: { ...s.prefs, permission: 'weird' } }));
    await m.rerender();
    assert.equal(btn().textContent, 'Read-only', 'another chat’s default does not replace this chat’s permission');
    store.set({ chatConfig: { t1: { permission: 'weird' } } });
    await m.rerender();
    assert.equal(btn().textContent, 'Ask for approval');
  } finally {
    await m.unmount();
  }
});

test('permission picker: a model that cannot auto-approve greys "Approve for me"', async () => {
  fx.sel = { ...fx.sel, model: { ...fx.sel.model, autoMode: false } };
  const m = await mountComposer({ threadId: 't1' });
  try {
    await click($('[aria-label="Change permissions"]'));
    const auto = $('.perm-item.auto-review');
    assert.equal(auto.getAttribute('aria-disabled'), 'true');
    assert.equal(auto.title, "This model can't auto-approve · Switch model");
    await click(auto);
    assert.deepEqual(last('toast'), ['toast', "This model can't auto-approve · Switch model"]);
    assert.ok($('.perm-menu'));
    assert.equal(all('prefs').length, 0);
  } finally {
    await m.unmount();
  }
});

test('the full-access warning follows this chat, including an inherited plan, across global-default changes', async () => {
  store.set((s: any) => ({ prefs: { ...s.prefs, permission: 'full-access' }, chatConfig: { t1: { permission: 'read-only' } } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.equal($('.fa-banner'), null);
    store.set({ chatConfig: { t1: { permission: 'plan' } } });
    await m.rerender();
    assert.equal($('.fa-banner'), null);
    assert.equal($('[aria-label="Change permissions"]').textContent, 'Plan mode');
    store.set((s: any) => ({ prefs: { ...s.prefs, permission: 'read-only' }, chatConfig: { t1: { permission: 'full-access' } } }));
    await m.rerender();
    assert.ok($('.fa-banner'));
  } finally {
    await m.unmount();
  }
});
