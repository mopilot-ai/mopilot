// MoMo's channels in the page, the edges (A2): a channel dragged onto a group moves through the page's own call, deleting the channel shown goes back to Main (a refused delete stays), and a read that is answered after a newer one is dropped, for the list and for Everything, a failed Everything read says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act, useState } from 'react';
import { render, click, flush } from './support/shell-chrome-kit.ts';
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
    reorder: async (id: string, dir: string) => log('reorder', id, dir),
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

const { useChannelsUi } = await import('../src/components/momo/channels/useChannelsUi.tsx');
const { EverythingFeed } = await import('../src/components/momo/channels/EverythingFeed.tsx');
const { useMomoChannels } = await import('../src/components/momo/channels/channelsData.ts');
const { DELETE_DELAY_MS } = await import('../src/components/momo/channels/channelCopy.ts');

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
const _submit = async (host: ParentNode) =>
  act(async () => void host.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }) as any));
const _textarea = async (el: Element | null, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
  });
  await flush();
};

const _actions = () => {
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
const _view = (r: any) => r.host.firstChild.getAttribute('data-view');

test('dragging a channel onto a group in the rail moves it through the page’s call; a refusal is a toast', async () => {
  reset();
  const r = await page();
  const head = r.host.querySelector('[class*=groupHead]') as HTMLElement;
  const drop = (id: string) => {
    const ev: any = new window.Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { getData: () => id };
    return act(async () => void head.dispatchEvent(ev));
  };
  await drop(A);
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'move'),
    [['move', A, G]],
  );
  answers.move = () => ({ ok: false, error: 'That group isn’t there any more.' });
  await drop(A);
  await settle();
  assert.deepEqual(calls.at(-1), ['toast', 'That group isn’t there any more.', 'error']);
  await r.unmount();
});

test('deleting the channel shown goes back to Main once it is deleted; a refused delete keeps the page where it is', async () => {
  reset();
  route = { name: 'momo', chatId: 'chat-a' };
  momoChats = { 'chat-a': `channel:${A}` };
  const r = await page();
  const openDelete = async () => {
    await click(button(r.host, 'More for the Kitchen channel'));
    await click(item(r.host, 'Delete'));
    await act(async () => void (await new Promise((res) => setTimeout(res, DELETE_DELAY_MS + 200))));
  };
  answers.delete = () => ({ ok: false, error: 'MoMo is not available' });
  await openDelete();
  await click([...r.host.querySelectorAll('button')].find((b) => text(b) === 'Delete')!);
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, 'MoMo is not available');
  assert.equal(calls.filter((c) => c[0] === 'navigate').length, 0);
  delete answers.delete;
  await click([...r.host.querySelectorAll('button')].find((b) => text(b) === 'Delete')!);
  assert.deepEqual(
    calls.filter((c) => c[0] === 'navigate'),
    [['navigate', { name: 'momo', tab: 'chat' }]],
  );
  await r.unmount();
});

test('a list read that is answered after a newer one is dropped', async () => {
  reset();
  const first = (() => {
    let resolve: (v: unknown) => void = () => undefined;
    const p = new Promise((r) => (resolve = r));
    return { p, resolve };
  })();
  let n = 0;
  const original = nativeStub.momoChannels.list;
  nativeStub.momoChannels.list = () => (++n === 1 ? first.p : original());
  let state: any = null;
  const Probe = () => ((state = useMomoChannels()), null);
  const r = await render(h(Probe));
  await act(async () => state.reload());
  await settle();
  assert.equal(state.channels.length, 2);
  // the first, slower answer carries older data and changes nothing
  first.resolve({ ok: true, enabled: true, channels: [], groups: [], room: 12 });
  await settle();
  assert.equal(state.channels.length, 2);
  nativeStub.momoChannels.list = original;
  await r.unmount();
});

test('Everything: a read answered after a newer one is dropped, and a read that throws says why', async () => {
  reset();
  const slow = (() => {
    let resolve: (v: unknown) => void = () => undefined;
    const p = new Promise((res) => (resolve = res));
    return { p, resolve };
  })();
  let n = 0;
  const original = nativeStub.momoChannels.everything;
  nativeStub.momoChannels.everything = (only?: string) => (++n === 1 ? slow.p : original(only));
  const row = { chatId: 'c', turnId: 't', channelId: null, name: 'Main', at: 1, user: 'fresh', assistant: '' };
  feed = { ok: true, unavailable: false, filters: [], rows: [row] };
  const r = await render(h(EverythingFeed, { open: () => undefined }));
  await act(async () => changed?.());
  await settle();
  assert.ok(text(r.host).includes('fresh'));
  slow.resolve({ ok: true, unavailable: false, filters: [], rows: [{ ...row, user: 'stale' }] });
  await settle();
  assert.ok(!text(r.host).includes('stale'));
  nativeStub.momoChannels.everything = () => Promise.reject(new Error('ipc down'));
  await act(async () => changed?.());
  await settle();
  assert.ok(text(r.host).includes('ipc down') || text(r.host).includes('Couldn’t read your channels.'));
  nativeStub.momoChannels.everything = original;
  await r.unmount();
});

test('the rail’s own rows run the page’s calls: Space then Down reorders a channel, and Everything’s + makes a channel or a group (#4926)', async () => {
  reset();
  const r = await page();
  const link = button(r.host, 'Kitchen')!;
  const key = (k: string) =>
    act(async () => void link.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as any));
  await key(' ');
  await key('ArrowDown');
  await settle();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'reorder'),
    [['reorder', A, 'down']],
  );
  // a refusal is the page's toast, as every call's
  answers.reorder = () => ({ ok: false, error: 'That channel isn’t there any more.' });
  await key('ArrowUp');
  await settle();
  assert.deepEqual(calls.at(-1), ['toast', 'That channel isn’t there any more.', 'error']);
  await click(button(r.host, 'Create channel or group'));
  await click(item(r.host, 'New channel'));
  assert.ok(r.host.querySelector('.dialog-head'));
  await click(button(r.host, 'Cancel'));
  await click(button(r.host, 'Create channel or group'));
  await click(item(r.host, 'New group'));
  assert.ok(text(r.host).includes('A folder for channels.'));
  await r.unmount();
});
