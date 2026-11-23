// A machine row in Settings › My machines (MachineRow.tsx, MachineAgentActions.tsx): one status line, at most one button and only when the person must act (Sign in, Get a new code, Install), a running sign-in with its code field, Open page and Cancel, and a ⋯ menu with the other sign-ins, Install an agent…, Open terminal, Rename and Remove; an offline machine offers no agent action.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  render,
  click,
  button,
  buttons,
  setValue,
  options,
  text,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');
const { currentSignin } = await import('../src/components/pages/settings/MachineAgentActions.tsx');

const agent = (id: string, label: string, state: string) => ({ id, label, state, reason: '' });
const MINI = {
  id: 'ssh:mini',
  name: 'mini',
  status: 'online',
  note: 'SSH · Claude Code, Gemini, Grok',
  signin: 'gemini',
  capabilities: { iab: false, cu: false },
  agents: [
    agent('claude', 'Claude Code', 'ready'),
    agent('codex', 'Codex', 'missing'),
    agent('gemini', 'Gemini', 'signin'),
    agent('grok', 'Grok', 'signin'),
  ],
};
const view = (o: object = {}) => ({
  hostId: 'ssh:mini',
  harness: 'gemini',
  state: 'waiting',
  codes: [],
  link: false,
  url: null,
  error: null,
  ...o,
});
let pushSignin: (v: unknown) => void = () => undefined;
let pushMachines: (v: unknown) => void = () => undefined;

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [MINI], resolved: true }),
    'host.onMachines': (cb: any) => ((pushMachines = cb), () => undefined),
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': (cb: any) => ((pushSignin = cb), () => undefined),
    'host.signin': (id: string, harness: string) => Promise.resolve(view({ hostId: id, harness, state: 'starting' })),
    'host.cancelSignin': () => Promise.resolve(true),
  });
  calls.length = 0;
});

const status = (root: Element) => text(root.querySelector('.machine-status'));
/** Opens the row's ⋯ menu (the test harness keeps a menu open after a pick, as a click outside would close it in the app). */
async function more(root: Element, name: string) {
  if (!options(root).length) await click(button(root, `More for ${name}`));
}
const signedOut = {
  ...MINI,
  agents: [agent('claude', 'Claude Code', 'missing'), agent('gemini', 'Gemini', 'signin'), agent('grok', 'Grok', 'signin')],
};

test('the Mac mini row: Online with the agent that runs there and who needs sign-in (#4931), one Sign in and the next in its menu', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Online · Claude Code · Gemini and Grok need sign-in');
  assert.equal(root.host.querySelector('.machine-dot')?.className, 'machine-dot ok');
  assert.equal(button(root.host, 'Sign in to Gemini on mini').textContent, 'Sign in');
  await click(button(root.host, 'More for mini'));
  assert.deepEqual(options(root.host), ['Sign in to Grok', 'Open terminal', 'Rename', 'Remove']);
  await click(button(root.host, 'Sign in to Grok'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.signin'),
    [['host.signin', 'ssh:mini', 'grok']],
  );
});

test('an agent whose state is still being read is no sign-in need: not in the row words, not in the menu (#4931)', async (t) => {
  const checking = { ...MINI, agents: [...MINI.agents.slice(0, 3), { ...agent('grok', 'Grok', 'signin'), reason: 'Checking on mini…' }] };
  responses['host.machines'] = () => Promise.resolve({ machines: [checking], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Online · Claude Code · Gemini needs sign-in');
  await click(button(root.host, 'More for mini'));
  assert.deepEqual(options(root.host), ['Open terminal', 'Rename', 'Remove']);
});

test('nothing runs there: who needs sign-in, one Sign in for the first, the next one in the menu', async (t) => {
  responses['host.machines'] = () => Promise.resolve({ machines: [signedOut], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Gemini and Grok need sign-in');
  assert.equal(root.host.querySelector('.machine-dot')?.className, 'machine-dot warn');
  assert.equal(button(root.host, 'Sign in to Gemini on mini').textContent, 'Sign in');
  await click(button(root.host, 'More for mini'));
  assert.deepEqual(options(root.host).slice(0, 1), ['Sign in to Grok']);
  await click(button(root.host, 'Sign in to Gemini on mini'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.signin'),
    [['host.signin', 'ssh:mini', 'gemini']],
  );
});

test('a running sign-in shows its agent, Open page reopens the vendor page, Cancel names the agent and stops it', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await act(() => pushSignin(view({ link: true, url: 'https://accounts.google.com/o/oauth2/x', codes: ['ABCD-1234'] })));
  assert.equal(status(root.host), 'Gemini: Enter this code in the page that opened: ABCD-1234');
  await click(button(root.host, 'Open page'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'shell.openExternal'),
    [['shell.openExternal', 'https://accounts.google.com/o/oauth2/x']],
  );
  await click(button(root.host, 'More for mini'));
  assert.deepEqual(options(root.host).slice(0, 1), ['Sign in to Grok'], 'the running one is not offered again');
  await click(button(root.host, 'Cancel signing in to Gemini on mini'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.cancelSignin'),
    [['host.cancelSignin', 'ssh:mini', 'gemini']],
  );
  // a page that is not https is never offered again
  await act(() => pushSignin(view({ link: true, url: 'file:///etc/passwd' })));
  assert.equal(buttons(root.host, 'Open page').length, 0);
});

test('an offline machine shows its cause and Check again, which asks every machine now', async (t) => {
  const asked: string[] = [];
  responses['host.check'] = () => (asked.push('check'), Promise.resolve());
  const off = {
    ...MINI,
    status: 'offline',
    note: 'Unreachable: ssh: connect to host mini port 22: Connection refused',
    platform: 'darwin',
    lastSeen: null,
  };
  responses['host.machines'] = () => Promise.resolve({ machines: [off], resolved: true });
  const root = await render(h(HostMachines, {}));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Offline · Remote Login is off');
  await click(button(root.host, 'Check again mini'));
  assert.deepEqual(asked, ['check']);
});

test('Check again that fails is a toast and the button comes back', async (t) => {
  responses['host.check'] = () => Promise.reject(new Error('the registry is busy'));
  const off = { ...MINI, status: 'offline', note: '', platform: 'linux', lastSeen: null };
  responses['host.machines'] = () => Promise.resolve({ machines: [off], resolved: true });
  const root = await render(h(HostMachines, {}));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'Check again mini'));
  await flush(3);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'The registry is busy.', 'error']);
  assert.equal(buttons(root.host, 'Check again mini').length, 1);
});

test('Install shows when nothing runs and the machine can install it, busy while it runs; a refusal is a toast', async (t) => {
  const installs: string[][] = [];
  let finish: (v?: unknown) => void = () => undefined;
  const onInstall = (id: string, harness: string) => (installs.push([id, harness]), new Promise((r) => (finish = r)));
  const bare = { ...MINI, agents: [agent('claude', 'Claude Code', 'missing'), agent('codex', 'Codex', 'missing')], installable: ['codex'] };
  responses['host.machines'] = () => Promise.resolve({ machines: [bare], resolved: true });
  const root = await render(h(HostMachines, { onInstall }));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Codex isn’t installed');
  await click(button(root.host, 'Install Codex on mini'));
  assert.deepEqual(installs, [['ssh:mini', 'codex']]);
  assert.equal(button(root.host, 'Install Codex on mini').textContent, 'Installing…');
  await act(async () => finish());
  assert.equal(button(root.host, 'Install Codex on mini').textContent, 'Install Codex');
  const refused = await render(h(HostMachines, { onInstall: () => Promise.reject(new Error('The machine has no npm.')) }));
  t.after(() => refused.unmount());
  await flush(5);
  await click(button(refused.host, 'Install Codex on mini'));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'The machine has no npm.', 'error']);
});

test('an offline machine says when it was last seen and offers no agent action, in its row or its menu', async (t) => {
  const seen = Date.now() - 2 * 3_600_000 - 60_000;
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [{ ...MINI, status: 'offline', note: 'No answer for 90 seconds.', lastSeen: seen }], resolved: true });
  const root = await render(h(HostMachines, { onInstall: async () => undefined }));
  t.after(() => root.unmount());
  await flush(5);
  assert.equal(status(root.host), 'Offline · No answer · seen 2 h ago');
  assert.equal(root.host.querySelector('.machine-sub')?.getAttribute('aria-description'), 'Check that it’s on and on the same network.');
  assert.equal(root.host.querySelectorAll('.machine-controls .btn-pill').length, 1, 'no agent action: the one button asks again');
  assert.equal(buttons(root.host, 'Check again mini').length, 1);
  await click(button(root.host, 'More for mini'));
  assert.deepEqual(options(root.host), ['Open terminal', 'Rename', 'Remove']);
  // it comes back: the row's action returns
  await act(() => pushMachines({ machines: [signedOut], resolved: true }));
  assert.equal(buttons(root.host, 'Sign in to Gemini on mini').length, 1);
});

test('the sign-in a row speaks about: one under way first, else the latest that ended unsigned; never another machine or a signed-in agent', () => {
  const agents = MINI.agents as any;
  const map = (...vs: any[]) => new Map(vs.map((v) => [`${v.hostId}\n${v.harness}`, v]));
  assert.equal(currentSignin('ssh:mini', agents, map()), null);
  const failed = view({ harness: 'grok', state: 'failed', error: 'denied' });
  const running = view({ state: 'waiting' });
  assert.equal(currentSignin('ssh:mini', agents, map(failed, running))!.agent.id, 'gemini');
  assert.equal(currentSignin('ssh:mini', agents, map(failed))!.agent.id, 'grok');
  assert.equal(currentSignin('ssh:mini', agents, map(view({ state: 'cancelled' }))), null);
  assert.equal(currentSignin('ssh:mini', agents, map(view({ harness: 'claude', state: 'failed' }))), null, 'Claude Code is ready');
  assert.equal(currentSignin('ssh:other', agents, map(running)), null);
});

test('Open terminal opens a terminal on the machine', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Open terminal'));
  assert.equal(calls.filter((c) => c[0] === 'openPaneTab').length, 1);
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate').at(-1), ['navigate', { name: 'home' }]);
});

test('an expired code has its own Get a new code; a failed sign-in starts again from Sign in', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await act(() => pushSignin(view({ state: 'expired', error: 'That code expired. Get a new one.' })));
  assert.equal(status(root.host), 'Gemini: That code expired');
  await click(button(root.host, 'Get a new code for Gemini on mini'));
  await flush();
  await act(() => pushSignin(view({ state: 'failed', error: 'denied' })));
  assert.equal(status(root.host), "Couldn't sign in to Gemini");
  await click(button(root.host, 'Sign in to Gemini on mini'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.signin'),
    [
      ['host.signin', 'ssh:mini', 'gemini'],
      ['host.signin', 'ssh:mini', 'gemini'],
    ],
  );
});

test('Rename asks main to keep the name (every surface shows it once the list comes back); an empty name cannot be saved; a refusal keeps the sheet', async (t) => {
  responses['host.rename'] = () => Promise.resolve();
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  const rename = async () => {
    await more(root.host, text(root.host.querySelector('.machine-name')));
    await click(button(root.host, 'Rename'));
    return root.host.querySelector('input[aria-label="Machine name"]') as HTMLInputElement;
  };
  const field = await rename();
  assert.equal(field.value, 'mini');
  await setValue(field, '');
  assert.equal(button(root.host, 'Save').disabled, true);
  await setValue(field, '  Mac mini ');
  await click(button(root.host, 'Save'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.rename'),
    [['host.rename', 'ssh:mini', '  Mac mini ']],
  );
  assert.equal(root.host.querySelector('.dialog'), null);
  await act(() => pushMachines({ machines: [{ ...MINI, name: 'Mac mini' }], resolved: true }));
  assert.equal(text(root.host.querySelector('.machine-name')), 'Mac mini');
  // Cancel asks nothing; Enter saves; a refusal is a toast and the sheet stays with what was typed
  await setValue(await rename(), 'Studio');
  await click(button(root.host, 'Cancel'));
  assert.equal(calls.filter((c) => c[0] === 'host.rename').length, 1);
  responses['host.rename'] = () => Promise.reject(new Error('Give the machine a name of up to 64 characters.'));
  const again = await rename();
  await setValue(again, 'x');
  again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Give the machine a name of up to 64 characters.', 'error']);
  assert.equal((root.host.querySelector('input[aria-label="Machine name"]') as HTMLInputElement).value, 'x');
  assert.equal(button(root.host, 'Save').disabled, false, 'it can be tried again');
  // Enter on an empty name does nothing
  await setValue(again, ' ');
  again.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.rename').length, 2);
});

const PLAN = { ssh: true, reachable: true, online: true, busy: 'no', daemon: false, unsure: false, shared: '', why: '' };
const forgotten = () => calls.filter((c) => c[0] === 'forgetHostMachine').length;
async function openRemove(root: { host: Element }) {
  await more(root.host, 'mini');
  await click(button(root.host, 'Remove'));
  await flush(3);
}

test('Remove on a machine that answers uninstalls the Host first, then forgets the machine; a failure keeps the sheet and offers Remove here only', async (t) => {
  responses['host.remove'] = () => Promise.resolve();
  responses['host.removePlan'] = () => Promise.resolve({ ...PLAN, busy: 'yes' });
  responses['host.uninstall'] = () => Promise.resolve({ left: '' });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await openRemove(root);
  assert.match(
    text(root.host.querySelector('.dialog')),
    /Stops the Host on mini and deletes its files\.A turn is running there\. It will stop\./,
  );
  await click(button(root.host.querySelector('.dialog')!, 'Remove'));
  await flush(3);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.uninstall' || c[0] === 'host.remove' || c[0] === 'forgetHostMachine'),
    [
      ['host.uninstall', 'ssh:mini', ''],
      ['host.remove', 'ssh:mini'],
      ['forgetHostMachine', 'ssh:mini'],
    ],
  );
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'mini removed']);
  // a Host that cannot be stopped keeps the machine; the person may still remove it here
  calls.length = 0;
  responses['host.removePlan'] = () => Promise.resolve({ ...PLAN, busy: 'unknown' });
  responses['host.uninstall'] = () => Promise.reject(new Error('no bin'));
  await openRemove(root);
  assert.match(text(root.host.querySelector('.dialog')), /A turn may be running there/);
  await click(button(root.host.querySelector('.dialog')!, 'Remove'));
  await flush(3);
  assert.equal(forgotten(), 0, 'a failed uninstall forgets nothing');
  assert.match(text(root.host.querySelector('.dialog')), /No bin/);
  await click(button(root.host, 'Remove here only'));
  await flush(3);
  assert.equal(forgotten(), 1);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), [
    'toast',
    "mini removed here. Its Host and chats' files remain there; add it again and Remove to delete them.",
  ]);
});

test('Remove of a boot daemon takes the password, and says the Host still runs when it is not given', async (t) => {
  responses['host.remove'] = () => Promise.resolve();
  responses['host.removePlan'] = () => Promise.resolve({ ...PLAN, daemon: true });
  responses['host.uninstall'] = (_id: string, password: string) => Promise.resolve({ left: password ? '' : 'daemon' });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await openRemove(root);
  assert.match(text(root.host.querySelector('.dialog')), /Keep running is on\. Without the password the Host stays\./);
  const field = root.host.querySelector('input[aria-label="Administrator password for mini"]') as HTMLInputElement;
  await setValue(field, 'pw');
  field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush(3);
  assert.deepEqual(
    calls.find((c) => c[0] === 'host.uninstall'),
    ['host.uninstall', 'ssh:mini', 'pw'],
  );
  calls.length = 0;
  await openRemove(root);
  await click(button(root.host.querySelector('.dialog')!, 'Remove'));
  await flush(3);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'mini removed. Its Host still runs there.']);
});

test('Remove of a machine that does not answer only forgets it here and says the Host stays; a plan that cannot be made counts as that', async (t) => {
  responses['host.remove'] = () => Promise.resolve();
  responses['host.removePlan'] = () => Promise.resolve({ ...PLAN, reachable: false, online: false });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await openRemove(root);
  assert.match(text(root.host.querySelector('.dialog')), /The Host and chats' files stay on mini\. This only removes it here\./);
  await click(button(root.host.querySelector('.dialog')!, 'Remove'));
  await flush(3);
  assert.equal(calls.filter((c) => c[0] === 'host.uninstall').length, 0);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), [
    'toast',
    "mini removed here. Its Host and chats' files remain there; add it again and Remove to delete them.",
  ]);
  calls.length = 0;
  responses['host.removePlan'] = () => Promise.reject(new Error('nope'));
  await openRemove(root);
  assert.match(text(root.host.querySelector('.dialog')), /The Host and chats' files stay on mini/);
  // Cancel leaves the machine alone
  await click(button(root.host, 'Cancel'));
  assert.equal(forgotten(), 0);
});

test('an older Host says so with Update; the button sends the update, and a failure is a toast with its cause', async (t) => {
  responses['host.update'] = () => Promise.resolve({ version: '2', output: '' });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  pushMachines({ machines: [{ ...MINI, agents: [agent('claude', 'Claude Code', 'ready')], hostStale: true }], resolved: true });
  await flush(3);
  assert.equal(text(root.host.querySelector('.machine-status')), 'Host is out of date');
  await click(button(root.host, 'Update the Host on mini'));
  await flush(3);
  assert.deepEqual(
    calls.find((c) => c[0] === 'host.update'),
    ['host.update', 'ssh:mini'],
  );
  responses['host.update'] = () => Promise.reject(new Error('Connection lost.'));
  await click(button(root.host, 'Update the Host on mini'));
  await flush(3);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Connection lost.', 'error']);
  // while it runs and waits for a turn to end the row says so and offers nothing; after a failure it offers Try again
  for (const [update, words] of [
    ['running', 'Updating Host…'],
    ['waiting', 'Updates when idle'],
  ] as const) {
    pushMachines({ machines: [{ ...MINI, agents: [agent('claude', 'Claude Code', 'ready')], hostStale: true, update }], resolved: true });
    await flush(3);
    assert.equal(text(root.host.querySelector('.machine-status')), words);
  }
  pushMachines({
    machines: [{ ...MINI, agents: [agent('claude', 'Claude Code', 'ready')], update: 'failed', updateError: 'disk full' }],
    resolved: true,
  });
  await flush(3);
  assert.equal(text(root.host.querySelector('.machine-status')), 'Update failed');
  assert.ok(button(root.host, 'Try again the Host on mini'));
});

test('a pairing refusal says Pair again; a transport failure or stale update eligibility keeps retry', async (t) => {
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  pushMachines({
    machines: [{ ...MINI, update: 'failed', updateError: 'This client is not paired.', updateNeedsPair: true }],
    resolved: true,
  });
  await flush(3);
  assert.equal(text(root.host.querySelector('.machine-status')), 'Pair again');
  assert.equal(buttons(root.host, 'Try again the Host on mini').length, 0);
  pushMachines({ machines: [{ ...MINI, update: 'failed', updateNeedsPair: true }], resolved: true });
  await flush(3);
  assert.match(root.host.querySelector('.machine-sub')?.getAttribute('aria-description') ?? '', /This Mac is not paired/);
  pushMachines({ machines: [{ ...MINI, update: 'failed', updateError: 'Connection timed out.' }], resolved: true });
  await flush(3);
  assert.equal(text(root.host.querySelector('.machine-status')), 'Update failed');
  assert.ok(button(root.host, 'Try again the Host on mini'));
});

test('Rename starts from the plain name when the shown name carries the address, and from the shown name when none is sent', async (t) => {
  responses['host.machines'] = () =>
    Promise.resolve({ machines: [{ ...MINI, name: 'Mini (localhost)', rawName: 'Mini' }], resolved: true });
  const root = await render(h(HostMachines));
  t.after(() => root.unmount());
  await flush(5);
  await more(root.host, text(root.host.querySelector('.machine-name')));
  await click(button(root.host, 'Rename'));
  const field = root.host.querySelector('input[aria-label="Machine name"]') as HTMLInputElement;
  assert.equal(field.value, 'Mini');
  await click(button(root.host, 'Cancel'));
  await act(() => pushMachines({ machines: [{ ...MINI, name: 'Mini (localhost)' }], resolved: true }));
  await click(button(root.host, 'Rename'));
  assert.equal((root.host.querySelector('input[aria-label="Machine name"]') as HTMLInputElement).value, 'Mini (localhost)');
});
