// src/components/harnessPicker/rows.tsx HarnessRow: a not-ready local row whose action is pressable is not aria-disabled around it (#5117); a row with nothing to press stays aria-disabled.
import { test, assert, $, $$, click, mount, fx, last, createElement, ModelPicker, store } from './support/harness-picker-ui/fixture.ts';

const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label))!;
const disabledAncestor = (el: Element) => {
  for (let n: Element | null = el; n; n = n.parentElement) if (n.getAttribute('aria-disabled') === 'true') return n;
  return null;
};

async function open() {
  store.set({ harnessOf: { c: 'claude' } });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await click($('[aria-label="Select model"]'));
  await click($('[aria-label="Select harness and model"]'));
  return m;
}

test('a signed-out row: Sign in has no aria-disabled ancestor, the row is marked data-disabled, and a click signs in', async () => {
  fx.status = { codex: { state: 'signin' } };
  const m = await open();
  try {
    const row = rowOf('Codex');
    const button = $('.hp-mini.primary', row)!;
    assert.ok(button);
    assert.equal(disabledAncestor(button), null);
    assert.equal(row.hasAttribute('data-disabled'), true);
    assert.equal(row.hasAttribute('aria-disabled'), false);
    await click(button);
    assert.equal(last('signIn:codex')?.[0], 'signIn:codex');
  } finally {
    await m.unmount();
  }
});

test('a missing row has nothing to press and stays aria-disabled', async () => {
  fx.status = { codex: { state: 'missing' } };
  const m = await open();
  try {
    const row = rowOf('Codex');
    assert.equal($$('button', row).length, 0);
    assert.equal(row.getAttribute('aria-disabled'), 'true');
    assert.equal(row.hasAttribute('data-disabled'), false);
  } finally {
    await m.unmount();
  }
});
