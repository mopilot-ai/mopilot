// Whether a machine chat's latest failed turn asks for the sign-in in its box, which the attention strip reads (src/session/machineAuthBox.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore } from './support/thread-kit.ts';

let owner: string | null = 'ssh:box';
mockStore({});
autoMock('src/lib/hostChats.ts', 'hostChats', { hostOfChatNow: () => owner });
const { useAuthBoxShown, drawsErrorBox, machineSignInAsked } = await import('../src/session/machineAuthBox.ts');

let shown: boolean | null = null;
function Probe() {
  shown = useAuthBoxShown('c1');
  return null;
}
const failed = {
  status: 'failed',
  error: { message: 'Failed to authenticate. API Error: 401 OAuth token has expired. Please run /login' },
};
const probe = async (turns: unknown[] | undefined) => {
  resetStore({ runtime: turns ? { c1: { turns } } : {} });
  await render(h(Probe));
  return shown;
};

beforeEach(() => {
  owner = 'ssh:box';
  shown = null;
});

test('a turn draws its box when it failed and is not running', () => {
  assert.equal(drawsErrorBox(failed, false), true);
  assert.equal(drawsErrorBox(failed, true), false);
  assert.equal(drawsErrorBox({ status: 'completed' }, false), false);
  assert.equal(drawsErrorBox(undefined, false), false);
});

test('the sign-in is asked for only on a chat on a machine, for a signed-out error', () => {
  assert.equal(machineSignInAsked('c1', failed.error.message), true);
  assert.equal(machineSignInAsked('c1', 'The build failed'), false);
  assert.equal(machineSignInAsked('c1', null), false);
  owner = null;
  assert.equal(machineSignInAsked('c1', failed.error.message), false);
});

test('the latest turn decides: a failed one asks, a running, later or missing one does not', async () => {
  assert.equal(await probe([failed]), true);
  assert.equal(await probe([{ ...failed, status: 'inProgress' }]), false, 'running');
  assert.equal(await probe([failed, { status: 'completed' }]), false, 'the latest turn did not fail');
  assert.equal(await probe(undefined), false, 'no turn: the strip is the only prompt');
  assert.equal(await probe([{ status: 'failed', error: { message: 'The build failed' } }]), false, 'an error that is not a sign-in');
  owner = null;
  assert.equal(await probe([failed]), false, 'a chat on this Mac');
});
