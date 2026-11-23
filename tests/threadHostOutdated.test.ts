// A chat on a machine whose Host is older than this app says so under its last turn, with the machine row's Update (src/components/thread/ThreadNotices.tsx, #5404); a current Host, a machine that is away and a chat on this Mac say nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { $, mount } from './support/composer-kit.ts';
import { mockSource } from './support/stubs.ts';

let chatMachine: any = { machine: null, pending: false };
mockSource('src/lib/chatMachine.ts', { useChatMachine: () => chatMachine });
mockSource('src/lib/hostMachines.ts', { useHostMachines: () => ({ machines: [chatMachine.machine?.row].filter(Boolean) }) });
mockSource('src/components/harness/OwnMcp.tsx', { OwnMcpNotice: () => null });
const { createElement: h } = await import('react');
const { ThreadNotices } = await import('../src/components/thread/ThreadNotices.tsx');

const row = (o: object = {}) => ({
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
  ...o,
});
const on = (r: any, away = false) => (chatMachine = { machine: { id: r.id, name: r.name, away, row: r }, pending: false });

test('an older Host: the chat says so and the row’s Update button follows', async () => {
  on(row({ hostStale: true }));
  const view = await mount(h(ThreadNotices, { threadId: 'acp:host-claude:c1' }));
  assert.match($('.machine-folder-note')!.textContent!, /Box's Host is out of date, so replies may not show\. Update it\./);
  assert.equal($('button')!.getAttribute('aria-label'), 'Update the Host on Box');
  await view.unmount();
});

test('a current Host, a machine that is away and a chat on this Mac say nothing', async () => {
  for (const state of [on(row()), on(row({ hostStale: true }), true), (chatMachine = { machine: null, pending: false })]) {
    void state;
    const view = await mount(h(ThreadNotices, { threadId: 'acp:host-claude:c1' }));
    assert.equal($('.machine-folder-note'), null);
    await view.unmount();
  }
});
