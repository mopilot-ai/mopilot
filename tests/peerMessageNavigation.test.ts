// Peer-message sender and recipient links reuse the current window under ordinary and modified activation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render, click } from './support/pages-kit.ts';
import { fakeNative, installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement: h, act } = await import('react');
const messages = [
  { id: 'out', sourceChatId: 'source', targetChatId: 'claude:repair', body: 'Request', delivery: 'delivered', reply: 'none' },
  { id: 'in', sourceChatId: 'acp:opencode:repair', targetChatId: 'source', body: 'Response', delivery: 'delivered', reply: 'none' },
];
const ids = ['claude:repair', 'acp:opencode:repair'];
const store = fakeStore<any>({
  route: { name: 'thread', id: 'source' },
  threads: Object.fromEntries(ids.map((id) => [id, { id, title: id }])),
});
const navigated: unknown[] = [];
stubStore({ useStore: store.useStore, navigate: (r: unknown) => navigated.push(r), threadTitle: (t: any) => t.title });
const bridge = fakeNative({
  peer: { snapshot: async () => messages, capabilities: async () => ({ peerTools: { available: true, reason: null } }) },
});
installNativeStub(bridge);
const { PeerMessages } = await import('../src/components/thread/PeerMessages.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

test('ordinary and Cmd/Ctrl sender/recipient clicks stay in the current window on every repeated activation', async () => {
  const v = await render(h(PeerMessages, { chatId: 'source' }));
  const links = [...v.host.querySelectorAll('.peer-chat-link')];
  assert.equal(links.length, 2);
  for (const [i, link] of links.entries()) {
    navigated.length = 0;
    await click(link);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { metaKey: true }])
      await act(async () => void link.dispatchEvent(new MouseEvent('click', { bubbles: true, ...modifier })));
    assert.deepEqual(navigated, Array(4).fill({ name: 'thread', id: ids[i] }));
  }
  assert.deepEqual(bridge.callsTo('win.open'), []);
  assert.deepEqual(bridge.callsTo('shell.openExternal'), []);
  await v.unmount();
});
