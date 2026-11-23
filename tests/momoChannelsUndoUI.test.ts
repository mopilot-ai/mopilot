// Undo toasts for MoMo's channels (design row 16, useChannelsUi.tsx): rename, move, archive and a group's delete each say so with Undo (8 s), and Undo runs the opposite call and says it was undone; a failed change or Undo says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act, useState } from 'react';
import { render, click, flush, type as typeInto } from './support/shell-chrome-kit.ts';
import { mockSource, stubStore } from './support/stubs.ts';
import { installNativeStub } from './support/ports/native.ts';

const calls: any[] = [];
const undos: { text: string; label: string; run: () => void }[] = [];
let route: any = { name: 'momo' };
let momoChats: Record<string, string> = {};
let turns = 0;
const store = (sel: any) => sel({ route, momoChats, threads: { c1: { turns: Array.from({ length: turns }) } } });
stubStore({
  useStore: store,
  navigate: (r: any) => calls.push(['navigate', r]),
  toast: (text: string, kind: string, opts?: any) => {
    calls.push(['toast', text, kind]);
    if (opts?.action) undos.push({ text, label: opts.action.label, run: opts.action.run });
  },
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
  momoChannels: {
    list: async () => ({ ok: true, enabled, channels, groups, room: 12 - channels.length }),
    chat: async (id: string) => log('chat', id) && (answers.chat ? answers.chat(id) : { ok: true, chatId: `chat-${id}`, warning: null }),
    create: async (name: string, group?: string | null) =>
      log('create', name, group) && (answers.create?.(name) ?? { ok: true, channel: CH(B, name) }),
    rename: async (id: string, name: string) => log('rename', id, name),
    archive: async (id: string) => log('archive', id),
    restore: async (id: string) => log('restore', id),
    restoreGroup: async (g: any, ids: string[]) => log('restoreGroup', g, ids),
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

const { useChannelsUi } = await import('../src/components/momo/channels/useChannelsUi.tsx');

const reset = () => {
  calls.length = 0;
  undos.length = 0;
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
    [ui.rail, h('button', { key: 'new', onClick: ui.newChannel }, 'make'), ui.dialogs],
  );
}
const page = async () => {
  const r = await render(h(Page));
  await settle();
  return r;
};

const undo = async () => {
  const u = undos.at(-1)!;
  assert.equal(u.label, 'Undo');
  await act(async () => void u.run());
  await settle();
};
const toasts = () => calls.filter((c) => c[0] === 'toast').map((c) => c[1]);
const rename = async (r: any, channel: string, to: string) => {
  await click(button(r.host, `More for the ${channel} channel`));
  await click(item(r.host, 'Rename'));
  await typeInto(r.host.querySelector('input'), to);
  await submit(r.host);
  await settle();
};

test('a rename says so with Undo, and Undo puts the old name back and says that; the same name says nothing', async () => {
  reset();
  const r = await page();
  await rename(r, 'Kitchen', 'Galley');
  assert.deepEqual(
    undos.map((u) => u.text),
    ['Renamed to #Galley'],
  );
  await undo();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'rename'),
    [
      ['rename', A, 'Galley'],
      ['rename', A, 'Kitchen'],
    ],
  );
  assert.equal(toasts().at(-1), 'Renamed the channel to Kitchen');
  undos.length = 0;
  await rename(r, 'Kitchen', 'Kitchen');
  assert.deepEqual(undos, []);
  // the name was taken meanwhile: the refusal is the toast
  await rename(r, 'Kitchen', 'Galley');
  answers.rename = () => ({ ok: false, error: 'You already have one with that name.' });
  await undo();
  assert.deepEqual(calls.at(-1), ['toast', 'You already have one with that name.', 'error']);
  await r.unmount();
});

test('a move into a group and out of one says so with Undo; Undo moves it back; a refusal offers no Undo', async () => {
  reset();
  const r = await page();
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'Move to group: Home'));
  await settle();
  assert.equal(undos.at(-1)!.text, 'Moved #Kitchen to the Home group');
  await undo();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'move'),
    [
      ['move', A, G],
      ['move', A, null],
    ],
  );
  assert.equal(toasts().at(-1), 'Moved #Kitchen out of its group');
  undos.length = 0;
  await click(button(r.host, 'More for the Garden channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'No group'));
  await settle();
  assert.equal(undos.at(-1)!.text, 'Moved #Garden out of its group');
  // a channel of a group that is gone: its old group has no name, and Undo still moves it back
  undos.length = 0;
  channels = [CH(A, 'Kitchen'), CH(B, 'Garden', { group: 'gr_00000000000000ff' })];
  await act(async () => void changed?.());
  await settle();
  await click(button(r.host, 'More for the Garden channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'Move to group: Home'));
  await settle();
  await undo();
  assert.deepEqual(calls.filter((c) => c[0] === 'move').at(-1), ['move', B, 'gr_00000000000000ff']);
  channels = [CH(A, 'Kitchen'), CH(B, 'Garden', { group: G })];
  await act(async () => void changed?.());
  await settle();
  // moved where it already is: no toast to undo
  undos.length = 0;
  channels = [CH(A, 'Kitchen'), CH(B, 'Garden', { group: G })];
  await click(button(r.host, 'More for the Garden channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'Move to group: Home'));
  await settle();
  assert.deepEqual(undos, []);
  answers.move = () => ({ ok: false, error: 'That group isn’t there any more.' });
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Move to group ›'));
  await click(item(r.host, 'Move to group: Home'));
  await settle();
  assert.deepEqual(undos, []);
  await r.unmount();
});

test('a channel dragged onto a group says so with Undo; a drop of an id the list does not know moves it and says nothing', async () => {
  reset();
  const r = await page();
  const head = r.host.querySelector('[class*=groupHead]') as HTMLElement;
  const drop = async (id: string) => {
    const ev: any = new window.Event('drop', { bubbles: true, cancelable: true });
    ev.dataTransfer = { getData: () => id };
    await act(async () => void head.dispatchEvent(ev));
    await settle();
  };
  await drop(A);
  assert.equal(undos.at(-1)!.text, 'Moved #Kitchen to the Home group');
  undos.length = 0;
  await drop('ch_00000000000000ff');
  assert.deepEqual(calls.filter((c) => c[0] === 'move').at(-1), ['move', 'ch_00000000000000ff', G]);
  assert.deepEqual(undos, []);
  await r.unmount();
});

test('archive says so with Undo; Undo restores the channel and says that; leaving the shown channel goes to Main; a refusal offers no Undo', async () => {
  reset();
  route = { name: 'momo', chatId: 'chat-a' };
  momoChats = { 'chat-a': `channel:${A}` };
  const r = await page();
  await click(button(r.host, 'More for the Kitchen channel'));
  await click(item(r.host, 'Archive'));
  await settle();
  assert.equal(undos.at(-1)!.text, 'Archived #Kitchen');
  assert.deepEqual(calls.filter((c) => c[0] === 'navigate').at(-1), ['navigate', { name: 'momo', tab: 'chat' }]);
  await undo();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'restore'),
    [['restore', A]],
  );
  assert.equal(toasts().at(-1), 'Unarchived the #Kitchen channel');
  // Undo that cannot: its own words; one that throws: the error's words
  answers.restore = () => ({ ok: false, error: 'That’s 12 channels. Archive one to add another.' });
  await undo();
  assert.deepEqual(calls.at(-1), ['toast', 'That’s 12 channels. Archive one to add another.', 'error']);
  nativeStub.momoChannels.restore = async () => {
    throw new Error('x');
  };
  await undo();
  assert.deepEqual(calls.at(-1), ['toast', 'x', 'error']);
  nativeStub.momoChannels.restore = async (id: string) => log('restore', id);
  undos.length = 0;
  answers.archive = () => ({ ok: false, error: 'gone' });
  await click(button(r.host, 'More for the Garden channel'));
  await click(item(r.host, 'Archive'));
  await settle();
  assert.deepEqual(undos, []);
  await r.unmount();
});

test('deleting a group says so with Undo; Undo puts the group back with the channels that were in it', async () => {
  reset();
  const r = await page();
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Delete group'));
  await settle();
  assert.equal(undos.at(-1)!.text, 'Deleted the Home group');
  await undo();
  assert.deepEqual(
    calls.filter((c) => c[0] === 'restoreGroup'),
    [['restoreGroup', { id: G, name: 'Home' }, [B]]],
  );
  assert.equal(toasts().at(-1), 'Restored the Home group');
  // a delete that fails offers nothing
  undos.length = 0;
  answers.deleteGroup = () => ({ ok: false, error: 'That group isn’t there any more.' });
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Delete group'));
  await settle();
  assert.deepEqual(undos, []);
  await r.unmount();
});
