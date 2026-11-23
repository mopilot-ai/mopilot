// Keep running after restart in Settings › My machines (MachineRow.tsx, KeepRunningSheet.tsx): only a Mac added over SSH whose Host answers and says whether it starts at boot offers it, checked when on; the sheet takes the administrator password in a secure field, sends it once, says FileVault's limit, keeps the sheet with an empty field after a wrong password, and offers the command to run at the machine instead.
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
} from './support/settings-harness.ts';

await setup();
await import('../src/lib/native/host.ts');
const { createElement: h } = await import('react');
const { HostMachines } = await import('../src/components/pages/settings/HostMachines.tsx');
const { keepRunningLede } = await import('../src/components/pages/settings/KeepRunningSheet.tsx');

const MAC = {
  id: 'ssh:mini',
  name: 'mini',
  status: 'online',
  note: '',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [{ id: 'claude', label: 'Claude Code', state: 'ready', reason: '' }],
  platform: 'darwin',
  startsAtBoot: 'no',
  fileVault: 'off',
};

beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [MAC], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.setStartAtBoot': () => Promise.resolve(),
    'host.startAtBootCommand': () => Promise.resolve("sudo /bin/sh -c 'x'"),
    'clipboard.write': () => Promise.resolve(),
  });
  calls.length = 0;
});

async function open(machine: object = MAC) {
  responses['host.machines'] = () => Promise.resolve({ machines: [machine], resolved: true });
  const root = await render(h(HostMachines));
  await flush(5);
  await click(button(root.host, 'More for mini'));
  return root;
}
const field = (root: Element) => root.querySelector('input[aria-label="Administrator password for mini"]') as HTMLInputElement;

test('a Mac added over SSH offers it in its ⋯ menu, checked when on; other machines and an older Host do not', async () => {
  const offered = async (machine: object) => {
    const root = await open(machine);
    try {
      return options(root.host).includes('Keep running after restart')
        ? button(root.host, 'Keep running after restart').getAttribute('aria-checked')
        : null;
    } finally {
      root.unmount();
    }
  };
  const root = await open();
  assert.deepEqual(options(root.host), ['Open terminal', 'Keep running after restart', 'Rename', 'Remove']);
  root.unmount();
  assert.equal(await offered(MAC), 'false');
  assert.equal(await offered({ ...MAC, startsAtBoot: 'yes' }), 'true');
  for (const other of [
    { ...MAC, platform: 'linux' },
    { ...MAC, id: 'relay:mini' },
    { ...MAC, startsAtBoot: 'unknown' },
    { ...MAC, status: 'offline' },
  ])
    assert.equal(await offered(other), null, JSON.stringify(other));
});

test('turning on: the password in a secure field, sent once, then a toast and the sheet closes', async (t) => {
  const root = await open();
  t.after(() => root.unmount());
  await click(button(root.host, 'Keep running after restart'));
  assert.equal(text(root.host.querySelector('.dialog-head')), 'Keep running after restart');
  assert.equal(
    text(root.host.querySelector('.machine-sheet-lede')),
    'Starts before anyone signs in. Needs an administrator password once.',
  );
  const input = field(root.host);
  assert.equal(input.type, 'password');
  assert.equal(input.autocomplete, 'off');
  assert.equal(button(root.host, 'Turn on').disabled, true, 'nothing to send yet');
  await setValue(input, 's3cret');
  await click(button(root.host, 'Turn on'));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.setStartAtBoot'),
    [['host.setStartAtBoot', 'ssh:mini', true, 's3cret']],
  );
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'mini keeps running after restart']);
  assert.equal(root.host.querySelector('.dialog'), null);
});

test('a wrong password keeps the sheet with the reason and an empty field; Enter sends, Cancel sends nothing', async (t) => {
  responses['host.setStartAtBoot'] = () =>
    Promise.reject(Object.assign(new Error('That password didn’t work.'), { code: 'wrong_password' }));
  const root = await open();
  t.after(() => root.unmount());
  await click(button(root.host, 'Keep running after restart'));
  await setValue(field(root.host), 'nope');
  field(root.host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(text(root.host.querySelector('.machine-sheet-error')), 'That password didn’t work.');
  assert.equal(field(root.host).value, '');
  assert.equal(button(root.host, 'Turn on').disabled, true);
  // Enter on an empty field sends nothing
  field(root.host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'host.setStartAtBoot').length, 1);
  await click(button(root.host, 'Cancel'));
  assert.equal(root.host.querySelector('.dialog'), null);
  assert.equal(calls.filter((c) => c[0] === 'host.setStartAtBoot').length, 1);
});

test('busy while it runs: the button says so and cannot be pressed again', async (t) => {
  let release: () => void = () => undefined;
  responses['host.setStartAtBoot'] = () => new Promise<void>((r) => (release = r));
  const root = await open({ ...MAC, startsAtBoot: 'yes' });
  t.after(() => root.unmount());
  await click(button(root.host, 'Keep running after restart'));
  // turning off: no command to copy, its own words
  assert.equal(buttons(root.host, 'Copy command').length, 0);
  assert.equal(
    text(root.host.querySelector('.machine-sheet-lede')),
    'It will start again only after someone signs in. Needs an administrator password.',
  );
  await setValue(field(root.host), 'pw');
  await click(button(root.host, 'Turn off'));
  assert.equal(button(root.host, 'Turning off…').disabled, true);
  release();
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'mini starts after sign-in again']);
  assert.deepEqual(
    calls.find((c) => c[0] === 'host.setStartAtBoot'),
    ['host.setStartAtBoot', 'ssh:mini', false, 'pw'],
  );
});

test('Copy command puts the command to run at the machine on the clipboard; a refusal stays in the sheet', async (t) => {
  const root = await open();
  t.after(() => root.unmount());
  await click(button(root.host, 'Keep running after restart'));
  await click(button(root.host, 'Copy command'));
  await flush();
  assert.deepEqual(
    calls.find((c) => c[0] === 'clipboard.write'),
    ['clipboard.write', "sudo /bin/sh -c 'x'"],
  );
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Command copied. Run it on the machine.']);
  assert.equal(root.host.querySelector('.dialog'), null);
  responses['host.startAtBootCommand'] = () => Promise.reject(new Error('Update this machine’s Host first.'));
  // the harness keeps the menu open after a pick
  if (!options(root.host).length) await click(button(root.host, 'More for mini'));
  await click(button(root.host, 'Keep running after restart'));
  await click(button(root.host, 'Copy command'));
  await flush();
  assert.equal(text(root.host.querySelector('.machine-sheet-error')), 'Update this machine’s Host first.');
});

test('the lede says FileVault’s limit when it is on, and Turning on… while busy', async (t) => {
  assert.deepEqual(keepRunningLede({ ...MAC, fileVault: 'on' } as any, true), [
    'Starts before anyone signs in. Needs an administrator password once.',
    'FileVault is on: after a power loss, someone must unlock the disk first.',
  ]);
  responses['host.setStartAtBoot'] = () => new Promise(() => undefined);
  const root = await open();
  t.after(() => root.unmount());
  await click(button(root.host, 'Keep running after restart'));
  await setValue(field(root.host), 'pw');
  await click(button(root.host, 'Turn on'));
  assert.equal(button(root.host, 'Turning on…').disabled, true);
  assert.equal(button(root.host, 'Copy command').disabled, true);
});
