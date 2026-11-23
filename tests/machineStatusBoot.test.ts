// A machine's status line about starting at boot (src/lib/machineStatus.ts): a Mac that FileVault holds after a restart says its disk is locked, a Mac over SSH waiting for a sign-in points at Keep running after restart, and a Linux machine whose user does not linger says it stops at sign-out with the fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KEEP_RUNNING_HINT, LINGER_HINT, machineStatus } from '../src/lib/machineStatus.ts';

const machine = (o: object = {}) =>
  ({
    id: 'ssh:m',
    name: 'm',
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
const ctx = { now: 0, signin: null, installing: undefined } as any;

test('a Mac whose disk FileVault keeps locked after a restart says so, the registry’s sentence as the tooltip', () => {
  const note = 'The machine restarted and FileVault keeps its disk locked until someone unlocks it at the machine.';
  assert.deepEqual(machineStatus(machine({ status: 'offline', waitingForLogin: 'locked', note, platform: 'darwin' }), ctx), {
    dot: 'warn',
    text: 'Restarted · disk locked',
    title: note,
  });
  assert.equal(machineStatus(machine({ status: 'offline', waitingForLogin: 'locked' }), ctx).title, undefined);
});

test('a Mac over SSH waiting for a sign-in points at Keep running after restart; another machine keeps the registry’s sentence', () => {
  const note = 'The machine restarted and is waiting for someone to sign in.';
  const waiting = { status: 'offline', waitingForLogin: 'restarted', note };
  assert.equal(machineStatus(machine({ ...waiting, platform: 'darwin' }), ctx).title, KEEP_RUNNING_HINT);
  assert.equal(machineStatus(machine({ ...waiting, platform: 'darwin', id: 'relay:m' }), ctx).title, note);
  assert.equal(machineStatus(machine({ ...waiting, platform: 'linux' }), ctx).title, note);
  assert.equal(KEEP_RUNNING_HINT, 'Once it’s back, turn on Keep running after restart in its ⋯ menu.');
});

test('Linux without lingering: it stops when you sign out, with the command that fixes it; lingering or unknown says nothing', () => {
  assert.deepEqual(machineStatus(machine({ platform: 'linux', startsAtBoot: 'no' }), ctx), {
    dot: 'warn',
    text: 'Stops when you sign out',
    title: LINGER_HINT,
  });
  assert.equal(machineStatus(machine({ platform: 'linux', startsAtBoot: 'yes' }), ctx).text, 'Online · Claude Code');
  assert.equal(machineStatus(machine({ platform: 'linux', startsAtBoot: 'unknown' }), ctx).text, 'Online · Claude Code');
  // an agent that still needs a sign-in keeps its line and button
  const signin = machineStatus(
    machine({ platform: 'linux', startsAtBoot: 'no', agents: [{ id: 'claude', label: 'Claude Code', state: 'signin', reason: '' }] }),
    ctx,
  );
  assert.equal(signin.text, 'Claude Code needs sign-in');
  assert.equal(signin.action?.label, 'Sign in');
  // a Mac's login agent is the normal case, not a warning
  assert.equal(machineStatus(machine({ platform: 'darwin', startsAtBoot: 'no' }), ctx).text, 'Online · Claude Code');
  assert.equal(LINGER_HINT, 'To fix, run on the machine: sudo loginctl enable-linger $USER');
});

test('shared phone and desktop status retain boot states after the shared-line extraction', async () => {
  const { machineLine, LEAD_STATES } = await import('../shared/host/machineLine.mjs');
  const { createRequire } = await import('node:module');
  const { phoneMachine } = createRequire(import.meta.url)('../electron/remote/phoneMachines.cjs');
  for (const row of [
    machine({ status: 'offline', waitingForLogin: 'locked', platform: 'darwin' }),
    machine({ status: 'offline', waitingForLogin: 'restarted', platform: 'darwin' }),
    machine({ platform: 'linux', startsAtBoot: 'no' }),
    machine({ platform: 'linux', startsAtBoot: 'no', localNetwork: 'denied' }),
    machine({ platform: 'linux', startsAtBoot: 'no', agents: [{ id: 'codex', label: 'Codex', state: 'signin' }] }),
  ]) {
    const desktop = machineStatus(row, ctx);
    assert.deepEqual(machineLine(row, 0), { dot: desktop.dot, text: desktop.text });
    const phone = phoneMachine(row, null, { now: 0, orgCovers: () => false });
    assert.deepEqual({ dot: phone.tone, text: phone.line }, { dot: desktop.dot, text: desktop.text });
  }
  const waiting = LEAD_STATES.find((s) => s.id === 'waiting-for-login')!;
  const noId = machine({ status: 'offline', waitingForLogin: 'signed-out', platform: 'darwin' });
  delete noId.id;
  assert.equal(waiting.line(noId, { now: 0 }).title, undefined);
});
