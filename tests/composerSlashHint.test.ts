// Claude Code command hints in the desktop composer, from menu selection through send.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mouse } from './support/composer-kit.ts';
import { fx, last, mountComposer, reset, settle, store } from './support/composer-setup.ts';

beforeEach(() => reset());

test('picking a Claude command shows the argument hint without adding it to the draft or send', async () => {
  fx.nativeCmds = [{ name: 'code-review' }];
  fx.provider = { label: 'Claude Code' };
  fx.registry = () => ({
    menu: [{ name: 'code-review', dispatch: 'passthrough', source: 'harness', description: 'Review changes', hint: '[focus]' }],
    hidden: [],
  });
  store.set({ harnessOf: { t1: 'claude' } });
  const m = await mountComposer({ threadId: 't1' });
  try {
    await m.type('/code-r');
    const row = $$('.slash-panel .add-panel-item').find((item) => item.querySelector('.add-panel-title')?.textContent === '/code-review');
    assert.ok(row);
    await mouse(row, 'mousedown');
    assert.equal($('.slash-panel'), null);
    assert.equal(m.editor().getAttribute('data-command-hint'), '[focus]');
    assert.equal(m.text, '/code-review ');
    assert.equal(m.editor().selectionStart, m.text.length);
    assert.equal(last('send'), undefined);

    await m.type('/code-review branch changes');
    assert.equal(m.editor().getAttribute('data-command-hint'), null);
    await m.key('Enter');
    await settle();
    assert.equal(last('send')?.[2], '/code-review branch changes');
  } finally {
    await m.unmount();
  }
});

test('a restored goal objective that looks like a command stays plain text', async () => {
  fx.provider = { label: 'Claude Code' };
  fx.registry = () => ({
    menu: [{ name: 'code-review', dispatch: 'passthrough', source: 'harness', description: 'Review changes', hint: '[focus]' }],
    hidden: [],
  });
  store.set({
    harnessOf: { t1: 'claude' },
    drafts: { t1: { text: '/code-review ', attachments: [], goal: true } },
  });
  const m = await mountComposer({ threadId: 't1' });
  try {
    assert.ok($('.goal-chip'));
    assert.equal(m.text, '/code-review ');
    assert.equal(m.editor().dataset.commandHint, undefined);
    await click($('.goal-chip'));
    assert.equal(m.editor().dataset.commandHint, '[focus]');
  } finally {
    await m.unmount();
  }
});
