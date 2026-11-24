// A chat on an older Host follows its machine's update status from detection through restart, with a manual update or retry when available (src/components/thread/ThreadNotices.tsx).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';
import type { ChatMachine } from '../src/lib/chatMachine.ts';
import type { HostMachineRow } from '../src/lib/hostMachines.ts';

let machine: ChatMachine | null = null;
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => ({ machine, pending: false }) });
mockSource('src/components/harness/OwnMcp.tsx', { OwnMcpNotice: () => null });
const { createElement: h } = await import('react');
const { ThreadNotices } = await import('../src/components/thread/ThreadNotices.tsx');

const row = (o: Partial<HostMachineRow> = {}): HostMachineRow => ({
  id: 'ssh:box',
  name: 'Box',
  status: 'online',
  note: '',
  signin: null,
  capabilities: { iab: false, cu: false },
  agents: [],
  installable: [],
  lastSeen: null,
  localNetwork: 'unknown',
  waitingForLogin: null,
  startsAtBoot: 'unknown',
  fileVault: 'unknown',
  platform: '',
  ...o,
});
const on = (row: HostMachineRow) => ({ id: row.id, name: row.name, away: row.status === 'offline', row });

test('an older Host goes from Update to progress or retry, then clears when the Host is current', async (t) => {
  const chat = () => h(ThreadNotices, { threadId: 'acp:host-claude:c1' });
  machine = on(row({ hostStale: true }));
  const view = await mount(chat());
  t.after(view.unmount);
  const note = () => $('.machine-folder-note', view.host);
  const button = () => $('button', view.host);
  assert.match(note().textContent!, /Box · Host is out of date/);
  assert.equal(button().getAttribute('aria-label'), 'Update the Host on Box');

  for (const [update, text] of [
    ['running', 'Updating Host…'],
    ['waiting', 'Updates when idle'],
  ] as const) {
    machine = on(row({ hostStale: true, update }));
    await view.render(chat());
    assert.equal(note().textContent, `Box · ${text}`);
    assert.equal(button(), null);
  }

  machine = on(row({ hostStale: true, update: 'failed', updateError: 'Could not reach the machine over SSH.' }));
  await view.render(chat());
  assert.match(note().textContent!, /Box · Update failed/);
  assert.equal(note().getAttribute('title'), 'Could not reach the machine over SSH.');
  assert.equal(button().getAttribute('aria-label'), 'Try again the Host on Box');

  machine = on(row());
  await view.render(chat());
  assert.equal(note(), null);
});

test('a different build of the same version, a newer Host, a machine that is away and a chat on this Mac say nothing', async (t) => {
  const chat = () => h(ThreadNotices, { threadId: 'acp:host-codex:c1' });
  machine = on(row({ hostStale: true, hostDiffers: true }));
  const view = await mount(chat());
  t.after(view.unmount);
  assert.equal($('.machine-folder-note', view.host), null);
  for (const state of [
    on(row({ hostNewer: true })),
    on(row({ hostStale: true, status: 'offline' })),
    on(row({ hostStale: true, linkDroppedAt: Date.now() })),
    null,
  ]) {
    machine = state;
    await view.render(chat());
    assert.equal($('.machine-folder-note', view.host), null);
  }
});

test('a relay-only older Host says where to update and has no Update button', async (t) => {
  machine = on(row({ id: 'relay:box', hostStale: true }));
  const view = await mount(h(ThreadNotices, { threadId: 'acp:host-custom:c1' }));
  t.after(view.unmount);
  assert.equal($('.machine-folder-note', view.host).textContent, 'Box · Host is out of date · Update it on the machine');
  assert.equal($('button', view.host), null);
});
