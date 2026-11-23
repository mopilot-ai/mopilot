// MoMo's channels on the Mac, the parts (A2: ChannelsRail.tsx, ChannelDialogs.tsx): the rail's Main, Everything, groups and channels (an empty group says where to drop, a channel is dragged or moved into a group), each row's menu, and the dialogs (a name only, instructions with their count, a delete that waits two seconds and offers to archive instead).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { window } from './support/dom.ts';
import { createElement as h, act } from 'react';
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

const { ChannelsRail, ChannelMenu } = await import('../src/components/momo/channels/ChannelsRail.tsx');
const { NameDialog, InstructionsDialog, DeleteDialog, MAX_INSTRUCTIONS } = await import(
  '../src/components/momo/channels/ChannelDialogs.tsx'
);
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
const act2 = (fn: () => unknown) => act(async () => void fn());
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

test('the rail lists Main, Everything, groups with their channels and the loose channels; the shown one is current', async () => {
  reset();
  const draw = (view: any) => render(h(ChannelsRail, { channels, groups, view, act: actions() }));
  const r = await draw({ kind: 'main' });
  assert.deepEqual(
    [...r.host.querySelectorAll('li > button, li > div > span, li button.railLink')]
      .map((e) => text(e))
      .filter(Boolean)
      .slice(0, 6),
    ['Main', 'Everything', 'Home', 'Garden', 'Kitchen'],
  );
  assert.equal(r.host.querySelector('[aria-current=page]')!.textContent, 'Main');
  await click(button(r.host, 'Everything'));
  await click(button(r.host, 'Kitchen'));
  await click(button(r.host, 'Main'));
  assert.deepEqual(calls, [['openEverything'], ['openChannel', A], ['openMain']]);
  await r.unmount();
  for (const [view, now] of [
    [{ kind: 'everything' }, 'Everything'],
    [{ kind: 'channel', id: B }, 'Garden'],
  ] as const) {
    const v = await draw(view);
    assert.equal(v.host.querySelector('[aria-current=page]')!.textContent, now);
    await v.unmount();
  }
});

test('an empty group says where to drop; a group of a channel that is gone shows its channel loose; no group row without groups', async () => {
  reset();
  groups = [
    { id: G, name: 'Home' },
    { id: 'gr_000000000000000b', name: 'Work' },
  ];
  const r = await render(h(ChannelsRail, { channels, groups, view: { kind: 'main' }, act: actions() }));
  assert.equal(r.host.querySelectorAll('p').length, 1);
  assert.equal(text(r.host.querySelector('p')!), 'Drag or move channels here');
  await r.rerender(
    h(ChannelsRail, { channels: [CH(A, 'Kitchen', { group: 'gr_gone' })], groups: [], view: { kind: 'main' }, act: actions() }),
  );
  assert.ok(button(r.host, 'Kitchen'));
  assert.equal(r.host.querySelectorAll('p').length, 0);
  await r.unmount();
});

test('a channel dragged onto a group moves into it; a drop with no channel moves nothing; the group lights while it is over', async () => {
  reset();
  const a = actions();
  const r = await render(h(ChannelsRail, { channels, groups, view: { kind: 'main' }, act: a }));
  const head = r.host.querySelector('[class*=groupHead]') as HTMLElement;
  const drag = (type: string, data: Record<string, string> = {}) => {
    const ev: any = new window.Event(type, { bubbles: true, cancelable: true });
    ev.dataTransfer = { setData: (k: string, v: string) => (data[k] = v), getData: (k: string) => data[k] ?? '' };
    return ev;
  };
  const data: Record<string, string> = {};
  const row = [...r.host.querySelectorAll('li[draggable]')].find((li) => text(li).includes('Kitchen'))!;
  await act(async () => void row.dispatchEvent(drag('dragstart', data)));
  assert.deepEqual(data, { 'text/x-momo-channel': A });
  await act(async () => void head.dispatchEvent(drag('dragover')));
  assert.equal(head.hasAttribute('data-over'), true);
  await act(async () => void head.dispatchEvent(drag('dragleave')));
  assert.equal(head.hasAttribute('data-over'), false);
  await act(async () => void head.dispatchEvent(drag('drop', data)));
  await act(async () => void head.dispatchEvent(drag('drop', {})));
  assert.deepEqual(calls, [['moveById', A, G]]);
  await r.unmount();
});

test('a channel’s menu: rename, instructions, a move into each group or out of its group, archive and delete; Escape and a click away close it', async () => {
  reset();
  const a = actions();
  groups = [
    { id: G, name: 'Home' },
    { id: 'gr_000000000000000b', name: 'Work' },
  ];
  const garden = channels[1];
  const r = await render(h(ChannelMenu, { channel: garden, groups, act: a }));
  const trigger = button(r.host, 'More for the Garden channel')!;
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  await click(trigger);
  assert.deepEqual(
    [...r.host.querySelectorAll('[role^=menuitem]')].map((e) => text(e)),
    ['Rename', 'Instructions', 'Move to group ›', 'Archive', 'Delete'],
  );
  assert.equal(item(r.host, 'Delete')!.className.includes('danger'), true, 'Delete is red');
  const sep = [...r.host.querySelectorAll('[role=menu] > *')].map((e) =>
    e.getAttribute('role') === 'separator' ? 'separator' : e.textContent,
  );
  assert.equal(sep.indexOf('separator') + 1, sep.indexOf('Delete'), 'after a divider');
  assert.equal(item(r.host, 'Move to group ›')!.getAttribute('aria-expanded'), 'false');
  await click(item(r.host, 'Move to group ›'));
  assert.deepEqual(
    [...r.host.querySelectorAll('[role^=menuitem]')].map((e) => text(e)),
    [
      'Rename',
      'Instructions',
      'Move to group ›',
      'Move to group: Home',
      'Move to group: Work',
      'Move to group: No group',
      'Archive',
      'Delete',
    ],
  );
  assert.equal(item(r.host, 'Home')!.getAttribute('aria-checked'), 'true');
  assert.equal(item(r.host, 'Work')!.getAttribute('aria-checked'), 'false');
  await act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(r.host.querySelector('[role=menu]'), null);
  await click(trigger);
  await act(async () => void document.body.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any));
  assert.equal(r.host.querySelector('[role=menu]'), null);
  for (const label of ['Rename', 'Instructions', 'Work', 'No group', 'Archive', 'Delete']) {
    await click(trigger);
    // an Escape that ends an input method's composition is not the user's, and leaves it open too
    await act(
      async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })),
    );
    assert.ok(r.host.querySelector('[role=menu]'));
    // a key that is not Escape, and a click inside the menu, leave it open
    await act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true })));
    await act(
      async () => void r.host.querySelector('[role=menu]')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any),
    );
    if (label === 'Work' || label === 'No group') await click(item(r.host, 'Move to group ›'));
    await click(item(r.host, label));
    assert.equal(r.host.querySelector('[role=menu]'), null);
  }
  assert.deepEqual(calls, [
    ['rename', B],
    ['instructions', B],
    ['move', B, 'gr_000000000000000b'],
    ['move', B, null],
    ['archive', B],
    ['remove', B],
  ]);
  // a channel in no group has no way out of one to offer
  await r.rerender(h(ChannelMenu, { channel: channels[0], groups: [], act: a }));
  await click(button(r.host, 'More for the Kitchen channel'));
  assert.equal(item(r.host, 'No group'), null);
  await r.unmount();
});

test('a group’s menu renames it or deletes it', async () => {
  reset();
  const a = actions();
  const r = await render(h(ChannelsRail, { channels, groups, view: { kind: 'main' }, act: a }));
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Rename'));
  await click(button(r.host, 'Group menu: Home'));
  await click(item(r.host, 'Delete group'));
  assert.deepEqual(calls, [
    ['renameGroup', G],
    ['removeGroup', G],
  ]);
  await r.unmount();
});

test('a name dialog asks a name only and says "A place for one topic"; a refusal stays in it; a good name closes it', async () => {
  reset();
  let reply: string | null = 'You already have one with that name.';
  const seen: string[] = [];
  let closed = 0;
  const r = await render(h(NameDialog, { submit: async (v: string) => (seen.push(v), reply), onClose: () => closed++ }));
  assert.equal(text(r.host.querySelector('.dialog-head')!).includes('New channel'), true);
  assert.ok(text(r.host).includes('A place for one topic. Your main chat stays as it is.'));
  assert.equal((button(r.host, 'Create') as HTMLButtonElement).disabled, true);
  await typeInto(r.host.querySelector('input'), 'Kitchen');
  await submit(r.host);
  await settle();
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, reply);
  assert.equal(closed, 0);
  reply = null;
  await submit(r.host);
  await settle();
  assert.deepEqual([seen, closed], [['Kitchen', 'Kitchen'], 1]);
  // a second press while one is under way does nothing
  let release: (v: string | null) => void = () => undefined;
  const slow = await render(
    h(NameDialog, { group: true, submit: () => new Promise<string | null>((res) => (release = res)), onClose: () => closed++ }),
  );
  assert.ok(text(slow.host).includes('A folder for channels.'));
  await typeInto(slow.host.querySelector('input'), 'Home');
  await submit(slow.host);
  await submit(slow.host);
  release(null);
  await settle();
  assert.equal(closed, 2);
  await slow.unmount();
  await r.unmount();
  const rename = await render(h(NameDialog, { rename: true, initial: 'Old', submit: async () => null, onClose: () => undefined }));
  assert.equal(text(rename.host.querySelector('.dialog-head')!).includes('Rename channel'), true);
  assert.equal(rename.host.querySelector('input')!.value, 'Old');
  assert.ok(button(rename.host, 'Save'));
  await rename.unmount();
  const group = await render(h(NameDialog, { rename: true, group: true, submit: async () => null, onClose: () => undefined }));
  assert.equal(text(group.host.querySelector('.dialog-head')!).includes('Rename group'), true);
  await group.unmount();
});

test('instructions keep their count and the dialog says when they are over 2,000; Cancel and Escape close', async () => {
  reset();
  let closed = 0;
  const seen: string[] = [];
  const r = await render(
    h(InstructionsDialog, { initial: 'Be brief.', submit: async (v: string) => (seen.push(v), null), onClose: () => closed++ }),
  );
  assert.ok(text(r.host).includes('9 / 2000'));
  assert.equal(r.host.querySelector('[data-over]'), null);
  await textarea(r.host.querySelector('textarea'), 'x'.repeat(MAX_INSTRUCTIONS + 1));
  assert.ok(r.host.querySelector('[data-over]'));
  await textarea(r.host.querySelector('textarea'), '');
  await submit(r.host);
  await settle();
  assert.deepEqual([seen, closed], [[''], 1]);
  await click(button(r.host, 'Cancel'));
  await act(async () => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(closed, 3);
  await r.unmount();
});

test('Delete stays off for two seconds, then works; Archive instead is the other way; a refusal stays in the dialog', async () => {
  reset();
  const done: any[] = [];
  let reply: string | null = 'The channel is busy.';
  let closed = 0;
  const r = await render(
    h(DeleteDialog, {
      name: 'Kitchen',
      remove: async () => (done.push('remove'), reply),
      archive: async () => (done.push('archive'), null),
      onClose: () => closed++,
    }),
  );
  assert.ok(text(r.host.querySelector('.dialog-head')!).includes('Delete #Kitchen?'));
  assert.ok(text(r.host).includes('Can’t be undone. You can archive it instead.'));
  const del = button(r.host, 'Delete') as HTMLButtonElement;
  assert.equal(del.disabled, true);
  await click(del);
  assert.deepEqual(done, []);
  await act(async () => void (await new Promise((r) => setTimeout(r, DELETE_DELAY_MS / 2))));
  assert.equal(del.disabled, true);
  await act(async () => void (await new Promise((r) => setTimeout(r, DELETE_DELAY_MS / 2 + 200))));
  assert.equal(del.disabled, false);
  await click(del);
  assert.equal(r.host.querySelector('[role=alert]')!.textContent, reply);
  assert.equal(del.disabled, false);
  reply = null;
  await click(del);
  assert.deepEqual([done, closed], [['remove', 'remove'], 1]);
  await r.unmount();
  const other = await render(
    h(DeleteDialog, {
      name: 'Kitchen',
      remove: async () => null,
      archive: async () => ((done as any[]).push('archive'), null),
      onClose: () => closed++,
    }),
  );
  await click(button(other.host, 'Archive instead'));
  assert.deepEqual([done.at(-1), closed], ['archive', 2]);
  await other.unmount();
});

test('Everything has Filter and a + on hover or focus; a channel’s ⋯ is for hover or focus and a right click opens the same menu (#4926)', async () => {
  reset();
  const made: string[] = [];
  const act = { ...actions(), create: { channel: () => made.push('channel'), group: () => made.push('group') } };
  const r = await render(h(ChannelsRail, { channels, groups: [], view: { kind: 'main' }, act }));
  // Everything's own row (its button and hover actions); the channels are a list beside it under the same item
  const row = [...r.host.querySelectorAll('button')].find((b) => text(b) === 'Everything')!.parentElement!;
  assert.deepEqual(
    [...row.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') ?? text(b)),
    ['Everything', 'Filter', 'Create channel or group'],
  );
  await click(button(row as any, 'Filter'));
  assert.equal(text(item(row as any, 'Status · Active ›')!), 'Status · Active ›');
  assert.equal(item(row as any, 'Status')!.getAttribute('aria-checked'), 'true');
  await click(item(row as any, 'Status'));
  assert.equal(row.querySelector('[role=menu]'), null);
  await click(button(row as any, 'Create channel or group'));
  await click(item(row as any, 'New group'));
  await click(button(row as any, 'Create channel or group'));
  await click(item(row as any, 'New channel'));
  assert.deepEqual(made, ['group', 'channel']);
  const kitchen = button(r.host, 'Kitchen')!.closest('li')!;
  assert.equal(kitchen.querySelector('[role=menu]'), null);
  await act2(() => kitchen.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }) as any));
  assert.deepEqual(
    [...kitchen.querySelectorAll('[role^=menuitem]')].map((e) => text(e)),
    ['Rename', 'Instructions', 'Archive', 'Delete'],
    'no groups to move to: no Move item',
  );
  await act2(() => void window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  assert.equal(kitchen.querySelector('[role=menu]'), null);
  // without the page's create calls there is no + (the rail alone)
  const bare = await render(h(ChannelsRail, { channels, groups: [], view: { kind: 'main' }, act: actions() }));
  assert.equal(button(bare.host, 'Create channel or group'), null);
  await bare.unmount();
  await r.unmount();
});

test('Space picks a channel up, Up and Down move it, Space, Escape or leaving drops it; Space never opens it (#4926)', async () => {
  reset();
  const r = await render(h(ChannelsRail, { channels, groups: [], view: { kind: 'main' }, act: actions() }));
  const link = () => button(r.host, 'Garden')!;
  const key = (el: Element, k: string) =>
    act(async () => void el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }) as any));
  const keyUp = (el: Element, k: string) =>
    act(async () => void el.dispatchEvent(new window.KeyboardEvent('keyup', { key: k, bubbles: true, cancelable: true }) as any));
  const status = () => text(link().closest('li')!.querySelector('[role=status]')!);
  await key(link(), 'ArrowDown');
  assert.equal(calls.length, 0, 'nothing moves until it is picked up');
  await key(link(), ' ');
  await keyUp(link(), ' ');
  assert.equal(link().hasAttribute('data-held'), true);
  assert.equal(status(), 'Picked up Garden. Up and Down move it, Space drops it.');
  assert.equal(
    calls.some((c) => c[0] === 'openChannel'),
    false,
    'Space is not a click',
  );
  await key(link(), 'ArrowUp');
  await key(link(), 'ArrowDown');
  await key(link(), 'a');
  assert.deepEqual(
    calls.filter((c) => c[0] === 'reorder'),
    [
      ['reorder', B, 'up'],
      ['reorder', B, 'down'],
    ],
  );
  await key(link(), ' ');
  assert.equal(link().hasAttribute('data-held'), false);
  assert.equal(status(), '');
  await key(link(), ' ');
  await act(
    async () =>
      void link().dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }) as any,
      ),
  );
  assert.equal(link().hasAttribute('data-held'), true, 'an input method’s Escape is its own');
  await key(link(), 'Escape');
  assert.equal(link().hasAttribute('data-held'), false);
  await key(link(), ' ');
  await act(async () => void link().dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }) as any));
  assert.equal(link().hasAttribute('data-held'), false, 'leaving it drops it');
  await r.unmount();
});

test('the channels, groups and loose ones alike, are a list nested under Everything', async () => {
  reset();
  const mixed = [CH(A, 'Kitchen', { group: G }), CH(B, 'Garden')];
  const r = await render(
    h(ChannelsRail, { channels: mixed, groups: [{ id: G, name: 'Home' }] as any, view: { kind: 'main' }, act: actions() }),
  );
  const everything = button(r.host, 'Everything')!.closest('li')!;
  const under = everything.querySelector('ul[aria-label=Channels]')!;
  assert.ok(under, 'the list is inside Everything\u2019s own item');
  assert.ok(under.contains(button(r.host, 'Kitchen')), 'a channel in a group');
  assert.ok(under.contains(button(r.host, 'Garden')), 'a channel with no group');
  assert.ok(under.contains([...r.host.querySelectorAll('span')].find((e) => text(e) === 'Home')!), 'the group itself');
  assert.equal(under.contains(button(r.host, 'Everything')), false, 'Everything is not inside its own list');
  assert.equal(button(r.host, 'Main')!.closest('ul[aria-label=Channels]'), null, 'Main stays above it');
  await r.unmount();
});
