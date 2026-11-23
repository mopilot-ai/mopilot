// The composer note's Install for an agent missing on the picked machine (HostAgentNote, src/lib/hostInstall.ts): one click installs it on the machine, its progress replaces the note, Cancel and Retry, a refusal is a toast, and once the machine is read again the note offers Sign in; an agent the machine cannot install, or an older Host, has no Install.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const PICK = { id: 'ssh:mini', name: 'mini', path: '/Users/u/app' };
const toasts: unknown[][] = [];
mockSource('src/store/core.ts', { set: () => undefined, toast: (...a: unknown[]) => void toasts.push(a) });
mockSource('src/session/useHostAgentChoice.ts', { useHostAgentChoice: () => null });
const { createElement } = await import('react');
const { HostAgentNote } = await import('../src/components/composer/HostAgentNote.tsx');
const { parseInstallView } = await import('../src/lib/hostInstall.ts');

// one bridge for the file: Host access is read once per window, so every test shares the fake that answered it
const fake = fakeNative({
  host: {
    access: async () => true,
    installAgent: async (id: string, harness: string) => ({ hostId: id, harness, state: 'queued', line: '', error: null, version: null }),
    cancelInstallAgent: async () => true,
  },
});
installNative(fake);

beforeEach(() => {
  toasts.length = 0;
});

test('B1: only a view with a machine, an agent and a known state is kept; text fields are strings or nothing', () => {
  const v = { hostId: 'ssh:a', harness: 'codex', state: 'running', line: 'x', error: null, version: null };
  assert.deepEqual(parseInstallView({ ...v, line: 3, error: 4, version: '1' }), { ...v, line: '', error: null, version: '1' });
  for (const bad of [
    null,
    'x',
    {},
    { ...v, hostId: '' },
    { ...v, hostId: 3 },
    { ...v, harness: '' },
    { ...v, harness: 1 },
    { ...v, state: 'green' },
    { ...v, state: 2 },
  ])
    assert.equal(parseInstallView(bad), null);
});

test('the note installs a missing agent on its machine in one click: progress, Cancel, a failure with Retry, then Sign in', async () => {
  const machine = { id: PICK.id, name: 'mini', signin: null, installable: ['codex'] };
  const note = { note: 'Codex: Not installed on mini; new chats start in Claude Code', blocked: { id: 'codex' } };
  const m = await mount(createElement(HostAgentNote, { view: { machine, choice: note } } as any));
  const push = async (o: object) => {
    fake.emit('host.onAgentInstall', { hostId: PICK.id, harness: 'codex', line: '', error: null, version: null, ...o });
    await m.render(createElement(HostAgentNote, { view: { machine, choice: note } } as any));
  };
  try {
    // Host access is answered by main first
    await new Promise((r) => setTimeout(r, 0));
    assert.match(m.host.textContent!, /Codex: Not installed on mini/);
    assert.equal($('button.btn-pill', m.host).textContent, 'Install on mini');
    await click($('button.btn-pill', m.host));
    await m.render(createElement(HostAgentNote, { view: { machine, choice: note } } as any));
    assert.deepEqual(fake.callsTo('host.installAgent'), [[PICK.id, 'codex']]);
    assert.match(m.host.textContent!, /Waiting to install Codex…/);
    await push({ state: 'running' });
    assert.match(m.host.textContent!, /Installing Codex…/);
    assert.equal($('button.btn-pill', m.host).textContent, 'Cancel');
    await click($('button.btn-pill', m.host));
    assert.deepEqual(fake.callsTo('host.cancelInstallAgent'), [[PICK.id, 'codex']]);
    await push({ state: 'failed', error: "Couldn't reach the npm registry (ENOTFOUND). Check this machine's network or proxy." });
    assert.match(m.host.textContent!, /Couldn't reach the npm registry/);
    assert.equal($('button.btn-pill', m.host).textContent, 'Retry');
    await push({ state: 'unreachable', error: null });
    assert.match(m.host.textContent!, /Couldn't install Codex\./);
    await push({ state: 'cancelled' });
    assert.match(m.host.textContent!, /Codex: Not installed on mini/, 'a cancelled install leaves the note as it was');
    await push({ state: 'installed', version: '1.0.0' });
    assert.match(m.host.textContent!, /Codex installed\./);
    // the machine was read again: Codex is installed and signed out, so the note has no button (the sign-in card above the composer signs it in)
    await m.render(
      createElement(HostAgentNote, {
        view: {
          machine: { ...machine, installable: [], signin: 'codex' },
          choice: { note: 'Codex: Sign in on mini', blocked: { id: 'codex' } },
        },
      } as any),
    );
    assert.deepEqual(
      $$('button.btn-pill', m.host).map((b: any) => b.textContent),
      [],
    );
  } finally {
    await m.unmount();
  }
});

test('a refused install is a toast; an agent the machine cannot install has no Install', async () => {
  const installAgent = fake.host.installAgent;
  (fake.host as any).installAgent = async () => Promise.reject(new Error('mini is offline.'));
  const machine = { id: PICK.id, name: 'mini', signin: null, installable: ['codex'] };
  const m = await mount(createElement(HostAgentNote, { view: { machine, choice: { note: 'n', blocked: { id: 'codex' } } } } as any));
  try {
    await click($('button.btn-pill', m.host));
    assert.equal(toasts.length, 1);
    await m.render(createElement(HostAgentNote, { view: { machine, choice: { note: 'n', blocked: { id: 'claude' } } } } as any));
    assert.equal(m.host.querySelector('button'), null);
    await m.render(
      createElement(HostAgentNote, {
        view: { machine: { ...machine, installable: undefined }, choice: { note: 'n', blocked: { id: 'codex' } } },
      } as any),
    );
    assert.equal(m.host.querySelector('button'), null, 'an older Host lists nothing it can install');
  } finally {
    (fake.host as any).installAgent = installAgent;
    await m.unmount();
  }
});
