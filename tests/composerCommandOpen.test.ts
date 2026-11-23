// src/components/ui/useComposerCommandOpen.ts: a composer command (the model-picker shortcut, a limit note's Change brain in
// MoMo's chat) opens the control of the composer it is for, and no other composer's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, act, useState } from 'react';
import { render } from './support/shell-chrome-kit.ts';

const { useComposerCommandOpen } = await import('../src/components/ui/useComposerCommandOpen.ts');
const { dispatchComposerCommand } = await import('../src/lib/shortcutFocus.ts');

function Control({ name }: { name: string }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  useComposerCommandOpen('open-model-picker', { anchor, setOpen });
  return h('button', { ref: setAnchor, 'data-open': String(open) }, name);
}

test('the command opens the main composer’s control only; after unmounting nothing listens', async () => {
  const r = await render(
    h(
      'div',
      null,
      h('div', { 'data-composer-chat': 'a', 'data-composer-main': 'true' }, h(Control, { name: 'main' })),
      h('div', { 'data-composer-chat': 'b' }, h(Control, { name: 'side' })),
    ),
  );
  const state = () => [...r.host.querySelectorAll('button')].map((b) => `${b.textContent}:${b.dataset.open}`);
  assert.deepEqual(state(), ['main:false', 'side:false']);
  await act(async () => dispatchComposerCommand('open-model-picker'));
  assert.deepEqual(state(), ['main:true', 'side:false']);
  await r.unmount();
  await act(async () => void window.dispatchEvent(new Event('open-model-picker')));
});
