// The composer's Plan on a chat that runs on a machine (src/components/composer/useComposerPlan.ts): offered for an agent whose machine's Host says it takes Plan, refused with the machine's name otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h } from 'react';
import { mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
let location: any = { machine: 'box', machineId: 'box', pending: false };
let machines: any[] = [];
const toasts: unknown[] = [];
const sessions: unknown[] = [];
mockSource('src/session/useComposerLocation.ts', { useComposerLocation: () => location });
let agentChoice: any = { choice: { harness: 'codex' } };
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => agentChoice });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines, resolved: true }) });
mockSource('src/components/composer/ComposerCommands.ts', { blocked: () => false });
mockSource('src/store/session/useSession.ts', { setSession: (...a: unknown[]) => sessions.push(a) });
mockSource('src/store/core.ts', { toast: (m: unknown) => toasts.push(m) });
const { useComposerPlan } = await import('../src/components/composer/useComposerPlan.ts');
let seen: any;
function Probe({ agent, plan = false, id = 'c1' }: { agent: string | null; plan?: boolean; id?: string | null }) {
  seen = useComposerPlan(id, plan, { harness: agent as any, basic: null });
  return h('i');
}
const box = (agents: object[]) => [{ id: 'box', name: 'box', agents }];

test('a machine whose Host takes Plan for the chat’s agent offers it, and turning it on writes the chat’s session', async () => {
  machines = box([{ id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true }]);
  const m = await mount(h(Probe, { agent: 'codex', plan: true }));
  try {
    assert.equal(seen.planOffWhy, null);
    // the flag the Host's lane sets is what the composer shows
    assert.equal(seen.planMode, true);
    assert.equal(seen.setPlanMode(false), undefined);
    assert.deepEqual(sessions.pop(), ['c1', { plan: false }]);
    assert.deepEqual(toasts, []);
  } finally {
    await m.unmount();
  }
});

test('an agent the Host does not say takes Plan, another agent of the machine, an older Host and an unknown machine keep it off with the machine’s name', async () => {
  const cases: [any[], string | null, string][] = [
    [box([{ id: 'codex', label: 'Codex', state: 'ready', reason: '' }]), 'codex', 'an older Host says nothing'],
    [
      box([
        { id: 'claude', label: 'Claude Code', state: 'ready', reason: '' },
        { id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true },
      ]),
      'claude',
      'only the agent the Host named',
    ],
    [box([{ id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true }]), null, 'no agent family (an ACP agent)'],
    [[], 'codex', 'a machine that is not listed'],
  ];
  for (const [rows, agent, why] of cases) {
    machines = rows;
    const m = await mount(h(Probe, { agent, plan: true }));
    try {
      assert.equal(seen.planOffWhy, "Plan mode isn't available on box yet.", why);
      // a machine that is listed and does not take Plan hides a stored Plan, and the machine not listed at all (nothing known) keeps showing it
      assert.equal(seen.planMode, rows.length === 0, why);
      toasts.length = 0;
      assert.equal(seen.setPlanMode(true), false, why);
      assert.deepEqual(toasts, ["Plan mode isn't available on box yet."], why);
    } finally {
      await m.unmount();
    }
  }
});

test('while the chat’s machine is not known the app waits, and a chat on this Mac has Plan as before', async () => {
  location = { machine: null, pending: true };
  let m = await mount(h(Probe, { agent: 'codex' }));
  try {
    assert.equal(seen.planOffWhy, 'Checking where this chat runs.');
  } finally {
    await m.unmount();
  }
  location = { machine: null, pending: false };
  m = await mount(h(Probe, { agent: 'codex' }));
  try {
    assert.equal(seen.planOffWhy, null);
  } finally {
    await m.unmount();
  }
});

test('a new chat on a machine asks the agent it is picked to run on, and an ACP agent’s own id (a basic harness) is no family of the Host', async () => {
  location = { machine: 'box', machineId: 'box', pending: false };
  machines = box([{ id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true }]);
  // the draft's agent choice is Codex (mocked above): its machine takes Plan
  let m = await mount(h(Probe, { agent: null, id: null }));
  try {
    assert.equal(seen.planOffWhy, null);
  } finally {
    await m.unmount();
  }
  // a started chat on a basic ACP harness has no first-tier family: Plan stays off there
  seen = undefined;
  function Basic() {
    seen = useComposerPlan('c1', false, { harness: null, basic: 'kimi' });
    return h('i');
  }
  m = await mount(h(Basic));
  try {
    assert.equal(seen.planOffWhy, "Plan mode isn't available on box yet.");
  } finally {
    await m.unmount();
  }
});

test('a chat in Plan keeps showing it while its machine is not listed or its place is checked, and Plan can still be switched off there; a new chat’s draft is not Plan until the machine takes it', async () => {
  location = { machine: 'box', machineId: 'box', pending: false };
  machines = [];
  let m = await mount(h(Probe, { agent: 'codex', plan: true }));
  try {
    assert.equal(seen.planMode, true);
    assert.equal(seen.setPlanMode(false), undefined, 'off is never refused');
    assert.deepEqual(sessions.pop(), ['c1', { plan: false }]);
  } finally {
    await m.unmount();
  }
  location = { machine: null, pending: true };
  m = await mount(h(Probe, { agent: 'codex', plan: true }));
  try {
    assert.equal(seen.planMode, true, 'still shown while where the chat runs is checked');
  } finally {
    await m.unmount();
  }
  // a new chat (no thread): its draft toggle follows the machine
  location = { machine: 'box', machineId: 'box', pending: false };
  m = await mount(h(Probe, { agent: 'codex', id: null }));
  try {
    assert.equal(seen.planMode, false);
  } finally {
    await m.unmount();
  }
});

test('a new chat’s agent is the one picked to run on the machine, else the one wanted, else none (so no Plan)', async () => {
  location = { machine: 'box', machineId: 'box', pending: false };
  machines = box([{ id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true }]);
  const planOff = async (choice: any) => {
    agentChoice = choice;
    const m = await mount(h(Probe, { agent: null, id: null }));
    try {
      return seen.planOffWhy;
    } finally {
      await m.unmount();
    }
  };
  try {
    assert.equal(await planOff({ choice: { harness: 'codex' } }), null);
    assert.equal(await planOff({ choice: null, want: 'codex' }), null, 'the agent wanted, before one is picked');
    assert.equal(await planOff(null), "Plan mode isn't available on box yet.", 'no agent known');
  } finally {
    agentChoice = { choice: { harness: 'codex' } };
  }
});
