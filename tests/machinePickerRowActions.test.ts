// src/components/composer/HostModelPicker.tsx rows: a not-ready machine row whose action is pressable is not aria-disabled around it (#5117).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const pick = { id: 'box', name: 'Box', path: '/remote' };
const state: any = { newChatHost: pick, chatConfig: {} };
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: (patch: any) => void Object.assign(state, typeof patch === 'function' ? patch(state) : patch),
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => 'host-claude' });
mockSource('src/store/projects.ts', { setChatConfig: () => undefined });
mockSource('src/store/panes.ts', { navigate: () => undefined });
const mark = { type: 'span', props: { className: 'mark' }, key: null, ref: null, $$typeof: Symbol.for('react.transitional.element') };
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: () => mark,
  BasicHarnessIcon: () => mark,
  BasicBadge: () => mark,
});
mockSource('src/store/session/useSession.ts', { useSessionField: () => null, setSession: async () => undefined });
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: () => null,
  switchMachineChat: async () => null,
  dropMachineSwitch: async () => undefined,
});
const machines = [
  {
    id: 'box',
    name: 'Box',
    installable: ['codex'],
    platform: 'linux',
    agents: [
      {
        id: 'claude',
        label: 'Claude Code',
        state: 'ready',
        models: [{ id: 'm', name: 'M', default: true, efforts: ['low'], defaultEffort: null }],
      },
      { id: 'codex', label: 'Codex', state: 'missing', reason: 'Not installed on Box' },
      { id: 'gemini', label: 'Gemini', state: 'signin', reason: 'Sign in on Box' },
    ],
  },
];
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => ({ pick, want: 'claude', choice: { harness: 'claude' } }),
});
const fake = fakeNative({
  host: {
    access: async () => true,
    check: async () => undefined,
    installAgent: async (id: string, harness: string) => ({ hostId: id, harness, state: 'queued', line: '', error: null, version: null }),
  },
});
installNative(fake);
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');

const rowOf = (label: string) => $$('.hp-row').find((r) => r.textContent?.includes(label))!;
const disabledAncestor = (el: Element) => {
  for (let n: Element | null = el; n; n = n.parentElement) if (n.getAttribute('aria-disabled') === 'true') return n;
  return null;
};

test('a signed-out and a missing machine row: their actions have no aria-disabled ancestor and a click fires them', async () => {
  const shell = h(
    'div',
    { 'data-composer-chat': 'a', 'data-composer-main': 'true' },
    h(HostModelPicker, { threadId: null, hostId: 'box' }),
  );
  const m = await mount(shell);
  try {
    const openRows = async () => {
      if (!$$('.hp-row').length) {
        if (!$('button[aria-label="Select harness and model"]')) await click($('button[aria-label="Select model"]'));
        await click($('button[aria-label="Select harness and model"]'));
      }
    };
    await openRows();
    const signin = $$('.hp-mini', rowOf('Gemini')).find((b) => b.textContent === 'Sign in')!;
    assert.equal(disabledAncestor(signin), null);
    await click(signin);
    assert.deepEqual(fake.callsTo('host.signin'), [['box', 'gemini']]);
    await openRows();
    const install = $$('.hp-mini', rowOf('Codex')).find((b) => b.textContent === 'Install on Box')!;
    assert.equal(disabledAncestor(install), null);
    await click(install);
    assert.equal(fake.callsTo('host.installAgent').length, 1);
  } finally {
    await m.unmount();
  }
});
