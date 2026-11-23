// A chat on a machine moves to another agent there (src/store/machineChatSwitch.ts, the chip's Undo): the pick reaches the Host first and the chip follows only once the Host holds it (A), a refusal is one line (B), and taking the choice back tells the Host too (W) for a chat on a machine and no one for a chat on this Mac (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

const sent: any[][] = [];
let host: (chatId: string, pick: any) => Promise<unknown> = async () => ({ pending: null });
const session: any[][] = [];
let basic: string | null = 'host-claude';
let onMachine = true;
mockSource('src/store/session/useSession.ts', {
  setSession: async (...a: any[]) => void session.push(a),
  useSession: () => ({ pendingSwitch: null }),
});
mockSource('src/store/chats.ts', { chatBasicHarness: () => basic });
let config: Record<string, any> = {};
mockSource('src/store/core.ts', { get: () => ({ chatConfig: config }) });
mockSource('src/lib/hostChats.ts', { onMachineNow: () => onMachine });
const lib = await import('../src/store/machineChatSwitch.ts');
const bridge = (t: { after: (fn: () => void) => void }) =>
  useFakeNative(t, { host: { switchChat: (chatId: string, pick: any) => (sent.push([chatId, pick]), host(chatId, pick)) } });
const reset = () => {
  sent.length = 0;
  session.length = 0;
  basic = 'host-claude';
  onMachine = true;
  host = async () => ({ pending: null });
};

test('A: only the agent that runs Claude Code is Claude to /goal and /init; Codex, a basic agent and an unknown chat are not', () => {
  reset();
  basic = 'host-claude';
  assert.equal(lib.hostRunsClaude('c'), true);
  config = { c: { hostAgent: 'codex' } };
  assert.equal(lib.hostRunsClaude('c'), false);
  config = { c: { hostAgent: 'acp:kimi' } };
  assert.equal(lib.hostRunsClaude('c'), false);
  config = {};
  basic = null;
  assert.equal(lib.hostRunsClaude('c'), false);
});

test('A: a machine lists its agents by id; the Host is asked by the harness kind (claude, codex or acp:<id>)', (t) => {
  bridge(t);
  assert.equal(lib.kindOfAgent('claude'), 'claude');
  assert.equal(lib.kindOfAgent('codex'), 'codex');
  assert.equal(lib.kindOfAgent('kimi'), 'acp:kimi');
  reset();
  assert.equal(lib.hostAgentOf('c'), 'claude');
  basic = 'host-codex';
  assert.equal(lib.hostAgentOf('c'), 'codex');
  basic = 'kimi';
  assert.equal(lib.hostAgentOf('c'), 'kimi');
  basic = null;
  assert.equal(lib.hostAgentOf('c'), '');
  // the agent the Host said after a switch settled wins over the one the id names
  basic = 'host-claude';
  config = { c: { hostAgent: 'acp:kimi' } };
  assert.equal(lib.hostAgentOf('c'), 'kimi');
  config = { c: { hostAgent: 'codex' } };
  assert.equal(lib.hostAgentOf('c'), 'codex');
  config = {};
  assert.deepEqual(
    [lib.agentOfKind('acp:kimi'), lib.agentOfKind('claude'), lib.agentOfKind(''), lib.agentOfKind(null)],
    ['kimi', 'claude', null, null],
  );
});

test('A: the pick goes to the Host with its model and effort, and the chip follows only once the Host holds it', async (t) => {
  bridge(t);
  reset();
  const out = await lib.switchMachineChat('c', { agent: 'kimi', model: 'k2', modelLabel: 'Kimi K2', effort: 'high' }, 'Box');
  assert.equal(out, null);
  assert.deepEqual(sent, [['c', { harness: 'acp:kimi', model: 'k2', effort: 'high' }]]);
  assert.deepEqual(session, [
    ['c', { pendingSwitch: { harness: 'acp:kimi', model: 'k2', modelLabel: 'Kimi K2', effort: 'high', mode: 'auto' } }],
  ]);
  await lib.switchMachineChat('c', { agent: 'codex', model: 'gpt', modelLabel: 'GPT' }, 'Box');
  assert.deepEqual(sent[1], ['c', { harness: 'codex', model: 'gpt' }], 'no effort named, none sent');
  assert.equal((session[1][1] as any).pendingSwitch.effort, null);
  // an agent the machine reports no models for: the agent alone is asked for, and the chip holds its own default
  await lib.switchMachineChat('c', { agent: 'codex', modelLabel: 'Codex' }, 'Box');
  assert.deepEqual(sent[2], ['c', { harness: 'codex' }]);
  assert.deepEqual((session[2][1] as any).pendingSwitch, {
    harness: 'codex',
    model: null,
    modelLabel: 'Codex',
    effort: null,
    mode: 'auto',
  });
});

test('B: a refusal is one line and changes nothing here: an older Host is told to update, any other reason is the Host’s own words', async (t) => {
  bridge(t);
  reset();
  host = async () => Promise.reject(Object.assign(new Error('x'), { code: 'feature_missing' }));
  assert.equal(await lib.switchMachineChat('c', { agent: 'codex', model: 'm', modelLabel: 'M' }, 'Box'), 'Update Box to switch agents.');
  host = async () => Promise.reject(Object.assign(new Error('Sign in to Codex on this machine first.'), { code: 'agent_signed_out' }));
  assert.equal(
    await lib.switchMachineChat('c', { agent: 'codex', model: 'm', modelLabel: 'M' }, 'Box'),
    'Sign in to Codex on this machine first.',
  );
  host = async () => Promise.reject(new Error(''));
  assert.equal(await lib.switchMachineChat('c', { agent: 'codex', model: 'm', modelLabel: 'M' }, 'Box'), 'Box could not switch this chat.');
  assert.equal(lib.switchRefusal(null, 'Box'), 'Box could not switch this chat.');
  assert.deepEqual(session, [], 'the chip never shows a choice the Host did not take');
});

test('W: taking the choice back names the chat’s own agent to the Host; a Host that cannot be reached does not break the Undo', async (t) => {
  bridge(t);
  reset();
  await lib.dropMachineSwitch('c', 'claude');
  assert.deepEqual(sent, [['c', { harness: 'claude' }]]);
  host = async () => Promise.reject(new Error('away'));
  await assert.doesNotReject(lib.dropMachineSwitch('c', 'kimi'));
  assert.deepEqual(sent[1], ['c', { harness: 'acp:kimi' }]);
});

test('I: the chip\u2019s Undo tells the Host of a chat on a machine, and no one for a chat on this Mac', async (t) => {
  bridge(t);
  reset();
  lib.undoMachineSwitch('c');
  assert.deepEqual(sent, [['c', { harness: 'claude' }]]);
  onMachine = false;
  lib.undoMachineSwitch('c');
  assert.equal(sent.length, 1);
});
