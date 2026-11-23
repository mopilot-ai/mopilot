// New cloud machine (NewCloudMachineSheet.tsx, CloudMachineSection.tsx; host.cloud): flag off shows nothing; the key is asked for the first time only ("Checking the key…", "That key was refused.") and is never shown again; the Machine step shows the price only when the provider publishes one and Limited disabled with its reason; the Create step follows the launch's step events, a failure shows the provider's words with Try again, Cancel cancels; Done starts a chat on the machine; the Cloud section's Delete names the chats first and sends the plan's token and the chats to carry.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, resetCtl, responses, calls, ctl, render, click, button, text, setValue, flush, act } from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { NewCloudMachineSheet, priceWords } = await import('../src/components/pages/settings/NewCloudMachineSheet.tsx');
const { renderMachines } = await import('./support/addMachineView.ts');
const { useCloudLines } = await import('../src/lib/hostCloud.ts');
const { parseMachineList } = await import('../src/lib/hostMachines.ts');
const { CloudMachineSection, CloudMachineSheet } = await import('../src/components/pages/settings/CloudMachineSection.tsx');

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
let push: (e: unknown) => void = () => undefined;
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
    'host.onCloud': (cb: (e: unknown) => void) => ((push = cb), () => undefined),
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
/** Past the key and the Machine step, to the Create step. */
const created = async (root: Element) => {
  await setValue(field(root, 'Name'), 'dev-cloud');
  await click(button(root, 'Create'));
};
const step = (e: Record<string, unknown>) => act(() => push({ kind: 'step', launch: 'l1', ...e }));

test('flag off: the sheet shows nothing and asks main for nothing', async () => {
  ctl.flags['host.cloud'] = false;
  const root = await sheet();
  assert.equal(root.host.innerHTML, '');
  assert.equal(named('host.cloudProviders').length, 0);
  const section = await render(
    h(CloudMachineSection, {
      machine: { id: 'c', name: 'c', cloud: { provider: 'oci', id: 'x', region: 'r', size: 's', network: 'full' } },
    }),
  );
  assert.equal(section.host.innerHTML, '');
});

test('the key is asked for the first time: one field per entry and a private key, Checking the key…, then the Machine step', async () => {
  let done: (v: unknown) => void = () => undefined;
  check = () => new Promise((r) => (done = r));
  const root = await sheet();
  assert.deepEqual(
    FIELDS.map((f) => !!field(root.host, f)),
    [true, true],
  );
  assert.equal(field(root.host, 'Private key').tagName, 'TEXTAREA');
  assert.equal(button(root.host, 'Save key').disabled, true, 'every field is needed');
  await typeKey(root.host);
  await click(button(root.host, 'Save key'));
  assert.match(text(root.host), /Checking the key…/);
  assert.equal(named('host.cloudSetKey')[0][1], 'oci');
  assert.deepEqual(Object.keys(named('host.cloudSetKey')[0][2]).sort(), ['privateKeyPem', 'tenancy', 'user']);
  await act(async () => done({ ok: true }));
  await flush();
  assert.equal(field(root.host, 'Private key'), null, 'the key is not shown again');
  assert.ok(field(root.host, 'Name'), 'the Machine step');
  assert.equal(root.host.innerHTML.includes('BEGIN PRIVATE KEY'), false);
});

test('a refused key says so and is not kept', async () => {
  check = () => Promise.resolve({ ok: false, code: 'unauthorized', message: 'Authorization failed' });
  const root = await sheet();
  await typeKey(root.host);
  await click(button(root.host, 'Save key'));
  await flush();
  assert.match(text(root.host), /That key was refused\./);
  assert.deepEqual(named('host.cloudRemoveKey'), [['host.cloudRemoveKey', 'oci']]);
  assert.ok(field(root.host, 'Private key'), 'the form stays for another try');
});

test('a key main cannot keep shows why; a check that throws reads as refused', async () => {
  responses['host.cloudSetKey'] = () => Promise.reject(new Error('The private key is not a PEM key.'));
  const root = await sheet();
  await typeKey(root.host);
  await click(button(root.host, 'Save key'));
  await flush();
  assert.match(text(root.host), /The private key is not a PEM key\./);
  responses['host.cloudSetKey'] = () => Promise.resolve({ ok: true });
  check = () => Promise.reject(new Error('offline'));
  await click(button(root.host, 'Save key'));
  await flush();
  assert.match(text(root.host), /That key was refused\./);
});

test('with a key kept the Provider step is skipped; Cancel closes', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  const root = await sheet();
  assert.equal(field(root.host, 'Private key'), null);
  assert.ok(field(root.host, 'Name'));
  await click(button(root.host, 'Cancel'));
  assert.equal(onClose, 1);
});

test('several providers: a picker; no providers: nothing to ask', async () => {
  providers = [
    { id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true },
    { id: 'other', label: 'Other', fields: [], hasKey: false },
  ];
  const root = await sheet();
  assert.deepEqual([...root.host.querySelectorAll('select[aria-label=Provider] option')].map(text), ['Oracle Cloud', 'Other']);
  providers = [];
  const empty = await sheet();
  assert.equal(empty.host.querySelector('input'), null);
});

test('Machine step: the price only when published, Limited disabled with its reason, Create needs a name', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  const root = await sheet();
  const sizes = [...root.host.querySelectorAll('[aria-label=Size] label')].map(text);
  assert.deepEqual(sizes, ['Small · 2 CPU · 8 GBabout $0.04/hour', 'Large · 8 CPU · 32 GB']);
  assert.equal(radio(root.host, 'Network', 'Limited').disabled, true);
  assert.match(text(root.host), /Limited needs a private network/);
  assert.equal(radio(root.host, 'Network', 'Full').checked, true);
  assert.equal(button(root.host, 'Create').disabled, true);
  await setValue(field(root.host, 'Name'), 'dev-cloud');
  assert.equal(button(root.host, 'Create').disabled, false);
  assert.equal((field(root.host, 'Region') as unknown as HTMLSelectElement).value, 'us-1');
  await click(radio(root.host, 'Size', 'Large'));
  await act(async () => {
    responses['host.cloudOptions'] = () => Promise.resolve({ ...OPTIONS, flags: { limitedNetwork: true }, reasons: {} });
  });
  await setValue(field(root.host, 'Region'), 'eu-1', 'change');
  await flush();
  assert.equal(radio(root.host, 'Network', 'Limited').disabled, false, 'the region asked again');
  assert.equal(named('host.cloudOptions').at(-1)![2], 'eu-1');
  await click(radio(root.host, 'Network', 'Limited'));
  await click(button(root.host, 'Create'));
  assert.deepEqual(named('host.cloudLaunch')[0][1], {
    provider: 'oci',
    name: 'dev-cloud',
    size: 'large',
    region: 'eu-1',
    network: 'limited',
  });
});

test('options that cannot be read say why', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  responses['host.cloudOptions'] = () => Promise.reject(new Error('The provider did not answer.'));
  const root = await sheet();
  assert.match(text(root.host), /The provider did not answer\./);
  assert.equal(button(root.host, 'Create').disabled, true);
});

test('priceWords: published prices only, in the currency', () => {
  assert.equal(priceWords(null, 'USD'), '');
  assert.equal(priceWords(Number.NaN, 'USD'), '');
  assert.equal(priceWords(0.5, 'USD'), 'about $0.5/hour');
  assert.equal(priceWords(0.004, 'EUR'), 'about 0.004 EUR/hour');
});

test('Create step: each of the four steps shows running, done, then the sheet says it is ready and starts a chat on the machine', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  const root = await sheet();
  await created(root.host);
  await act(async () => push({ kind: 'launch', launch: 'l1' }));
  const states = () => [...root.host.querySelectorAll('.cloud-steps li')].map((li) => `${text(li)}:${li.getAttribute('data-state')}`);
  assert.deepEqual(states(), ['Create the machine:waiting', 'Start the Host:waiting', 'Connect:waiting', 'Pair:waiting']);
  await step({ step: 'create', state: 'running' });
  assert.equal(states()[0], 'Create the machine:running');
  await step({ step: 'create', state: 'done' });
  await step({ step: 'start', state: 'running' });
  await step({ launch: 'other', step: 'start', state: 'failed', error: 'not ours' });
  assert.deepEqual(
    states().map((s) => s.split(':')[1]),
    ['done', 'running', 'waiting', 'waiting'],
  );
  for (const s of ['start', 'connect', 'pair']) await step({ step: s, state: 'done' });
  assert.deepEqual(
    states().map((s) => s.split(':')[1]),
    ['done', 'done', 'done', 'done'],
  );
  assert.match(text(root.host), /Cancel deletes what was made\./);
  await act(async () => launch.resolve({ id: 'cloud:oci:1', providerId: 'ocid1' }));
  assert.match(text(root.host), /dev-cloud is ready/);
  await click(button(root.host, 'Start a chat on it'));
  assert.deepEqual(named('pickNewChatHost')[0].slice(1), [{ id: 'cloud:oci:1', name: 'dev-cloud' }]);
  assert.deepEqual(named('navigate')[0].slice(1), [{ name: 'home' }]);
  assert.equal(onClose, 1);
});

test('a failed step shows the provider’s words and Try again launches once more; a failure with no step says the error', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  const root = await sheet();
  await created(root.host);
  await act(async () => push({ kind: 'launch', launch: 'l1' }));
  await step({ step: 'create', state: 'running' });
  await step({ step: 'create', state: 'failed', error: 'Out of host capacity.' });
  await act(async () => launch.reject(Object.assign(new Error('ignored'), { code: 'failed' })));
  assert.match(text(root.host.querySelector('[role=alert]')), /Out of host capacity\./);
  assert.equal(root.host.querySelector('.cloud-steps li')!.getAttribute('data-state'), 'failed');
  await click(button(root.host, 'Try again'));
  assert.equal(named('host.cloudLaunch').length, 2);
  assert.equal(root.host.querySelector('[role=alert]'), null, 'the steps start over');
  await act(async () => launch.reject(new Error('The size is not offered here.')));
  assert.match(text(root.host.querySelector('[role=alert]')), /The size is not offered here\./);
});

test('Cancel ends the creation at main and goes back to the Machine step; the rejection that follows is not a failure', async () => {
  providers = [{ id: 'oci', label: 'Oracle Cloud', fields: FIELDS, hasKey: true }];
  const root = await sheet();
  await created(root.host);
  await act(async () => push({ kind: 'launch', launch: 'l1' }));
  await click(button(root.host, 'Cancel'));
  assert.deepEqual(named('host.cloudCancel'), [['host.cloudCancel', 'l1']]);
  assert.ok(field(root.host, 'Name'));
  await act(async () => launch.reject(Object.assign(new Error('Cancelled.'), { code: 'cancelled' })));
  assert.equal(root.host.querySelector('[role=alert]'), null);
  assert.ok(field(root.host, 'Name'));
  // a launch that resolves after Cancel does not jump to Done
  await created(root.host);
  await click(button(root.host, 'Cancel'));
  await act(async () => launch.resolve({ id: 'x', providerId: 'y' }));
  assert.equal(/is ready/.test(text(root.host)), false);
});

const MACHINE = {
  id: 'cloud:oci:1',
  name: 'dev-cloud',
  cloud: { provider: 'oci', id: 'ocid1', region: 'us-1', size: 'small', network: 'limited' as const },
};

test('the Cloud section: provider, size, region, network from the record; Stop now calls main and a refusal is a toast', async () => {
  responses['host.cloudStop'] = () => Promise.resolve({ ok: true });
  const root = await render(h(CloudMachineSection, { machine: MACHINE }));
  assert.deepEqual([...root.host.querySelectorAll('.cloud-fact')].map(text), ['Provideroci', 'Sizesmall', 'Regionus-1', 'NetworkLimited']);
  await click(button(root.host, 'Stop now'));
  assert.deepEqual(named('host.cloudStop'), [['host.cloudStop', 'cloud:oci:1']]);
  responses['host.cloudStop'] = () => Promise.reject(new Error('Stop was refused.'));
  await click(button(root.host, 'Stop now'));
  assert.deepEqual(named('toast').at(-1)!.slice(1), ['Stop was refused.', 'error']);
  const plain = await render(h(CloudMachineSection, { machine: { id: 'a', name: 'a' } }));
  assert.equal(plain.host.innerHTML, '', 'not a cloud machine');
});

const PLAN = {
  token: 'tok-1',
  chats: [
    { chatId: 'c1', title: 'Fix login', folder: '/srv/app' },
    { chatId: 'c2', title: 'Nightly', folder: null },
  ],
};

test('Delete… names the chats first, offers to push each one’s work, says what is lost, and sends the token and the chosen chats', async () => {
  responses['host.cloudPlan'] = () => Promise.resolve(PLAN);
  responses['host.cloudDelete'] = () => Promise.resolve({ ok: true });
  const root = await render(h(CloudMachineSection, { machine: MACHINE }));
  await click(button(root.host, 'Delete…'));
  await flush();
  const dialog = root.host.querySelector('.dialog')!;
  assert.match(text(dialog), /Delete dev-cloud\? These chats run on it: Fix login, Nightly\./);
  assert.match(text(dialog), /Files that were not pushed are gone\./);
  const boxes = [...dialog.querySelectorAll('.cloud-chat')];
  assert.deepEqual(boxes.map(text), ['Fix loginPush unpushed work to a branch first', 'NightlyPush unpushed work to a branch first']);
  assert.equal(named('host.cloudDelete').length, 0, 'nothing is deleted before the red Delete');
  const input = (i: number) => boxes[i].querySelector('input') as HTMLInputElement;
  await click(input(0));
  await click(input(1));
  await click(input(1));
  await click(button(dialog, 'Delete'));
  assert.deepEqual(named('host.cloudDelete'), [['host.cloudDelete', 'cloud:oci:1', { token: 'tok-1', carry: ['c1'] }]]);
  assert.equal(root.host.querySelector('.dialog'), null, 'the sheet closes');
  assert.deepEqual(named('toast').at(-1)!.slice(1), ['dev-cloud deleted']);
});

test('Delete… with no chats, a refused delete and a plan that cannot be made', async () => {
  responses['host.cloudPlan'] = () => Promise.resolve({ token: 't', chats: [] });
  responses['host.cloudDelete'] = () => Promise.reject(new Error('The machine changed. Try again.'));
  const root = await render(h(CloudMachineSection, { machine: MACHINE }));
  await click(button(root.host, 'Delete…'));
  await flush();
  assert.match(text(root.host.querySelector('.dialog')), /^Delete dev-cloudDelete dev-cloud\?Files that were not pushed are gone\./);
  assert.equal(root.host.querySelector('.cloud-chats'), null);
  await click(button(root.host.querySelector('.dialog')!, 'Delete'));
  assert.match(text(root.host.querySelector('[role=alert]')), /The machine changed\. Try again\./);
  assert.equal(named('host.cloudDelete')[0][2].carry.length, 0);
  await click(button(root.host.querySelector('.dialog')!, 'Cancel'));
  assert.equal(root.host.querySelector('.dialog'), null);
  responses['host.cloudPlan'] = () => Promise.reject(new Error('No plan.'));
  await click(button(root.host, 'Delete…'));
  await flush();
  assert.match(text(root.host.querySelector('[role=alert]')), /No plan\./);
  assert.equal(button(root.host.querySelector('.dialog')!, 'Delete').disabled, true);
});

test('the section in its sheet', async () => {
  let closed = 0;
  const root = await render(h(CloudMachineSheet, { machine: MACHINE, onClose: () => void (closed += 1) }));
  assert.match(text(root.host), /dev-cloud.*Cloud.*Provider/);
  await click(button(root.host, 'Close'));
  assert.equal(closed, 1);
});

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

test('the machine list keeps a whole cloud record and drops a partial one', () => {
  const list = parseMachineList({
    machines: [
      ROW,
      { ...ROW, id: 'b', cloud: { provider: 'oci' } },
      { ...ROW, id: 'c', cloud: { provider: 'oci', id: 'x', network: 'limited' } },
      { ...ROW, id: 'd', cloud: { provider: 'oci', id: 'y' } },
    ],
    resolved: true,
  })!;
  assert.deepEqual(
    list.machines.map((m) => m.cloud),
    [
      MACHINE.cloud,
      undefined,
      { provider: 'oci', id: 'x', region: '', size: '', network: 'limited' },
      { provider: 'oci', id: 'y', region: '', size: '', network: 'full' },
    ],
  );
});

test('Settings: Add machine offers New cloud machine… as a fourth way in only with the flag on, and it opens the sheet', async () => {
  ctl.flags['host.cloud'] = false;
  const off = await mounted([]);
  await click(button(off.host, 'Add machine'));
  assert.equal(buttonsNamed(off.host, 'New cloud machine…'), 0);
  ctl.flags['host.cloud'] = true;
  const on = await mounted([]);
  await click(on.host.querySelectorAll('button.btn-pill.primary')[0]);
  await click(button(on.host, 'New cloud machine…'));
  await flush();
  assert.equal(on.host.querySelector('.dialog-head')?.textContent, 'New cloud machine');
  assert.equal(named('host.cloudProviders').length, 1);
});

test('Settings: a cloud machine’s row menu has Cloud…, which opens its Cloud section; other machines and the flag off have none', async () => {
  const root = await mounted([ROW, { ...ROW, id: 'ssh:a', name: 'a', cloud: undefined }]);
  const items = () => [...root.host.querySelectorAll('.menu-item')].filter((b) => text(b) === 'Cloud…');
  for (const more of root.host.querySelectorAll('button.icon-btn[aria-label^="More for"]')) await click(more);
  assert.equal(items().length, 1);
  await click(items()[0]);
  assert.match(text(root.host.querySelector('.dialog')), /dev-cloud.*Cloud.*Provider/);
  ctl.flags['host.cloud'] = false;
  const off = await mounted([ROW]);
  await click(off.host.querySelector('button.icon-btn[aria-label^="More for"]')!);
  assert.equal([...off.host.querySelectorAll('.menu-item')].filter((b) => text(b) === 'Cloud…').length, 0);
});

const buttonsNamed = (root: Element, label: string) => [...root.querySelectorAll('button')].filter((b) => text(b) === label).length;

function Lines({ ids }: { ids: string[] }) {
  const lines = useCloudLines(ids);
  return h('div', { id: 'lines' }, [...lines].map(([id, l]) => `${id}=${l?.line ?? '-'}`).join('|'));
}

test('useCloudLines: each cloud machine’s line from main, read again when its state changes; nothing asked with the flag off', async () => {
  let line = { line: 'Waking…', dot: 'warn', action: null } as unknown;
  responses['host.cloudLine'] = (id: string) => (id === 'bad' ? Promise.reject(new Error('x')) : Promise.resolve(line));
  const root = await render(h(Lines, { ids: ['a', 'bad'] }));
  await flush();
  assert.equal(text(root.host), 'a=Waking…|bad=-');
  line = { line: 'Asleep · wakes on next message', dot: 'off', action: 'Wake' };
  await act(async () => push({ kind: 'step', launch: 'l', step: 'create', state: 'running' }));
  assert.equal(text(root.host), 'a=Waking…|bad=-', 'a creation step is not a line change');
  await act(async () => push({ kind: 'state', hostId: 'a' }));
  await flush();
  assert.equal(text(root.host), 'a=Asleep · wakes on next message|bad=-');
  await root.rerender(h(Lines, { ids: [] }));
  assert.equal(text(root.host), '');
  ctl.flags['host.cloud'] = false;
  calls.length = 0;
  await root.rerender(h(Lines, { ids: ['a'] }));
  await flush();
  assert.equal(named('host.cloudLine').length, 0);
  await root.unmount();
});
