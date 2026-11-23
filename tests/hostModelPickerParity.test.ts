// A machine chat's model picker as This Mac's (audit L36-L38): the Limited badge of a basic agent, Install on a missing agent's row for new and started chats, and the model-picker shortcut opening it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const MODEL = { id: 'remote', name: 'Remote model', default: true, efforts: ['low', 'high'], defaultEffort: 'low' };
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any = { newChatHost: pick, chatConfig: {} };
let machines: any[] = [];
let basic: string | null = 'host-claude';
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: () => undefined,
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => basic });
mockSource('src/store/projects.ts', { setChatConfig: () => undefined });
mockSource('src/store/panes.ts', { navigate: () => undefined });
const mark = (text = '') => ({
  type: 'span',
  props: { className: 'mark', children: text },
  key: null,
  ref: null,
  $$typeof: Symbol.for('react.transitional.element'),
});
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: () => mark(),
  BasicHarnessIcon: () => mark(),
  BasicBadge: () => mark('Limited'),
});
mockSource('src/store/session/useSession.ts', { useSessionField: () => null, setSession: async () => undefined });
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: () => null,
  switchMachineChat: async () => null,
  dropMachineSwitch: async () => undefined,
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => ({ pick, want: 'claude', choice: { harness: 'claude' } }),
});
const fake = fakeNative({
  host: {
    access: async () => true,
    installAgent: async (id: string, harness: string) => ({ hostId: id, harness, state: 'queued', line: '', error: null, version: null }),
  },
});
installNative(fake);
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');
const { dispatchComposerCommand } = await import('../src/lib/shortcutFocus.ts');

const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label))!;
function reset(installable: string[] = ['codex']) {
  basic = 'host-claude';
  state = { newChatHost: pick, chatConfig: {} };
  machines = [
    {
      id: 'box',
      name: 'Box',
      installable,
      agents: [
        { id: 'claude', label: 'Claude Code', state: 'ready', models: [MODEL] },
        { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on Box' },
        { id: 'custom', label: 'Custom', state: 'ready', models: [{ ...MODEL, id: 'custom-model' }] },
      ],
    },
  ];
}
const withShell = (child: any) => h('div', { 'data-composer-chat': 'a', 'data-composer-main': 'true' }, child);
const listButton = () => $('button[aria-label="Select harness and model"]');

test('L37: only a basic agent wears the Limited badge in the harness list, as on This Mac', async () => {
  reset();
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    await click($('button[aria-label="Select model"]'));
    await click(listButton());
    assert.equal(rowOf('Custom').textContent!.includes('Limited'), true);
    assert.equal(rowOf('Claude Code').textContent!.includes('Limited'), false);
    assert.equal(rowOf('Codex').textContent!.includes('Limited'), false);
  } finally {
    await m.unmount();
  }
});

test('L36: a missing agent the machine installs has Install on its row, for a new chat and a started chat; one it cannot install has none', async () => {
  for (const threadId of [null, 'c']) {
    reset();
    const m = await mount(withShell(h(HostModelPicker, { threadId, hostId: 'box' })));
    try {
      await click($('button[aria-label="Select model"]'));
      await click(listButton());
      const install = $$('.hp-mini', rowOf('Codex')).find((b) => b.textContent === 'Install on Box');
      assert.ok(install, `Install on Box for threadId=${threadId}`);
      assert.equal($$('.hp-mini', rowOf('Claude Code')).length, 0);
      await click(install);
      assert.deepEqual(fake.callsTo('host.installAgent').pop(), ['box', 'codex']);
    } finally {
      await m.unmount();
    }
  }
  reset([]);
  const m = await mount(withShell(h(HostModelPicker, { threadId: 'c', hostId: 'box' })));
  try {
    await click($('button[aria-label="Select model"]'));
    await click(listButton());
    assert.equal($$('.hp-mini', rowOf('Codex')).length, 0);
    assert.match(rowOf('Codex').textContent!, /Install Codex on Box\./);
  } finally {
    await m.unmount();
  }
});

test('L38: the model-picker shortcut opens the machine chat picker, on the harness list when the chat has no usable model', async () => {
  reset();
  const m = await mount(withShell(h(HostModelPicker, { threadId: null, hostId: 'box' })));
  try {
    assert.equal($('.effort-pop'), null);
    await act(async () => dispatchComposerCommand('open-model-picker'));
    assert.ok($('.effort-pop'), 'a chat with a model opens on its effort panel, as a click does');
  } finally {
    await m.unmount();
  }
  reset();
  state.chatConfig.c = { hostSelection: { hostId: 'box', harness: 'claude', model: 'gone', effort: 'high' } };
  const gone = await mount(withShell(h(HostModelPicker, { threadId: 'c', hostId: 'box' })));
  try {
    await act(async () => dispatchComposerCommand('open-model-picker'));
    assert.equal($$('.hp-row').length, 3, 'a model the machine no longer has opens on the harness list');
  } finally {
    await gone.unmount();
  }
});
