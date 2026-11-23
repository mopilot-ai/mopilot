// Remote sidebar rows pass machine-qualified folders to the PR reader across all Host harnesses.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import './support/dom.ts';
import './support/allOnScreen.ts';
import { machineFolderKey } from '../src/lib/machineFolder.ts';
import { sidebarRowKit } from './support/sidebar-row-kit.ts';
import type { Thread } from '../src/store/types.ts';

const owners = new Map<string, string>();
let online = true;
let answered = true;
mock.module('../src/lib/hostChats.ts', {
  namedExports: {
    useHostChats: () => ({ owners, status: 'ready', answered }),
    machineOfChat: (state: { answered: boolean; owners: Map<string, string> }, id: string) =>
      state.answered ? (state.owners.get(id) ?? '') : null,
  },
});
mock.module('../src/lib/hostMachines.ts', {
  namedExports: { useHostMachines: () => ({ machines: [{ id: 'windows', name: 'Laptop', status: online ? 'online' : 'offline' }] }) },
});
const kit = await sidebarRowKit();

for (const agent of ['claude', 'codex', 'gemini']) {
  test(`${agent}: the sidebar keeps the remote folder for PR discovery and retires it on owner changes`, async () => {
    const id = `acp:host-${agent}:remote`;
    const cwd = 'C:\\work\\mopilot';
    owners.set(id, 'windows');
    online = true;
    answered = true;
    kit.reads.length = 0;
    const host = document.createElement('div');
    const root = createRoot(host);
    let version = 0;
    const show = () =>
      act(async () => root.render(h(kit.ThreadRow, { thread: { id, cwd, name: agent, updatedAt: ++version } as Thread, active: false })));
    try {
      await show();
      assert.equal(kit.reads.at(-1)?.[1], machineFolderKey('windows', cwd));
      online = false;
      await show();
      assert.equal(kit.reads.at(-1)?.[1], '', 'offline folders are not looked up on this Mac');
      answered = false;
      await show();
      assert.equal(kit.reads.at(-1)?.[1], '', 'unresolved ownership cannot read a local folder');
      answered = true;
      owners.delete(id);
      await show();
      assert.equal(kit.reads.at(-1)?.[1], cwd, 'a chat moved here reads its local checkout');
    } finally {
      await act(async () => root.unmount());
      owners.clear();
    }
  });
}
