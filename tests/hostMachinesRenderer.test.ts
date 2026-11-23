// The renderer's remote machines: the list followed from main (src/lib/hostMachines.ts) and Settings › Connections › Machines (HostMachines.tsx, AddMachineSheet.tsx): gated by Host access, malformed lists ignored (B1), install steps shown as they arrive, a failed install and a failed pairing kept visible with a retry, and the pasted code. The row itself is in tests/hostMachineRow.test.ts.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  click,
  button,
  text,
  setValue,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');
const { parseMachineList } = await import('../src/lib/hostMachines.ts');

test('the list preserves an explicit registry read failure', () => {
  assert.deepEqual(parseMachineList({ machines: [], resolved: true, registryUnreadable: true }), {
    machines: [],
    resolved: true,
    registryUnreadable: true,
  });
});

const ROW = {
  id: 'ssh:a',
  name: 'a',
  status: 'online',
  note: 'SSH · claude',
  signin: null,
  capabilities: { iab: false, cu: false, desktop: false },
  agents: [],
  installable: [],
  lastSeen: null,
  localNetwork: 'unknown',
  waitingForLogin: null,
  startsAtBoot: 'unknown',
  fileVault: 'unknown',
  platform: '',
};
let pushAccess: (v: unknown) => void = () => undefined;
let pushMachines: (v: unknown) => void = () => undefined;
let pushStep: (v: unknown) => void = () => undefined;
const reads: unknown[] = [];

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': (cb: any) => ((pushAccess = cb), () => undefined),
    'host.machines': () => Promise.resolve(reads.shift() ?? { machines: [ROW], resolved: true }),
    'host.onMachines': (cb: any) => ((pushMachines = cb), () => undefined),
    'host.onInstallStep': (cb: any) => ((pushStep = cb), () => undefined),
    'host.onPrompt': () => () => undefined,
    'host.onSignin': () => () => undefined,
    // the folder picker a paired machine opens by itself
    'host.fsList': () => Promise.resolve({ value: { path: '/home/me', roots: ['/home/me'], entries: [] } }),
  });
  reads.length = 0;
  calls.length = 0;
});

const input = (root: Element, label: string) => root.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c.slice(1));

/** Opens the Add machine sheet (one field, no tabs). */
async function openSheet(host: Element) {
  await click(button(host, 'Add machine'));
}

test('#4923: the list parser keeps which side of the app a Host is on, and nothing for a Host that is current or says it oddly', () => {
  const only = (o: object) => parseMachineList({ machines: [{ ...ROW, ...o }], resolved: true })!.machines[0];
  const row = only({ hostStale: true, hostDiffers: true });
  assert.deepEqual([row.hostStale, row.hostDiffers, row.hostNewer], [true, true, undefined]);
  assert.equal(only({ hostNewer: true }).hostNewer, true);
  const current = only({ hostStale: 'yes', hostNewer: 1, hostDiffers: 'true' });
  assert.deepEqual([current.hostStale, current.hostNewer, current.hostDiffers], [undefined, undefined, undefined]);
});

test('the list parser keeps only a list of well-formed rows (B1)', () => {
  assert.deepEqual(parseMachineList({ machines: [ROW], resolved: true }), { machines: [ROW], resolved: true });
  assert.deepEqual(parseMachineList({ machines: [], resolved: 'yes' }), { machines: [], resolved: false });
  const declared = parseMachineList({ machines: [{ ...ROW, capabilities: { iab: true, cu: 'yes' } }], resolved: true });
  assert.deepEqual(declared!.machines[0].capabilities, { iab: true, cu: false, desktop: false }, 'only true counts');
  const listed = parseMachineList({
    machines: [
      {
        ...ROW,
        agents: [
          { id: 'alpha', label: 'Alpha', state: 'signin', reason: 'Sign in on a', extra: 1 },
          { id: 'beta', label: 'Beta', state: 'odd', reason: 4 },
          { id: 'broken' },
          null,
          'x',
        ],
      },
      { ...ROW, agents: 'none' },
    ],
    resolved: true,
  });
  assert.deepEqual(
    listed!.machines[0].agents,
    [
      { id: 'alpha', label: 'Alpha', state: 'signin', reason: 'Sign in on a' },
      { id: 'beta', label: 'Beta', state: null, reason: '' },
    ],
    'only an id with its label is kept, its readiness only when it is one of the known states',
  );
  assert.deepEqual(listed!.machines[1].agents, [], 'anything but a list is none');
  // the login an agent runs on there: its name and plan as text, whichever of them there is; anything else is no word
  const logged = parseMachineList({
    machines: [
      {
        ...ROW,
        agents: [
          { id: 'claude', label: 'Claude Code', state: 'ready', reason: '', loginAccount: { name: 'Meggie', plan: 'Ultra' } },
          { id: 'codex', label: 'Codex', state: 'ready', reason: '', loginAccount: { plan: 'Pro', name: 7 } },
          { id: 'kimi', label: 'Kimi', state: 'ready', reason: '', loginAccount: { name: '', plan: null } },
          { id: 'gemini', label: 'Gemini', state: 'ready', reason: '', loginAccount: 'Meggie' },
          { id: 'amp', label: 'Amp', state: 'ready', reason: '', loginAccount: { name: 'Solo' } },
          { id: 'zed', label: 'Zed', state: 'ready', reason: '' },
        ],
      },
    ],
    resolved: true,
  });
  assert.deepEqual(
    logged!.machines[0].agents.map((a) => a.loginAccount),
    [{ name: 'Meggie', plan: 'Ultra' }, { plan: 'Pro' }, undefined, undefined, { name: 'Solo' }, undefined],
  );
  // the Host's Local Network report and an offline machine's wait for a sign-in: known values only, else none
  const states = parseMachineList({
    machines: [
      { ...ROW, localNetwork: 'denied', waitingForLogin: 'restarted' },
      { ...ROW, localNetwork: 'allowed', waitingForLogin: 'signed-out' },
      { ...ROW, localNetwork: 'maybe', waitingForLogin: 7 },
      { ...ROW, localNetwork: undefined, waitingForLogin: undefined },
    ],
    resolved: true,
  });
  assert.deepEqual(
    states!.machines.map((m) => [m.localNetwork, m.waitingForLogin]),
    [
      ['denied', 'restarted'],
      ['allowed', 'signed-out'],
      ['unknown', null],
      ['unknown', null],
    ],
  );
  // the agents a machine's Host can install reach the window (the composer's Install reads them); anything but ids is dropped
  const installs = parseMachineList({
    machines: [
      { ...ROW, installable: ['codex', 3, '', 'gemini'] },
      { ...ROW, installable: 'codex' },
    ],
  });
  assert.deepEqual(
    installs!.machines.map((m) => m.installable),
    [['codex', 'gemini'], []],
  );
  // when it last answered is a time, or nothing
  const seen = parseMachineList({
    machines: [
      { ...ROW, lastSeen: 5 },
      { ...ROW, lastSeen: 'x' },
      { ...ROW, lastSeen: Number.NaN },
    ],
  });
  assert.deepEqual(
    seen!.machines.map((m) => m.lastSeen),
    [5, null, null],
  );
  for (const bad of [
    null,
    'x',
    {},
    { machines: {} },
    { machines: [null] },
    { machines: [{ ...ROW, id: '' }] },
    { machines: [{ ...ROW, name: 3 }] },
    { machines: [{ ...ROW, note: null }] },
    { machines: [{ ...ROW, status: 'green' }] },
  ])
    assert.equal(parseMachineList(bad), null);
});

test('without Host access nothing of My machines exists; with it, each machine shows its status line', async (t) => {
  responses['host.access'] = false;
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  assert.equal(text(view.host), '', 'closed alpha: nothing renders');
  await act(() => pushAccess(true));
  await flush();
  assert.match(text(view.host), /Machines/);
  assert.equal(text(view.host.querySelector('.machine-status')), 'Needs attention', 'online, but it reported no agent');
  assert.equal(view.host.querySelector('.machine-sub')?.getAttribute('aria-description'), 'SSH · claude');
  // main pushes a changed list; a malformed push changes nothing
  const signedOut = [{ id: 'claude', label: 'Claude Code', state: 'signin', reason: '' }];
  await act(() =>
    pushMachines({
      machines: [{ ...ROW, status: 'attention', note: 'claude is not signed in on this machine.', agents: signedOut }],
      resolved: true,
    }),
  );
  assert.equal(text(view.host.querySelector('.machine-status')), 'Claude Code needs sign-in');
  await act(() => pushMachines({ machines: 'nope' }));
  assert.equal(text(view.host.querySelector('.machine-status')), 'Claude Code needs sign-in');
  await act(() => pushAccess(false));
  assert.equal(text(view.host), '', 'access lost: it goes away');
  await act(() => pushAccess(true));
});

test('a Host that raised cards with no phone linked reads "No phone linked · push is off" on the machine page, until it has none or a sign-in needs the line (#4721)', async (t) => {
  const ready = [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }];
  responses['host.machines'] = () => Promise.resolve({ machines: [{ ...ROW, agents: ready, pushSkipped: 2 }], resolved: true });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  const line = () => text(view.host.querySelector('.machine-status'));
  assert.equal(line(), 'No phone linked · push is off');
  // a phone linked again: the row carries no count and the ordinary line returns
  await act(() => pushMachines({ machines: [{ ...ROW, agents: ready }], resolved: true }));
  assert.equal(line(), 'Online · Claude Code');
  // an agent that still needs a sign-in keeps its own line and button
  const signedOut = [{ id: 'claude', label: 'Claude Code', state: 'signin', reason: '' }];
  await act(() => pushMachines({ machines: [{ ...ROW, status: 'attention', agents: signedOut, pushSkipped: 2 }], resolved: true }));
  assert.equal(line(), 'Claude Code needs sign-in');
});

test('adding a machine shows each step as it arrives, replaces a step seen again, and saves the host when it is paired', async (t) => {
  let finish: (v: unknown) => void = () => undefined;
  responses['host.add'] = () => new Promise((r) => (finish = r));
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(input(view.host, 'Machine'), 'not a host!');
  await click(button(view.host, 'Add'));
  assert.deepEqual(toasts().at(-1), ['Enter a machine like user@example.com', 'error']);
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 0);
  await setValue(input(view.host, 'Machine'), 'me@box');
  await click(button(view.host, 'Add'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.add'),
    [['host.add', 'me@box']],
  );
  assert.equal(button(view.host, 'Adding…').disabled, true);
  await act(() => pushStep({ destination: 'other@box', step: { id: 'connect', label: 'Connect', state: 'ok', output: 'x' } }));
  assert.equal(view.host.querySelector('.host-install-steps'), null, 'a step of another install is not shown');
  await act(() => pushStep({ destination: 'me@box', step: { id: 'connect', label: 'Connect', state: 'running', output: '' } }));
  await act(() => pushStep({ destination: 'me@box', step: { id: 'connect', label: 'Connect', state: 'ok', output: 'Linux x86_64' } }));
  await act(() =>
    pushStep({ destination: 'me@box', step: { id: 'node', label: 'Check Node', state: 'failed', output: 'Node 22 or newer is needed' } }),
  );
  const steps = [...view.host.querySelectorAll('.host-step')];
  assert.deepEqual(
    steps.map((s) => s.className),
    ['host-step ok', 'host-step failed'],
  );
  assert.match(text(steps[0]), /Linux x86_64/);
  await act(() => finish({ ok: true, paired: true, error: '', id: 'ssh:me@box', steps: [] }));
  assert.deepEqual(toasts().at(-1), ['Added me@box']);
  assert.deepEqual(useStore.getState().prefs.sshHosts, ['me@box']);
  assert.equal(input(view.host, 'Machine').value, '');
});

test('a failed install keeps its steps and reason on the card, and the same machine can be tried again', async (t) => {
  responses['host.add'] = () =>
    Promise.resolve({
      ok: false,
      paired: false,
      error: 'Node 22 or newer is needed',
      id: 'ssh:me@box',
      steps: [{ id: 'node', label: 'Check Node', state: 'failed', output: 'v18' }],
    });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  await openSheet(view.host);
  await setValue(input(view.host, 'Machine'), 'me@box');
  await click(button(view.host, 'Add'));
  assert.match(text(view.host.querySelector('[role=alert]')), /Node 22 or newer/);
  assert.match(text(view.host.querySelector('.host-install-steps')), /Check Node/);
  assert.equal(input(view.host, 'Machine').value, 'me@box', 'the input is kept for a retry');
  assert.equal(useStore.getState().prefs.sshHosts, undefined, 'a failed install is not saved as a host');
  responses['host.add'] = () => Promise.reject(new Error('ipc closed'));
  await click(button(view.host, 'Add'));
  assert.match(text(view.host.querySelector('[role=alert]')), /ipc closed/i);
});

test('a machine that installed but did not pair takes the pasted code; a wrong code stays on the card until the right one pairs it', async (t) => {
  responses['host.add'] = () =>
    Promise.resolve({ ok: true, paired: false, error: 'That is not the pairing code.', id: 'ssh:me@box', steps: [] });
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  assert.equal(input(view.host, 'Pairing code'), null);
  await openSheet(view.host);
  await setValue(input(view.host, 'Machine'), 'me@box');
  await click(button(view.host, 'Add'));
  assert.deepEqual(useStore.getState().prefs.sshHosts, ['me@box'], 'the machine is installed and listed');
  assert.equal(button(view.host, 'Pair').disabled, true, 'no code typed yet');
  responses['host.pair'] = () => Promise.reject(new Error('That is not the pairing code.'));
  await setValue(input(view.host, 'Pairing code'), 'WRONG');
  await click(button(view.host, 'Pair'));
  await flush();
  assert.match(text(view.host.querySelector('[role=alert]')), /not the pairing code/);
  responses['host.pair'] = () => Promise.resolve();
  await setValue(input(view.host, 'Pairing code'), 'abcd-efgh-jkmn');
  await click(button(view.host, 'Pair'));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'host.pair').at(-1), ['host.pair', 'ssh:me@box', 'abcd-efgh-jkmn']);
  assert.equal(input(view.host, 'Pairing code'), null, 'paired: the code row goes away');
  assert.deepEqual(toasts().at(-1), ['Paired me@box']);
  assert.equal(view.host.querySelector('[role=alert]'), null);
});

test('Enter installs and pairs from the keyboard', async (t) => {
  responses['host.add'] = () => Promise.resolve({ ok: true, paired: false, error: '', id: 'ssh:me@box', steps: [] });
  responses['host.pair'] = () => Promise.resolve();
  const view = await renderMachines();
  t.after(() => view.unmount());
  await flush();
  const enter = (el: Element) =>
    act(() => {
      el.dispatchEvent(new (globalThis as any).window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
  await openSheet(view.host);
  await setValue(input(view.host, 'Machine'), 'me@box');
  await enter(input(view.host, 'Machine'));
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 1);
  // pairing didn't finish: Try again adds it again, without anything to run on the machine
  await click(button(view.host, 'Try again'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 2);
  await setValue(input(view.host, 'Pairing code'), 'ABCD-EFGH-JKMN');
  await enter(input(view.host, 'Pairing code'));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.pair').length, 1);
});

test('machine model catalogs survive main-to-renderer parsing for every agent family', () => {
  const models = [{ id: 'remote-only', name: 'Remote only', default: true, efforts: ['low', 'high'], defaultEffort: 'high' }];
  const agents = ['claude', 'codex', 'kimi'].map((id) => ({ id, label: id, state: 'ready', reason: '', models }));
  const parsed = parseMachineList({ machines: [{ ...ROW, agents }], resolved: true });
  for (const agent of parsed!.machines[0].agents) assert.deepEqual((agent as any).models, models);
});

test("an agent's logins and the credential it would use survive main-to-renderer parsing; anything else is dropped", () => {
  const logins = [{ id: 'a', label: 'me@work.com', state: 'ok', limited: false, billing: 'subscription', active: true }];
  const parsed = parseMachineList({
    machines: [
      {
        ...ROW,
        agents: [
          { id: 'claude', label: 'Claude Code', state: 'ready', reason: '', using: 'key', logins },
          { id: 'codex', label: 'Codex', state: 'ready', reason: '', using: 'elsewhere', logins: 'none' },
          { id: 'kimi', label: 'Kimi', state: 'ready', reason: '', using: 'own' },
          { id: 'grok', label: 'Grok', state: 'ready', reason: '', using: 'org' },
        ],
      },
    ],
    resolved: true,
  });
  const [claude, codex, kimi, grok] = parsed!.machines[0].agents as any[];
  assert.deepEqual([claude.using, claude.logins], ['key', logins]);
  assert.deepEqual([codex.using, codex.logins], [undefined, undefined]);
  assert.deepEqual([kimi.using, grok.using], ['own', 'org']);
});

test('pending remote deletions stay visible in Settings and clear after reconnect acknowledgements', async (t) => {
  let pending = [{ hostId: 'ssh:a', chatId: 'gone' }];
  responses['host.pendingDeletions'] = () => Promise.resolve(pending);
  const root = await renderMachines();
  t.after(() => root.unmount());
  await flush(4);
  assert.match(text(root.host), /1 chat deletion pending/);
  pending = [...pending, { hostId: 'ssh:a', chatId: 'gone-2' }];
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await flush(4);
  assert.match(text(root.host), /2 chat deletions pending/);
  pending = [];
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await flush(4);
  assert.doesNotMatch(text(root.host), /chat deletions? pending/);
});

test('unreadable pending deletion storage is visible instead of being reported as no work remaining', async (t) => {
  responses['host.pendingDeletions'] = () => Promise.reject(new Error('unreadable deletion file'));
  const root = await renderMachines();
  t.after(() => root.unmount());
  await flush(4);
  assert.match(text(root.host), /Pending chat deletions could not be read/);
  responses['host.pendingDeletions'] = () => Promise.resolve([]);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
  });
  await flush(4);
  assert.doesNotMatch(text(root.host), /could not be read/);
});

test('a pending deletion read finishing after Settings unmount cannot publish a stale error', async () => {
  let reject: any;
  responses['host.pendingDeletions'] = () =>
    new Promise((_resolve, r) => {
      reject = r;
    });
  const root = await renderMachines();
  await flush(2);
  root.unmount();
  reject(new Error('late storage error'));
  await flush(3);
});

test('parseMachineList forwards rawName (the name without its address) only when it is a non-empty string', () => {
  const parse = (extra: object) => parseMachineList({ machines: [{ ...ROW, ...extra }], resolved: true })?.machines[0];
  assert.equal(parse({ name: 'Mac (localhost)', rawName: 'Mac' })?.rawName, 'Mac');
  assert.equal('rawName' in parse({})!, false);
  assert.equal('rawName' in parse({ rawName: '' })!, false);
  assert.equal('rawName' in parse({ rawName: 7 })!, false);
});

test('the Host’s word that it takes Plan for an agent is kept only as true: anything else, or nothing, is no word', () => {
  const planned = parseMachineList({
    machines: [
      {
        ...ROW,
        agents: [
          { id: 'codex', label: 'Codex', state: 'ready', reason: '', planMode: true },
          { id: 'claude', label: 'Claude Code', state: 'ready', reason: '', planMode: 'yes' },
          { id: 'kimi', label: 'Kimi Code', state: 'ready', reason: '', planMode: false },
        ],
      },
    ],
    resolved: true,
  });
  assert.deepEqual(
    planned!.machines[0].agents.map((a) => a.planMode),
    [true, undefined, undefined],
  );
});

test('the Host’s word that it could not check an agent reaches the row only as true (#5177)', () => {
  const parsed = parseMachineList({
    machines: [
      {
        ...ROW,
        agents: [
          { id: 'codex', label: 'Codex', state: 'ready', reason: 'Couldn’t check Codex on Box', unsure: true },
          { id: 'claude', label: 'Claude Code', state: 'ready', reason: '', unsure: 'yes' },
        ],
      },
    ],
    resolved: true,
  });
  assert.deepEqual(
    parsed!.machines[0].agents.map((a) => a.unsure),
    [true, undefined],
  );
});
