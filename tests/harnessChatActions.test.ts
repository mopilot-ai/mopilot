// What a chat's errors and replies offer (chatActions.ts) and /goal as typed (goalCommand.ts).
import { beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { called, fx, reset } from './support/harness-logic-fakes.ts';

const claudeCalls: any[] = [];
const rec =
  (name: string) =>
  (...args: any[]) =>
    void claudeCalls.push([name, ...args]);
mock.module(new URL('../src/session/harness/claude.ts', import.meta.url).href, {
  namedExports: Object.fromEntries(
    ['recheckClaude', 'reloginClaudeAccount', 'addClaudeAccount', 'pinClaudeChat', 'removeClaudeAccount', 'switchClaudeAccount'].map(
      (n) => [n, rec(n)],
    ),
  ),
});
/** The chats that run on a machine, by id. */
const onMachine: Record<string, string | null> = {};
mock.module(new URL('../src/lib/hostChats.ts', import.meta.url).href, {
  // `null`: the chats on machines are not read yet, so any chat may be on one
  namedExports: {
    hostOfChatNow: (id: string) => (onMachine[id] === undefined ? '' : onMachine[id]),
    onMachineNow: (id: string) => onMachine[id] !== undefined,
  },
});
/** The agent a machine runs a chat on, by id (`hostAgentOf`). */
const machineAgent: Record<string, string> = {};
mock.module(new URL('../src/store/machineChatSwitch.ts', import.meta.url).href, {
  namedExports: { hostAgentOf: (id: string) => machineAgent[id] ?? '' },
});
const { authRecovery, rateReply } = await import('../src/session/chatActions.ts');
const { goalOff, runGoalCommand } = await import('../src/session/harness/goalCommand.ts');
const { claudeThreadId } = await import('../src/harness/types.ts');

const claudeChat = claudeThreadId('s1');
beforeEach(() => {
  reset();
  claudeCalls.length = 0;
});

test('a signed-out Claude error offers sign-in and re-check on the login the chat runs on', () => {
  assert.equal(authRecovery('codex-1', 'Failed to authenticate'), null);
  assert.equal(authRecovery(claudeChat, 'Network error'), null);
  fx.state.claudeAccounts = { active: 'default', accounts: [{ id: 'work' }] };
  fx.state.claudeChats[claudeChat] = { id: 'work' };
  const r = authRecovery(claudeChat, 'OAuth token has expired')!;
  r.signIn();
  r.recheck?.();
  assert.deepEqual(claudeCalls, [
    ['reloginClaudeAccount', 'work'],
    ['recheckClaude', 'work'],
  ]);
  // #4908: a login the provider refuses is redone the same way
  assert.equal(authRecovery(claudeChat, 'Your organization has disabled Claude subscription access for Claude Code')!.label, 'Sign in');
});

test('ratings: Codex uploads feedback; every other harness counts it as usage data, with sharing on or off', async () => {
  // with sharing off the click is the consent to send that one rating
  fx.state.prefs.shareUsageData = false;
  await rateReply('codex-1', 'good');
  await rateReply('codex-1', 'bad');
  assert.deepEqual(called('sendFeedback'), [
    ['codex-1', 'good_result', null, false],
    ['codex-1', 'bad_result', null, false],
  ]);
  fx.store.sendFeedback = async () => {
    throw new Error('offline');
  };
  await rateReply('codex-1', 'good');
  assert.deepEqual(fx.tracked, [], 'a Codex rating is not usage data');
  assert.equal(await rateReply(claudeChat, 'good'), true);
  fx.state.prefs.shareUsageData = null;
  await rateReply(claudeChat, 'bad');
  fx.state.prefs.shareUsageData = true;
  await rateReply('acp:kimi:1', 'good');
  assert.deepEqual(fx.tracked, [
    ['reply_rated', { harness: 'claude', rating: 'good' }],
    ['reply_rated', { harness: 'claude', rating: 'bad' }],
    ['reply_rated', { harness: 'acp:kimi', rating: 'good' }],
  ]);
  // nothing about a Claude or basic-harness reply goes to OpenAI
  assert.equal(called('sendFeedback').length, 3);
});

test('goalOff: a temporary chat, or a new chat that will be temporary', () => {
  assert.equal(goalOff(null), null);
  fx.state.newChatTemporary = true;
  assert.match(goalOff(null)!, /Temporary/);
  fx.state.threads.t = { ephemeral: true };
  assert.match(goalOff('t')!, /Temporary/);
  assert.equal(goalOff('u', { threads: { u: {} } } as any), null);
});

test('/goal on Claude goes out as typed; clear and show without a chat say so', async () => {
  const chat = claudeChat;
  await runGoalCommand(chat, 'budget 200k');
  await runGoalCommand(chat, 'pause');
  await runGoalCommand(chat, 'resume');
  await runGoalCommand(chat, 'edit foo');
  await runGoalCommand(chat, '');
  await runGoalCommand(chat, 'tests pass');
  assert.deepEqual(
    called('sendMessage').map((c) => c[1]),
    ['/goal budget 200k', '/goal pause', '/goal resume', '/goal edit foo', '/goal', '/goal tests pass'],
  );
  assert.deepEqual(called('sendMessage')[0].slice(2), [[], { human: true }]);
  await runGoalCommand(chat, 'clear');
  assert.deepEqual(called('clearGoal'), [[chat, true]]);
  fx.state.newChatHarness = 'claude';
  await runGoalCommand(null, 'clear');
  await runGoalCommand(null, '');
  assert.deepEqual(called('toast'), [['No goal set'], ['No goal set. Use /goal <condition> to set one.']]);
  await runGoalCommand(null, 'ship');
  assert.deepEqual(called('sendMessage').at(-1), [null, '/goal ship', [], { human: true }]);
  // a temporary chat can't set one
  fx.state.threads[chat] = { ephemeral: true };
  await runGoalCommand(chat, 'ship');
  assert.deepEqual(called('toast').at(-1), ["Temporary chats can't have goals", 'error']);
});

test('/goal on Claude follows a pending switch to Claude', async () => {
  fx.sessions.c = { pendingSwitch: { harness: 'claude' } };
  await runGoalCommand('c', 'go');
  assert.deepEqual(called('sendMessage'), [['c', '/goal go', [], { human: true }]]);
});

test('/goal on Codex runs each kind through the store; without a chat only set and show work', async () => {
  await runGoalCommand('c', '');
  await runGoalCommand('c', 'pause');
  await runGoalCommand('c', 'resume');
  await runGoalCommand('c', 'edit new aim');
  await runGoalCommand('c', 'clear');
  await runGoalCommand('c', 'budget 10k');
  await runGoalCommand('c', 'ship it');
  assert.deepEqual(called('showGoal'), [['c']]);
  assert.deepEqual(called('pauseGoal'), [['c']]);
  assert.deepEqual(called('resumeGoal'), [['c']]);
  assert.deepEqual(called('editGoal'), [['c', 'new aim']]);
  assert.deepEqual(called('clearGoal'), [['c']]);
  assert.deepEqual(called('setGoalBudget'), [['c', 10000]]);
  assert.deepEqual(called('sendMessage'), [['c', 'ship it', [], { goal: 'ship it', human: true }]]);
  for (const a of ['pause', 'resume', 'edit x', 'clear', 'budget 1k']) await runGoalCommand(null, a);
  assert.deepEqual(called('toast'), Array(5).fill(['No goal set']));
  fx.store.blockedReason = () => 'Goals are off';
  await runGoalCommand('c', 'x');
  assert.deepEqual(called('toast').at(-1), ['Goals are off', 'error']);
});

test('/goal in a chat that a machine runs on Claude Code is Claude Code’s own command, though the chat is drawn as another agent', async () => {
  const id = 'acp:host-claude:u1';
  onMachine[id] = 'box';
  machineAgent[id] = 'claude';
  try {
    await runGoalCommand(id, 'ship');
    await runGoalCommand(id, 'clear');
    assert.deepEqual(called('sendMessage'), [[id, '/goal ship', [], { human: true }]]);
    assert.deepEqual(called('clearGoal'), [[id, true]]);
    // the machine's agent is Codex now: the goal is set as Codex sets it, by a message that carries it
    machineAgent[id] = 'codex';
    await runGoalCommand(id, 'ship');
    assert.deepEqual(called('sendMessage').at(-1), [id, 'ship', [], { goal: 'ship', human: true }]);
    // a chat on this Mac is never read as a machine's, whatever agent a stale entry names
    delete onMachine[id];
    machineAgent[id] = 'claude';
    await runGoalCommand(id, 'again');
    assert.deepEqual(called('sendMessage').at(-1), [id, 'again', [], { goal: 'again', human: true }]);
  } finally {
    delete onMachine[id];
    delete machineAgent[id];
  }
});

test("/goal says when main didn't take the goal, so the composer keeps what was typed", async () => {
  fx.store.sendMessage = async () => false;
  assert.equal(await runGoalCommand('c', 'ship it'), false);
});

test('#4278: a signed-out error of a chat on a machine offers that machine’s row and nothing of this Mac; another error there offers nothing', () => {
  const opened: string[] = [];
  fx.store.openSettings = (section: string) => () => void opened.push(section);
  onMachine[claudeChat] = 'box';
  try {
    fx.state.claudeChats[claudeChat] = { id: 'work' };
    const r = authRecovery(claudeChat, 'Not signed in: the token was refused')!;
    assert.equal(r.label, 'Sign in on machine');
    assert.equal(r.recheck, undefined, 'there is no login of this Mac to check again');
    r.signIn();
    assert.deepEqual(opened, ['connections']);
    assert.deepEqual(claudeCalls, [], 'no sign-in of this Mac was started');
    assert.equal(authRecovery(claudeChat, 'You have hit your usage limit'), null);
    // a failure the machine typed as something else is not a sign-in failure, whatever its other words say
    assert.equal(authRecovery(claudeChat, 'Context window is full: please run /login'), null);
    assert.equal(authRecovery(claudeChat, null), null);
  } finally {
    delete onMachine[claudeChat];
  }
  // where the chat runs is not known yet: nothing is offered, least of all a sign-in of this Mac
  onMachine[claudeChat] = null;
  try {
    assert.equal(authRecovery(claudeChat, 'OAuth token has expired'), null);
    assert.deepEqual(claudeCalls, []);
  } finally {
    delete onMachine[claudeChat];
  }
  // the same chat on this Mac again: its own login
  assert.equal(authRecovery(claudeChat, 'OAuth token has expired')!.label, 'Sign in');
});
