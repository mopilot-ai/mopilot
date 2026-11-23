// MoMo's channels in the page (A2: src/components/momo/channels/useChannelsUi.tsx, ChannelChrome.tsx, EverythingFeed.tsx, channelsData.ts): the page reads the list and tells where it is from the route; a channel is opened, made by name (the cap and a taken name said in the dialog), renamed, moved, archived and deleted through the dialogs; its header and first row; Everything's rows and filter; the list hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act, useState } from 'react';
import { render, click, flush, type as typeInto } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
let route: any = { name: 'momo' };
let momoChats: Record<string, string> = {};
let turns = 0;
const store = (sel: any) => sel({ route, momoChats, threads: { c1: { turns: Array.from({ length: turns }) } } });
stubStore({
  useStore: store,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (text: string, kind: string) => calls.push(['toast', text, kind]),
  sendMessage: async (...args: any[]) => (calls.push(['send', ...args]), true),
});

const CH = (id: string, name: string, extra: any = {}) => ({
  id,
  name,
  group: null,
  createdAt: 1,
  hasInstructions: false,
  welcome: null,
  ...extra,
});
const A = 'ch_000000000000000a';
const B = 'ch_000000000000000b';
const G = 'gr_000000000000000a';
const answers: Record<string, any> = {};
let channels: any[] = [];
let groups: any[] = [];
let enabled = true;
let feed: any = { ok: true, rows: [], filters: [], unavailable: false };
let changed: (() => void) | null = null;
const log = (name: string, ...args: any[]) => (calls.push([name, ...args]), answers[name] ? answers[name](...args) : { ok: true });
const nativeStub: any = {
  momoChat: { previousChats: async () => [] },
  momoChannels: {
    list: async () => ({ ok: true, enabled, channels, groups, room: 12 - channels.length }),
    chat: async (id: string) => log('chat', id) && (answers.chat ? answers.chat(id) : { ok: true, chatId: `chat-${id}`, warning: null }),
    create: async (name: string, group?: string | null) =>
      log('create', name, group) && (answers.create?.(name) ?? { ok: true, channel: CH(B, name) }),
    rename: async (id: string, name: string) => log('rename', id, name),
    archive: async (id: string) => log('archive', id),
    delete: async (id: string) => log('delete', id),
    move: async (id: string, group: string | null) => log('move', id, group),
    getInstructions: async (id: string) => log('getInstructions', id) && (answers.getInstructions?.(id) ?? { ok: true, text: 'Be brief.' }),
    setInstructions: async (id: string, text: string) => log('setInstructions', id, text),
    welcome: async (id: string, a: string) => log('welcome', id, a),
    createGroup: async (name: string) => log('createGroup', name),
    renameGroup: async (id: string, name: string) => log('renameGroup', id, name),
    deleteGroup: async (id: string) => log('deleteGroup', id),
    everything: async (only?: string) => (calls.push(['everything', only]), feed),
    onChanged: (cb: () => void) => ((changed = cb), () => (changed = null)),
  },
};
installNativeStub(nativeStub);
mockSource('src/lib/ignored.ts', { errorText: (e: any) => String(e?.message ?? e), noteIgnored: () => undefined });

const { useChannelsUi, EVERYTHING } = await import('../src/components/momo/channels/useChannelsUi.tsx');
const { ChannelHeader, WelcomeRow } = await import('../src/components/momo/channels/ChannelChrome.tsx');
const { EverythingFeed, FEED_REFRESH_MS } = await import('../src/components/momo/channels/EverythingFeed.tsx');
const { channelCall, useMomoChannels } = await import('../src/components/momo/channels/channelsData.ts');
const { CHANNEL_COPY: C, DELETE_DELAY_MS } = await import('../src/components/momo/channels/channelCopy.ts');

const reset = () => {
  calls.length = 0;
  route = { name: 'momo' };
  momoChats = {};
  turns = 0;
  enabled = true;
  channels = [CH(A, 'Kitchen'), CH(B, 'Garden', { group: G })];
  groups = [{ id: G, name: 'Home' }];
  feed = { ok: true, rows: [], filters: [{ id: 'main', name: 'Main' }], unavailable: false };
  for (const k of Object.keys(answers)) delete answers[k];
};
const settle = async () => {
  for (let i = 0; i < 4; i++) await flush();
};
const text = (el: Element) => el.textContent ?? '';
const button = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLElement>('button')].find((b) => (b.getAttribute('aria-label') ?? text(b)).includes(label)) ?? null;
const item = (root: ParentNode, label: string) =>
  [...root.querySelectorAll<HTMLElement>('[role^=menuitem]')].find((b) => text(b).includes(label)) ?? null;
const submit = async (host: ParentNode) =>
  act(async () => void host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any));
const textarea = async (el: Element | null, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  await flush();
};

const actions = () => {
  const out: any = {};
  for (const k of [
    'openMain',
    'openEverything',
    'openChannel',
    'rename',
    'instructions',
    'move',
    'moveById',
    'reorder',
    'archive',
    'remove',
    'renameGroup',
    'removeGroup',
  ])
    out[k] = (...a: any[]) => calls.push([k, ...a.map((x) => x?.id ?? x)]);
  return out;
};

/** The page's own use of the channels UI: its rail, its dialogs and what it navigates to. */
function Page() {
  const ui = useChannelsUi();
  const [shown, setShown] = useState(0);
  void setShown;
  return h(
    'div',
    {
      'data-enabled': String(ui.enabled),
      'data-view': ui.view.kind + ('id' in ui.view ? `:${ui.view.id}` : ''),
      'data-channel': ui.channel?.name ?? '',
      'data-n': shown,
    },
    [
      ui.rail,
      h('button', { key: 'new', onClick: ui.newChannel }, 'make'),
      h('button', { key: 'newGroup', onClick: ui.newGroup }, 'New group'),
      ui.dialogs,
    ],
  );
}
const page = async () => {
  const r = await render(h(Page));
  await settle();
  return r;
};
const view = (r: any) => r.host.firstChild.getAttribute('data-view');

test('the page reads the list, shows nothing of channels while they are off, and tells where it is from the route', async () => {
  reset();
  enabled = false;
  const off = await page();
  assert.equal((off.host.firstChild as HTMLElement).getAttribute('data-enabled'), 'false');
  assert.equal(off.host.querySelector('nav, ul'), null);
  await off.unmount();
  enabled = true;
  const on = await page();
  assert.equal(view(on), 'main');
  assert.ok(button(on.host, 'New group'));
  await on.unmount();
  route = { name: 'momo', chatId: EVERYTHING };
  const every = await page();
  assert.equal(view(every), 'everything');
  await every.unmount();
  route = { name: 'momo', chatId: 'chat-a' };
  momoChats = { 'chat-a': `channel:${A}` };
  const inChannel = await page();
  assert.equal(view(inChannel), `channel:${A}`);
  assert.equal((inChannel.host.firstChild as HTMLElement).getAttribute('data-channel'), 'Kitchen');
  await inChannel.unmount();
  // a route that is another route, or a chat that is not a channel's (an earlier main chat), is Main
  route = { name: 'thread', id: 'x' };
  const other = await page();
  assert.equal(view(other), 'main');
  await other.unmount();
  route = { name: 'momo', chatId: 'old' };
  momoChats = { old: 'previous' };
  const earlier = await page();
  assert.equal(view(earlier), 'main');
  await earlier.unmount();
});

test('opening a channel asks main for its chat and goes there; a refusal is a toast', async () => {
  reset();
  const r = await page();
  await click(button(r.host, 'Kitchen'));
  assert.deepEqual(calls.filter((c) => c[0] !== 'everything').slice(0, 2), [
    ['chat', A],
    ['navigate', { name: 'momo', tab: 'chat', chatId: `chat-${A}` }],
  ]);
  calls.length = 0;
  answers.chat = () => ({ ok: false, error: 'That channel isn’t there any more.', reason: 'gone' });
  await click(button(r.host, 'Kitchen'));
  assert.deepEqual(calls.at(-1), ['toast', 'That channel isn’t there any more.', 'error']);
  await click(button(r.host, 'Main'));
  await click(button(r.host, 'Everything'));
  assert.deepEqual(calls.slice(-2), [
    ['navigate', { name: 'momo', tab: 'chat' }],
    ['navigate', { name: 'momo', tab: 'chat', chatId: EVERYTHING }],
  ]);
  await r.unmount();
});

test('New channel makes one by name and opens it; the cap and a taken name are said in the dialog; New group makes a group', async () => {
  reset();
  const r = await page();
  await click(button(r.host, 'make'));
  answers.create = () => ({ ok: false, error: 'That’s 12 channels. Archive one to add another.', reason: 'cap' });
  await typeInto(r.host.querySelector('input'), 'Trip');
  await submit(r.host);
  await settle();
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'That’s 12 channels. Archive one to add another.');
  delete answers.create;
  await submit(r.host);
  await settle();
  assert.equal(r.host.querySelector('.dialog-head'), null);
  assert.ok(calls.some((c) => c[0] === 'create' && c[1] === 'Trip'));
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate').at(-1), ['navigate', { name: 'momo', tab: 'chat', chatId: `chat-${B}` }]);
  calls.length = 0;
  await click(button(r.host, 'New group'));
  await typeInto(r.host.querySelector('input'), 'Home 2');
  await submit(r.host);
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'createGroup'),
    [['createGroup', 'Home 2']],
  );
  await r.unmount();
});

test('rename and group rename change the name; instructions open on what main holds; the others say so in a toast when main refuses', async () => {
  reset();
  const r = await page();
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Rename'));
  await typeInto(r.host.querySelector('input'), 'Galley');
  await submit(r.host);
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'rename'),
    [['rename', A, 'Galley']],
  );
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Rename'));
  await typeInto(r.host.querySelector('input'), 'House');
  await submit(r.host);
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'renameGroup'),
    [['renameGroup', G, 'House']],
  );
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Instructions'));
  assert.equal(r.host.querySelector('textarea')!.value, 'Be brief.');
  await textarea(r.host.querySelector('textarea'), 'In French.');
  await submit(r.host);
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'setInstructions'),
    [['setInstructions', A, 'In French.']],
  );
  answers.getInstructions = () => ({ ok: false, error: 'gone' });
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Instructions'));
  assert.deepEqual(calls.at(-1), ['toast', 'gone', 'error']);
  answers.move = () => ({ ok: false, error: 'That group isn’t there any more.' });
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'Move to group: Home'));
  assert.deepEqual(calls.at(-1), ['toast', 'That group isn’t there any more.', 'error']);
  answers.deleteGroup = () => ({ ok: true });
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Delete group'));
  assert.ok(calls.some((c) => c[0] === 'deleteGroup'));
  await r.unmount();
});

test('archive and delete leave the channel’s own page for Main, and a channel that is not shown leaves the page where it is', async () => {
  reset();
  route = { name: 'momo', chatId: 'chat-a' };
  momoChats = { 'chat-a': `channel:${A}` };
  const r = await page();
  await click(button(r.host, 'More for the Garden channel'));
  await click(item(r.host, 'Archive'));
  assert.equal(calls.filter((c) => c[0] === 'navigate').length, 0);
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Archive'));
  assert.deepEqual(
    calls.filter((c) => c[0] === 'navigate'),
    [['navigate', { name: 'momo', tab: 'chat' }]],
  );
  calls.length = 0;
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Delete'));
  assert.ok(text(r.host).includes('Delete #Kitchen?'));
  await click(button(r.host, 'Cancel'));
  await r.unmount();
  // deleting another channel, or one while on Main, stays where it is; the dialog's own Archive instead works the same way
  reset();
  const m = await page();
  await click(button(m.host, 'More for the Kitchen channel'));
  await click(item(m.host, 'Delete'));
  await act(async () => void (await new Promise((r) => setTimeout(r, DELETE_DELAY_MS + 200))));
  await click([...m.host.querySelectorAll('button')].find((b) => text(b) === 'Delete')!);
  assert.ok(calls.some((c) => c[0] === 'delete' && c[1] === A));
  assert.equal(calls.filter((c) => c[0] === 'navigate').length, 0);
  await click(button(m.host, 'More for the Garden channel'));
  await click(item(m.host, 'Delete'));
  await click(button(m.host, 'Archive instead'));
  assert.ok(calls.some((c) => c[0] === 'archive' && c[1] === B));
  await m.unmount();
});

test('a channel’s header names it with its menu; its first row asks once, Yes records and sends a normal message, No and Not now only record', async () => {
  reset();
  const a = actions();
  const head = await render(h(ChannelHeader, { channel: channels[0], groups, act: a }));
  assert.ok(text(head.host).includes('Kitchen'));
  assert.ok(button(head.host, 'More for the Kitchen channel'));
  await head.unmount();
  const welcome = (channel: any) => render(h(WelcomeRow, { channel, chatId: 'c1' }));
  const r = await welcome(channels[0]);
  assert.equal(text(r.host.querySelector('p')!), 'This channel is for one topic. Want me to suggest tasks I can do here?');
  assert.deepEqual(
    [...r.host.querySelectorAll('button')].map((b) => text(b)),
    ['Yes', 'No', 'Not now'],
  );
  await click(button(r.host, 'Yes'));
  assert.deepEqual(calls, [
    ['welcome', A, 'yes'],
    ['send', 'c1', 'Suggest tasks you can do here', [], { human: true }],
  ]);
  await r.unmount();
  for (const [label, answer] of [
    ['No', 'no'],
    ['Not now', 'later'],
  ] as const) {
    calls.length = 0;
    const x = await welcome(channels[0]);
    await click(button(x.host, label));
    assert.deepEqual(calls, [['welcome', A, answer]]);
    await x.unmount();
  }
  // a refusal is a toast and the chips come back; an answered channel and a chat with turns show no row
  calls.length = 0;
  answers.welcome = () => ({ ok: false, error: 'gone' });
  const fail = await welcome(channels[0]);
  await click(button(fail.host, 'Yes'));
  assert.deepEqual(calls.at(-1), ['toast', 'gone', 'error']);
  assert.equal((button(fail.host, 'Yes') as HTMLButtonElement).disabled, false);
  await fail.unmount();
  const answered = await welcome(CH(A, 'Kitchen', { welcome: 'no' }));
  assert.equal(answered.host.innerHTML, '');
  await answered.unmount();
  turns = 2;
  const used = await welcome(channels[0]);
  assert.equal(used.host.innerHTML, '');
  await used.unmount();
});

test('Everything lists each channel’s rows with its name and filters by channel; a row opens its channel; a failed read says so and Try again reads', async (t) => {
  reset();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const row = (o: any) => ({
    chatId: 'c',
    turnId: 't',
    channelId: null,
    name: 'Main',
    at: Date.UTC(2026, 10, 15, 12),
    user: 'hi',
    assistant: 'hello',
    ...o,
  });
  feed = {
    ok: true,
    unavailable: false,
    filters: [
      { id: 'main', name: 'Main' },
      { id: A, name: 'Kitchen' },
    ],
    rows: [
      row({ chatId: 'ca', turnId: 't2', channelId: A, name: 'Kitchen', user: 'milk', assistant: '' }),
      row({ turnId: 't1', user: '' }),
    ],
  };
  const opened: any[] = [];
  const r = await render(h(EverythingFeed, { open: (x: any) => opened.push(x.chatId) }));
  await settle();
  assert.deepEqual(
    [...r.host.querySelectorAll('select option')].map((o) => text(o)),
    ['All channels', 'Main', '#Kitchen'],
  );
  assert.deepEqual(
    [...r.host.querySelectorAll('[data-channel]')].map((b) => [b.getAttribute('data-channel'), text(b).includes('#Kitchen')]),
    [
      [A, true],
      ['main', false],
    ],
  );
  await click(r.host.querySelector('[data-channel]'));
  assert.deepEqual(opened, ['ca']);
  await act(async () => {
    const select = r.host.querySelector('select')!;
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')!.set!.call(select, A);
    select.dispatchEvent(new window.Event('change', { bubbles: true }) as any);
  });
  await settle();
  assert.deepEqual(calls.filter((c) => c[0] === 'everything').slice(-1), [['everything', A]]);
  // main's change and the interval read again
  const reads = () => calls.filter((c) => c[0] === 'everything').length;
  const before = reads();
  await act(async () => changed?.());
  await act(async () => t.mock.timers.tick(FEED_REFRESH_MS));
  await settle();
  assert.equal(reads(), before + 2);
  feed = { ...feed, rows: [] };
  await act(async () => changed?.());
  await settle();
  assert.ok(text(r.host).includes('Nothing yet.'));
  feed = { ok: false, error: 'MoMo is not available' };
  await act(async () => changed?.());
  await settle();
  assert.ok(text(r.host).includes('Couldn’t read your channels.'));
  assert.equal(r.host.querySelector('select')!.options.length, 3);
  feed = { ok: true, rows: [row({})], filters: [], unavailable: false };
  await click(button(r.host, 'Try again'));
  assert.equal(r.host.querySelector('[role=alert]'), null);
  await r.unmount();
});

test('the list hook reads again when main says, keeps the newest answer, and says why a read failed; channelCall never throws', async () => {
  reset();
  let state: any = null;
  const Probe = () => ((state = useMomoChannels()), null);
  const r = await render(h(Probe));
  await settle();
  assert.deepEqual([state.enabled, state.channels.length, state.groups.length, state.room, state.error], [true, 2, 1, 10, null]);
  channels = [CH(A, 'Kitchen')];
  await act(async () => changed?.());
  await settle();
  assert.equal(state.channels.length, 1);
  const real = nativeStub;
  const original = real.momoChannels.list;
  real.momoChannels.list = async () => ({ ok: false, error: 'MoMo is not available', reason: 'not_allowed' });
  await act(async () => state.reload());
  await settle();
  assert.equal(state.error, 'MoMo is not available');
  assert.equal(state.channels.length, 1);
  real.momoChannels.list = async () => {
    throw new Error('ipc down');
  };
  await act(async () => state.reload());
  await settle();
  assert.equal(state.error, 'ipc down');
  real.momoChannels.list = original;
  await r.unmount();
  assert.deepEqual(
    await channelCall(
      async () => ({ ok: true as const, n: 2 }),
      (x) => x.n,
    ),
    { ok: true, value: 2 },
  );
  assert.deepEqual(
    await channelCall(
      async () => ({ ok: false as const, error: 'no' }),
      () => 1,
    ),
    { ok: false, error: 'no' },
  );
  assert.deepEqual(
    await channelCall(
      async () => {
        throw new Error('boom');
      },
      () => 1,
    ),
    { ok: false, error: 'boom' },
  );
  assert.equal(C.placeholder('Kitchen'), 'Message #Kitchen');
});
