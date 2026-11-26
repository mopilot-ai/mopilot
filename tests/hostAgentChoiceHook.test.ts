// useHostAgentChoice: the pick's machine row and the agent it resolves to, none without a pick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let pick: any = null;
let saved = 'claude';
let draft: string | null = null;
let machines: any[] = [];
let prefs: any;
mockSource('src/store/core.ts', { useStore: (sel: (s: unknown) => unknown) => sel({ newChatHarnessPick: draft, prefs }) });
// where new chats start before a pick: the last used or the saved default (store/chats.ts startingHarness)
mockSource('src/store/chats.ts', { startingHarness: () => saved });
mockSource('src/store/projects.ts', { newChatHostPick: () => pick });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
const { createElement } = await import('react');
const { useHostAgentChoice } = await import('../src/session/useHostAgentChoice.ts');

let seen: any;
const view = () => seen;
const Probe = () => ((seen = useHostAgentChoice()), null);
const agent = (id: string, state: string) => ({ id, label: id, state, reason: '' });

test("no folder on a machine: nothing; a pick: its row and the agent resolved from the saved default or the folder's own", async () => {
  const m = await mount(createElement(Probe));
  try {
    assert.equal(seen, null);
    pick = { id: 'box', name: 'box', path: '/p' };
    machines = [{ id: 'box', name: 'box', agents: [agent('claude', 'ready'), agent('codex', 'ready')] }];
    await m.render(createElement(Probe));
    assert.equal(view().machine.id, 'box');
    assert.equal(view().choice.harness, 'claude');
    pick = { ...pick, agent: 'codex' };
    await m.render(createElement(Probe));
    assert.equal(view().choice.harness, 'codex');
    // a machine not (yet) listed has no readiness to go by
    machines = [];
    await m.render(createElement(Probe));
    assert.deepEqual(view(), { pick, want: 'codex', machine: null, choice: null });
  } finally {
    await m.unmount();
  }
});

test('a draft-local agent pick reaches remote readiness, while a machine-specific pick still wins', async () => {
  pick = { id: 'box', name: 'box', path: '/p' };
  machines = [{ id: 'box', name: 'box', agents: [agent('claude', 'ready'), agent('codex', 'ready'), agent('kimi', 'signin')] }];
  const m = await mount(createElement(Probe));
  try {
    for (const [choice, want] of [
      ['codex', 'codex'],
      ['acp:kimi', 'kimi'],
      ['claude', 'claude'],
    ] as const) {
      draft = choice;
      await m.render(createElement(Probe));
      assert.equal(view().want, want);
    }
    draft = 'acp:kimi';
    pick = { ...pick, agent: 'codex' };
    await m.render(createElement(Probe));
    assert.equal(view().want, 'codex');
    draft = null;
    pick = { id: 'box', name: 'box', path: '/p' };
    await m.render(createElement(Probe));
    assert.equal(view().want, 'claude');
  } finally {
    draft = null;
    await m.unmount();
  }
});

test('with nothing picked, the agent the last chat on the machine started on, while it is ready there; prefs without any picks keep the default', async () => {
  pick = { id: 'box', name: 'box', path: '/p' };
  machines = [{ id: 'box', name: 'box', agents: [agent('claude', 'ready'), agent('codex', 'ready')] }];
  const m = await mount(createElement(Probe));
  try {
    prefs = { hostPicks: { box: { agent: 'codex' } } };
    await m.render(createElement(Probe));
    assert.equal(view().want, 'codex');
    prefs = { hostPicks: { other: { agent: 'codex' } } };
    await m.render(createElement(Probe));
    assert.equal(view().want, 'claude');
    prefs = {};
    await m.render(createElement(Probe));
    assert.equal(view().want, 'claude');
  } finally {
    prefs = undefined;
    await m.unmount();
  }
});
