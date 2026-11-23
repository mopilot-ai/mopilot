// A failed turn's sign-in recovery on a machine chat: the same shape as This Mac's, fed by the machine's own sign-in (src/session/machineAgent.ts).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, callsTo, moduleCalls } from './support/thread-kit.ts';

let machine: any = { id: 'ssh:box', name: 'build-box', away: false };
let need: any = null;
let signins = new Map<string, any>();
let base: any = null;
let startResult: () => Promise<unknown> = async () => {};
let basic: string | undefined = undefined;
let kind: string | undefined = undefined;
mockStore({ chatBasicHarness: () => basic });
autoMock('src/lib/chatMachine.ts', 'machine', { useChatMachine: () => ({ machine, pending: false }) });
autoMock('src/session/useHostSigninNeed.ts', 'need', { useHostAgentThere: () => need });
autoMock('src/store/machineChatSwitch.ts', 'sw', { agentOfKind: () => kind });
autoMock('src/session/chatActions.ts', 'chat', { authRecovery: () => base });
autoMock('src/lib/hostSignin.ts', 'signin', {
  useHostSignins: () => signins,
  RUNNING: new Set(['starting', 'waiting']),
  signinKey: (m: string, a: string) => `${m}\n${a}`,
  startSignin: (...a: unknown[]) => (moduleCalls.push(['signin:startSignin', a]), startResult()),
  cancelSignin: (...a: unknown[]) => (moduleCalls.push(['signin:cancelSignin', a]), Promise.resolve()),
});
const { useAuthRecovery, useMachineAgent } = await import('../src/session/machineAgent.ts');

let got: any = null;
function Probe() {
  got = useAuthRecovery('c1', 'Not signed in: x');
  return null;
}
let seen: any = null;
function AgentProbe() {
  seen = useMachineAgent('c1');
  return null;
}
const mount = () => render(h(Probe));

beforeEach(() => {
  resetStore({ chatConfig: {} });
  moduleCalls.length = 0;
  machine = { id: 'ssh:box', name: 'build-box', away: false };
  need = { machine, agent: { id: 'claude', label: 'Claude Code' }, standIn: false };
  signins = new Map();
  base = { label: 'Sign in on machine', signIn: () => moduleCalls.push(['base', []]) };
  startResult = async () => {};
  got = null;
  basic = undefined;
  kind = undefined;
  seen = null;
});

test('on this Mac, or with nothing to recover, the recovery is the base’s', async () => {
  machine = null;
  await mount();
  assert.equal(got, base);
  machine = { id: 'ssh:box', name: 'build-box', away: false };
  base = null;
  await mount();
  assert.equal(got, null);
});

test('on a machine the button is named for it and starts that machine’s own sign-in', async () => {
  await mount();
  assert.equal(got.label, 'Sign in on build-box');
  assert.equal(got.recheck, undefined);
  assert.equal(got.waiting.text(), null);
  got.signIn();
  assert.deepEqual(callsTo('signin:startSignin'), [['ssh:box', 'claude']]);
});

test('a refused start is told', async () => {
  startResult = () => Promise.reject(new Error('machine is busy'));
  await mount();
  got.signIn();
  await new Promise((r) => setImmediate(r));
  assert.equal(callsTo('store:toast').length, 1);
});

test('while the sign-in runs its progress is the waiting row, with Cancel', async () => {
  signins = new Map([['ssh:box\nclaude', { state: 'waiting', link: 'u', codes: ['AB-12'] }]]);
  await mount();
  assert.equal(got.waiting.text(), 'Enter this code in the page that opened: AB-12');
  signins = new Map([['ssh:box\nclaude', { state: 'waiting', link: 'u', codes: [] }]]);
  await mount();
  assert.equal(got.waiting.text(), 'Finish signing in in your browser');
  got.waiting.cancel();
  assert.deepEqual(callsTo('signin:cancelSignin'), [['ssh:box', 'claude']]);
});

test('where the machine does not list the agent only the label changes: its row in Settings stays the way', async () => {
  need = null;
  await mount();
  assert.equal(got.label, 'Sign in on build-box');
  assert.equal(got.signIn, base.signIn);
});

test('the chat’s agent there: the kind it asked for, else its harness’s family, else the harness itself, else none; the saved choice only on a machine', async () => {
  const agent = async () => (await render(h(AgentProbe)), seen);
  kind = 'codex';
  assert.equal((await agent()).agentId, 'codex');
  kind = undefined;
  basic = 'host-claude';
  assert.equal((await agent()).agentId, 'claude');
  basic = 'kimi';
  assert.equal((await agent()).agentId, 'kimi');
  basic = undefined;
  assert.equal((await agent()).agentId, '');
  assert.equal((await agent()).saved, undefined);
  const hostSelection = { hostId: 'ssh:box', harness: 'claude', model: 'opus', effort: null };
  resetStore({ chatConfig: { c1: { hostSelection } } });
  assert.deepEqual((await agent()).saved, hostSelection);
  resetStore({ chatConfig: undefined });
  assert.equal((await agent()).saved, undefined);
  machine = null;
  need = null; // the real hook answers null on this Mac
  resetStore({ chatConfig: { c1: { hostSelection } } });
  const here = await agent();
  assert.deepEqual([here.machine, here.agentId, here.saved, here.agent], [null, '', undefined, null]);
});

test('the waiting row names the agent by its label, else by its id’s name, and adds the code when there is one', async () => {
  need = { machine, agent: { id: 'claude', label: '' }, standIn: false };
  basic = 'host-claude';
  signins = new Map([['ssh:box\nclaude', { state: 'waiting', link: 'u', codes: [] }]]);
  await mount();
  assert.match(got.waiting.text(), /^Finish signing in in your browser/);
  signins = new Map([['ssh:box\nclaude', { state: 'done' }]]);
  await mount();
  assert.equal(got.waiting.text(), null, 'a finished sign-in is no waiting row');
});
