// Real anchored layers give Goal and PR selection their initial keyboard focus after placement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { PrStackPicker } from '../src/components/thread/PrStackPicker';
import { mount } from './support/goal-pills.ts';
import { browserPopoverFocus } from './support/popover-focus.ts';

const placed = () => act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

test('Goal card takes focus after its real Popover becomes visible', async (t) => {
  browserPopoverFocus(t);
  const m = await mount(t);
  const trigger = m.pill();
  trigger.getBoundingClientRect = () => new window.DOMRect(24, 200, 180, 30);
  trigger.focus();
  await m.open();
  await placed();
  assert.equal(document.activeElement, m.card());
});

test('PR picker search takes focus after its real Popover becomes visible', async (t) => {
  browserPopoverFocus(t);
  const host = document.createElement('div');
  const trigger = document.createElement('button');
  trigger.getBoundingClientRect = () => new window.DOMRect(24, 200, 180, 30);
  document.body.append(host, trigger);
  trigger.focus();
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        h(PrStackPicker, {
          chatId: 'chat',
          url: 'https://github.com/o/r/pull/1',
          api: { stackCandidates: async () => [], stack: async () => {} } as any,
          anchor: trigger,
          onClose: () => {},
        }),
      ),
    );
    await placed();
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Find a parent pull request');
  } finally {
    await act(async () => root.unmount());
    host.remove();
    trigger.remove();
  }
});
