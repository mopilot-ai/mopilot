// Adding a Linux machine lets its user's systemd manager linger (electron/host/install.cjs), so the Host keeps running after sign-out and starts at boot before anyone signs in; a machine that will not allow it keeps a working install with the command that fixes it, a Mac has no such step, and a rollback turns lingering off only when this app turned it on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bundle, machine, upto } from './support/host-install-kit.ts';
const require = createRequire(import.meta.url);
const { createInstaller, LINGER_ON, LINGER_UNDO, HOST_HOME } = require('../electron/host/install.cjs');

const step = (out: any) => out.steps.find((s: any) => s.id === 'linger');

test('Linux: lingering turned on, or already on, is a passing step after the Host started', async () => {
  for (const said of ['turned-on', 'already']) {
    const m = machine({ 'enable-linger': { stdout: `${said}\n` } });
    const out = await createInstaller({ channel: m.channel, bundle }).install('me@box');
    assert.equal(out.ok, true);
    assert.deepEqual(step(out), {
      id: 'linger',
      label: 'Keep running after sign-out',
      state: 'ok',
      output: 'Starts with the machine, before anyone signs in.',
      index: 5,
      total: 6,
    });
    const ids = out.steps.map((s: any) => s.id);
    assert.equal(ids.indexOf('linger'), ids.indexOf('start') + 1);
    assert.equal(upto(m, 'enable-linger'), LINGER_ON);
  }
});

test('Linux: a machine that refuses lingering (or a command that fails) keeps the install, with the command that fixes it', async () => {
  for (const reply of [{ stdout: 'refused\n' }, { code: 1, stderr: 'boom' }, new Error('ssh died')]) {
    const out = await createInstaller({ channel: machine({ 'enable-linger': reply }).channel, bundle }).install('me@box');
    assert.equal(out.ok, true);
    assert.equal(step(out).state, 'skipped');
    assert.equal(step(out).output, 'Stops when you sign out. To fix, run on the machine: sudo loginctl enable-linger $USER');
  }
});

test('a Mac has no lingering step', async () => {
  const m = machine({ 'uname -sm': { stdout: 'Darwin arm64\n' } });
  const out = await createInstaller({ channel: m.channel, bundle }).install('mac');
  assert.equal(out.ok, true);
  assert.equal(step(out), undefined);
  assert.ok(!m.commands().some((c) => c.includes('linger')));
});

test('the commands: lingering is asked of loginctl for this user, marked when this app turned it on, and undone only then', async () => {
  assert.match(LINGER_ON, /loginctl show-user "\$\(id -un\)" --property=Linger --value/);
  assert.match(LINGER_ON, /loginctl enable-linger "\$\(id -un\)"/);
  assert.ok(LINGER_ON.includes(`touch "${HOST_HOME}/linger-on"`));
  assert.ok(LINGER_UNDO.startsWith(`if [ -f "${HOST_HOME}/linger-on" ]; then loginctl disable-linger "$(id -un)"`));
  // a failed Linux install rolls back with the undo; a Mac's rollback has none
  const lin = machine({ pair: { code: 1, stderr: 'boom' } });
  assert.equal((await createInstaller({ channel: lin.channel, bundle }).install('me@box')).rolledBack, true);
  assert.ok(upto(lin, 'uninstall').includes(LINGER_UNDO));
  const mac = machine({ 'uname -sm': { stdout: 'Darwin arm64\n' }, pair: { code: 1, stderr: 'boom' } });
  await createInstaller({ channel: mac.channel, bundle }).install('mac');
  assert.ok(!upto(mac, 'uninstall').includes('linger'));
});
