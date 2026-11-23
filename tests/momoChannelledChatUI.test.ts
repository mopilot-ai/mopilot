// MoMo's page with channels (A2: src/components/momo/channels/ChannelledChat.tsx inside MomoPage and the shell): with `momo.channels` off the page is the shell around the chat, unchanged; on, the rail lists Main, Everything and the channels (and nothing of them while main says channels are off), a channel's page has its header, its first row and the composer line "Message #name", Everything is the feed and a row opens its chat, and the rail's New channel makes a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement as h, useContext } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';
import { reactivePrefs } from './support/reactivePrefs.ts';

const calls: any[] = [];
let route: any = { name: 'momo' };
let momoChats: Record<string, string> = {};
let channelsFlag = true;
let enabled = true;
let tasksPanel = false;
const channels = [{ id: 'ch_000000000000000a', name: 'Kitchen', group: null, createdAt: 1, hasInstructions: false, welcome: null }];

// the shell keeps its pane in the prefs, so they must re-render what reads them
const store = reactivePrefs(() => ({ route, momoChats, threads: {} }));
stubStore({
  useStore: store.useStore,
  setPrefs: store.setPrefs,
  navigate: (r: any) => calls.push(['navigate', r]),
  openThread: async () => {},
  setDraft: () => {},
  toast: () => {},
  sendMessage: async () => true,
});
mockSource('src/lib/mopilot.ts', { useMoPilot: () => ({ signedIn: false, user: null }) });
installNativeStub({
  momoChat: { mainChat: async () => ({ chatId: 'm1', warning: null }), previousChats: async () => [], onBrainChanged: () => () => {} },
  momoChannels: {
    list: async () => ({ ok: true, enabled, channels: enabled ? channels : [], groups: [], room: 11 }),
    chat: async (id: string) => ({ ok: true, chatId: `chat-${id}`, warning: null }),
    create: async (name: string) => (
      calls.push(['create', name]), { ok: true, channel: { ...channels[0], id: 'ch_000000000000000b', name } }
    ),
    everything: async () => ({ ok: true, rows: [], filters: [{ id: 'main', name: 'Main' }], unavailable: false }),
    onChanged: () => () => {},
  },
});
mockSource('src/session/useChatRowState.ts', { useChatRowState: () => null });
mockSource('src/session/momoPrefs.ts', {
  useMomoPrefs: () => ({
    onboarding: { done: true },
    paused: false,
    tasksPanel,
    shell: true,
    channels: channelsFlag,
    persona: { name: 'MoMo', color: 'clay' },
  }),
  saveMomoPref: async () => true,
});
mockSource('src/lib/flags.ts', { useFlag: () => false, harnessEnabled: () => true });
mockSource('src/components/momo/setup/MomoSetup.tsx', { MomoSetup: () => h('div') });
const { MomoPlaceholder } = await import('../src/components/momo/useMomoChat.ts');
mockSource('src/components/thread/ThreadView.tsx', {
  ThreadView: ({ threadId }: any) => h('div', { 'data-thread': threadId, 'data-placeholder': useContext(MomoPlaceholder) }),
});
mockSource('src/components/momo/BrainChip.tsx', { BrainChip: () => h('span') });
mockSource('src/components/momo/MomoPanel.tsx', { MomoPanel: () => h('aside') });
mockSource('src/components/momo/MemoryTab.tsx', { MemoryTab: () => h('div') });
mockSource('src/components/momo/TasksTab.tsx', { TasksTab: () => h('div') });
mockSource('src/components/momo/tasks/TasksPanel.tsx', { TasksPanel: () => h('div') });
mockSource('src/components/momo/MomoOutputs.tsx', { MomoOutputs: () => h('div') });
const { default: MomoPage } = await import('../src/components/momo/MomoPage.tsx');
const { ChannelledChat } = await import('../src/components/momo/channels/ChannelledChat.tsx');
const { EVERYTHING } = await import('../src/components/momo/channels/useChannelsUi.tsx');

const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const page = async (p: any = {}) => {
  const r = await render(h(MomoPage, p));
  await settle();
  return r;
};
const reset = () => {
  calls.length = 0;
  route = { name: 'momo' };
  momoChats = {};
  channelsFlag = true;
  enabled = true;
  tasksPanel = false;
  store.reset();
  window.localStorage.clear();
};
// the account row's button: the avatar's initials and the name, both N/A with no account and no OS user
const SIGNED_OUT = 'N/AN/A';
const buttons = (r: any) => [...r.host.querySelectorAll('nav button')].map((b: any) => b.textContent || b.getAttribute('aria-label'));

test('channels flag off: the shell is what M0b draws, with only Everything in its rail and no call to channels', async () => {
  reset();
  channelsFlag = false;
  const r = await page();
  assert.deepEqual(buttons(r), ['Hide sidebar', 'Back to chats', 'Everything', 'Tasks', 'Memory', 'Settings', SIGNED_OUT]);
  assert.equal(r.host.querySelector('[data-placeholder]')!.getAttribute('data-placeholder'), 'Message MoMo');
  await r.unmount();
});

test('flag on but main says channels are off: the same page, nothing of channels', async () => {
  reset();
  enabled = false;
  const r = await page();
  assert.deepEqual(buttons(r), ['Hide sidebar', 'Back to chats', 'Everything', 'Tasks', 'Memory', 'Settings', SIGNED_OUT]);
  await r.unmount();
});

test('on: Main, Everything, the channels and New channel/New group in the rail; Main keeps MoMo’s own composer line', async () => {
  reset();
  const r = await page();
  assert.deepEqual(
    buttons(r).filter((b: any) => !String(b).startsWith('More for the')),
    [
      'Hide sidebar',
      'Back to chats',
      'Main',
      'Everything',
      'Filter',
      'Create channel or group',
      'Kitchen',
      'New channel or group',
      'Tasks',
      'Memory',
      'Settings',
      SIGNED_OUT,
    ],
  );
  assert.equal(r.host.querySelector('[data-placeholder]')!.getAttribute('data-placeholder'), 'Message MoMo');
  assert.equal(r.host.querySelector('[data-channel-header]'), null);
  await click(r.host.querySelector('[aria-label="New channel or group"]'));
  await click([...r.host.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'New channel'));
  assert.ok(r.host.textContent!.includes('A place for one topic. Your main chat stays as it is.'));
  await r.unmount();
});

test('a channel’s page: its header, its first row, and the composer says Message #Kitchen', async () => {
  reset();
  route = { name: 'momo', chatId: 'chat-a' };
  momoChats = { 'chat-a': 'channel:ch_000000000000000a' };
  const r = await page({ chatId: 'chat-a' });
  assert.equal(r.host.querySelector('[data-placeholder]')!.getAttribute('data-placeholder'), 'Message #Kitchen');
  assert.ok(r.host.querySelector('[data-channel-header]')!.textContent!.includes('Kitchen'));
  assert.ok(r.host.querySelector('[data-welcome]'));
  assert.equal(r.host.querySelector('nav [aria-current=page]')!.textContent, 'Kitchen');
  await r.unmount();
});

test('Everything is the feed, and a row opens its chat: a channel’s own, or Main’s page', async () => {
  reset();
  route = { name: 'momo', chatId: EVERYTHING };
  const r = await page({ chatId: EVERYTHING });
  assert.ok(r.host.querySelector('section[aria-label=Everything]'));
  assert.equal(r.host.querySelector('[data-thread]'), null);
  await r.unmount();
  // the rows open their chats
  const native = (globalThis as any).window?.native;
  void native;
  const rows = [
    { chatId: 'chat-a', turnId: 't1', channelId: 'ch_000000000000000a', name: 'Kitchen', at: 1, user: 'milk', assistant: '' },
    { chatId: 'm1', turnId: 't2', channelId: null, name: 'Main', at: 2, user: 'hi', assistant: '' },
  ];
  installNativeStub({
    momoChat: { mainChat: async () => ({ chatId: 'm1', warning: null }), previousChats: async () => [], onBrainChanged: () => () => {} },
    momoChannels: {
      list: async () => ({ ok: true, enabled, channels, groups: [], room: 11 }),
      everything: async () => ({ ok: true, rows, filters: [], unavailable: false }),
      onChanged: () => () => {},
    },
  });
  const again = await render(h(ChannelledChat, { chatId: EVERYTHING, on: true }));
  await settle();
  const feedRows = [...again.host.querySelectorAll('[data-channel]')];
  await click(feedRows[0]);
  await click(feedRows[1]);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'navigate'),
    [
      ['navigate', { name: 'momo', tab: 'chat', chatId: 'chat-a' }],
      ['navigate', { name: 'momo', tab: 'chat' }],
    ],
  );
  await again.unmount();
});

test('Memory and Tasks pages carry the same rail as the chat, channels included, with none of its places current (#4926)', async () => {
  reset();
  route = { name: 'momo', tab: 'memory' };
  const r = await page({ tab: 'memory' });
  const names = [...r.host.querySelectorAll('nav button')]
    .map((b: any) => b.textContent || b.getAttribute('aria-label'))
    .filter((n) => !String(n).startsWith('More for the'));
  assert.deepEqual(names.slice(0, 4), ['Hide sidebar', 'Back to chats', 'Main', 'Everything']);
  assert.ok(names.includes('Kitchen') && names.includes('New channel or group'));
  assert.equal(r.host.querySelector('nav [aria-current=page]')!.textContent, 'Memory', 'only the page itself is current');
  await click(r.host.querySelector('[aria-label="New channel or group"]'));
  await click([...r.host.querySelectorAll('[role=menuitem]')].find((b) => b.textContent === 'New group'));
  assert.ok(r.host.textContent!.includes('A folder for channels.'), 'its dialogs come with it');
  await r.unmount();
  // channels off, or main saying so: the shell's own plain rail
  channelsFlag = false;
  const plain = await page({ tab: 'memory' });
  assert.equal(plain.host.querySelector('[aria-label="New channel or group"]'), null);
  await plain.unmount();
  channelsFlag = true;
  enabled = false;
  const off = await page({ tab: 'memory' });
  assert.equal(off.host.querySelector('[aria-label="New channel or group"]'), null);
  assert.ok(off.host.querySelector('nav'));
  await off.unmount();
});

test('with the Tasks panel on, its title names the channel shown, and Everything and Main have none to name', async () => {
  reset();
  tasksPanel = true;
  const title = async (chatId?: string, tag?: string) => {
    route = { name: 'momo', chatId };
    momoChats = chatId && tag ? { [chatId]: tag } : {};
    store.reset();
    window.localStorage.clear();
    const r = await page({ chatId });
    await click(r.host.querySelector('[aria-label=Tasks][aria-pressed]'));
    const text = r.host.querySelector('aside h2')!.textContent;
    await r.unmount();
    return text;
  };
  assert.equal(await title('chat-a', 'channel:ch_000000000000000a'), 'Tasks in #Kitchen');
  assert.equal(await title(EVERYTHING), 'Tasks');
  assert.equal(await title(), 'Tasks');
});
