// Settings → My machines → Add by command (src/components/pages/settings/AddByCommandCard.tsx): the button opens a card with the line to
// run and Copy, the time left and Cancel; a machine that ran it shows its name, system, user and address with Allow and "Didn't run this?
// Deny"; Allow adds it and closes the card; a command that could not be made, expired or was denied says so with Get a new command.
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
  text,
  flush,
  act,
} from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { renderMachines } = await import('./support/addMachineView.ts');
const { AddByCommandCard, machineFacts, expiresIn } = await import('../src/components/pages/settings/AddByCommandCard.tsx');

const COMMAND = 'f=$(mktemp) && curl -fsSL https://relay.example/v1/boot/b_x -o "$f"; …';
let push: (v: unknown) => void = () => undefined;
let startFails = false;
beforeEach(() => {
  resetCtl();
  startFails = false;
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.onBoot': (cb: any) => ((push = cb), () => undefined),
    'host.bootStart': () =>
      startFails
        ? Promise.reject(new Error('This app has no relay to add a machine by command.'))
        : Promise.resolve({ state: 'waiting', command: COMMAND, expiresAt: Date.now() + 15 * 60_000, machine: null, error: '' }),
    'host.bootAllow': () => Promise.resolve({ id: 'relay:h_1' }),
    'host.bootDeny': () => Promise.resolve(),
    'clipboard.write': () => Promise.resolve(),
  });
  calls.length = 0;
});
const asked = (name: string) => calls.filter((c) => c[0] === name).length;

async function opened() {
  const view = await renderMachines();
  await flush();
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  return view;
}

test('the card shows the line to run with Copy and the time left; a machine that ran it is described, and Allow adds it', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  assert.match(text(view.host), /Run this on the machine \(macOS or Linux, no admin needed\):/);
  assert.ok(text(view.host).includes(COMMAND));
  assert.match(text(view.host), /Waiting for the machine · Expires in 15 min/);
  await click(button(view.host, 'Copy'));
  assert.deepEqual(calls.find((c) => c[0] === 'clipboard.write')?.slice(1), [COMMAND]);
  await act(() =>
    push({
      state: 'asking',
      command: COMMAND,
      expiresAt: 0,
      error: '',
      machine: { name: 'far-box', os: 'darwin', arch: 'arm64', user: 'ops', ip: '203.0.113.9' },
    }),
  );
  assert.match(text(view.host), /far-box wants to joinmacOS arm64 · user ops · from 203\.0\.113\.9/);
  await click(button(view.host, 'Allow'));
  await flush();
  assert.equal(asked('host.bootAllow'), 1);
  assert.doesNotMatch(text(view.host), /wants to join/);
  assert.match(text(view.host), /Setting up far-box…/, 'listed, and the card stays until it has joined');
  // the machine finished joining: the card closes
  await act(() => push({ state: 'ready', command: COMMAND, expiresAt: 0, error: '', machine: null }));
  assert.doesNotMatch(text(view.host), /Setting up|Waiting for the machine/);
});

test('a join that failed after Allow says why with Try again, which repeats the join in place; Close leaves the machine listed', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  const named = { name: 'far-box', os: 'linux', arch: 'x64', user: 'u', ip: '' };
  await act(() => push({ state: 'asking', command: '', expiresAt: 0, error: '', machine: named }));
  await click(button(view.host, 'Allow'));
  await flush();
  const failed = {
    state: 'join_failed',
    command: '',
    expiresAt: 0,
    machine: named,
    error: 'far-box was added, but its Host did not start answering within 2 minutes.',
  };
  await act(() => push(failed));
  assert.match(text(view.host), /far-box was added, but its Host did not start answering within 2 minutes\./);
  const starts = asked('host.bootStart');
  responses['host.bootStart'] = () => Promise.resolve({ ...failed, state: 'joining', error: '' });
  await click(button(view.host, 'Try again'));
  await flush();
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'host.bootStart')
      .at(-1)
      ?.slice(1),
    [true],
  );
  assert.equal(asked('host.bootStart'), starts + 1);
  assert.match(text(view.host), /Setting up far-box…/);
  // Close while it is joining ends only the card (leaving Any network tells the app the command is over)
  await click(button(view.host, 'Close'));
  assert.doesNotMatch(text(view.host), /Setting up/);
  // a join that ends while the card is closed leaves it closed, and opening it again starts clean
  await act(() => push({ ...failed, state: 'ready' }));
  responses['host.bootStart'] = () =>
    Promise.resolve({ state: 'waiting', command: COMMAND, expiresAt: Date.now() + 60_000, machine: null, error: '' });
  // the sheet reopens on its field; Any network starts a new command
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  assert.ok(text(view.host).includes(COMMAND));
});

test('a command that failed on the machine says why with Try again, which gets a new command', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  const why =
    'The machine started the command but did not finish joining. Check its terminal for the line that starts with “MoPilot:”, then try again.';
  await act(() => push({ state: 'failed', command: '', expiresAt: 0, machine: null, error: why }));
  assert.match(text(view.host), /did not finish joining/);
  await click(button(view.host, 'Try again'));
  await flush();
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'host.bootStart')
      .at(-1)
      ?.slice(1),
    [false],
  );
});

test('a build with no relay says so and returns to the machine field, not a Try again that fails again', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  await act(() =>
    push({
      state: 'failed',
      command: '',
      expiresAt: 0,
      machine: null,
      error: 'This app has no relay to add a machine by command.',
    }),
  );
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Add by command isn’t available');
  assert.equal(
    [...view.host.querySelectorAll('button')].some((b) => text(b) === 'Try again'),
    false,
  );
  await click(button(view.host, 'Use SSH'));
  assert.ok(view.host.querySelector('input[aria-label="Machine"]'), 'the machine field is back');
});

test('Deny ends it; Cancel ends a waiting command; a command that could not be made or that expired says so', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  await act(() =>
    push({ state: 'asking', command: '', expiresAt: 0, error: '', machine: { name: '', os: 'plan9', arch: '', user: '', ip: '' } }),
  );
  assert.match(text(view.host), /A machine wants to joinplan9/);
  await click(button(view.host, 'Didn’t run this? Deny'));
  assert.equal(asked('host.bootDeny'), 1);
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  await click(button(view.host, 'Cancel'));
  assert.equal(asked('host.bootDeny'), 2);
  // a Cancel the app could not carry out is said
  responses['host.bootDeny'] = () => Promise.reject(new Error('The relay could not be reached.'));
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  await click(button(view.host, 'Cancel'));
  await flush();
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'toast')
      .at(-1)
      ?.slice(1),
    ['The relay could not be reached.', 'error'],
  );
  responses['host.bootDeny'] = () => Promise.resolve();
  startFails = true;
  await click(button(view.host, 'Add machine'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  assert.match(text(view.host), /Add by command isn’t available/);
  startFails = false;
  // the way on is the machine field; coming back to Any network asks again
  await click(button(view.host, 'Use SSH'));
  await click(button(view.host, 'Any network (add by command)'));
  await flush();
  assert.ok(text(view.host).includes(COMMAND));
  await act(() => push({ state: 'expired', command: '', expiresAt: 0, machine: null, error: '' }));
  assert.match(text(view.host), /That command expired\./);
  const before = asked('host.bootStart');
  await click(button(view.host, 'Get a new command'));
  await flush();
  assert.deepEqual(
    calls
      .filter((c) => c[0] === 'host.bootStart')
      .at(-1)
      ?.slice(1),
    [false],
  );
  assert.equal(asked('host.bootStart'), before + 1, 'an expired command is replaced, not retried');
  await act(() => push({ state: 'expired', command: '', expiresAt: 0, machine: null, error: '' }));
  await click(button(view.host, 'Close'));
  assert.doesNotMatch(text(view.host), /expired/);
});

test('the facts and the time left in words', () => {
  assert.equal(machineFacts({ name: 'n', os: 'linux', arch: 'x64', user: '', ip: '' }), 'Linux x64');
  assert.equal(expiresIn(1000, 2000), 'Expired');
  assert.equal(expiresIn(30_000, 0), 'Expires in under a minute');
  assert.equal(expiresIn(5 * 60_000, 0), 'Expires in 5 min');
});

test('an Allow or a Copy that fails says so; a machine with no name is added as the machine', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c.slice(1));
  responses['clipboard.write'] = () => Promise.reject(new Error('denied'));
  await click(button(view.host, 'Copy'));
  await flush();
  assert.deepEqual(toasts().at(-1), ["Couldn't copy: denied", 'error']);
  await act(() =>
    push({ state: 'asking', command: '', expiresAt: 0, error: '', machine: { name: '', os: 'linux', arch: 'x64', user: 'u', ip: '' } }),
  );
  responses['host.bootAllow'] = () => Promise.reject(new Error('No machine is waiting to join.'));
  await click(button(view.host, 'Allow'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['No machine is waiting to join.', 'error']);
  responses['host.bootAllow'] = () => Promise.resolve({ id: 'relay:h_2' });
  await click(button(view.host, 'Allow'));
  await flush();
  assert.deepEqual(toasts().at(-1), ['Added the machine']);
});

test('an end that arrives while Allow is still answering is kept; a joining machine that gave no name is the machine', async (t) => {
  const view = await opened();
  t.after(() => view.unmount());
  const asking = {
    state: 'asking',
    command: '',
    expiresAt: 0,
    error: '',
    machine: { name: 'far-box', os: 'linux', arch: 'x64', user: 'u', ip: '' },
  };
  await act(() => push(asking));
  responses['host.bootAllow'] = () => {
    push({ ...asking, state: 'join_failed', error: 'far-box was added, but finishing its setup over the relay failed.' });
    return Promise.resolve({ id: 'relay:h_1' });
  };
  await click(button(view.host, 'Allow'));
  await flush();
  assert.match(text(view.host), /finishing its setup over the relay failed\./);
  await act(() => push({ state: 'joined', command: '', expiresAt: 0, error: '', machine: null }));
  assert.match(text(view.host), /Setting up the machine…/);
});

test('a closed card draws nothing and asks for no command', async (t) => {
  const view = await render(
    h(AddByCommandCard, {
      open: false,
      onClose: () => undefined,
      onUseSsh: () => undefined,
    }),
  );
  t.after(() => view.unmount());
  await flush();
  assert.equal(text(view.host), '');
  assert.equal(asked('host.bootStart'), 0);
});
