// A failed turn on a machine chat, in the same box as This Mac's (TurnErrorHelp), fed by the machine: its own model list for "unavailable model", and its login's reset time at a usage limit.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, settle, resetStore, callsTo, moduleCalls } from './support/thread-kit.ts';

const MODELS = [
  { id: 'opus', name: 'Opus', default: true, efforts: ['low'], defaultEffort: 'low' },
  { id: 'sonnet', name: 'Sonnet', default: false, efforts: [], defaultEffort: null },
];
let machine: any = { id: 'ssh:box', name: 'build-box', away: false };
let agent: any = null;
let saved: any = null;
let retryResult: () => Promise<unknown> = async () => {};
mockStore({
  limitNoteWay: () => null,
  toastFailure: (m: string) => () => moduleCalls.push(['failure', [m]]),
});
autoMock('src/session/harness/select.ts', 'sel', {
  useHarnessModels: () => [],
  useEffectiveSelection: () => ({ modelId: null }),
  useHarnessAccounts: () => ({ active: null }),
});
autoMock('src/lib/shortcutFocus.ts', 'focus');
autoMock('src/store/failedTurnRetry.ts', 'retry', {
  retryFailedTurn: (...a: unknown[]) => (moduleCalls.push(['retried', a]), retryResult()),
});
autoMock('src/lib/chatMachine.ts', 'machine', { useChatMachine: () => ({ machine, pending: false }) });
autoMock('src/session/machineAgent.ts', 'mAgent', { useMachineAgent: () => ({ machine, agentId: 'claude', agent, saved }) });
const { TurnErrorHelp } = await import('../src/components/thread/view/TurnErrorHelp.tsx');
const lib = await import('../src/components/thread/view/machineModels.ts');

const mount = (message: string, live = true) => render(h(TurnErrorHelp, { chatId: 'c1', turnId: 't1', message, live }));

beforeEach(() => {
  resetStore({ segments: {} });
  moduleCalls.length = 0;
  machine = { id: 'ssh:box', name: 'build-box', away: false };
  agent = { id: 'claude', label: 'Claude Code', state: 'ready', models: MODELS, logins: [] };
  saved = null;
  retryResult = async () => {};
});

test('a refused model on a machine: named for it, and the machine’s other model is chosen for this chat, then the turn retried', async () => {
  const v = await mount("The 'opus' model is not supported");
  assert.equal(v.host.firstElementChild!.textContent, "Opus isn't available on build-box");
  assert.equal(v.$('button')!.textContent, 'Use Sonnet');
  await settle(() => v.$('button')!.click());
  assert.deepEqual(callsTo('store:setChatConfig'), [
    ['c1', { hostSelection: { hostId: 'ssh:box', harness: 'claude', model: 'sonnet', effort: null } }],
  ]);
  assert.deepEqual(
    moduleCalls.filter(([n]) => n === 'retried'),
    [['retried', ['c1', 't1']]],
  );
});

test('an unnamed refusal is about the chat’s saved model; a failed retry is told', async () => {
  saved = { hostId: 'ssh:box', harness: 'claude', model: 'sonnet', effort: null };
  retryResult = () => Promise.reject(new Error('no'));
  const v = await mount('model_not_found');
  assert.match(v.host.textContent!, /^Sonnet isn't available/);
  assert.equal(v.$('button')!.textContent, 'Use Opus');
  await settle(() => v.$('button')!.click());
  assert.deepEqual(
    moduleCalls.filter(([n]) => n === 'failure'),
    [['failure', ["Couldn't retry"]]],
  );
});

test('no other model, no agent listed, or not live: the line only; an unknown name says itself', async () => {
  agent = { ...agent, models: [MODELS[0]] };
  const alone = await mount("The 'opus' model is not supported");
  assert.equal(alone.$('button'), null);
  agent = null;
  const none = await mount('model_not_found');
  assert.match(none.host.textContent!, /^This model isn't available on build-box/);
  assert.equal(none.$('button'), null);
  agent = { id: 'claude', models: MODELS };
  const idle = await mount("The 'zzz' model is not supported", false);
  assert.match(idle.host.textContent!, /^zzz isn't available/);
  assert.equal(idle.$('button'), null);
});

test('a usage limit on a machine says so for it and when its login starts over; a bare one keeps its words', async () => {
  const soon = Math.floor(Date.now() / 1000) + 3 * 3600 + 120;
  agent = {
    ...agent,
    logins: [{ id: 'a', label: 'a', state: 'ok', limited: true, limitedUntil: soon, billing: 'subscription', active: true }],
  };
  const v = await mount('Usage limit reached: 5-hour limit');
  assert.equal(v.host.firstElementChild!.textContent, 'Usage limit reached on build-box');
  assert.match(v.host.textContent!, /Resets in 3h/);
  const bare = await mount('rate_limit');
  assert.match(bare.host.textContent!, /^Out of usage or rate limited\.Resets in 3h/);
  agent = null;
  const nobody = await mount('rate_limit');
  assert.doesNotMatch(nobody.host.textContent!, /Resets/);
});

test('reset note: seconds or milliseconds, none when unknown or past; other model', () => {
  assert.equal(lib.limitResetNote(null), null);
  assert.equal(lib.limitResetNote(1), null);
  const soon = Math.floor(Date.now() / 1000) + 2 * 3600 + 120;
  assert.match(lib.limitResetNote(soon)!, /^Resets in 2h /);
  assert.match(lib.limitResetNote(soon * 1000)!, /^Resets in 2h /);
  assert.equal(lib.otherModel(MODELS as any, new Set(['opus']))!.id, 'sonnet');
  assert.equal(lib.otherModel(MODELS as any, new Set(['sonnet']))!.id, 'opus');
  assert.equal(lib.otherModel(MODELS as any, new Set(['opus', 'sonnet'])), undefined);
});
