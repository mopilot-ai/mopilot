// A held peer message's card (src/components/thread/PeerMessages.tsx): its receiver gets Allow and Decline, its sender
// only Cancel, and a declined or expired one offers nothing more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
let notify: () => void = () => {};
let messages: any[] = [];
const calls: any[] = [];
const record =
  (name: string) =>
  async (...args: any[]) => {
    calls.push([name, ...args]);
  };
installNativeStub({
  session: { snapshot: async () => null },
  peer: {
    snapshot: async () => messages,
    capabilities: async () => ({ peerTools: { available: true, reason: null } }),
    onChanged: (cb: () => void) => {
      notify = cb;
      return () => {};
    },
    approve: record('approve'),
    decline: record('decline'),
    cancel: record('cancel'),
  },
});
stubStore({
  navigate: () => {},
  openInSplit: () => {},
  toast: () => {},
  useStore: (f: any) => f({ route: { name: 'home' }, threads: { A: { title: 'Source' }, B: { title: 'Target' } } }),
  threadTitle: (t: any) => t.title,
});
const { PeerMessages } = await import('../src/components/thread/PeerMessages.tsx');
const { markWindowReady } = await import('../src/lib/windowReady.ts');
markWindowReady();
const buttons = () => [...document.body.querySelectorAll('button')].map((b) => b.textContent);
const click = async (text: string) => {
  const button = [...document.body.querySelectorAll('button')].find((b) => b.textContent === text);
  assert.ok(button, `Missing button ${text}`);
  await act(async () => button.click());
};

test('a held message offers its receiver Allow and Decline, and its sender only Cancel', async () => {
  messages = [
    {
      id: 'in',
      sourceChatId: 'B',
      targetChatId: 'A',
      body: 'Drop the table',
      delivery: 'held',
      reply: 'awaiting',
      errorCode: 'held_mode_mismatch',
    },
    {
      id: 'out',
      sourceChatId: 'A',
      targetChatId: 'B',
      body: 'Ship it',
      delivery: 'held',
      reply: 'awaiting',
      errorCode: 'held_mode_unknown',
    },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(PeerMessages, { chatId: 'A' })));
  try {
    assert.match(document.body.textContent!, /Waiting for approval/);
    assert.match(document.body.textContent!, /The chats’ permissions differ, so it waits for approval\./);
    // the sender cannot allow its own message past the receiver's hold
    assert.equal(buttons().filter((b) => b === 'Allow').length, 1);
    await click('Allow');
    await click('Decline');
    await click('Cancel message');
    assert.deepEqual(calls, [
      ['approve', 'A', 'in'],
      ['decline', 'A', 'in'],
      ['cancel', 'A', 'out'],
    ]);
    messages = [
      { ...messages[0], delivery: 'declined', errorCode: null },
      { ...messages[1], delivery: 'expired', errorCode: 'hold_expired' },
    ];
    await act(async () => notify());
    assert.match(document.body.textContent!, /Declined.*Expired/);
    assert.match(document.body.textContent!, /Not approved in time\./);
    assert.deepEqual(
      buttons().filter((b) => ['Allow', 'Decline', 'Cancel message'].includes(b!)),
      [],
    );
  } finally {
    await act(() => root.unmount());
    host.remove();
    void window;
  }
});

test('a chat no window lists (an archived one) reads by the title kept with the message, never its id', async () => {
  messages = [
    { id: 'o', sourceChatId: 'A', targetChatId: 'Z', targetTitle: 'Archived chat', body: 'Kept', delivery: 'delivered', reply: 'none' },
    { id: 'i', sourceChatId: 'Y', sourceTitle: 'Archived sender', targetChatId: 'A', body: 'Hi', delivery: 'delivered', reply: 'none' },
    { id: 'u', sourceChatId: 'X', targetChatId: 'A', body: 'Old', delivery: 'delivered', reply: 'none' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  await act(async () => root.render(createElement(PeerMessages, { chatId: 'A' })));
  try {
    const heads = [...document.body.querySelectorAll('.peer-message-head .peer-chat-link')].map((b) => b.textContent);
    assert.deepEqual(heads, ['Archived chat', 'Archived sender', 'another chat']);
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
