// Which agent a new chat on a machine starts on (src/harness/hostAgent.ts): the machine's own readiness decides, and a row that reports none keeps the caller's rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentIdOf, chooseHostAgent } from '../src/harness/hostAgent.ts';
import type { MachineAgent } from '../src/lib/hostMachines.ts';

const agent = (id: string, state: MachineAgent['state'], reason = ''): MachineAgent => ({ id, label: id.toUpperCase(), state, reason });

test('a pick that is ready on the machine is used, and the ready ones are offered', () => {
  const c = chooseHostAgent(
    'claude',
    [agent('codex', 'signin', 'Sign in on box'), agent('claude', 'ready'), agent('kimi', 'ready')],
    'box',
  );
  assert.deepEqual(c, { harness: 'claude', offered: [agent('claude', 'ready'), agent('kimi', 'ready')], blocked: null, note: null });
});

test('a pick that is signed out on the machine stands in the first ready agent and says why', () => {
  const c = chooseHostAgent('claude', [agent('claude', 'signin', 'Sign in on box'), agent('kimi', 'ready')], 'box');
  assert.equal(c!.harness, 'kimi');
  assert.equal(c!.blocked!.id, 'claude');
  assert.equal(c!.note, 'CLAUDE: Sign in on box; new chats start in KIMI');
});

test('a pick the machine does not list is missing there; with no reason given the note still says it is not ready', () => {
  const missing = chooseHostAgent('claude', [agent('kimi', 'ready')], 'box')!;
  assert.deepEqual(missing.blocked, { id: 'claude', label: 'Claude Code', state: 'missing', reason: 'Not installed on box' });
  assert.equal(missing.note, 'Claude Code: Not installed on box; new chats start in KIMI');
  const bare = chooseHostAgent('claude', [agent('claude', 'signin'), agent('kimi', 'ready')], 'box')!;
  assert.equal(bare.note, 'CLAUDE: isn’t ready on box; new chats start in KIMI');
});

test('with no agent ready nothing is chosen and the note says so', () => {
  const c = chooseHostAgent('claude', [agent('claude', 'signin', 'Sign in on box')], 'box')!;
  assert.equal(c.harness, null);
  assert.deepEqual(c.offered, []);
  assert.equal(c.note, 'CLAUDE: Sign in on box. No agent is ready on box');
});

test('a row that reports no readiness is unknown, so the caller keeps its own rule', () => {
  assert.equal(chooseHostAgent('claude', [], 'box'), null);
  assert.equal(chooseHostAgent('claude', [agent('claude', null)], 'box'), null);
});

test('a saved kind names its agent id', () => {
  assert.equal(agentIdOf('acp:kimi'), 'kimi');
  assert.equal(agentIdOf('claude'), 'claude');
});
