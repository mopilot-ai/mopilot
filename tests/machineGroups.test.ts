// Settings -> Computer use, "On <machine>": what was approved on a Host's desktop, with Remove for each app and for the machine's always-allowed list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, $$, click, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
installNativeStub({
  computer: {
    revokeOnMachine: async (...a: any[]) => (calls.push(['one', ...a]), true),
    revokeAllOnMachine: async (...a: any[]) => (calls.push(['all', ...a]), true),
  },
});
mockSource('src/components/pages/Settings.tsx', {
  Group: (p: any) => createElement('section', { 'aria-label': p.title }, p.title, p.action, p.children),
  Row: (p: any) => createElement('div', { className: 'row' }, p.title, ' ', p.desc, p.children),
});
const { createElement } = await import('react');
const { MachineGroups } = await import('../src/components/pages/settings/MachineGroups.tsx');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes', level: 'click' };
const MACHINES: any[] = [
  {
    id: 'h1',
    name: 'box',
    global: [NOTES],
    chats: [{ chatId: 'c1', grants: [{ bundleId: 'com.apple.finder', name: 'Finder', level: 'view' }] }],
  },
  { id: 'h2', name: 'studio', global: [], chats: [] },
];

test('each machine is a group under its name with its always-allowed apps and its chats’ apps; Remove takes one back from that machine only', async () => {
  const done: string[] = [];
  const m = await mount(
    createElement(MachineGroups, {
      machines: MACHINES,
      chatTitle: (id: string) => `Chat ${id}`,
      change: async (what: string, run: () => Promise<unknown>) => (done.push(what), run()),
    }),
  );
  try {
    assert.equal($$('section').length, 2);
    const box = $('section[aria-label="On box"]');
    assert.match(box.textContent!, /Notes.*Click.*always/);
    assert.match(box.textContent!, /Finder.*View only.*Chat c1/);
    assert.equal($$('button', box).filter((b) => b.textContent === 'Remove all').length, 1);
    assert.equal($$('button', $('section[aria-label="On studio"]')).length, 0, 'nothing always allowed there: no Remove all');
    await click($$('button', box).find((b) => b.getAttribute('aria-label') === 'Remove Finder')!);
    await click($$('button', box).find((b) => b.getAttribute('aria-label') === 'Remove Notes')!);
    await click($$('button', box).find((b) => b.textContent === 'Remove all')!);
    assert.deepEqual(calls, [
      ['one', 'h1', 'c1', 'com.apple.finder'],
      ['one', 'h1', null, 'com.apple.Notes'],
      ['all', 'h1'],
    ]);
    assert.deepEqual(done, ['remove Finder', 'remove Notes', 'remove the apps always allowed on box']);
  } finally {
    await m.unmount();
  }
});

test('a level this build does not know is shown as it is', async () => {
  const m = await mount(
    createElement(MachineGroups, {
      machines: [{ id: 'h1', name: 'box', global: [{ bundleId: 'x', name: 'X', level: 'custom' }], chats: [] }] as any,
      chatTitle: (id: string) => id,
      change: async () => true,
    }),
  );
  try {
    assert.match($('section').textContent!, /custom · always/);
  } finally {
    await m.unmount();
  }
});
