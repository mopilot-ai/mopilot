// A MoMo chat's composer has none of the coding side's chrome (#2279): no mode or permission picker ("Set by opencode",
// "Build"), no Full access banner, no model picker (MoMo's brain chip sets those, through the model slot's one seam),
// MoMo's own placeholder, and a + menu of files, Computer History and a sketch only; a coding chat on the same harness
// keeps all of it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { Composer, mountComposer, reset, settle, store } from './support/composer-setup.ts';

// after composer-setup's mocks, so its store is the fake one
const { MomoModelSlot } = await import('../src/components/momo/useMomoChat.ts');

beforeEach(() => reset());
const titles = () => $$('.add-panel-title').map((x) => x.textContent);

test('a MoMo chat’s composer: no pickers, banner or model chip, MoMo’s placeholder and a short + menu', async () => {
  store.set((s: any) => ({ prefs: { ...s.prefs, permission: 'full-access' }, momoChats: { t1: 'main' } }));
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.ok(!$('[aria-label="Change permissions"]'));
    assert.ok(!$('.fa-banner'));
    assert.ok(!$('.stub-model'));
    assert.equal(
      $('.composer-editor').getAttribute('data-placeholder') ?? $('.composer-editor').getAttribute('placeholder'),
      'Message MoMo',
    );
    await click($('[aria-label="Add files and more"]'));
    await settle();
    assert.deepEqual(titles(), ['Files and folders', 'Computer History', 'Sketch']);
  } finally {
    await m.unmount();
  }
});

test('a basic harness’s MoMo chat hides coding permissions; a coding chat keeps an accessible indicator', async () => {
  store.set({ basicOf: { t1: 'kimi', t2: 'kimi' }, momoChats: { t1: 'main' } });
  const momo = await mountComposer({ threadId: 't1' });
  try {
    assert.ok(!$('.perm-btn'));
  } finally {
    await momo.unmount();
  }
  const coding = await mountComposer({ threadId: 't2' });
  try {
    assert.equal($('.perm-btn.set-by').textContent, '');
    assert.match($('.perm-btn.set-by').getAttribute('aria-description')!, /Kimi/);
    assert.ok($('.stub-model'));
    assert.notEqual(
      $('.composer-editor').getAttribute('data-placeholder') ?? $('.composer-editor').getAttribute('placeholder'),
      'Message MoMo',
    );
  } finally {
    await coding.unmount();
  }
});

test('MoMo fills the model picker’s slot through MomoModelSlot; a coding chat ignores it', async () => {
  store.set({ momoChats: { t1: 'main' } });
  const chip = h('button', { className: 'stub-brain-chip' }, 'Kimi Code');
  const inSlot = (threadId: string) =>
    mount(h(MomoModelSlot.Provider, { value: chip }, h(Composer, { threadId, variant: 'thread' } as any)));
  let m = await inSlot('t1');
  try {
    assert.ok($('.composer-right .stub-brain-chip'));
    assert.ok(!$('.stub-model'));
  } finally {
    await m.unmount();
  }
  m = await inSlot('t2');
  try {
    assert.ok(!$('.stub-brain-chip'));
    assert.ok($('.stub-model'));
  } finally {
    await m.unmount();
  }
});
