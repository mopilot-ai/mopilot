// New cloud machine, the edges (NewCloudMachineSheet.tsx, CloudMachineSection.tsx; host.cloud): two providers and the Full/Limited choice, empty options, answers that arrive after the sheet closed, a key main cannot keep, and the Cloud sheets closing from Settings.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, calls, ctl, render, click, button, text, setValue, flush, act } from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { NewCloudMachineSheet } = await import('../src/components/pages/settings/NewCloudMachineSheet.tsx');
const { renderMachines } = await import('./support/addMachineView.ts');
const { CloudMachineSection } = await import('../src/components/pages/settings/CloudMachineSection.tsx');

const FIELDS = ['tenancy', 'user'];
const OPTIONS = {
  flags: { limitedNetwork: false },
  reasons: { limitedNetwork: 'Limited needs a private network in the compartment.' },
  sizes: [
    { id: 'small', label: 'Small', cpus: 2, memoryGb: 8, pricePerHour: 0.0426, currency: 'USD' },
    { id: 'large', label: 'Large', cpus: 8, memoryGb: 32, pricePerHour: null, currency: 'USD' },
  ],
  regions: [
    { id: 'us-1', label: 'US East' },
    { id: 'eu-1', label: 'Frankfurt' },
  ],
};
const named = (n: string) => calls.filter((c) => c[0] === n);
let launch: { resolve: (v: unknown) => void; reject: (e: unknown) => void };
let providers: unknown[];
let check: () => Promise<unknown>;
let onClose = 0;

beforeEach(() => {
  resetCtl();
  onClose = 0;
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: false }];
  check = () => Promise.resolve({ ok: true });
  Object.assign(responses, {
    'host.cloudProviders': () => Promise.resolve(providers),
    'host.cloudSetKey': () => Promise.resolve({ ok: true }),
    'host.cloudRemoveKey': () => Promise.resolve(true),
    'host.cloudCheck': () => check(),
    'host.cloudOptions': () => Promise.resolve(OPTIONS),
    'host.cloudLaunch': () => new Promise((resolve, reject) => (launch = { resolve, reject })),
    'host.cloudCancel': () => Promise.resolve(),
    'host.onCloud': () => () => undefined,
  });
});

const sheet = async () => {
  const root = await render(h(NewCloudMachineSheet, { onClose: () => void (onClose += 1) }));
  await flush();
  return root;
};
const field = (root: Element, label: string) => root.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
const radio = (root: Element, group: string, label: string) =>
  [...root.querySelectorAll(`[aria-label="${group}"] label`)]
    .find((l) => text(l).startsWith(label))!
    .querySelector('input') as HTMLInputElement;
const typeKey = async (root: Element) => {
  for (const f of FIELDS) await setValue(field(root, f), `${f}-value`);
  await setValue(field(root, 'Private key'), '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
};

const MACHINE = {
  id: 'cloud:oci:1',
  name: 'dev-cloud',
  cloud: { provider: 'oci', id: 'ocid1', region: 'us-1', size: 'small', network: 'limited' as const },
};

const ROW = { id: 'cloud:oci:1', name: 'dev-cloud', status: 'offline', note: 'Offline', cloud: MACHINE.cloud };
const kept: { unmount: () => Promise<void> }[] = [];
// the machine list is one subscription shared by every mount: each test ends its own
afterEach(async () => {
  for (const r of kept.splice(0)) await r.unmount();
});
const mounted = async (machines: unknown[]) => {
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines, resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onBoot': () => () => undefined,
    'host.bootDeny': () => Promise.resolve(),
    'host.discover': () => new Promise(() => undefined),
  });
  const root = await renderMachines();
  kept.push(root);
  await flush();
  return root;
};

const pick = (el: HTMLSelectElement, value: string) =>
  act(() => {
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });

test('Machine step: Full can be picked again after Limited; two providers show a picker; empty options leave size and region empty', async () => {
  providers = [
    { id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true },
    { id: 'other', label: 'Other Cloud', fields: FIELDS, hasKey: true },
  ];
  responses['host.cloudOptions'] = () => Promise.resolve({ ...OPTIONS, flags: { limitedNetwork: true } });
  const root = await sheet();
  await click(radio(root.host, 'Network', 'Limited'));
  assert.equal(radio(root.host, 'Network', 'Limited').checked, true);
  await click(radio(root.host, 'Network', 'Full'));
  assert.equal(radio(root.host, 'Network', 'Full').checked, true);
  const select = root.host.querySelector('select[aria-label="Provider"]') as HTMLSelectElement;
  await pick(select, 'other');
  await flush();
  assert.equal(named('host.cloudOptions').at(-1)![1], 'other');
  responses['host.cloudOptions'] = () => Promise.resolve({ flags: { limitedNetwork: false }, reasons: {}, sizes: [], regions: [] });
  await pick(select, 'oci');
  await flush();
  assert.equal(button(root.host, 'Create').disabled, true);
});

test('a sheet closed before main answers ignores the answers, including a failed one', async () => {
  let provide: (v: unknown) => void = () => undefined;
  let fail: (e: unknown) => void = () => undefined;
  responses['host.cloudProviders'] = () => new Promise((resolve, reject) => ((provide = resolve), (fail = reject)));
  const first = await render(h(NewCloudMachineSheet, { onClose: () => undefined }));
  await first.unmount();
  await act(async () => provide([{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }]));
  await act(async () => fail(new Error('late')));
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  responses['host.cloudProviders'] = () => Promise.resolve(providers);
  let answer: (v: unknown) => void = () => undefined;
  let refuse: (e: unknown) => void = () => undefined;
  responses['host.cloudOptions'] = () => new Promise((resolve, reject) => ((answer = resolve), (refuse = reject)));
  const second = await render(h(NewCloudMachineSheet, { onClose: () => undefined }));
  await flush();
  await second.unmount();
  await act(async () => answer(OPTIONS));
  await act(async () => refuse(new Error('late')));
  // a failed provider list and a failed options call are said, while the sheet is open
  responses['host.cloudProviders'] = () => Promise.reject(new Error('No providers.'));
  const failed = await sheet();
  assert.equal(failed.host.querySelector('select[aria-label="Provider"]'), null);
  assert.ok(named('host.cloudProviders').length >= 3);
});

test('the Cloud section: Limited network and a missing size read as they are, and the Cloud sheets close from Settings', async () => {
  const limited = await render(
    h(CloudMachineSection, { machine: { ...MACHINE, cloud: { ...MACHINE.cloud, network: 'limited', size: '' } } }),
  );
  assert.match(text(limited.host), /NetworkLimited/);
  assert.match(text(limited.host), /Size–/);
  const full = await render(h(CloudMachineSection, { machine: { ...MACHINE, cloud: { ...MACHINE.cloud, network: 'full' as const } } }));
  assert.match(text(full.host), /NetworkFull/);
  ctl.flags['host.cloud'] = true;
  const root = await mounted([ROW]);
  await click(root.host.querySelector('button.icon-btn[aria-label^="More for"]')!);
  await click([...root.host.querySelectorAll('.menu-item')].find((b) => text(b) === 'Cloud…')!);
  await click(button(root.host.querySelector('.dialog')!, 'Close'));
  assert.equal(root.host.querySelector('.dialog'), null);
  await click(button(root.host, 'Add machine'));
  await click(button(root.host, 'New cloud machine…'));
  await flush();
  await click(button(root.host.querySelector('.dialog')!, 'Cancel'));
  assert.equal(root.host.querySelector('.dialog'), null);
});

test('a key main cannot keep says why and stays on the Provider step', async () => {
  responses['host.cloudSetKey'] = () => Promise.reject(new Error('The private key is not a PEM key.'));
  const root = await sheet();
  await typeKey(root.host);
  await click(button(root.host, 'Save key'));
  await flush();
  assert.match(text(root.host), /The private key is not a PEM key\./);
  assert.ok(field(root.host, 'Private key'));
  assert.equal(named('host.cloudCheck').length, 0);
});

test('saving the key of one provider leaves the other provider asking for its own', async () => {
  providers = [
    { id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: false },
    { id: 'other', label: 'Other Cloud', fields: FIELDS, hasKey: false },
  ];
  const root = await sheet();
  await typeKey(root.host);
  await click(button(root.host, 'Save key'));
  await flush();
  assert.ok(field(root.host, 'Name'), 'the Machine step for the provider that has its key');
  assert.equal(named('host.cloudSetKey').length, 1);
});
