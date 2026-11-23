// Adding a Mac nobody is signed in on (#3593) as the system daemon: the install's Keep running after restart step (electron/host/install.cjs over daemonInstall.cjs) sends the administrator password only to sudo's standard input and starts the Host before anyone signs in; a wrong password is rolled back like any failed step, one after the daemon is on is not; main and the IPC pass the password only as that option; and the Add machine card asks for it in place and runs the add again with it, or keeps the plain message when the person cancels.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle, machine, upto } from './support/host-install-kit.ts';
import {
  setup,
  resetCtl,
  responses,
  calls,
  useStore,
  defaultState,
  click,
  button,
  buttons,
  text,
  setValue,
  flush,
} from './support/settings-harness.ts';
// @ts-ignore: plain ESM without declarations
import { NO_GUI_SESSION } from '../shared/host/launchd.mjs';
const require = createRequire(import.meta.url);
const { createInstaller } = require('../electron/host/install.cjs');
const { register } = require('../electron/app/ipc/host.cjs');

const mac = (script = {}) => machine({ 'uname -sm': { stdout: 'Darwin arm64\n' }, ...script });
const ids = (out: any) => out.steps.map((s: any) => s.id);

test('with the password, a Mac’s Host is made the daemon after its unit and before it starts; the password goes on sudo’s standard input only', async () => {
  const m = mac();
  const out = await createInstaller({ channel: m.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'pw' });
  assert.equal(out.ok, true);
  assert.deepEqual(ids(out).slice(-5), ['unit', 'daemon', 'start', 'status', 'pair']);
  assert.deepEqual(
    out.steps.find((s: any) => s.id === 'daemon'),
    { id: 'daemon', label: 'Keep running after restart', state: 'ok', output: 'Starts before anyone signs in.', index: 5, total: 6 },
  );
  // loading the daemon started the Host: no restart of it that the status check would land in the middle of
  assert.deepEqual(
    out.steps.find((s: any) => s.id === 'start'),
    { id: 'start', label: 'Start the Host', state: 'ok', output: 'Started by the system daemon.', index: 5, total: 6 },
  );
  assert.ok(!m.commands().some((c) => c.includes('pkill') || c.includes('launchctl bootstrap "$D"')));
  const sudo = m.ran.find((r) => r.command.startsWith('/usr/bin/sudo -S -k'));
  assert.deepEqual(sudo?.input, Buffer.from('pw\n'));
  assert.ok(m.ran.every((r) => !r.command.includes('pw\n')));
  assert.ok(upto(m, 'LaunchAgents/ai.mopilot.host.plist"').startsWith('rm -f'));
  // Linux, or no password, never runs sudo
  const lin = machine();
  await createInstaller({ channel: lin.channel, bundle }).install('me@box', undefined, { daemonPassword: 'pw' });
  assert.ok(!lin.commands().some((c) => c.includes('sudo')));
  const plain = mac();
  await createInstaller({ channel: plain.channel, bundle }).install('me@mini');
  assert.ok(!plain.commands().some((c) => c.includes('sudo')));
  assert.ok(
    plain.commands().some((c) => c.includes('launchctl bootstrap "$D"')),
    'without the daemon the agent is started as before',
  );
});

test('a wrong password fails its own step and rolls the install back; a failure after the daemon is on keeps it', async () => {
  const wrong = mac({ '/usr/bin/sudo': { code: 1, stderr: 'Sorry, try again.' } });
  const out = await createInstaller({ channel: wrong.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'nope' });
  assert.equal(out.ok, false);
  assert.equal(out.failedStep, 'daemon');
  assert.equal(out.error, 'That password didn’t work.');
  assert.equal(out.rolledBack, true);
  assert.ok(!wrong.commands().some((c) => c.includes('launchctl bootstrap "$D"')), 'nothing was started');
  const later = mac({ pair: { code: 1, stderr: 'boom' } });
  const kept = await createInstaller({ channel: later.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'pw' });
  assert.equal(kept.failedStep, 'pair');
  assert.equal(kept.rolledBack, false, 'only an administrator can take the daemon off');
  assert.ok(!later.commands().some((c) => c.includes('uninstall')));
});

test('a repeated install with a Host already there: a failure before the daemon puts it back, one with the daemon on or uncertain leaves it', async () => {
  const there = { 'test -f': { stdout: 'installed\n' }, 'tar -xzf': { stdout: 'made=yes prev=/old\n' } };
  // a wrong password wrote nothing as root: the earlier Host runs again on the version it had
  const wrong = mac({ ...there, '/usr/bin/sudo': { code: 1, stderr: 'Sorry, try again.' } });
  const refused = await createInstaller({ channel: wrong.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'nope' });
  assert.equal(refused.failedStep, 'daemon');
  assert.equal(refused.rolledBack, true);
  assert.ok(refused.steps.some((s: any) => s.id === 'rollback' && s.label === 'Put the Host back'));
  // a lost acknowledgment may follow the root plist: nothing is moved back under a daemon that may run these files
  const lost = mac({ ...there, '/usr/bin/sudo': { code: 255, stderr: 'Connection closed.' } });
  const uncertain = await createInstaller({ channel: lost.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'pw' });
  assert.equal(uncertain.failedStep, 'daemon');
  assert.equal(uncertain.rolledBack, false);
  assert.ok(!uncertain.steps.some((s: any) => s.id === 'rollback'));
  // nor under one that is on
  const later = mac({ ...there, pair: { code: 1, stderr: 'boom' } });
  const kept = await createInstaller({ channel: later.channel, bundle }).install('me@mini', undefined, { daemonPassword: 'pw' });
  assert.equal(kept.failedStep, 'pair');
  assert.equal(kept.rolledBack, false);
  assert.ok(!kept.steps.some((s: any) => s.id === 'rollback'));
});

test('main passes the password to the install only as its option; the IPC takes only a non-empty string', async () => {
  const handlers = new Map<string, any>();
  const added: any[] = [];
  const svc: any = { list: () => ({ machines: [], resolved: true }), add: async (...a: any[]) => (added.push(a), { ok: true }) };
  register(
    { handle: (c: string, fn: any) => handlers.set(c, fn) },
    { app: { getPath: () => '/ud' }, broadcastAll: () => undefined },
    { create: () => svc, allowed: () => true },
  );
  const call = (...a: any[]) => handlers.get('host:add')({}, ...a);
  await call('me@mini', { daemonPassword: 'pw' });
  await call('me@mini', { daemonPassword: '' });
  await call('me@mini', { daemonPassword: 7 });
  await call('me@mini');
  assert.deepEqual(added, [
    ['me@mini', { daemonPassword: 'pw' }],
    ['me@mini', {}],
    ['me@mini', {}],
    ['me@mini', {}],
  ]);
  // machines.add hands the option to the installer
  const { createMachines } = require('../electron/host/machines.cjs');
  const got: any[] = [];
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'add-daemon-'));
  const m = createMachines({
    dir,
    allowed: () => true,
    watch: () => undefined,
    call: async () => null,
    installer: { install: async (...a: any[]) => (got.push(a.length === 3 ? a[2] : null), { ok: false, error: 'x', id: '', steps: [] }) },
  });
  await m.add('me@mini', { daemonPassword: 'pw' });
  await m.add('me@mini');
  m.dispose();
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(got, [{ daemonPassword: 'pw' }, {}]);
});

await setup();
const { renderMachines } = await import('./support/addMachineView.ts');
let finish: (v: unknown) => void = () => undefined;
beforeEach(() => {
  resetCtl();
  useStore.setState({ ...defaultState(), route: { name: 'settings', section: 'connections' } }, true);
  Object.assign(responses, {
    'host.access': true,
    'host.onAccess': () => () => undefined,
    'host.machines': () => Promise.resolve({ machines: [], resolved: true }),
    'host.onMachines': () => () => undefined,
    'host.onInstallStep': () => () => undefined,
    'host.onSignin': () => () => undefined,
    'host.onPrompt': () => () => undefined,
    'host.discover': () => Promise.resolve([]),
    'host.add': () => new Promise((r) => (finish = r)),
  });
  calls.length = 0;
});
const NOBODY = {
  ok: false,
  paired: false,
  error: `Bootstrap failed: 5: Input/output error\n${NO_GUI_SESSION}`,
  id: '',
  steps: [{ id: 'start', label: 'Start the Host', state: 'failed', output: NO_GUI_SESSION }],
};
async function addMini() {
  const view = await renderMachines();
  await flush();
  await click(button(view.host, 'Add machine'));
  await setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'me@mini');
  await click(button(view.host, 'Add'));
  finish(NOBODY);
  await flush();
  return view;
}
const field = (root: Element) => root.querySelector('input[aria-label="Administrator password for me@mini"]') as HTMLInputElement;

test('the card offers Enter password; the password field adds it again with the password, never kept in the field', async (t) => {
  const view = await addMini();
  t.after(() => view.unmount());
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Nobody is signed in on me@mini');
  await click(button(view.host, 'Enter password'));
  const input = field(view.host);
  assert.equal(input.type, 'password');
  assert.equal(button(view.host, 'Turn on').disabled, true);
  await setValue(input, 's3cret');
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'host.add'),
    [
      ['host.add', 'me@mini'],
      ['host.add', 'me@mini', { daemonPassword: 's3cret' }],
    ],
  );
  assert.equal(field(view.host), null, 'the field goes while it adds');
  finish({ ok: true, paired: true, error: '', id: 'ssh:me@mini', steps: [] });
  await flush();
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', 'Added me@mini']);
});

test('Cancel keeps the plain message and sends nothing; an empty field sends nothing; Turn on sends', async (t) => {
  const view = await addMini();
  t.after(() => view.unmount());
  await click(button(view.host, 'Enter password'));
  field(view.host).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await flush();
  await click(button(view.host, 'Cancel'));
  assert.equal(field(view.host), null);
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Nobody is signed in on me@mini');
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 1);
  await click(button(view.host, 'Enter password'));
  await setValue(field(view.host), 'pw');
  await click(button(view.host, 'Turn on'));
  assert.equal(calls.filter((c) => c[0] === 'host.add').length, 2);
  // a wrong password comes back as the card's reason, with the same offer to try again
  finish({
    ok: false,
    paired: false,
    error: 'That password didn’t work.',
    id: '',
    steps: [{ id: 'daemon', label: 'Keep running after restart', state: 'failed', output: 'That password didn’t work.' }],
  });
  await flush();
  assert.equal(text(view.host.querySelector('.host-install-line')), 'Couldn’t keep me@mini running without sign-in');
  assert.equal(buttons(view.host, 'Enter password').length, 1);
});

test('an uncertain daemon mutation never uninstalls files the root service may already own', async () => {
  for (const mode of ['bootstrap', 'ack', 'transport', 'cleanup']) {
    const m = mac({
      '/usr/bin/sudo':
        mode === 'bootstrap' ? { code: 1, stderr: 'bootstrap failed' } : mode === 'ack' ? { stdout: '' } : { stdout: 'turned-on\n' },
    });
    const channel = async (dest: string, command: string, input?: Buffer) => {
      const answer = await m.channel(dest, command, input);
      if (
        (mode === 'transport' && command.startsWith('/usr/bin/sudo')) ||
        (mode === 'cleanup' && command.startsWith('rm -f "$HOME/Library/LaunchAgents/'))
      )
        throw new Error('connection lost after mutation');
      return answer;
    };
    const out = await createInstaller({ channel, bundle }).install('me@mini', undefined, { daemonPassword: 'pw' });
    assert.equal(out.failedStep, 'daemon', mode);
    assert.equal(out.rolledBack, false, mode);
    assert.ok(!m.commands().some((c) => c.includes('uninstall')), mode);
  }
});

for (const when of ['before', 'during'])
  test(`daemon password stays bound to the failed machine when its address is edited ${when} the prompt`, async (t) => {
    const view = await addMini();
    t.after(() => view.unmount());
    const edit = () => setValue(view.host.querySelector('input[aria-label="Machine"]')!, 'other@host');
    if (when === 'before') await edit();
    await click(button(view.host, 'Enter password'));
    if (when === 'during') await edit();
    await setValue(field(view.host), 'pw');
    await click(button(view.host, 'Turn on'));
    assert.deepEqual(calls.filter((c) => c[0] === 'host.add').at(-1), ['host.add', 'me@mini', { daemonPassword: 'pw' }]);
    finish({ ok: true, paired: true, error: '', id: 'ssh:me@mini', steps: [] });
    await flush();
  });

test('daemon helper distinguishes local credential refusal from a lost remote acknowledgment', async () => {
  const { turnOn } = require('../electron/host/daemonInstall.cjs');
  for (const [password, stderr, code] of [
    ['bad\ninput', '', 'invalid'],
    ['pw', 'not in the sudoers file', 'not_admin'],
    ['pw', 'Sorry, try again.', 'wrong_password'],
  ]) {
    const m = mac({ '/usr/bin/sudo': { code: 1, stderr } });
    await assert.rejects(
      turnOn((command: string, input?: Buffer) => m.channel('me@mini', command, input), 'host', password),
      {
        code,
        daemonMayExist: false,
      },
    );
  }
  for (const prefix of ['/usr/bin/sudo', 'rm -f']) {
    const m = mac();
    await assert.rejects(
      turnOn(
        async (command: string, input?: Buffer) => {
          if (command.startsWith(prefix)) throw new Error('lost acknowledgment');
          return m.channel('me@mini', command, input);
        },
        'host',
        'pw',
      ),
      { message: 'lost acknowledgment', daemonMayExist: true },
    );
  }
});
