// The goal bar's actions on a chat on a machine (src/store/machineChatGoal.ts, src/session/harness/adapters/hostSemantics.ts): the machine's agent runs each one and its answer is the chat's goal (A), a refusal is one short line shaped as this Mac's own failures are (B), a Host too old for it says so in the app's words (I), and the handlers are the ones a machine's Claude Code and Codex chats run (W).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mockSource } from './support/stubs.ts';
import { useFakeNative } from './support/ports/native.ts';

const toasts: any[][] = [];
const goals: any[] = [];
mockSource('src/store/core.ts', { toast: (...a: any[]) => void toasts.push(a) });
mockSource('src/store/actions.ts', { setGoalState: async (chatId: string, goal: any) => (goals.push([chatId, goal]), true) });
const lib = await import('../src/store/machineChatGoal.ts');
const { HOST_HANDLERS } = await import('../src/session/harness/adapters/hostSemantics.ts');
const { handlerFor } = await import('../src/harness/adapters/semantics.ts');
const { registerSemanticHandlers } = await import('../src/session/harness/adapters/handlers.ts');

const asked: any[][] = [];
let answer: (chatId: string, what: any) => Promise<unknown> = async () => ({ goal: { objective: 'ship', status: 'paused' } });
const bridge = (t: { after: (fn: () => void) => void }) =>
  useFakeNative(t, { host: { goalChat: (chatId: string, what: any) => (asked.push([chatId, what]), answer(chatId, what)) } });
const reset = () => {
  asked.length = 0;
  toasts.length = 0;
  goals.length = 0;
  answer = async () => ({ goal: { objective: 'ship', status: 'paused' } });
};

test('A: each action of the goal bar goes to the machine as the wire has it, and the goal it answers with is the chat’s', async (t) => {
  bridge(t);
  reset();
  for (const [args, wire] of [
    ['pause', { action: 'pause' }],
    ['resume', { action: 'resume' }],
    ['extend', { action: 'extend' }],
    ['clear', { action: 'clear' }],
    ['clear human', { action: 'clear', human: true }],
    ['budget 200k', { action: 'budget', tokens: 200_000 }],
    ['budget none', { action: 'budget', tokens: null }],
    ['edit ship it, then rest', { action: 'edit', objective: 'ship it, then rest' }],
  ] as const) {
    asked.length = 0;
    // an edit says whether it went through, as the editor on this Mac needs; the others say nothing
    assert.equal(await lib.runMachineGoal('c', args), args.startsWith('edit ') ? true : undefined, args);
    assert.deepEqual(asked, [['c', wire]], args);
  }
  assert.deepEqual(goals.at(-1), ['c', { objective: 'ship', status: 'paused' }]);
  assert.deepEqual(toasts, []);
});

test('A: a budget that is not one is said so and nothing is asked; an action nobody has is a mistake, not a refusal', async (t) => {
  bridge(t);
  reset();
  assert.equal(await lib.runMachineGoal('c', 'budget lots'), undefined);
  assert.deepEqual(toasts, [['Budget: a number of tokens like 200k, or none', 'error']]);
  assert.deepEqual(asked, []);
  await assert.rejects(lib.runMachineGoal('c', 'rewind'), /Unknown goal action rewind/);
});

test('B: a refusal is one line shaped as the same action’s failure is on this Mac, and the goal stays as it was', async (t) => {
  bridge(t);
  reset();
  answer = async () => Promise.reject(Object.assign(new Error("Kimi doesn't support goals"), { code: 'unsupported' }));
  for (const [args, said] of [
    ['pause', "Couldn't pause goal: Kimi doesn't support goals"],
    ['resume', "Couldn't resume goal: Kimi doesn't support goals"],
    ['extend', "Couldn't add rounds to the goal: Kimi doesn't support goals"],
    ['clear', "Couldn't clear goal: Kimi doesn't support goals"],
    ['budget 5k', "Couldn't set the budget: Kimi doesn't support goals"],
  ] as const) {
    toasts.length = 0;
    assert.equal(await lib.runMachineGoal('c', args), undefined, args);
    assert.deepEqual(toasts, [[said, 'error']], args);
  }
  toasts.length = 0;
  assert.equal(await lib.runMachineGoal('c', 'edit x'), false);
  assert.deepEqual(toasts, [["Couldn't edit goal: Kimi doesn't support goals", 'error']]);
  assert.deepEqual(goals, []);
});

test('I: a Host without goal controls is too old for them, in the words every machine chat uses; a refusal with no words has some', async (t) => {
  bridge(t);
  reset();
  answer = async () =>
    Promise.reject(
      Object.assign(new Error('The host cannot do this safely yet (it lacks goalControls). Update it.'), { code: 'feature_missing' }),
    );
  await lib.runMachineGoal('c', 'pause');
  assert.deepEqual(toasts, [["Couldn't pause goal: The machine is too old for this. Update it.", 'error']]);
  assert.equal(lib.goalRefusal(Object.assign(new Error('x'), { code: 'feature_missing' })), 'The machine is too old for this. Update it.');
  assert.equal(lib.goalRefusal(new Error('')), 'The machine could not change the goal.');
  assert.equal(lib.goalRefusal(null), 'The machine could not change the goal.');
  assert.equal(
    lib.goalRefusal(new Error("Can't reach the machine, so the goal is unchanged.")),
    "Can't reach the machine, so the goal is unchanged.",
  );
});

test('W: the handlers a machine’s Claude Code and Codex chats run are the machine’s: registered under both kinds, and only the goal is theirs', async (t) => {
  bridge(t);
  reset();
  registerSemanticHandlers();
  for (const kind of ['acp:host-claude', 'acp:host-codex'] as const) {
    assert.equal(await handlerFor(kind, 'goal'), HOST_HANDLERS.goal, kind);
    assert.equal(await handlerFor(kind, 'rename'), null, kind);
  }
  assert.equal(await handlerFor('acp:kimi', 'goal'), null);
  await HOST_HANDLERS.goal!({ chatId: 'c', args: 'resume' });
  assert.deepEqual(asked, [['c', { action: 'resume' }]]);
});

test('the bridge types load: window.native.host.goalChat is declared with the rest of the machine calls', async () => {
  await import('../src/lib/native/host.ts');
});
