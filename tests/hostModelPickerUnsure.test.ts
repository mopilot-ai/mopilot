// An agent the Host could not check (#5177) stays selectable in the machine's picker, says so once and offers Retry, which asks every machine again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const pick = { id: 'box', name: 'Box', path: '/remote' };
const state: any = { newChatHost: pick, chatConfig: {} };
const toasts: any[] = [];
mockSource('src/store/core.ts', { toast: (...a: any[]) => void toasts.push(a), useStore: (sel: any) => sel(state), set: () => {} });
mockSource('src/store/chats.ts', { chatBasicHarness: () => 'host-claude' });
mockSource('src/store/projects.ts', { setChatConfig: () => {} });
mockSource('src/store/panes.ts', { navigate: () => {} });
mockSource('src/store/session/useSession.ts', { useSessionField: () => null, setSession: async () => {} });
mockSource('src/store/machineChatSwitch.ts', {
  agentOfKind: () => null,
  switchMachineChat: async () => null,
  dropMachineSwitch: async () => {},
});
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => ({ pick, want: 'claude', choice: { harness: 'claude' } }),
});
const mark = (id: string) => ({
  type: 'span',
  props: { className: 'harness-icon', 'data-h': id },
  key: null,
  ref: null,
  $$typeof: Symbol.for('react.transitional.element'),
});
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: ({ h: id }: any) => mark(id),
  BasicHarnessIcon: ({ id }: any) => mark(id),
  BasicBadge: () => null,
});
const machines = [
  {
    id: 'box',
    name: 'Box',
    agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', unsure: true, reason: 'Couldn’t check Claude Code on Box', models: [] }],
  },
];
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');

test('Retry on an agent the Host could not check asks the machines again; a refusal reaches the user', async () => {
  let fail = false;
  const native = fakeNative({
    host: {
      check: async () => {
        if (fail) throw new Error('Host said no');
      },
    },
  });
  installNative(native);
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    await click($('button[aria-label="Select model"]'));
    const title = $('button[aria-label="Select harness and model"]');
    if (title) await click(title);
    const retry = () =>
      $$('.hp-row')
        .find((r) => r.textContent?.includes('Claude Code'))!
        .querySelector('[aria-label="Check Claude Code again"]')!;
    assert.match($$('.hp-row')[0].textContent ?? '', /Couldn’t check/);
    await click(retry());
    assert.equal(native.callsTo('host.check').length, 1);
    fail = true;
    await click(retry());
    assert.equal(native.callsTo('host.check').length, 2);
    assert.equal(toasts.at(-1)?.[1], 'error');
  } finally {
    await m.unmount();
  }
});
