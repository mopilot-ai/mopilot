// Every harness gets a single usage control after the model picker, with plan limits only for its serving harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { Composer, reset, store } from './support/composer-setup.ts';
import { composerUsageWindows } from './support/composer-child-stubs.ts';
import { contextUsageKey } from '../src/store/contextUsage.ts';

const { MomoModelSlot } = await import('../src/components/momo/useMomoChat.ts');

test('the context ring immediately follows the model selection on every harness', async () => {
  for (const [harness, momo] of [
    ['codex', false],
    ['claude', false],
    ['acp:opencode', false],
    ['codex', true],
  ] as const) {
    reset();
    composerUsageWindows.codex = [{ label: '5h', usedPercent: 20, resetsAt: null }];
    composerUsageWindows.claude = [{ label: 'Weekly', usedPercent: 50, resetsAt: null }];
    const segments = { chat: [{ harness, nativeId: `${harness}:native` }] };
    store.set({
      harnessOf: { chat: harness },
      basicOf: harness.startsWith('acp:') ? { chat: 'opencode' } : {},
      momoChats: momo ? { chat: 'main' } : {},
      segments,
      runtime: {
        chat: {
          turns: [],
          tokenUsage: { last: { totalTokens: 20_000 }, modelContextWindow: 200_000 },
          tokenUsageOwner: contextUsageKey(segments.chat as any, 'chat'),
        },
      },
    });
    const m = await mount(
      h(MomoModelSlot.Provider, { value: h('span', { className: 'stub-model' }) }, h(Composer, { threadId: 'chat', variant: 'thread' })),
    );
    try {
      const model = document.querySelector('.composer-right .stub-model');
      const ring = document.querySelector('.composer-right .context-ring');
      assert.ok(model, harness);
      assert.ok(ring, harness);
      const plan =
        momo || harness.startsWith('acp:')
          ? ''
          : harness === 'codex'
            ? '. Plan usage: 5-hour limit, 20% used'
            : '. Plan usage: Weekly · All models, 50% used';
      assert.equal(ring.getAttribute('aria-label'), `Context: 10% used, 20k of 200k tokens${plan}`, `${harness}${momo ? ' (MoMo)' : ''}`);
      assert.equal(ring.closest('.tooltip-anchor')!.previousElementSibling, model, `${harness}: ring immediately follows model`);
      assert.equal(document.querySelectorAll('.composer-right .context-ring, .composer-right .usage-chip').length, 1, harness);
    } finally {
      await m.unmount();
      delete composerUsageWindows.codex;
      delete composerUsageWindows.claude;
    }
  }
});
