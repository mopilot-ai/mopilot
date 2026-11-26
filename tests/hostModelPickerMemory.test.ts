// The machine picker of a new chat starts on the model and effort the last chat started on that machine used for the same agent (prefs.hostPicks), kept as the draft's pick; another agent's memory or a model gone from the machine falls back to its default.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mockTsx, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const MODEL = { id: 'remote', name: 'Remote model', default: true, efforts: ['low', 'high'], defaultEffort: 'low' };
const pick = { id: 'box', name: 'Box', path: '/remote' };
let state: any;
mockSource('src/store/core.ts', {
  toast: () => undefined,
  useStore: (sel: any) => sel(state),
  set: (patch: any) => {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
  },
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => 'host-claude' });
mockSource('src/store/projects.ts', { setChatConfig: () => undefined });
mockSource('src/store/panes.ts', { navigate: () => undefined });
const mark = {
  type: 'span',
  props: { className: 'harness-icon' },
  key: null,
  ref: null,
  $$typeof: Symbol.for('react.transitional.element'),
};
mockTsx(new URL('../src/components/harnessPicker/badges.tsx', import.meta.url), {
  HarnessIcon: () => mark,
  BasicHarnessIcon: () => mark,
  BasicBadge: () => null,
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
    agents: [
      {
        id: 'claude',
        label: 'Claude Code',
        state: 'ready',
        models: [MODEL, { ...MODEL, id: 'second', name: 'Second', default: false, defaultEffort: 'high' }],
      },
      { id: 'custom', label: 'Custom', state: 'ready', models: [{ ...MODEL, id: 'custom-model' }] },
    ],
  },
];
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines }) });
installNative(fakeNative({ host: { signin: async () => undefined } }));
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => ({ pick, want: 'claude', choice: { harness: 'claude' } }),
});
const { createElement: h } = await import('react');
const { HostModelPicker } = await import('../src/components/composer/HostModelPicker.tsx');
const button = () => $('button[aria-label="Select model"]');
const reset = (last: unknown) => {
  state = { newChatHost: pick, chatConfig: {}, prefs: { hostPicks: { box: last } } };
};

test("a new chat starts on the machine's last model and effort for that agent, kept as the draft's pick; another agent's or a gone model's does not", async () => {
  reset({ agent: 'claude', model: 'second', effort: 'low' });
  const m = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
  try {
    assert.match(button().textContent!, /Second/);
    assert.deepEqual(state.newChatHost.selection, { hostId: 'box', harness: 'claude', model: 'second', effort: 'low' });
  } finally {
    await m.unmount();
  }
  for (const last of [
    { agent: 'custom', model: 'second', effort: 'low' },
    { agent: 'claude', model: 'gone', effort: 'high' },
  ]) {
    reset(last);
    const again = await mount(h(HostModelPicker, { threadId: null, hostId: 'box' }));
    try {
      assert.match(button().textContent!, /Remote model/);
      assert.doesNotMatch(button().textContent!, /unavailable/);
      assert.equal(state.newChatHost.selection, undefined, "the machine's own default needs no pick");
    } finally {
      await again.unmount();
    }
  }
});
