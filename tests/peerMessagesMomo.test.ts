// A MoMo chat takes no part in messages between chats (src/components/thread/PeerMessages.tsx, #2288): Quick Chat's Ask
// MoMo view read MoMo's peer messages, which main refuses from Quick Chat, and showed "Chat messaging unavailable: This
// window can’t message for that chat."; a MoMo chat now reads and shows nothing there, and a coding chat still does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const calls: string[] = [];
const state: any = { route: { name: 'home' }, threads: {}, momoChats: { momo: 'main' } };
installNativeStub({
  session: { snapshot: async () => (calls.push('follow'), null) },
  peer: {
    snapshot: async (id: string) => {
      calls.push(`snapshot ${id}`);
      throw new Error("Error invoking remote method 'peer:snapshot': Error: invalid_source_window");
    },
    capabilities: async () => ({ peerTools: { available: true, reason: null } }),
    onChanged: () => () => {},
  },
});
// openInSplit: a chat link's ⌥-click (session/openChat.ts)
stubStore({ navigate: () => {}, openInSplit: () => {}, toast: () => {}, useStore: (f: any) => f(state), threadTitle: (t: any) => t.title });
const { PeerMessages } = await import('../src/components/thread/PeerMessages.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();

async function shown(chatId: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(PeerMessages, { chatId, readOnly: true, inPane: true, entry: true })));
  await act(async () => {
    for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
  });
  const text = host.textContent;
  await act(() => root.unmount());
  host.remove();
  return text;
}

test('a MoMo chat in Quick Chat: no peer messages read, no "Chat messaging unavailable"', async () => {
  calls.length = 0;
  assert.equal(await shown('momo'), '');
  assert.deepEqual(calls, []);
});

test('a coding chat the window may not message for still says so', async () => {
  calls.length = 0;
  assert.match((await shown('code')) ?? '', /^Chat messaging unavailable/);
  assert.ok(calls.includes('snapshot code'));
});
