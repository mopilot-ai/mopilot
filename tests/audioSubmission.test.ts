// An audio draft transfers durably before clearing and never crosses a changed account, model or recipient.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
let state: any = { accounts: { active: 'account' }, claudeAccounts: { active: 'claude-account' }, prefs: { model: 'first' } };
let hold: () => Promise<string>;
let finish: (id: string) => Promise<void>;
let timeout = false;
const expired = Symbol();
stubStore({ getState: () => state });
installNativeStub({ speech: { hold: () => hold(), finishTransfer: (id: string) => finish(id) } });
mock.module('../src/lib/localSpeech.ts', {
  namedExports: { withTimeout: (p: any) => (timeout ? Promise.resolve(expired) : p), timedOut: (v: any) => v === expired },
});
const { prepareAudioSubmission, audioSubmissionOwner } = await import('../src/session/audioSubmission.ts');
const audio: any[] = [{ kind: 'audio', path: '/saved.wav' }];

test('the full submission owner rejects account/model/config changes during a pending durable hold', async () => {
  for (const change of ['account', 'claudeAccount', 'model', 'effort', 'tier', 'permission', 'claudeSelection', 'recipient']) {
    state = { accounts: { active: 'account' }, claudeAccounts: { active: 'claude-account' }, prefs: { model: 'first' } };
    timeout = false;
    const gate = deferred<string>(),
      released: string[] = [];
    hold = () => gate.promise;
    finish = async (id) => {
      released.push(id);
    };
    const before = audioSubmissionOwner(state);
    const preparing = prepareAudioSubmission('home', 'Listen', audio, null, { kind: 'claude' }, () => change !== 'recipient');
    if (change === 'account') state.accounts.active = 'replacement';
    else if (change === 'claudeAccount') state.claudeAccounts.active = 'replacement';
    else if (change !== 'recipient') state.prefs[change === 'tier' ? 'serviceTier' : change] = 'replacement';
    if (change !== 'recipient') assert.notEqual(audioSubmissionOwner(state), before);
    gate.resolve('transfer');
    assert.equal(await preparing, null);
    assert.deepEqual(released, ['transfer']);
  }
});

test('a current audio hold succeeds; timeouts retire their late acknowledgment and release failures never change another draft', async () => {
  timeout = false;
  finish = async () => {};
  hold = async () => 'ready';
  assert.equal(await prepareAudioSubmission('chat', '', audio, 'chat', {}, () => true), 'ready');
  hold = async () => {
    throw new Error('disk full');
  };
  await assert.rejects(
    prepareAudioSubmission('chat', '', audio, 'chat', {}, () => true),
    /disk full/,
  );
  const late = deferred<string>();
  hold = () => late.promise;
  const released: string[] = [];
  finish = async (id) => {
    released.push(id);
    throw new Error('release failed');
  };
  timeout = true;
  await assert.rejects(
    prepareAudioSubmission('home', '', audio, null, {}, () => true),
    /draft is kept/,
  );
  late.resolve('late');
  await new Promise(setImmediate);
  assert.deepEqual(released, ['late']);
  timeout = false;
  hold = async () => 'obsolete';
  assert.equal(await prepareAudioSubmission('chat', '', audio, 'chat', {}, () => false), null);
});
