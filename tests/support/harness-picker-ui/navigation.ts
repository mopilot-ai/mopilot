// Harness picker navigation UI cases using shared DOM, harness mocks, and picker state.
import {
  test,
  assert,
  $,
  $$,
  click,
  fire,
  flush,
  mount,
  mouse,
  events,
  store,
  fx,
  createElement,
  ModelPicker,
  models,
  openPicker,
  openHarnesses,
  row,
  item,
  last,
  key,
  sub,
} from './fixture.ts';

export function registerNavigation() {
  test('an empty model list still loading shows a loading row, not "no models"', async () => {
    // Codex left idle starts on the first listing, and its list arrives after it reads as ready
    fx.models = { codex: [], claude: models };
    fx.loading = { codex: true };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    const loading = () => $('.popover-layer .hp-models-loading');
    assert.equal(loading()?.getAttribute('role'), 'status');
    assert.equal(loading()?.getAttribute('aria-busy'), 'true');
    assert.match(loading()!.textContent!, /Loading models…/);
    assert.ok(loading()!.querySelector('.spinner'));
    assert.equal($('.popover-layer .hp-models-empty'), null);
    // loaded and still empty: it says none are listed and points to the harness's page
    fx.loading = { codex: false };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(loading(), null);
    assert.equal($('.popover-layer .hp-models-empty .menu-desc')!.textContent, 'No models listed');
    await m.unmount();
  });

  test('the harness list: statuses, sign-in, the current harness, back, and Manage harnesses', async () => {
    fx.enabled = ['codex', 'claude'];
    fx.status = { codex: { state: 'detecting' }, claude: { state: 'signin' } };
    store.set({ basicHarnesses: [{ id: 'kimi', state: 'admitted' }] });
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.match(row('Codex').textContent!, /Checking…/);
    assert.equal(row('Codex').getAttribute('aria-disabled'), 'true');
    assert.ok(row('Codex').querySelector('.menu-check svg'));
    assert.match(row('Claude Code').textContent!, /Signed out/);
    await click(row('Claude Code').querySelector('.hp-mini'));
    assert.deepEqual(last('signIn:claude'), ['signIn:claude', null]);
    // the current harness's models show; a disabled row doesn't take over the flyout
    // the flyout names its harness to assistive tech; its headings don't repeat the harness row beside it
    const flyout = (h: string) => $(`.popover-layer [role=menu][aria-label="${h}"]`);
    assert.match(flyout('Codex')!.textContent!, /Models/);
    await mouse(row('Claude Code'), 'mousemove');
    await click(row('Claude Code'));
    assert.ok(!flyout('Claude Code'));
    assert.deepEqual(
      events
        .filter((e) => e[0] === 'ensure')
        .map((e) => e[1])
        .sort(),
      ['claude', 'codex'],
    );
    await click($('.hp-back'));
    assert.ok($('.effort-pop'));
    await click($('[aria-label="Select harness and model"]'));
    await click(item('Manage harnesses…'));
    assert.deepEqual(last('navigate'), ['navigate', { name: 'settings', section: 'harnesses' }]);
    assert.ok(!$('.popover-layer'));
    await m.unmount();
  });

  test("the picker pops open as Codex's does; changing view inside it slides the sections in instead", async () => {
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    const layer = (sel: string) => $(sel).closest('.popover-layer')!.className.trim();
    await openPicker();
    assert.equal(layer('.effort-pop'), 'popover-layer picker');
    await openHarnesses();
    assert.equal(layer('.hp-harnesses'), 'popover-layer picker picker-view');
    // back to the effort panel: a change of view, not a fresh open
    await click($('.hp-back'));
    assert.equal(layer('.effort-pop'), 'popover-layer picker picker-view');
    // closed and opened again, it pops open afresh
    await openPicker();
    assert.ok(!$('.effort-pop'));
    await openPicker();
    assert.equal(layer('.effort-pop'), 'popover-layer picker');
    await m.unmount();
  });

  test('harness rows: missing, error and usage lines', async () => {
    fx.status = { codex: { state: 'missing' }, claude: { state: 'error', error: 'boom\nstack' } };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.match(row('Codex').textContent!, /Not installedInstall codex/);
    assert.match(row('Claude Code').textContent!, /ErrorBoom|Errorboom/);
    fx.status = { claude: { state: 'error' } };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(row('Claude Code').querySelector('.menu-desc')!.textContent, '');
    fx.status = {};
    fx.accounts.codex = { active: sub('a1', 'one@x.test', { left: 62 }), accounts: [sub('a1', 'one@x.test', { left: 62 })] };
    await m.render(createElement(ModelPicker, { threadId: null }));
    // the short form of the account view's status, the same as the profile menu's
    assert.match(row('Codex').textContent!, /62% left/);
    assert.doesNotMatch(row('Claude Code').textContent!, /% left/);
    await m.unmount();
  });

  test('models: current one checked, descriptions on hover, older versions folded, none listed', async () => {
    fx.models.codex = [models[0], models[1], { id: 'v1', label: 'V1', efforts: [], defaultEffort: null, more: true }];
    fx.models.claude = [];
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.match(row('Codex').className, /open/);
    const list = () => $$('.hp-models .menu-item').map((x) => x.textContent);
    assert.deepEqual(list(), ['Automatic', 'Old', 'New', 'More versions']);
    assert.ok(item('Old').querySelector('svg'));
    await click(item('More versions'));
    assert.deepEqual(list(), ['Automatic', 'Old', 'New', 'More versions', 'V1']);
    await click(item('More versions'));
    assert.deepEqual(list(), ['Automatic', 'Old', 'New', 'More versions']);
    await mouse(item('New').parentElement!, 'mouseover');
    await flush(260, 1);
    assert.equal($('.tooltip').textContent, 'The newest');
    // a row sliding under a still pointer (Chromium's mouseover with no move) keeps the open flyout
    await mouse(row('Claude Code'), 'mouseover');
    assert.equal($$('.popover-layer .menu').at(-1)!.getAttribute('aria-label'), 'Codex');
    await mouse(row('Claude Code'), 'mousemove');
    assert.equal($$('.popover-layer .menu').at(-1)!.getAttribute('aria-label'), 'Claude Code');
    assert.match($$('.popover-layer .menu').at(-1)!.textContent!, /ModelsNo models listedSettings/);
    await m.unmount();
  });
}

export function registerKeyboard() {
  test('the models flyout closes on its own with an outside press', async () => {
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openHarnesses();
    assert.ok($('.hp-models'));
    await key(document.body, 'Escape');
    assert.ok(!$('.hp-models'));
    await m.unmount();
  });

  test('keyboard: the effort panel takes focus; the harness list and its models are menus the arrows, ArrowRight, Enter and ArrowLeft drive', async () => {
    fx.status = { claude: { state: 'signin' } };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    const press = (k: string) =>
      fire(document.activeElement!, new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    const lists = () => $$('.popover-layer [role=menu]');
    // the active row of the list that has focus
    const active = () => document.activeElement!.querySelector('.kbd-active')?.textContent;
    await openPicker();
    await flush();
    assert.equal(document.activeElement, $('.effort-pop'), 'its arrows and Tab work without the mouse');
    await openHarnesses();
    const harnesses = lists().find((l) => l.textContent!.includes('‹ Harness'))!;
    assert.equal(document.activeElement, harnesses);
    assert.ok(
      lists().some((l) => l.getAttribute('aria-label') === 'Codex'),
      "the current harness's models show beside it",
    );
    assert.notEqual(document.activeElement, lists().at(-1), 'without taking focus from the list');
    await press('ArrowDown');
    assert.equal(active(), '‹ Harness');
    await press('ArrowDown');
    assert.match(active()!, /^Codex/);
    // Claude can't be used yet: the keyboard skips its row and reaches its sign-in action
    await press('ArrowDown');
    assert.equal(active(), 'Sign in to claude');
    const signIn = row('Claude Code').querySelector('[role=menuitem]')!;
    assert.equal(
      signIn.closest('[aria-disabled]')!.getAttribute('aria-disabled'),
      'false',
      'sign-in remains enabled inside an unavailable harness group',
    );
    await press('Enter');
    assert.deepEqual(last('signIn:claude'), ['signIn:claude', null]);
    await press('ArrowUp');
    await press('ArrowRight');
    await flush();
    const models = lists().find((l) => l.getAttribute('aria-label') === 'Codex')!;
    assert.equal(document.activeElement, models, 'opened from the keyboard: the models take focus');
    await press('ArrowDown');
    await press('ArrowDown');
    assert.equal(active(), 'Automatic');
    await press('ArrowDown');
    assert.equal(active(), 'Old');
    await press('ArrowLeft');
    await flush();
    assert.equal(document.activeElement, harnesses, 'back to the harness list');
    assert.ok(!lists().some((l) => l.getAttribute('aria-label') === 'Codex'));
    assert.match(active()!, /^Codex/, 'its row stays active through the re-render that closed the models');
    await press('ArrowRight');
    await flush();
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    await press('ArrowDown');
    assert.equal(active(), 'New');
    await press('Enter');
    assert.deepEqual(last('selection'), ['selection', 'codex', { model: 'new', effort: 'high' }, null]);
    await m.unmount();
  });
}
