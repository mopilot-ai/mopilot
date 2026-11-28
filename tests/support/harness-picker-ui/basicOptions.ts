// Harness picker cases for a basic harness's own options before and inside a chat: the catalog on new-chat defaults,
// long value lists, the mode left to the permission slot, and choices that set the default or are refused.
import { test, assert, $, $$, click, flush, mount, EMPTY_SESSION, events, store, fx, createElement, ModelPicker, item } from './fixture.ts';

const MODELS = Array.from({ length: 12 }, (_, i) => ({ value: `p/m${i}`, name: `Model ${i}` }));
const CATALOG = {
  modes: null,
  configOptions: [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'p/m0', options: MODELS },
    {
      id: 'effort',
      name: 'Effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'low',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'high', name: 'High' },
      ],
    },
    {
      id: 'mode',
      name: 'Session Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'build',
      options: [{ value: 'build', name: 'build' }],
    },
  ],
};
const configEvents = () => events.filter((e) => e[0] === 'acpConfig');

export function registerBasicOptions() {
  test('provider-qualified model labels stay compact while full identity and wire values remain available', async () => {
    const full = 'OpenCode/Claude Haiku 5.5';
    const options = [{ value: 'opaque/provider/model-id', name: full }];
    store.set({
      newBasic: 'opencode',
      basicHarnesses: [
        {
          id: 'opencode',
          state: 'admitted',
          catalog: {
            configOptions: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: options[0].value, options }],
          },
        },
      ],
    });
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    const btn = $('[aria-label="Select model"]');
    assert.equal(btn.querySelector('.model-name')!.textContent, 'Claude Haiku 5.5');
    assert.equal(btn.getAttribute('title'), `Opencode · ${full}`);
    assert.ok(!btn.querySelector('.hp-badge'));
    await click(btn);
    assert.ok(item(full));
    await click(item(full));
    await flush();
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { config: { model: options[0].value } } });
    await m.unmount();
  });

  test('basic harness, new chat: its catalog on the defaults chosen for new chats, and a choice sets that default', async () => {
    store.set((s: any) => ({
      newBasic: 'opencode',
      basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: CATALOG }],
      // a default it no longer offers falls back to its own value
      prefs: { ...s.prefs, basicDefaults: { opencode: { config: { model: 'p/m3', effort: 'gone' } } } },
    }));
    // Chromium's scrollIntoView can answer with a promise: the list must not hand it to React as a cleanup
    const scrolled: string[] = [];
    const proto = (window as any).Element.prototype;
    const was = proto.scrollIntoView;
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this.textContent!);
      return Promise.resolve();
    };
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    const btn = $('[aria-label="Select model"]');
    assert.equal(btn.querySelector('.model-name')!.textContent, 'Model 3');
    await click(btn);
    // the current value is brought into view in the long list
    assert.deepEqual(scrolled, ['Model 3']);
    await click(btn);
    assert.ok(!$('.acp-values'));
    proto.scrollIntoView = was;
    await click(btn);
    // the mode is in the permission slot, not here
    assert.deepEqual(
      $$('.acp-config .hp-head').map((x) => x.textContent),
      ['Model', 'Effort', 'Harness'],
    );
    // a long list scrolls on its own; a short one doesn't
    assert.equal($$('.acp-values').length, 1);
    // the model's values, after Auto
    assert.equal($$('.acp-values .menu-item').length, 13);
    assert.match($$('.acp-values .menu-item')[0].textContent!, /^Auto/);
    assert.ok(item('Low').querySelector('svg'));
    assert.match(document.body.textContent!, /New Opencode chats start with these/);
    await click(item('High'));
    await flush();
    assert.equal(configEvents().length, 0);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { config: { model: 'p/m3', effort: 'high' } } });
    await m.unmount();
  });

  test('basic harness, in a chat: a choice applies to the chat and becomes the default; one it refuses changes neither', async () => {
    store.set((s: any) => ({
      basicOf: { c: 'opencode' },
      basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: CATALOG }],
      sessions: { c: { ...EMPTY_SESSION, acp: { configOptions: CATALOG.configOptions } } },
      prefs: { ...s.prefs, basicDefaults: {} },
    }));
    const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
    await click($('[aria-label="Select model"]'));
    await click(item('Model 5'));
    await flush();
    assert.deepEqual(configEvents().at(-1), ['acpConfig', 'c', 'model', 'p/m5']);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { config: { model: 'p/m5' } } });
    fx.acpRefuses = true;
    // the menu stays open for the next choice
    await click(item('Model 7'));
    await flush();
    assert.deepEqual(configEvents().at(-1), ['acpConfig', 'c', 'model', 'p/m7']);
    assert.deepEqual(store.get().prefs.basicDefaults, { opencode: { config: { model: 'p/m5' } } });
    await m.unmount();
  });

  test('basic harness that offers no options: no empty section, just the harness list', async () => {
    store.set({ newBasic: 'goose', basicHarnesses: [{ id: 'goose', state: 'admitted', catalog: null }] });
    const m = await mount(createElement(ModelPicker, { threadId: null }));
    await click($('[aria-label="Select model"]'));
    assert.ok(!$('.acp-config'));
    assert.deepEqual(
      $$('.hp-head').map((x) => x.textContent),
      ['Harness'],
    );
    await m.unmount();
  });
}
