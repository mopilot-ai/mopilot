// The Switch host dialog's one-click fix (src/components/composer/SwitchHostFix.tsx, fixFor in src/lib/hostSwitch.ts): a machine that lacks the chat's agent offers Install on it, one that has it signed out offers Sign in on it, the refusal of a press offers the same, and the copy names the machine each refusal concerns.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { fixFor, refusalCopy, refusalMachine } from '../src/lib/hostSwitch.ts';
import type { SwitchMachine } from '../src/lib/hostSwitch.ts';

const { SwitchHostDialog } = await import('../src/components/composer/SwitchHostDialog.tsx');

// one bridge for the file: Host access is read once per window
const fake = fakeNative({
  host: {
    access: async () => true,
    installAgent: async (id: string, harness: string) => ({ hostId: id, harness, state: 'queued', line: '', error: null, version: null }),
    cancelInstallAgent: async () => true,
    signin: async (id: string, harness: string) => ({
      hostId: id,
      harness,
      state: 'starting',
      codes: [],
      link: false,
      url: null,
      error: null,
    }),
    cancelSignin: async () => true,
    signinInput: async () => true,
  },
});
installNative(fake);

const agent = (id: string, label: string, state: 'ready' | 'signin' | 'missing') => ({ id, label, state, reason: '' });
const box = (agents: object[], over: Partial<SwitchMachine> = {}): SwitchMachine => ({
  id: 'ssh:box',
  name: 'build-box',
  status: 'online',
  note: 'SSH',
  agents: agents as any,
  installable: ['claude', 'codex'],
  ...over,
});
const LOCAL: SwitchMachine = { id: 'local', name: 'This Mac', status: 'online', note: '' };

test('fixFor: install for a missing agent its Host installs, sign in for a signed-out one, the press code for a row read as ready, nothing otherwise', () => {
  const missing = box([agent('claude', 'Claude Code', 'missing')]);
  assert.deepEqual(fixFor(missing, 'claude'), { kind: 'install', machine: missing, agent: 'claude', label: 'Claude Code' });
  assert.equal(fixFor({ ...missing, installable: [] }, 'claude'), null, 'its Host cannot install it');
  assert.equal(fixFor({ ...missing, installable: undefined }, 'claude'), null, 'an older row lists nothing installable');
  const out = box([agent('claude', 'Claude Code', 'signin')]);
  assert.equal(fixFor(out, 'claude')?.kind, 'signin');
  // the row is ready (or does not list the agent) but the press refused: the code says what to fix
  const ready = box([agent('claude', 'Claude Code', 'ready')]);
  assert.equal(fixFor(ready, 'claude', 'agent_signed_out')?.kind, 'signin');
  assert.equal(fixFor(ready, 'claude', 'agent_login_refused')?.kind, 'signin');
  assert.equal(fixFor(box([]), 'codex', 'agent_missing')?.label, 'Codex', 'an unlisted agent is named by its id');
  assert.equal(fixFor(box([]), 'codex', 'agent_missing')?.kind, 'install');
  assert.equal(fixFor(box([], { installable: [] }), 'codex', 'agent_missing'), null);
  assert.equal(fixFor(ready, 'claude', 'turn_running'), null, 'another refusal has no fix');
  assert.equal(fixFor(ready, 'claude'), null);
  assert.equal(fixFor(out, undefined), null, 'a chat with no known agent judges nothing');
  assert.equal(fixFor({ ...missing, status: 'offline' }, 'claude'), null, 'an offline machine cannot be fixed from here');
  // the row's own state wins over a stale code
  assert.equal(fixFor(out, 'claude', 'agent_missing')?.kind, 'signin');
});

test('copy names the machine the refusal is about: a cloud source that may still run is the chat host, the others the target', () => {
  assert.equal(refusalMachine('source_may_run', 'target', 'cloud-1'), 'cloud-1');
  assert.equal(refusalMachine('source_unknown', 'target', 'cloud-1'), 'cloud-1');
  assert.equal(refusalMachine('target_dirty', 'target', 'cloud-1'), 'target');
  assert.equal(refusalMachine(undefined, 'target', 'cloud-1'), 'target');
  assert.equal(refusalCopy('source_may_run', 'cloud-1'), 'cloud-1 still exists at the provider. Wake it, or delete it first.');
  assert.equal(refusalCopy('nothing_to_carry', 'x'), "The changes couldn't be gathered. Check that the folder has a commit and a remote.");
  assert.equal(
    refusalCopy('carry_mismatch', 'box'),
    "The changes that reached box aren't the ones sent. Try again, or continue without the changes.",
  );
});

const props = (machines: SwitchMachine[], over: Record<string, any> = {}) => ({
  chatId: 'c1',
  project: '/work/app',
  ownerId: 'local',
  ownerLost: false,
  machines,
  turnRunning: false,
  agent: 'claude',
  onContinue: async () => undefined,
  onClose: () => undefined,
  ...over,
});
const fixButtons = () => $$('[data-switch-fix] button').map((b) => b.textContent);
const tick = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));
const type = (el: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
const pressSwitch = () => click($$('.acct-dialog-actions button').find((b) => b.textContent === 'Switch host')!);

test("a machine without the chat's agent offers Install on it in the dialog (Settings' button): progress, a failure that brings the button back, and the machine is read again when it ends", async () => {
  const missing = box([agent('claude', 'Claude Code', 'missing')]);
  const m = await mount(createElement(SwitchHostDialog, props([LOCAL, missing]) as any));
  const push = async (state: string, o: object = {}) => {
    await act(async () =>
      fake.emit('host.onAgentInstall', { hostId: 'ssh:box', harness: 'claude', state, line: '', error: null, version: null, ...o }),
    );
    await tick();
  };
  try {
    await tick();
    assert.equal($('.switch-host-note').textContent, "Claude Code isn't installed on build-box.");
    assert.deepEqual(fixButtons(), ['Install on build-box']);
    await click($('[data-switch-fix] button'));
    assert.deepEqual(fake.callsTo('host.installAgent'), [['ssh:box', 'claude']]);
    await push('running');
    assert.match($('[data-switch-fix]').textContent!, /Installing Claude Code…/);
    assert.deepEqual(fixButtons(), ['Installing…']);
    await push('failed', { error: 'No network.' });
    assert.match($('[data-switch-fix]').textContent!, /No network\./);
    assert.deepEqual(fixButtons(), ['Install on build-box'], 'the button is back to try again');
    await click($('[data-switch-fix] button'));
    await push('running');
    await push('installed', { version: '1' });
    assert.match($('[data-switch-fix]').textContent!, /Checking build-box…/);
    assert.deepEqual(fixButtons(), [], 'nothing more to press while the machine is read again');
    // the registry says it is ready: the row opens and the fix goes
    await m.render(createElement(SwitchHostDialog, props([LOCAL, box([agent('claude', 'Claude Code', 'ready')])]) as any));
    assert.equal($('[data-switch-fix]'), null);
    assert.equal(($('[role=radio]') as HTMLButtonElement).disabled, false);
  } finally {
    await m.unmount();
  }
});

test("a signed-out agent offers Sign in on the machine (Settings' controls): the code, Cancel, Try again, and the dialog reads the machine when it is signed in", async () => {
  const out = box([agent('claude', 'Claude Code', 'signin')]);
  const m = await mount(createElement(SwitchHostDialog, props([LOCAL, out]) as any));
  const push = async (o: object) => {
    await act(async () =>
      fake.emit('host.onSignin', {
        hostId: 'ssh:box',
        harness: 'claude',
        state: 'waiting',
        codes: [],
        link: false,
        url: null,
        error: null,
        ...o,
      }),
    );
    await tick();
  };
  try {
    await tick();
    assert.deepEqual(fixButtons(), ['Sign in on build-box']);
    await click($('[data-switch-fix] button'));
    assert.deepEqual(fake.callsTo('host.signin'), [['ssh:box', 'claude']]);
    await push({ state: 'starting' });
    assert.deepEqual(fixButtons(), ['Cancel']);
    await push({ link: true });
    assert.match($('[data-switch-fix]').textContent!, /Finish signing in in your browser/);
    await type($('input[aria-label="Code from the page"]') as HTMLInputElement, ' abc ');
    await click($$('[data-switch-fix] button').find((b) => b.textContent === 'Send')!);
    assert.equal(fake.callsTo('host.signinInput').length, 1);
    await click($$('[data-switch-fix] button').find((b) => b.textContent === 'Cancel')!);
    assert.deepEqual(fake.callsTo('host.cancelSignin'), [['ssh:box', 'claude']]);
    await push({ state: 'waiting', codes: ['ABCD'], link: true });
    assert.equal($('code')!.textContent!.trim(), 'ABCD');
    assert.equal($('input[aria-label="Code from the page"]'), null, 'a code the machine relayed needs none typed');
    await push({ state: 'expired' });
    assert.deepEqual(fixButtons(), ['Try again']);
    await click($('[data-switch-fix] button'));
    assert.equal(fake.callsTo('host.signin').length, 2);
    await push({ state: 'signed-in' });
    assert.match($('[data-switch-fix]').textContent!, /Checking build-box…/);
  } finally {
    await m.unmount();
  }
});

test('a press the machine refuses for its agent offers the fix for that machine, and the refusal goes away once it is fixed', async () => {
  const ready = box([agent('claude', 'Claude Code', 'ready')]);
  let attempts = 0;
  const m = await mount(
    createElement(
      SwitchHostDialog,
      props([LOCAL, ready], {
        onContinue: async () => {
          if (attempts++ === 0) throw Object.assign(new Error('x'), { code: 'agent_signed_out' });
        },
      }) as any,
    ),
  );
  try {
    await tick();
    assert.equal($('[data-switch-fix]'), null, 'the row reads as ready: nothing to fix yet');
    await type($('input[aria-label="Folder on the host"]') as HTMLInputElement, '/srv/app');
    await pressSwitch();
    assert.equal($('[role=alert]').textContent, 'Sign in to Claude Code on build-box.');
    assert.deepEqual(fixButtons(), ['Sign in on build-box']);
    fake.emit('host.onSignin', {
      hostId: 'ssh:box',
      harness: 'claude',
      state: 'signed-in',
      codes: [],
      link: false,
      url: null,
      error: null,
    });
    await tick();
    assert.equal($('[role=alert]'), null, 'the refusal is cleared once the sign-in ends');
  } finally {
    await m.unmount();
  }
});

test('a cloud source that may still run is named in the refusal, not the machine the chat is going to', async () => {
  const cloud: SwitchMachine = { id: 'cloud:1', name: 'my-cloud', status: 'online', note: '' };
  const m = await mount(
    createElement(
      SwitchHostDialog,
      props([cloud, LOCAL], {
        ownerId: 'cloud:1',
        onContinue: async () => Promise.reject(Object.assign(new Error('x'), { code: 'source_may_run' })),
      }) as any,
    ),
  );
  try {
    await tick();
    await type($('input[aria-label="Folder on the host"]') as HTMLInputElement, '/srv/app');
    await pressSwitch();
    assert.equal($('[role=alert]').textContent, 'my-cloud still exists at the provider. Wake it, or delete it first.');
  } finally {
    await m.unmount();
  }
});
