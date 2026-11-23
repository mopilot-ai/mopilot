// A machine's row opens its page only with host.machinePage on (MachineRow.tsx, X2); an app whose flags cannot be read fails closed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import './support/dom.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { installNative } from '../src/lib/native.ts';
// the machine page's status section follows the sign-ins of an account with Host
const HOST = { access: async () => true, onAccess: () => () => undefined, onSignin: () => () => undefined, signinViews: async () => [] };

const machine = (o: object = {}) =>
  ({
    id: 'ssh:box',
    name: 'build-box',
    status: 'online',
    note: '',
    signin: null,
    capabilities: { iab: false, cu: false },
    agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
    installable: [],
    lastSeen: null,
    localNetwork: 'unknown',
    waitingForLogin: null,
    startsAtBoot: 'unknown',
    fileVault: 'unknown',
    platform: '',
    ...o,
  }) as any;

test('the row opens the page only with host.machinePage on; the flag read fails closed', async () => {
  const { MachineRow } = await import('../src/components/pages/settings/MachineRow.tsx');
  const props = { machine: machine(), signins: new Map(), installs: new Map(), onInstall: () => undefined, now: 0 } as any;
  installNative({ host: HOST, flags: { isEnabled: (k: string) => k === 'host.machinePage', onChanged: () => () => undefined } } as never);
  let r = await render(h(MachineRow, props));
  await act(async () => (one(r.host, '[role=button]') as HTMLElement).click());
  assert.ok(document.body.querySelector('.machine-page'), 'the page is open');
  await r.unmount();
  installNative({ host: HOST, flags: { isEnabled: () => false, onChanged: () => () => undefined } } as never);
  r = await render(h(MachineRow, props));
  assert.equal(r.host.querySelector('.machine-main[role=button]'), null);
  await r.unmount();
  installNative({ host: HOST } as never);
  r = await render(h(MachineRow, props));
  assert.equal(r.host.querySelector('.machine-main[role=button]'), null, 'an app with no flags shows no page');
  await r.unmount();
});

test('the page closes from its own close button', async () => {
  const { MachineRow } = await import('../src/components/pages/settings/MachineRow.tsx');
  const props = { machine: machine(), signins: new Map(), installs: new Map(), onInstall: () => undefined, now: 0 } as any;
  installNative({ host: HOST, flags: { isEnabled: () => true, onChanged: () => () => undefined } } as never);
  const r = await render(h(MachineRow, props));
  await act(async () => (one(r.host, '[role=button]') as HTMLElement).click());
  await act(async () => (one(document.body, '[aria-label="Close"]') as HTMLElement).click());
  assert.equal(document.body.querySelector('.machine-page'), null);
  await r.unmount();
});
