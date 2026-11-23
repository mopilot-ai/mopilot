// The composer's machine menu is a picker only (#2709, 2026-11-02): a machine with a signed-out agent says so in one short line and is picked like any other; no row signs in, and nothing in the menu reaches into the machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import type { HostMachine } from '../src/components/composer/HostChip.tsx';

const unattended = false;
mockSource('src/lib/flags.ts', {
  useFlag: (k: string) => k === 'host.unattended' && unattended,
  isEnabled: (k: string) => k === 'host.unattended' && unattended,
});
mockSource('src/lib/host.ts', { useHostAccess: () => true });
mockSource('src/components/pages/settings/Connections.tsx', {
  openSshTerminal: () => {
    throw new Error('The machine picker must not open a terminal.');
  },
});
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [], resolved: true }) });
const { createElement } = await import('react');
const { HostChip } = await import('../src/components/composer/HostChip.tsx');

const MAC: HostMachine = { id: 'local', name: 'This Mac', status: 'online', note: '' };
const LAB: HostMachine = {
  id: 'lab',
  name: 'lab',
  status: 'attention',
  note: 'gemini is not signed in on this machine.',
  signin: 'gemini',
  agents: [{ id: 'gemini', label: 'Gemini', state: 'signin' }],
};
const BARE: HostMachine = { id: 'bare', name: 'bare', status: 'attention', note: '' };
const MINI: HostMachine = { id: 'mini', name: 'mac-mini-test', status: 'online', note: 'SSH', capabilities: { iab: true, cu: false } };

test('every row picks a machine: a signed-out agent is one short line on its machine, never a row of its own', async () => {
  const picks: string[] = [];
  const m = await mount(
    createElement(HostChip, { machines: [MAC, MINI, LAB, BARE], onPick: (x: HostMachine) => (picks.push(x.id), null) }),
  );
  try {
    await click($('button.host-chip'));
    const rows = $$('[role=menu] [role^=menuitem]');
    assert.deepEqual(
      rows.map((r) => [r.querySelector('.menu-title')?.textContent, r.querySelector('.menu-desc')?.textContent ?? '']),
      [
        ['This Mac', ''],
        ['mac-mini-test', 'No computer use'],
        ['lab', 'Gemini needs sign-in'],
        ['bare', 'Needs attention'],
        ['Add machine…', ''],
        ['Switch host…', 'Send a message first'],
      ],
    );
    assert.ok(!$('[role=menu]').textContent!.includes('Sign in'), 'no sign-in anywhere in the menu');
    await click(rows[2]);
    assert.deepEqual(picks, ['lab'], 'the machine that needs a sign-in is still picked like any other');
  } finally {
    await m.unmount();
  }
});
