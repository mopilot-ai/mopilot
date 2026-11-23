// An agent a machine lacks and its Host cannot install (the catalog has no npm line): the composer note shows the vendor's own command with Copy and Check again, or its docs page, and nothing for an agent that is switched off; shared/host/installHelp.mjs says which.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';

const toasts: unknown[][] = [];
mockSource('src/store/core.ts', {
  set: () => undefined,
  toast: (...a: unknown[]) => void toasts.push(a),
});
mockSource('src/session/useHostAgentChoice.ts', {
  useHostAgentChoice: () => null,
});
const { createElement } = await import('react');
const { HostAgentNote } = await import('../src/components/composer/HostAgentNote.tsx');
const { installHelp, manualOffers } = await import('../shared/host/installHelp.mjs');

let copyFails = false;
let checkFails = false;
const fake = fakeNative({
  host: {
    access: async () => true,
    check: async () => {
      if (checkFails) throw new Error('mini is offline.');
    },
  },
  clipboard: {
    write: async () => {
      if (copyFails) throw new Error('denied');
    },
  },
});
installNative(fake);

beforeEach(() => {
  toasts.length = 0;
  copyFails = false;
  checkFails = false;
});

test('installHelp: the vendor command for the machine, else its docs page; nothing for an unknown or switched-off agent', () => {
  assert.equal(installHelp('cursor', 'darwin')!.command, 'curl https://cursor.com/install -fsS | bash');
  assert.equal(installHelp('cursor', '')!.docs, 'https://cursor.com/docs/cli/installation');
  assert.match(installHelp('goose', 'linux')!.command!, /download_cli\.sh/);
  assert.deepEqual(installHelp('kiro', 'darwin'), {
    command: null,
    docs: 'https://kiro.dev/docs/acp/',
  });
  assert.match(installHelp('claude', 'linux')!.command!, /claude\.ai\/install\.sh/);
  assert.equal(installHelp('trae', 'darwin'), null, 'trae is switched off');
  assert.equal(installHelp('nope', 'darwin'), null);
});

test('manualOffers: missing, not installable by the Host, offered by the catalog; never the test agent', () => {
  const agents = [
    { id: 'claude', state: 'ready' },
    { id: 'codex', state: 'missing' },
    { id: 'cursor', state: 'missing' },
    { id: 'kiro', state: 'signin' },
    { id: 'trae', state: 'missing' },
    { id: 'fake', state: 'missing' },
    { id: 'goose', state: 'missing' },
  ];
  assert.deepEqual(
    manualOffers({ agents, installable: ['codex', 'goose'] }).map((a) => a.id),
    ['cursor'],
  );
});

const noteOf = (id: string, machine: object = {}) => ({
  machine: {
    id: 'ssh:mini',
    name: 'mini',
    platform: 'darwin',
    signin: null,
    installable: [],
    ...machine,
  },
  choice: {
    note: 'Agent: Not installed on mini',
    blocked: { id, label: 'Agent', state: 'missing' },
  },
});
const checkAgain = (host: any) => $$('button', host).find((b: any) => b.textContent === 'Check again')!;

test('the note shows the vendor command with Copy and Check again for an agent the Host cannot install', async () => {
  const m = await mount(createElement(HostAgentNote, { view: noteOf('cursor') } as any));
  try {
    await new Promise((r) => setTimeout(r, 0));
    assert.match(m.host.textContent!, /Not installed on mini/);
    assert.equal($('code.install-cmd', m.host).textContent, 'curl https://cursor.com/install -fsS | bash');
    assert.equal($('button.install-copy', m.host).getAttribute('title'), 'Copy command');
    await click($('button.install-copy', m.host));
    assert.deepEqual(fake.callsTo('clipboard.write').at(-1), ['curl https://cursor.com/install -fsS | bash']);
    await new Promise((r) => setTimeout(r, 0));
    assert.equal($('button.install-copy', m.host).getAttribute('title'), 'Copied');
    assert.ok(!$$('button.btn-pill', m.host).some((b: any) => /^Install/.test(b.textContent)), 'no Install button');
    const before = fake.callsTo('host.check').length;
    await click(checkAgain(m.host));
    assert.equal(fake.callsTo('host.check').length, before + 1);
    assert.equal(toasts.length, 0);
    // a refused re-read is a toast
    checkFails = true;
    await click(checkAgain(m.host));
    assert.equal(toasts.length, 1);
    // a copy that failed does not say it copied
    copyFails = true;
    await click($('button.install-copy', m.host));
    await new Promise((r) => setTimeout(r, 0));
    assert.equal($('button.install-copy', m.host).getAttribute('title'), 'Copy command');
  } finally {
    await m.unmount();
  }
});

test('an agent with no command shows its docs page; a switched-off agent and a Host-installable one show neither', async () => {
  const m = await mount(createElement(HostAgentNote, { view: noteOf('kiro') } as any));
  try {
    assert.equal(m.host.querySelector('code'), null);
    await click($$('button', m.host).find((b: any) => b.textContent === 'Docs ↗')!);
    assert.deepEqual(fake.callsTo('shell.openExternal').at(-1), ['https://kiro.dev/docs/acp/']);
    await m.render(createElement(HostAgentNote, { view: noteOf('trae') } as any));
    assert.equal(m.host.querySelector('[data-install-by-hand]'), null);
    await m.render(
      createElement(HostAgentNote, {
        view: noteOf('codex', { installable: ['codex'] }),
      } as any),
    );
    assert.equal(m.host.querySelector('[data-install-by-hand]'), null, 'its Host installs it: Install, not a command');
    assert.equal($('button.btn-pill', m.host).textContent, 'Install on mini');
  } finally {
    await m.unmount();
  }
});
