// The renderer's follow of Host's gate (src/lib/host.ts, electron/app/ipc/host.cjs, electron/bridge/host.cjs): false until main answers, then main's answer and each pushed change; a preload without the bridge never shows Host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { createRequire } from 'node:module';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const require = createRequire(import.meta.url);
const { useHostAccess, hostAllowedNow } = await import('../src/lib/host.ts');

const seen: boolean[] = [];
function Probe() {
  const allowed = useHostAccess();
  seen.push(allowed);
  return null;
}
async function mount() {
  const el = document.createElement('div');
  document.body.append(el);
  await act(async () => createRoot(el).render(createElement(Probe)));
}

test('a window whose bridge is not installed yet, or has no Host, shows nothing and follows main once it can', async () => {
  seen.length = 0;
  await mount();
  assert.equal(seen.at(-1), false, 'no bridge yet');
  assert.equal(hostAllowedNow(), false, 'code outside a component reads the same answer');
  installNative(fakeNative({ host: null }));
  await mount();
  assert.equal(seen.at(-1), false, 'a preload without the Host bridge');
});

test('main’s answer and its pushed changes are followed, a malformed push counts as no', async () => {
  const fake = fakeNative({ host: { access: async () => true } });
  installNative(fake);
  seen.length = 0;
  await mount();
  assert.equal(seen.at(-1), true);
  assert.equal(hostAllowedNow(), true);
  await act(async () => fake.emit('host.onAccess', false));
  assert.equal(seen.at(-1), false);
  assert.equal(hostAllowedNow(), false);
  await act(async () => fake.emit('host.onAccess', 'yes'));
  assert.equal(seen.at(-1), false, 'a push that is not true is no');
  await act(async () => fake.emit('host.onAccess', true));
  assert.equal(seen.at(-1), true);
  // a second window following the same answer does not start a second read
  await mount();
  assert.equal(seen.at(-1), true);
  assert.equal(fake.callsTo('host.access').length, 1);
});

test('the IPC answers with the gate and the bridge names its channels', async () => {
  const handlers = new Map<string, () => unknown>();
  require('../electron/app/ipc/host.cjs').register({ handle: (c: string, f: () => unknown) => handlers.set(c, f) });
  assert.equal(handlers.get('host:access')!(), false, 'no gate open yet');
  assert.deepEqual(await handlers.get('host:openSideChat')!(), { value: null }, 'local side chats work with Host off');
  assert.deepEqual(Object.keys(require('../electron/bridge/host.cjs')), [
    'access',
    'onAccess',
    'machines',
    'onMachines',
    'onMachineRemoved',
    'add',
    'addLocal',
    'cancelAdd',
    'removeLocal',
    'pair',
    'update',
    'check',
    'startHost',
    'rename',
    'setStartAtBoot',
    'startAtBootCommand',
    'rotateKey',
    'removePlan',
    'uninstall',
    'remove',
    'pendingDeletions',
    'owner',
    'picture',
    'remoteChats',
    'continueChat',
    'codePlan',
    'planRelease',
    'signin',
    'signinViews',
    'signinInput',
    'cancelSignin',
    'onSignin',
    'apiKeys',
    'setApiKey',
    'removeApiKey',
    'ownerPolicy',
    'setOwnerPolicy',
    'clients',
    'removeClient',
    'audit',
    'hostStatus',
    'phoneDirectList',
    'phoneDirectSet',
    'signOutEverywhere',
    'orgAccess',
    'setOrgAccess',
    'removeOrgAccess',
    'orgSignIn',
    'orgSignOut',
    'onOrgAccess',
    'cloudProviders',
    'cloudSetKey',
    'cloudRemoveKey',
    'cloudCheck',
    'cloudOptions',
    'cloudLaunch',
    'cloudCancel',
    'cloudWake',
    'cloudStop',
    'cloudPlan',
    'cloudDelete',
    'cloudLine',
    'onCloud',
    'switchChat',
    'goalChat',
    'installAgent',
    'cancelInstallAgent',
    'onAgentInstall',
    'onInstallStep',
    'onPrompt',
    'answerPrompt',
    'discover',
    'reachable',
    'fsList',
    'fsSearch',
    'sidebarRepository',
    'gitStatus',
    'commands',
    'gitDiff',
    'gitTurnDiff',
    'gitBranches',
    'gitSwitch',
    'gitCommit',
    'gitDiscard',
    'fsTree',
    'fsRead',
    'clone',
    'worktree',
    'bindFolder',
    'startChat',
    'openSideChat',
    'gitSignIn',
    'forwardPort',
    'setPath',
    'bootStart',
    'bootView',
    'bootAllow',
    'bootDeny',
    'onBoot',
    'attentions',
    'onAttention',
    'onCloneProgress',
  ]);
});
