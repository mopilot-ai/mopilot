// The control pill names the chat's agent (computerUse.cjs wires ControlPills' `who`) and says "You took over" while the person has it; the badge says the same words with the Esc hint.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { rig } = await import('./support/computer-use-setup-rig.ts');

test('the pill names the agent ("The agent" when main names none), never the app, and is paused while the chat is taken over', async () => {
  const r = rig();
  const { cu, indicator } = r.runtime;
  cu.app = 'Definitely Not An App 7f3c';
  assert.deepEqual(await indicator.pills.who('c1'), { agent: 'The agent', paused: false });
  r.states.set('c1', { computer: { app: 'Notes', state: 'takeover' } });
  assert.deepEqual(await indicator.pills.who('c1'), { agent: 'The agent', paused: true });
  r.states.set('c1', { computer: { app: 'Notes', state: 'active' } });
  assert.deepEqual(await indicator.pills.who('c1'), { agent: 'The agent', paused: false });
  // the badge: the same words and the Esc hint
  assert.equal(indicator.labelFor('c1'), 'The agent is using your computer · Esc to stop');
});

test('the pill names a paired device using this Mac as the one using it; a chat here keeps its agent (#1364)', async () => {
  const remote = {
    get: (id: string) => (id === 'remote-1' ? { deviceName: 'Studio', harness: 'claude' } : null),
    indicatorLabel: (id: string) => (id === 'remote-1' ? 'Studio is using your computer · Esc to stop' : null),
    modelOr: (_id: string, fallback: (id: string) => unknown) => fallback(_id),
  };
  const r = rig({ options: { remote, agentName: () => 'Claude' } });
  const { cu, indicator } = r.runtime;
  cu.app = 'Definitely Not An App 7f3c';
  assert.equal((await indicator.pills.who('remote-1')).agent, 'Studio');
  assert.deepEqual(await indicator.pills.who('c1'), { agent: 'Claude', paused: false });
  // the badge: a remote owner's label wins; a chat here names its agent
  assert.equal(indicator.labelFor('remote-1'), 'Studio is using your computer · Esc to stop');
  assert.equal(indicator.labelFor('c1'), 'Claude is using your computer · Esc to stop');
});
