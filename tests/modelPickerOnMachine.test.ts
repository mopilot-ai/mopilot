// The composer's model button (ModelPicker): a new chat in a folder on a machine shows that machine's agents; a chat, or a new chat here, keeps its harness's own picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount, mockTsx } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let pick: any = null;
let owner: string | null = '';
mockSource('src/lib/hostChats.ts', { useHostChats: () => ({}), machineOfChat: () => owner });
let harness: { basic: string | null; harness: string | null } = { basic: null, harness: 'claude' };
mockSource('src/store/core.ts', { useStore: (sel: (s: unknown) => unknown) => sel({}) });
mockSource('src/store/projects.ts', { newChatHostPick: () => pick });
mockSource('src/session/useComposerHarness.ts', { useComposerHarness: () => harness });
const { createElement } = await import('react');
const stub = (name: string) => () => createElement('i', { 'data-picker': name });
mockTsx(new URL('../src/components/composer/HostModelPicker.tsx', import.meta.url), { HostModelPicker: stub('machine') });
mockTsx(new URL('../src/components/harnessPicker/FirstTierPicker.tsx', import.meta.url), { FirstTierPicker: stub('first') });
mockTsx(new URL('../src/components/harnessPicker/BasicPicker.tsx', import.meta.url), { BasicPicker: stub('basic') });
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: () => null,
  BasicHarnessIcon: () => null,
  BasicBadge: () => null,
  UsageMeters: () => null,
  signInHarness: () => null,
  ThreadHarnessBadge: () => null,
});
mockTsx(new URL('../src/components/harnessPicker/SwitchChip.tsx', import.meta.url), { SwitchChip: () => null });
const { ModelPicker } = await import('../src/components/harnessPicker/HarnessPicker.tsx');

const shown = (m: { host: Element }) => m.host.querySelector('[data-picker]')?.getAttribute('data-picker') ?? null;

test("a new chat on a machine folder shows the machine's agents; a chat or a local new chat keeps its own picker", async () => {
  pick = { id: 'box', name: 'box', path: '/p' };
  const m = await mount(createElement(ModelPicker, { threadId: null }));
  try {
    assert.equal(shown(m), 'machine');
    await m.render(createElement(ModelPicker, { threadId: 'c1' }));
    assert.equal(shown(m), 'first', 'a local chat keeps its harness picker');
    owner = 'box';
    await m.render(createElement(ModelPicker, { threadId: 'c1' }));
    assert.equal(shown(m), 'machine');
    owner = null;
    await m.render(createElement(ModelPicker, { threadId: 'c1' }));
    assert.equal(shown(m), null);
    assert.match(m.host.textContent!, /Reading machine/);
    owner = '';
    pick = null;
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(shown(m), 'first');
    harness = { basic: 'kimi', harness: null };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(shown(m), 'basic');
    harness = { basic: null, harness: null };
    await m.render(createElement(ModelPicker, { threadId: null }));
    assert.equal(shown(m), null);
  } finally {
    await m.unmount();
  }
});
