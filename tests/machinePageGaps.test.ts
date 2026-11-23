// The corners of a machine's page (X2): the path a Host row carries, the readers' fallbacks, quiet hours turned off, a refused spending limit, a rule saved from the page itself and the page closed from its row.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, act } from 'react';
import './support/dom.ts';
import { render, one } from './support/shell-panels-kit.ts';
import { mockSource } from './support/stubs.ts';
import { installNative } from '../src/lib/native.ts';

const toasts: string[] = [];
mockSource('src/store/core.ts', { toast: (m: string) => void toasts.push(m) });
mockSource('src/lib/flags.ts', { useFlag: () => true, isEnabled: () => true, harnessEnabled: () => true, useEnabledHarnesses: () => [] });

const QUIET = { start: '22:00', end: '07:00', tz: 'UTC' };
const DOC = {
  version: 1,
  permissionMax: 'full-access',
  approvals: { remindMinutes: 10, pauseMinutes: 30 },
  notify: { needsYou: true, done: false, paused: true, detail: 'tool', quiet: QUIET },
  spend: { dayUsd: 20 },
};
// the status section follows the sign-ins main reports, for an account with Host
const setHost = (over: Record<string, unknown>) =>
  installNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      onSignin: () => () => undefined,
      signinViews: async () => [],
      ...over,
    },
  } as never);
beforeEach(() => setHost({}));

const data = await import('../src/lib/machinePageData.ts');
const { parseMachineList } = await import('../src/lib/hostMachines.ts');
const { MachinePage } = await import('../src/components/pages/settings/MachinePage.tsx');
const { MachineRulesSection } = await import('../src/components/pages/settings/MachineRulesSection.tsx');
const { MachineSpendingSection } = await import('../src/components/pages/settings/MachineSpendingSection.tsx');
const { MachineStatusSection } = await import('../src/components/pages/settings/MachineStatusSection.tsx');
const tick = () => new Promise((r) => setImmediate(r));
const machine = (o: object = {}) =>
  ({
    id: 'ssh:box',
    name: 'build-box',
    status: 'online',
    note: '',
    signin: null,
    capabilities: { iab: false, cu: false },
    agents: [],
    installable: [],
    lastSeen: null,
    localNetwork: 'unknown',
    waitingForLogin: null,
    startsAtBoot: 'unknown',
    fileVault: 'unknown',
    platform: '',
    ...o,
  }) as any;
const row = (path: unknown) => ({ id: 'ssh:box', name: 'box', note: '', status: 'online', path });
const pathOf = (path: unknown) => parseMachineList({ machines: [row(path)], resolved: true })!.machines[0].path;

test('a Host row carries the path it is reached by only when main says one of the three modes', () => {
  assert.deepEqual(pathOf({ mode: 'relay', path: 'relay', latencyMs: 80 }), { mode: 'relay', path: 'relay', latencyMs: 80 });
  assert.deepEqual(pathOf({ mode: 'auto', path: 'tcp', latencyMs: Number.NaN }), { mode: 'auto', path: null, latencyMs: null });
  assert.deepEqual(pathOf({ mode: 'ssh', path: 'ssh' }), { mode: 'ssh', path: 'ssh', latencyMs: null });
  assert.equal(pathOf({ mode: 'carrier-pigeon' }), undefined);
  assert.equal(pathOf(null), undefined);
});

test('the page’s readers fall back: an audit line without who, devices with no direct list, a phone with no state, a write main did not echo', async () => {
  assert.equal(data.readAudit([1, { at: 'x', kind: 'a' }, { at: 1 }]), undefined, 'lines without a time or a kind are dropped');
  assert.deepEqual(data.readAudit([{ at: 1, kind: 'chat.permit' }]), [{ at: 1, kind: 'chat.permit', who: '' }]);
  assert.deepEqual(data.readAudit([{ at: 1, kind: 'client.added', who: 'P', whoKind: 'phone' }]), [
    { at: 1, kind: 'client.added', who: 'P', whoKind: 'phone' },
  ]);
  setHost({
    clients: async () => [
      { id: 'p1', name: 'Pocket iPhone', kind: 'phone', addedAt: 1 },
      { id: 'd1', name: 'Work Mac', kind: 'desktop', addedAt: 2 },
    ],
  });
  let page = await data.loadMachinePage('ssh:box');
  assert.equal(
    page.devices?.every((d) => d.direct === undefined),
    true,
    'no direct list, no switch',
  );
  setHost({
    clients: async () => [
      { id: 'p1', name: 'Pocket iPhone', kind: 'phone', addedAt: 1 },
      { id: 'd1', name: 'Work Mac', kind: 'desktop', addedAt: 2 },
    ],
    phoneDirectList: async () => [
      { pairId: 'x', fingerprint: 'p1', state: 'weird' },
      { pairId: 'y', fingerprint: 'd1', state: 'on' },
    ],
  });
  page = await data.loadMachinePage('ssh:box');
  assert.equal(
    page.devices?.every((d) => d.direct === undefined),
    true,
    'an unknown state and a desktop get no switch',
  );
  setHost({ setOwnerPolicy: async () => undefined });
  const kept = await data.saveOwnerDoc(DOC, (c) => void (c.permissionMax = 'default'));
  assert.equal(kept.permissionMax, 'default', 'with nothing echoed the copy that was sent is what shows');
});

test('status: a path with nothing known about the relay shows the choice without a reach line', async () => {
  const r = await render(h(MachineStatusSection, { machine: machine({ path: { mode: 'auto', path: null, latencyMs: null } }), now: 0 }));
  assert.ok(r.host.querySelector('[aria-label="Connection"]'));
  await r.unmount();
});

test('rules: quiet hours say their span and turn off', async () => {
  const sent: any[] = [];
  setHost({ setOwnerPolicy: async (doc: any) => (sent.push(doc), { doc }) });
  const r = await render(h(MachineRulesSection, { doc: DOC, rules: data.readRules(DOC)!, onSaved: () => undefined }));
  assert.match(r.host.textContent!, /22:00 to 07:00/);
  await act(async () => (one(r.host, '[role=switch][aria-label="Quiet hours"]') as HTMLButtonElement).click());
  assert.equal(sent.at(-1).notify.quiet, null);
  await r.unmount();
});

test('spending: a limit main refuses says why', async () => {
  setHost({ setOwnerPolicy: async () => Promise.reject(new Error('Limit is too high.')) });
  const r = await render(
    h(MachineSpendingSection, {
      doc: DOC,
      spend: { dayUsd: 1, dayLimitUsd: 20, chatLimitUsd: null, unpriced: false },
      onSaved: () => undefined,
    }),
  );
  await act(async () => (one(r.host, '[aria-label="Daily limit"]') as HTMLButtonElement).click());
  await act(async () => (one(document.body, '[role^=menuitem]', '$5') as HTMLElement).click());
  assert.match(toasts.at(-1)!, /Limit is too high/);
  await r.unmount();
});

test('a rule saved on the page is what the rules and the spending line show next, and the page closes', async () => {
  setHost({
    ownerPolicy: async () => DOC,
    hostStatus: async () => ({ spend: { dayUsd: 4, unpriced: 2 } }),
    setOwnerPolicy: async (doc: any) => ({ doc: { ...doc, spend: { dayUsd: 5 } } }),
  });
  let closed = 0;
  const r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => void closed++ }));
  await act(tick);
  await act(async () => (one(r.host, '[role=switch][aria-label="Notify when a run is done"]') as HTMLButtonElement).click());
  assert.match(r.host.textContent!, /About \$4 today/);
  assert.match(r.host.textContent!, /no price/, 'a total with unpriced chats keeps saying so after a save');
  assert.match(r.host.textContent!, /Daily limit\$5/, 'the limit the saved document carries');
  await act(async () => (one(document.body, '[aria-label="Close"]') as HTMLButtonElement).click());
  assert.equal(closed, 1);
  await r.unmount();
});

test('a saved rule the page cannot read keeps the rules it had, and with no spending nothing is added', async () => {
  setHost({ ownerPolicy: async () => DOC, setOwnerPolicy: async () => ({ doc: { version: 1 } }) });
  const r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => undefined }));
  await act(tick);
  assert.equal(r.host.textContent!.includes('Spending'), false);
  await act(async () => (one(r.host, '[role=switch][aria-label="Notify when a run is done"]') as HTMLButtonElement).click());
  assert.match(r.host.textContent!, /22:00 to 07:00/, 'the rules still show');
  assert.equal(r.host.textContent!.includes('Spending'), false);
  await r.unmount();
});

test('a saved total with every chat priced says nothing about prices', async () => {
  setHost({
    ownerPolicy: async () => DOC,
    hostStatus: async () => ({ spend: { dayUsd: 4 } }),
    setOwnerPolicy: async (doc: any) => ({ doc }),
  });
  const r = await render(h(MachinePage, { machine: machine(), now: 0, onClose: () => undefined }));
  await act(tick);
  await act(async () => (one(r.host, '[role=switch][aria-label="Notify when a run is done"]') as HTMLButtonElement).click());
  assert.match(r.host.textContent!, /About \$4 today/);
  assert.equal(r.host.textContent!.includes('no price'), false);
  await r.unmount();
});
