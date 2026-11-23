// Harness picker tuning UI cases using shared DOM, harness mocks, and picker state.
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
  defined,
  events,
  store,
  fx,
  createElement,
  ModelPicker,
  openPicker,
  last,
} from './fixture.ts';

export function registerTuning() {
  test('effort: slider by pointer and arrow keys, clamped to the model', async () => {
    fx.sel = { ...fx.sel, efforts: ['low', 'medium', 'high'], effort: 'medium' };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openPicker();
    const track = $('.effort-track');
    assert.equal(track.getAttribute('aria-valuenow'), '1');
    (track as any).getBoundingClientRect = () => ({ left: 0, width: 228, top: 0, height: 10, right: 228, bottom: 10 });
    const captured: number[] = [];
    (track as any).setPointerCapture = (id: number) => captured.push(id);
    await fire(track, new (window as any).PointerEvent('pointerdown', { bubbles: true, clientX: 214, pointerId: 3 }));
    assert.deepEqual(last('selection'), ['selection', 'codex', { effort: 'high' }, null]);
    assert.deepEqual(captured, [3]);
    await fire(track, new (window as any).PointerEvent('pointermove', { bubbles: true, clientX: 14, buttons: 0 }));
    assert.deepEqual(defined(last('selection'))[2], { effort: 'high' });
    await fire(track, new (window as any).PointerEvent('pointermove', { bubbles: true, clientX: -500, buttons: 1 }));
    assert.deepEqual(defined(last('selection'))[2], { effort: 'low' });
    const pop = $('.effort-pop');
    await fire(pop, new (window as any).KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.deepEqual(defined(last('selection'))[2], { effort: 'high' });
    await fire(pop, new (window as any).KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    assert.deepEqual(defined(last('selection'))[2], { effort: 'low' });
    await fire(pop, new (window as any).KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    assert.equal(events.filter((e) => e[0] === 'selection').length, 4);
    // an effort the model doesn't list counts as the first; a track without capture still works
    fx.sel = { ...fx.sel, effort: 'ultra' };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal($('.effort-track').getAttribute('aria-valuenow'), '0');
    delete (track as any).setPointerCapture;
    (window as any).HTMLElement.prototype.setPointerCapture = undefined;
    await fire($('.effort-track'), new (window as any).PointerEvent('pointerdown', { bubbles: true, clientX: 114 }));
    assert.deepEqual(defined(last('selection'))[2], { effort: 'medium' });
    await m.unmount();
  });

  test('effort: none to choose shows Default and why; keys change nothing', async () => {
    fx.sel = { ...fx.sel, efforts: [], effort: null };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openPicker();
    assert.equal($('.effort-name').textContent, 'Default');
    assert.equal($('.hp-no-effort').textContent, 'This model has no effort levels');
    await fire($('.effort-pop'), new (window as any).KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(last('selection'), undefined);
    fx.sel = { ...fx.sel, model: null, efforts: ['high'], effort: 'high' };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal($('.effort-name').textContent, 'High');
    assert.equal($('.hp-no-effort').textContent, '');
    await m.unmount();
  });

  test('Fast: toggles fast mode or the first tier, explains itself, and is off where unavailable', async () => {
    fx.fastNote = 'billed 2x';
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openPicker();
    const fast = () => $('[aria-label="Toggle fast mode"]');
    await click(fast());
    assert.deepEqual(last('selection'), ['selection', 'codex', { fast: true }, null]);
    await mouse(fast().parentElement!, 'mouseover');
    await flush(460, 1);
    assert.equal($('.tooltip').textContent, 'Enable fast mode · billed 2x');
    await mouse(fast().parentElement!, 'mouseout');
    fx.sel = { ...fx.sel, fast: true, tiers: [{ id: 'priority', name: 'Priority' }], tier: 'priority' };
    fx.fastNote = null;
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.match(fast().className, /on/);
    await click(fast());
    assert.deepEqual(defined(last('selection'))[2], { tier: null });
    await mouse(fast().parentElement!, 'mouseover');
    await flush(460, 1);
    assert.equal($('.tooltip').textContent, 'Disable fast mode');
    await mouse(fast().parentElement!, 'mouseout');
    fx.sel = { ...fx.sel, fast: false };
    await m.render(createElement(ModelPicker, { threadId: null }));
    await click(fast());
    assert.deepEqual(defined(last('selection'))[2], { tier: 'priority' });
    fx.sel = { ...fx.sel, fastUnavailable: 'Not on this plan' };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal((fast() as HTMLButtonElement).disabled, true);
    await mouse(fast().parentElement!, 'mouseover');
    await flush(460, 1);
    assert.equal($('.tooltip').textContent, 'Not on this plan');
    await mouse(fast().parentElement!, 'mouseout');
    // an account or harness that can't have Fast has no toggle; a spacer keeps the title centred
    fx.sel = { ...fx.sel, fastUnavailable: 'Fast mode is billed to extra usage, which is turned off for this account', fastHidden: true };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(fast(), null);
    assert.equal($('.effort-head').children.length, 3);
    assert.equal($('.effort-head > span.effort-icon-btn')?.getAttribute('aria-hidden'), 'true');
    await m.unmount();
    fx.sel = { ...fx.sel, fastHidden: false };
    // a harness with its own Fast wording
    store.set({ newHarness: 'claude' });
    fx.sel = { ...fx.sel, fastUnavailable: null };
    const m2 = await mount(createElement(ModelPicker, { threadId: null }));
    await openPicker();
    await mouse(fast().parentElement!, 'mouseover');
    await flush(460, 1);
    assert.equal($('.tooltip').textContent, 'Claude fast tip');
    await m2.unmount();
  });

  test('tiers: several are listed as a speed choice', async () => {
    fx.sel = {
      ...fx.sel,
      tiers: [
        { id: 'flex', name: 'Flex', description: 'Cheaper' },
        { id: 'priority', name: 'Priority' },
      ],
      tier: 'flex',
    };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await openPicker();
    const radios = $$('.hp-tiers [role=radio]');
    assert.deepEqual(
      radios.map((r) => [r.textContent, r.getAttribute('aria-checked')]),
      [
        ['StandardDefault speed and rate', 'false'],
        ['FlexCheaper', 'true'],
        ['Priority', 'false'],
      ],
    );
    await click(radios[0]);
    assert.deepEqual(defined(last('selection'))[2], { tier: null });
    await click(radios[2]);
    assert.deepEqual(defined(last('selection'))[2], { tier: 'priority' });
    fx.sel = { ...fx.sel, fastUnavailable: 'no' };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.ok(!$('.hp-tiers'));
    await m.unmount();
  });

  test("a route the harness's own config sets: the pill's mark and the header's provider, unless MoPilot chose the provider", async () => {
    fx.routes = {
      codex: {
        harness: 'codex',
        kind: 'external',
        router: { id: 'magpie', label: 'magpie' },
        label: 'magpie',
        endpoint: 'http://127.0.0.1:3425',
        reasons: ['router'],
        file: null,
        stale: { running: 0, idle: 0 },
        effects: [],
      },
    };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    assert.equal($('.route-mark')!.textContent, '⇄ magpie');
    assert.match($('.route-mark')!.getAttribute('title')!, /^Requests from Codex go through magpie at 127\.0\.0\.1:3425/);
    await openPicker();
    assert.equal($('.effort-model').textContent, ' Codex · magpie · Old ');
    await m.unmount();
    // a provider MoPilot chose for the chat is the route: no mark, and the header names it
    fx.provider = { label: 'OpenRouter', firstParty: false };
    const n = await mount(createElement(ModelPicker, { threadId: 'c' }));
    assert.equal($('.route-mark'), null);
    await openPicker();
    assert.equal($('.effort-model').textContent, ' Codex · OpenRouter · Old ');
    await n.unmount();
    fx.routes = {};
  });

  test('reset to default resets only the effort, to the model default, and keeps the model', async () => {
    fx.provider = { label: 'OpenRouter' };
    fx.sel = { ...fx.sel, effort: 'low', fast: true };
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await openPicker();
    assert.equal($('.effort-model').textContent, ' Codex · OpenRouter · Old ');
    await click($('[aria-label="Reset to default"]'));
    // the model's own default effort, not null: a Codex chat would fall back to its thread's effort
    assert.deepEqual(last('selection'), ['selection', 'codex', { effort: 'high' }, 'c']);
    // a model the list doesn't know has no default to go back to
    fx.sel = { ...fx.sel, model: null };
    await m.render(createElement(ModelPicker, { threadId: 'c' }));
    await click($('[aria-label="Reset to default"]'));
    assert.deepEqual(last('selection'), ['selection', 'codex', { effort: null }, 'c']);
    assert.equal($('.hp-scope'), null);
    assert.equal(last('makeDefault'), undefined);
    assert.deepEqual(defined(events.find((e) => e[0] === 'caps')).slice(1), ['c', { kind: 'codex', model: 'old' }]);
    await m.unmount();
  });
}
