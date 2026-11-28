// The picker's model list while it has nothing to show (src/components/harnessPicker/rows.tsx ModelList): it reads as
// loading for MODELS_LOADING_MS at most, then says what to do: sign in for the chat, or the harness's Settings page. Opening
// it asks the harness for its list again.
import { mock } from 'node:test';
import { act } from 'react';
import {
  test,
  assert,
  $,
  click,
  mount,
  store,
  fx,
  createElement,
  ModelPicker,
  models,
  last,
  row,
  mouse,
  events,
  item,
  openHarnesses,
} from './support/harness-picker-ui/fixture.ts';

const { ModelList, MODELS_LOADING_MS } = await import('../src/components/harnessPicker/rows.tsx');
const { switchModel } = await import('../src/components/harnessPicker/applySwitch.ts');

test('an explicit Automatic switch does not inherit a newer pinned default', () => {
  fx.selFor = { codex: { model: 'new' } };
  assert.equal(switchModel('codex', null)?.id, '');
  assert.equal(switchModel('codex', 'new')?.id, 'new');
});

test('a MoMo composer offers explicit brain models and cannot clear its brain pin to Automatic', async () => {
  store.set({ harnessOf: { c: 'claude' }, momoModels: { c: 'old' } });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await openHarnesses();
  assert.ok(!$('.hp-models')!.textContent?.includes('Default (recommended)'));
  assert.ok(item('Old'));
  await click(item('New'));
  assert.equal(last('selection')?.[2].model, 'new');
  await m.unmount();
});

for (const h of ['codex', 'claude'] as const)
  test(`${h}: Automatic is checked separately from its effective model and can be selected after a pin`, async () => {
    store.set({ harnessOf: { c: h }, newHarness: h });
    fx.sel = { ...fx.sel, automatic: true };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openHarnesses();
    assert.equal(item('Default (recommended)').getAttribute('aria-checked'), 'true');
    assert.equal(item('Old').getAttribute('aria-checked'), 'false');
    await click(item('New'));
    assert.equal(last('selection')?.[2].model, 'new');
    fx.sel = { ...fx.sel, automatic: false };
    await openHarnesses();
    await click(item('Default (recommended)'));
    assert.deepEqual(last('selection')?.slice(0, 3), ['selection', h, { model: null, effort: 'high', fast: false }]);
    await m.unmount();
  });

test('an empty list reads as loading for MODELS_LOADING_MS, then points to Settings', async () => {
  fx.models = { codex: [], claude: models };
  fx.loading = { codex: true };
  store.set({ harnessOf: { c: 'codex' } });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  // the limit is armed when the empty list first renders, so the clock is the mock's from before the flyout opens
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    await click($('[aria-label="Select model"]'));
    await click($('[aria-label="Select harness and model"]'));
    await mouse(row('Codex'), 'mousemove');
    await act(async () => mock.timers.tick(MODELS_LOADING_MS - 1));
    assert.ok($('.hp-models-loading'), 'still loading just before the limit');
    await act(async () => mock.timers.tick(1));
    assert.equal($('.hp-models-loading'), null, 'after the limit the list stops spinning');
    assert.equal($('.hp-models-empty .menu-desc')!.textContent, 'No models listed');
    await click($('.hp-models-empty .hp-mini.primary'));
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'codex' }]);
  } finally {
    mock.timers.reset();
  }
  await m.unmount();
});

test('a signed-out harness with no models says to sign in, and its button signs in for the chat', async () => {
  fx.models = { codex: [], claude: [] };
  fx.status = { codex: { state: 'signin' } };
  const m = await mount(createElement(ModelList, { h: 'codex', chatId: 'c', currentModel: null, onPick: () => {} }));
  assert.equal($('.hp-models-empty .menu-desc')!.textContent, 'Sign in to see models');
  await click($('.hp-models-empty .hp-mini.primary'));
  assert.deepEqual(last('signIn:codex'), ['signIn:codex', 'c']);
  assert.equal(last('navigate'), undefined);
  await m.unmount();
});

test("opening a harness's model list asks that harness for it again, once per harness shown", async () => {
  store.set({ harnessOf: { c: 'codex' } });
  const asked = () => events.filter((e) => e[0] === 'refreshModels').map((e) => e[1]);
  const before = asked().length;
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await click($('[aria-label="Select model"]'));
  // the picker's own pane lists no models: nothing is asked yet
  assert.deepEqual(asked().slice(before), []);
  await click($('[aria-label="Select harness and model"]'));
  await mouse(row('Codex'), 'mousemove');
  assert.deepEqual(asked().slice(before), ['codex']);
  await mouse(row('Claude Code'), 'mousemove');
  assert.deepEqual(asked().slice(before), ['codex', 'claude']);
  await m.unmount();
});
