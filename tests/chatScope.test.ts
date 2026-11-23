// What a chat's transcript is drawn inside (src/components/thread/ChatScope.tsx): the chat's activity marks, and the machine's folder for a chat on a machine.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, useContext } from 'react';
import { fakeStore, render } from './support/shell-panels-kit.ts';
import { stubStore } from './support/stubs.ts';

stubStore(fakeStore({ threads: { t1: { cwd: '/srv/app' } } }).exports);
let machine: { id: string; name: string; away: boolean } | null = null;
mock.module('../src/lib/chatMachine.ts', {
  namedExports: {
    useRemoteFolderValue: (_id: string, folder: string) => (machine ? { machineId: machine.id, folder } : null),
  },
});
const { ChatScope } = await import('../src/components/thread/ChatScope.tsx');
const { ActivityChat } = await import('../src/components/thread/turnTokens.tsx');
const { RemoteFolderContext } = await import('../src/lib/remoteFolder.ts');

function Read() {
  return h('i', { 'data-out': JSON.stringify([useContext(ActivityChat), useContext(RemoteFolderContext)]) });
}
const out = (host: HTMLElement) => JSON.parse(host.querySelector('i')!.getAttribute('data-out')!);

test('a chat on this Mac draws with its own activity and no machine; one on a machine also carries the machine and its folder', async () => {
  let v = await render(h(ChatScope, { threadId: 't1', children: h(Read) }));
  assert.deepEqual(out(v.host), ['t1', null]);
  await v.unmount();
  machine = { id: 'ssh:me@box', name: 'box', away: false };
  v = await render(h(ChatScope, { threadId: 't1', children: h(Read) }));
  assert.deepEqual(out(v.host), ['t1', { machineId: 'ssh:me@box', folder: '/srv/app' }]);
  await v.unmount();
});
