// Auto in the composer's pickers (src/harness/autoRoute.ts, FirstTierPicker, BasicPicker, rows.tsx): the Auto model row
// and the Auto (all harnesses) row, what the model button says in Auto, and a pick by hand ending it, in a chat and for new chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stubSlice } from './support/stubs.ts';

let storeRef: any;
const configs: any[] = [];
stubSlice('src/store/projects.ts', {
  setChatConfig: (id: string, patch: any) => {
    configs.push([id, patch]);
    storeRef.set((s: any) => ({ chatConfig: { ...s.chatConfig, [id]: { ...s.chatConfig?.[id], ...patch } } }));
  },
});
const f = await import('./support/harness-picker-ui/fixture.ts');
const {
  $,
  $$,
  click,
  flush,
  mount,
  mouse,
  store,
  fx,
  events,
  createElement,
  ModelPicker,
  openPicker,
  openHarnesses,
  row,
  item,
  last,
  EMPTY_SESSION,
} = f;
storeRef = store;
const { autoButtonLabel, autoModelRow } = await import('../src/session/harness/autoRoute.ts');

const modelsList = () => $$('.hp-models .menu-item').map((x) => x.textContent);
const globalRow = () => $$('.menu-item').find((x) => x.textContent!.startsWith('Auto (all harnesses)'))!;
const label = () => $('[aria-label="Select model"] .model-name').textContent;
const effortShown = () => $('[aria-label="Select model"] .model-effort')?.textContent ?? null;
const lastConfig = () => configs.at(-1);

test('in a chat, Auto leads its own harness’s models; picking it turns Auto on', async () => {
  configs.length = 0;
  store.set({ harnessOf: { c: 'codex' }, chatConfig: {} });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await openHarnesses();
  assert.deepEqual(modelsList(), ['Auto', 'Default (recommended)', 'Old', 'New']);
  assert.equal(item('Auto').getAttribute('aria-checked'), 'false');
  await click(item('Auto'));
  assert.deepEqual(lastConfig(), ['c', { autoRoute: 'harness' }]);
  assert.ok(!$('.hp-models'), 'the picker closes');
  await m.unmount();
});

test('in Auto the button names the model the last message ran on, the effort panel says Auto picks it', async () => {
  store.set({ harnessOf: { c: 'codex' }, chatConfig: { c: { autoRoute: 'harness' } } });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  assert.equal(label(), 'Auto');
  assert.equal(effortShown(), null);
  store.set({ sessions: { c: { ...EMPTY_SESSION, autoRoute: { mode: 'harness', model: 'new', effort: 'high', at: 1 } } } });
  await flush();
  assert.equal(label(), 'Auto · New');
  assert.equal(effortShown(), 'High');
  store.set({ sessions: { c: { ...EMPTY_SESSION, autoRoute: { mode: 'harness', model: 'new', at: 2 } } } });
  await flush();
  assert.equal(effortShown(), null);
  store.set({ sessions: { c: { ...EMPTY_SESSION, autoRoute: { mode: 'harness', fallback: true, reason: 'x', at: 3 } } } });
  await flush();
  assert.equal(label(), 'Auto');
  assert.equal(effortShown(), null);
  await openPicker();
  assert.match(document.body.textContent!, /Auto picks the effort for each message/);
  await openHarnesses();
  assert.equal(item('Auto').getAttribute('aria-checked'), 'true');
  assert.equal(item('Default (recommended)').getAttribute('aria-checked'), 'false');
  // a model picked by hand ends Auto
  configs.length = 0;
  await click(item('Old'));
  assert.deepEqual(configs[0], ['c', { autoRoute: null }]);
  assert.equal(last('selection')?.[2].model, 'old');
  await m.unmount();
});

test('Auto (all harnesses) leads the harness list, and cancels a waiting switch', async () => {
  configs.length = 0;
  store.set({
    harnessOf: { c: 'codex' },
    chatConfig: {},
    sessions: { c: { ...EMPTY_SESSION, pendingSwitch: { harness: 'claude', model: 'new', modelLabel: 'New', effort: null } } },
  });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await openHarnesses();
  assert.equal(globalRow().getAttribute('aria-checked'), 'false');
  // the switch target's models offer no Auto: Auto belongs to the harness the chat is on
  assert.ok(!modelsList().includes('Auto'));
  await mouse(row('Codex'), 'mousemove');
  await flush();
  assert.equal(modelsList()[0], 'Auto');
  await click(item('Auto'));
  assert.deepEqual(last('session'), ['session', 'c', { pendingSwitch: null }]);
  assert.deepEqual(lastConfig(), ['c', { autoRoute: 'harness' }]);
  // a switch waiting again is cancelled by Auto (all harnesses) too
  store.set({ sessions: { c: { ...EMPTY_SESSION, pendingSwitch: { harness: 'claude', model: 'new', modelLabel: 'New', effort: null } } } });
  events.length = 0;
  await openHarnesses();
  await click(globalRow());
  assert.deepEqual(last('session'), ['session', 'c', { pendingSwitch: null }]);
  assert.deepEqual(lastConfig(), ['c', { autoRoute: 'global' }]);
  await openHarnesses();
  assert.equal(globalRow().getAttribute('aria-checked'), 'true');
  assert.equal(label(), 'Auto');
  await m.unmount();
  // without a waiting switch nothing is cancelled
  store.set({ sessions: {}, chatConfig: {} });
  const n = await mount(createElement(ModelPicker, { threadId: 'c' }));
  events.length = 0;
  await openHarnesses();
  await click(globalRow());
  assert.equal(last('session'), undefined);
  await n.unmount();
});

test('for new chats Auto is a pref, and picking it on another harness picks that harness for the draft', async () => {
  store.set({ prefs: { modelScopeHintSeen: true } });
  const m = await mount(createElement(ModelPicker, { threadId: null }));
  await openHarnesses();
  await click(item('Auto'));
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: 'harness' }]);
  assert.equal(last('pick'), undefined);
  await openHarnesses();
  await mouse(row('Claude Code'), 'mousemove');
  await flush();
  await click(item('Auto'));
  assert.deepEqual(last('pick'), ['pick', 'claude']);
  await openHarnesses();
  await click(globalRow());
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: 'global' }]);
  // a model picked by hand for new chats ends it
  await openHarnesses();
  await click(item('Old'));
  assert.deepEqual(events.filter((e) => e[0] === 'prefs').at(-1), ['prefs', { autoRouteNewChats: null }]);
  await m.unmount();
});

test('a MoMo chat offers neither Auto row', async () => {
  store.set({ harnessOf: { c: 'codex' }, momoModels: { c: { model: 'old' } }, chatConfig: {} });
  const m = await mount(createElement(ModelPicker, { threadId: 'c' }));
  await openHarnesses();
  assert.ok(!modelsList().includes('Auto'));
  assert.equal(globalRow(), undefined);
  await m.unmount();
  store.set({ momoModels: {} });
});

const CATALOG = {
  modes: null,
  configOptions: [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'p/a',
      options: [
        { value: 'p/a', name: 'Model A' },
        { value: 'p/b', name: 'Model B' },
      ],
    },
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
  ],
};

test('a basic harness: Auto leads its model values, a pick by hand ends it, and Auto (all harnesses) leads its list', async () => {
  store.set((s: any) => ({
    newBasic: 'opencode',
    basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: CATALOG }],
    prefs: { ...s.prefs, autoRouteNewChats: null },
  }));
  const m = await mount(createElement(ModelPicker, { threadId: null }));
  assert.equal(label(), 'Model A');
  await click($('[aria-label="Select model"]'));
  const autoRow = () => $$('.menu-item').find((x) => x.textContent!.startsWith('AutoPicks the model'))!;
  assert.equal(autoRow().getAttribute('aria-checked'), 'false');
  assert.equal(item('Model A').getAttribute('aria-checked'), 'true');
  await click(autoRow());
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: 'harness' }]);
  assert.equal(label(), 'Auto');
  await click($('[aria-label="Select model"]'));
  // in Auto the agent's current value is a turn's pick, not the chat's choice
  assert.equal(autoRow().getAttribute('aria-checked'), 'true');
  assert.equal(item('Model A').getAttribute('aria-checked'), 'false');
  // an effort pick keeps Auto; a model pick ends it
  events.length = 0;
  await click(item('High'));
  assert.ok(!events.some((e) => e[0] === 'prefs' && 'autoRouteNewChats' in e[1]));
  await click(item('Model B'));
  await flush();
  assert.ok(events.some((e) => e[0] === 'prefs' && e[1].autoRouteNewChats === null));
  // a choice keeps the menu open
  await click(globalRow());
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: 'global' }]);
  if (!globalRow()) await click($('[aria-label="Select model"]'));
  assert.equal(globalRow().getAttribute('aria-checked'), 'true');
  // another harness picked by hand for new chats ends it
  await click(row('Codex'));
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: null }]);
  assert.deepEqual(last('pick'), ['pick', 'codex']);
  await m.unmount();
});

test('on a first-tier harness, a basic agent picked by hand ends Auto (all harnesses)', async () => {
  store.set((s: any) => ({
    newBasic: null,
    newHarness: 'codex',
    basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: CATALOG }],
    prefs: { ...s.prefs, autoRouteNewChats: 'global' },
  }));
  const m = await mount(createElement(ModelPicker, { threadId: null }));
  await openHarnesses();
  await click(row('Opencode'));
  assert.deepEqual(last('prefs'), ['prefs', { autoRouteNewChats: null }]);
  assert.deepEqual(last('pick'), ['pick', 'acp:opencode']);
  await m.unmount();
  // without Auto (all harnesses) on, the pick changes no Auto setting
  store.set((s: any) => ({ prefs: { ...s.prefs, autoRouteNewChats: null } }));
  events.length = 0;
  const n = await mount(createElement(ModelPicker, { threadId: null }));
  await openHarnesses();
  await click(row('Opencode'));
  assert.ok(!events.some((e) => e[0] === 'prefs' && 'autoRouteNewChats' in e[1]));
  await n.unmount();
  store.set({ basicHarnesses: [] });
});

test('a chat waiting on a switch to a basic harness: Auto (all harnesses) cancels the switch', async () => {
  configs.length = 0;
  store.set({
    harnessOf: { b: 'codex' },
    basicHarnesses: [{ id: 'opencode', state: 'admitted', catalog: CATALOG }],
    chatConfig: {},
    sessions: { b: { ...EMPTY_SESSION, pendingSwitch: { harness: 'acp:opencode', model: '', modelLabel: '', effort: null } } },
  });
  const m = await mount(createElement(ModelPicker, { threadId: 'b' }));
  await click($('[aria-label="Select model"]'));
  await click(globalRow());
  assert.deepEqual(last('session'), ['session', 'b', { pendingSwitch: null }]);
  assert.deepEqual(lastConfig(), ['b', { autoRoute: 'global' }]);
  await m.unmount();
  store.set({ sessions: {} });
});

test('the Auto row and button label', () => {
  assert.deepEqual(autoModelRow(), { id: '@auto', label: 'Auto', efforts: [], defaultEffort: null, fast: false, more: false });
  assert.equal(autoButtonLabel(null), 'Auto');
  assert.equal(autoButtonLabel({ mode: 'harness', model: 'gpt-5.5-mini', at: 1 }), 'Auto · GPT-5.5 Mini');
  assert.equal(autoButtonLabel({ mode: 'harness', model: 'old', at: 1 }, [{ id: 'old', label: 'Old' } as any]), 'Auto · Old');
  void fx;
});
