// A failed turn's headline and action (src/components/thread/view/TurnErrorHelp.tsx): a model the plan doesn't include
// offers the harness's default; a bare rate limit offers the way on; other errors are only their text.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, settle, resetStore, callsTo, moduleCalls } from './support/thread-kit.ts';

let models: any[] = [];
let current: string | null = null;
let limited: any = null;
let way: any = null;
let machine: any = null;
const retries: string[][] = [];
let retryResult: () => Promise<unknown> = async () => {};
mockStore({
  limitNoteWay: () => way,
  chatHarnessLabel: (id: string) => (id.startsWith('claude:') ? 'Claude Code' : 'Codex'),
  toastFailure: (m: string) => () => moduleCalls.push(['failure', [m]]),
});
autoMock('src/session/harness/select.ts', 'sel', {
  useHarnessModels: () => models,
  useEffectiveSelection: () => ({ modelId: current }),
  useHarnessAccounts: () => ({ active: limited ? { limited } : null }),
});
autoMock('src/lib/chatMachine.ts', 'machine', { useChatMachine: () => ({ machine, pending: false }) });
autoMock('src/lib/shortcutFocus.ts', 'focus');
autoMock('src/store/failedTurnRetry.ts', 'retry', { retryFailedTurn: (c: string, t: string) => (retries.push([c, t]), retryResult()) });
const { TurnErrorHelp } = await import('../src/components/thread/view/TurnErrorHelp.tsx');
const { friendlyError, sameWords, unavailableModel } = await import('../src/components/thread/view/friendlyError.ts');

const M = [
  { id: 'gpt-5.5-codex', label: 'GPT-5.5 Codex', isDefault: false },
  { id: 'gpt-5', label: 'GPT-5', isDefault: true, defaultEffort: 'medium' },
  { id: 'alias', label: 'Aliased', resolved: 'gpt-x', isDefault: false },
];
const CODEX = "The 'gpt-5.5-codex' model is not supported when using Codex with a ChatGPT account.";
const mount = (message: string, live = true, chatId = 'c1') => render(h(TurnErrorHelp, { chatId, turnId: 't1', message, live }));

beforeEach(() => {
  resetStore({ segments: {} });
  moduleCalls.length = 0;
  retries.length = 0;
  models = M;
  current = 'gpt-5';
  limited = null;
  way = null;
  machine = null;
  retryResult = async () => {};
});

test('unavailableModel recognizes real model errors', () => {
  assert.equal(unavailableModel(CODEX), 'gpt-5.5-codex');
  assert.equal(unavailableModel('code: model_not_found'), null);
  assert.equal(unavailableModel('The model `o9` does not exist or you do not have access to it.'), 'o9');
  assert.equal(
    unavailableModel(
      "There's an issue with the selected model (claude-opus-4-1). It may not exist or you may not have access to it. Run /model to pick a different model.",
    ),
    'claude-opus-4-1',
  );
  assert.equal(unavailableModel("model 'gpt-x' not available"), 'gpt-x', 'the first capture');
  assert.equal(unavailableModel("The 'o9-mini' model does not exist"), 'o9-mini', 'the name may come before the word model');
  assert.equal(unavailableModel('Model not found'), null);
  assert.equal(unavailableModel('The requested model is not available'), null);
  for (const no of ['bad key', 'rate_limit', 'Model output was cut off']) assert.equal(unavailableModel(no), undefined);
  assert.equal(friendlyError('rate_limit'), 'Out of usage or rate limited.');
});

test('a refused model names itself and offers the default, then retries', async () => {
  const v = await mount(CODEX);
  assert.equal(v.host.firstElementChild!.textContent, "Your plan doesn't include GPT-5.5 Codex");
  const b = v.$('.turn-error-actions button')!;
  assert.equal(b.textContent, 'Use GPT-5');
  await settle(() => b.click());
  assert.deepEqual(callsTo('sel:setSelection'), [['codex', { model: 'gpt-5', effort: 'medium' }, 'c1']]);
  assert.deepEqual(retries, [['c1', 't1']]);
});

test('a retry that fails is reported', async () => {
  retryResult = () => Promise.reject(new Error('no'));
  const v = await mount(CODEX);
  await settle(() => v.$('button')!.click());
  assert.deepEqual(
    moduleCalls.filter(([n]) => n === 'failure'),
    [['failure', ["Couldn't retry"]]],
  );
});

test('an unnamed refusal is about the current model; the label falls back to the id, resolved ids match', async () => {
  const unnamed = await mount('model_not_found');
  assert.match(unnamed.host.textContent!, /include GPT-5$|include GPT-5Use /);
  assert.equal(unnamed.$('button')!.textContent, 'Use GPT-5.5 Codex');
  await unnamed.unmount();
  const resolved = await mount("The 'gpt-x' model is not supported");
  assert.match(resolved.host.textContent!, /include Aliased/);
  await resolved.unmount();
  const unknown = await mount("The 'zzz' model is not supported");
  assert.match(unknown.host.textContent!, /include zzz/);
  await unknown.unmount();
  current = null;
  const none = await mount('model_not_found');
  assert.match(none.host.textContent!, /include this model/);
});

test('no action when not live or when no other model exists', async () => {
  const idle = await mount(CODEX, false);
  assert.equal(idle.$('button'), null);
  await idle.unmount();
  models = [M[0]];
  const alone = await mount(CODEX);
  assert.equal(alone.$('button'), null);
});

test('a basic harness chat is sent to its model picker', async () => {
  const v = await mount('Model not found', true, 'acp:gemini:s1');
  assert.match(v.host.textContent!, /include this model/);
  const b = v.$('button')!;
  assert.equal(b.textContent, 'Choose a model');
  await settle(() => b.click());
  assert.deepEqual(callsTo('focus:dispatchComposerCommand'), [['open-model-picker']]);
  await v.unmount();
  assert.equal((await mount('Model not found', false, 'acp:gemini:s1')).$('button'), null);
});

test('a bare rate limit shows when it resets and the way on', async () => {
  way = { action: { label: 'Continue on Claude', run: () => moduleCalls.push(['way', []]) } };
  limited = { resetsAt: Date.now() + 3 * 3600_000 };
  const v = await mount('rate_limit');
  assert.match(v.host.textContent!, /^Out of usage or rate limited\.Resets in /);
  await settle(() => v.$('button')!.click());
  assert.equal(moduleCalls.filter(([n]) => n === 'way').length, 1);
  await v.unmount();
  limited = null;
  const idle = await mount('rate_limit', false);
  assert.equal(idle.host.textContent, 'Out of usage or rate limited.');
});

test("a basic harness chat never shows the first-tier account's reset time", async () => {
  limited = { resetsAt: Date.now() + 3 * 3600_000 };
  const v = await mount('rate_limit', true, 'acp:gemini:s1');
  assert.equal(v.$('.turn-error-details'), null);
  assert.match(v.host.textContent!, /^Out of usage or rate limited\./);
});

test('other errors are only their text', async () => {
  const v = await mount('{"error":{"message":"bad key"}}');
  assert.equal(v.host.textContent, 'bad key');
});

test('#4908: a login the provider refuses is one headline naming the agent and the machine, with what to do, and no model or limit help', async () => {
  const said =
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
  const claude = 'claude:11111111-1111-4111-8111-111111111111';
  machine = { id: 'ssh:box', name: 'mopilot-mini', away: false };
  const m = await mount(said, true, claude);
  try {
    assert.match(m.host.textContent ?? '', /Claude Code on mopilot-mini can't run: its login is refused/);
    assert.match(m.host.textContent ?? '', /Sign in again, or use another machine/);
    assert.ok(!m.host.querySelector('.turn-error-actions'), 'the turn offers the sign-in; this adds no second action');
  } finally {
    await m.unmount();
  }
  // on this Mac there is no machine to name
  machine = null;
  const local = await mount(said, true, claude);
  try {
    assert.match(local.host.textContent ?? '', /^Claude Code can't run: its login is refused/);
    assert.doesNotMatch(local.host.textContent ?? '', /another machine/);
  } finally {
    await local.unmount();
  }
});

test('#4908: a reply that is only the failure’s own words is not drawn twice; any other reply stays', () => {
  const said =
    'Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead, or ask your admin to enable access';
  assert.equal(sameWords(said, said), true);
  assert.equal(sameWords(`  ${said}\n`, `API Error: 403 ${said}`), true, 'the error may say more around it');
  assert.equal(sameWords('Done.', 'Done.'), true);
  assert.equal(sameWords('The build is ready. Error', 'Error'), false, 'a short error is not found inside a longer reply');
  assert.equal(sameWords('', said), false);
  assert.equal(sameWords(undefined, said), false);
  assert.equal(sameWords('some reply', undefined), false);
  assert.equal(sameWords(undefined, 'x'), false);
  assert.equal(sameWords(undefined, undefined), false);
  assert.equal(sameWords('Short note', said), false);
});
