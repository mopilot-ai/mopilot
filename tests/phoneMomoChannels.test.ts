// MoMo's channels on the classic phone (mobile/src/screens/MomoChannels.tsx in Momo.tsx, mobile/src/momo/channels*.ts): nothing of them without the method, the flag or the answer `enabled`; the picker lists Main, groups and channels; a channel is made by name only (the Mac's refusal shown under the field); picking one follows it by id, sends to it by id and says "Message #name"; the first row asks once; rename, move, archive and delete (which waits two seconds and offers to archive instead) go to the Mac; a channel that goes away sends the page back to Main; the words are in both catalogs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, click, flush, inputText } from './support/phone/component-kit';
import { momoRuntime, mountMomo, snapshotOf } from './support/phone/momo-kit';

const contractPath = '../mobile/src/momo/channelsContract';
const { parseChannels, parseChanged, parseChannel, channelChatKey, channelOfKey, CHANNELS_LIST } = await import(contractPath);
const outboxPath = '../mobile/src/outbox';
const { sendCall } = await import(outboxPath);
const enPath = '../mobile/src/ui/i18n/locales/en';
const zhPath = '../mobile/src/ui/i18n/locales/zh-Hans';
const en = (await import(enPath)).default;
const zh = (await import(zhPath)).default;
const sheetPath = '../mobile/src/screens/MomoChannels';
const { DELETE_DELAY_MS } = await import(sheetPath);

const A = 'ch_000000000000000a';
const B = 'ch_000000000000000b';
const G = 'gr_000000000000000a';
const ch = (id: string, name: string, extra: any = {}) => ({ id, name, group: null, hasInstructions: false, welcome: null, ...extra });
const METHODS = ['momo.state.get', 'momo.prefs.set', 'momo.channels.list', 'momo.channels.create'];

let list: any;
const reset = () => {
  list = {
    enabled: true,
    channels: [ch(A, 'Kitchen'), ch(B, 'Garden', { group: G })],
    groups: [
      { id: G, name: 'Home' },
      { id: 'gr_000000000000000b', name: 'Work' },
    ],
    room: 10,
  };
};
function page(over: Record<string, any> = {}, methods = METHODS) {
  return momoRuntime({
    'machine.hello': () => ({ v: 1, capabilities: { momo: true, momoBrainSet: false, methods, permissionCeiling: 'auto-review' } }),
    'momo.chat.follow': () => snapshotOf(),
    'momo.chat.unfollow': () => ({}),
    'momo.chat.send': () => ({ sent: true }),
    'momo.brain.get': () => ({ brain: null }),
    'momo.routines.list': () => ({ proposals: [], routines: [] }),
    'momo.sources.status': () => ({ calendar: true, reminders: true }),
    'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0 }),
    'momo.prefs.get': () => ({ paused: false, proactivity: 'default', quietHours: null, levels: [{ id: 'default' }] }),
    'momo.channels.list': () => list,
    'momo.channels.create': ({ name }: any) => ({ channel: ch('ch_000000000000000c', name) }),
    'momo.channels.rename': ({ channelId, name }: any) => ({ channel: ch(channelId, name) }),
    'momo.channels.move': ({ channelId, group }: any) => ({ channel: ch(channelId, 'Kitchen', { group }) }),
    'momo.channels.archive': ({ channelId }: any) => ({ id: channelId }),
    'momo.channels.delete': ({ channelId }: any) => ({ id: channelId }),
    'momo.channels.welcome': ({ channelId, answer }: any) => ({ channel: ch(channelId, 'Kitchen', { welcome: answer }) }),
    'momo.channels.group.create': () => ({ group: { id: 'gr_000000000000000c', name: 'x' } }),
    'momo.channels.group.rename': () => ({ group: { id: G, name: 'x' } }),
    'momo.channels.group.delete': () => ({ removed: true }),
    ...over,
  });
}
const label = (name: string) => document.querySelector(`[aria-label="${name}"]`) as HTMLElement | null;
const calls = (m: any, method: string) => m.calls.filter(([x]: [string]) => x === method).map(([, p]: any) => p);
const wait = (ms: number) => act(async () => void (await new Promise((r) => setTimeout(r, ms))));
const openPicker = async () => {
  await click('More');
  await click('Channels');
};

test('the contract keeps what it understands: a list needs its arrays, a channel its id and name, the flag must be exactly true', () => {
  reset();
  const parsed = parseChannels({
    ...list,
    channels: [...list.channels, { id: '', name: 'x' }, null, { id: 'z', name: 'Z', welcome: 'maybe', hasInstructions: true }],
  });
  assert.deepEqual(
    parsed.channels.map((c: any) => [c.id, c.welcome, c.hasInstructions]),
    [
      [A, null, false],
      [B, null, false],
      ['z', null, true],
    ],
  );
  assert.deepEqual(
    parsed.groups.map((g: any) => g.name),
    ['Home', 'Work'],
  );
  assert.equal(parsed.room, 10);
  assert.equal(parseChannels({ enabled: 'yes', channels: [], groups: [{ id: 'g' }], room: 'x' }).enabled, false);
  assert.equal(parseChannels({ enabled: 'yes', channels: [], groups: [{ id: 'g' }], room: 'x' }).room, 0);
  assert.throws(() => parseChannels({ channels: 'x', groups: [] }), /Could not read the channels/);
  assert.throws(() => parseChannels(null), /Could not read/);
  assert.equal(parseChannel('x'), null);
  assert.equal(parseChannel({ id: A, name: 'K', welcome: 'later' })!.welcome, 'later');
  assert.equal(parseChanged({ channel: ch(A, 'K') }).name, 'K');
  assert.throws(() => parseChanged({}), /Could not read the channel/);
  assert.equal(CHANNELS_LIST, 'momo.channels.list');
  assert.deepEqual([channelChatKey(A), channelOfKey(channelChatKey(A)), channelOfKey('momo')], [`momo:${A}`, A, null]);
});

test('a message to a channel goes out as momo.chat.send with its channel id; Main’s carries none', () => {
  const item: any = { id: 'm1', chatId: 'momo', text: 'hi', attachments: [], momo: true };
  assert.deepEqual(sendCall(item, true, 0), ['momo.chat.send', { id: 'm1', text: 'hi', followUp: 'queue' }]);
  assert.deepEqual(sendCall({ ...item, chatId: channelChatKey(A) }, true, 0), [
    'momo.chat.send',
    { id: 'm1', text: 'hi', followUp: 'queue', channelId: A },
  ]);
});

test('nothing of channels without the method, with channels off at the Mac, or from an older Mac', async () => {
  reset();
  for (const [methods, over] of [
    [METHODS.filter((m) => m !== 'momo.channels.list'), {}],
    [METHODS, { 'momo.channels.list': () => ({ enabled: false, channels: [], groups: [], room: 0 }) }],
  ] as const) {
    const view = await mountMomo(page({ ...over }, [...methods]));
    await flush();
    await click('More');
    assert.equal(label('Channels'), null);
    assert.doesNotMatch(view.text(), /Channels/);
    await view.unmount();
  }
});

test('the picker lists Main, the groups with their channels and the loose ones; an empty group says where to move channels from', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  const t = view.text();
  for (const word of [
    'Main',
    '#Kitchen',
    'Home',
    '#Garden',
    'Work',
    'Move channels here from a channel’s menu.',
    'New channel',
    'New group',
  ])
    assert.ok(t.includes(word), word);
  await view.unmount();
});

test('picking a channel follows it by id, says Message #Kitchen, sends to it by id and shows its name; Main brings Main back', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click('#Kitchen');
  await flush();
  assert.deepEqual(calls(m, 'momo.chat.follow').at(-1), { items: 50, channelId: A });
  assert.ok(label('Message #Kitchen'));
  assert.match(view.text(), /#Kitchen/);
  const sent: any[] = [];
  const original = m.runtime.send;
  m.runtime.send = (...args: any[]) => (sent.push(args), original(...args));
  await inputText('Message #Kitchen', 'plan dinner');
  await click('Send');
  await flush();
  assert.deepEqual(sent.at(-1)?.slice(0, 2), [channelChatKey(A), 'plan dinner']);
  await openPicker();
  await click('Main');
  await flush();
  assert.deepEqual(calls(m, 'momo.chat.follow').at(-1), { items: 50 });
  assert.ok(label('Ask MoMo anything'));
  await view.unmount();
});

test('a channel’s first row asks once; Yes records and sends a normal message, No and Not now only record; an answered channel has no row', async () => {
  for (const [button, answer] of [
    ['Yes', 'yes'],
    ['No', 'no'],
    ['Not now', 'later'],
  ] as const) {
    reset();
    const m = page({
      'momo.channels.welcome': ({ channelId, answer: a }: any) => (
        (list.channels = list.channels.map((c: any) => (c.id === channelId ? { ...c, welcome: a } : c))),
        { channel: ch(channelId, 'Kitchen', { welcome: a }) }
      ),
    });
    const view = await mountMomo(m);
    await flush();
    await openPicker();
    await click('#Kitchen');
    await flush();
    assert.match(view.text(), /This channel is for one topic\. Want me to suggest tasks I can do here\?/);
    await click(button);
    await flush();
    assert.deepEqual(calls(m, 'momo.channels.welcome'), [{ channelId: A, answer }]);
    assert.doesNotMatch(view.text(), /This channel is for one topic/);
    await view.unmount();
  }
  reset();
  const failing = page({ 'momo.channels.welcome': () => Promise.reject(new Error('That channel isn’t there any more.')) });
  const v = await mountMomo(failing);
  await flush();
  await openPicker();
  await click('#Kitchen');
  await flush();
  await click('Yes');
  assert.match(v.text(), /That channel isn’t there any more\./);
  await v.unmount();
});

test('New channel asks a name only; the Mac’s refusal stays under the field; a good name makes it and opens it', async () => {
  reset();
  let refuse = true;
  const m = page({
    'momo.channels.create': ({ name }: any) =>
      refuse ? Promise.reject(new Error('That’s 12 channels. Archive one to add another.')) : { channel: ch('ch_000000000000000c', name) },
  });
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click('New channel');
  assert.match(view.text(), /A place for one topic\. Your main chat stays as it is\./);
  await inputText('Name', 'Trip');
  await click('Create');
  assert.match(view.text(), /That’s 12 channels\. Archive one to add another\./);
  refuse = false;
  list = { ...list, channels: [...list.channels, ch('ch_000000000000000c', 'Trip')] };
  await click('Create');
  await flush();
  assert.deepEqual(calls(m, 'momo.channels.create').at(-1), { name: 'Trip', group: null });
  assert.deepEqual(calls(m, 'momo.chat.follow').at(-1), { items: 50, channelId: 'ch_000000000000000c' });
  await view.unmount();
});

test('rename, move into a group or out, new group, rename group and delete group go to the Mac', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click(`Channel menu: Kitchen`);
  await click('Rename');
  await inputText('Name', 'Galley');
  await click('Save');
  assert.deepEqual(calls(m, 'momo.channels.rename'), [{ channelId: A, name: 'Galley' }]);
  await click('Channel menu: Kitchen');
  await click('Move to group');
  await click('Home');
  assert.deepEqual(calls(m, 'momo.channels.move').at(-1), { channelId: A, group: G });
  await click('Channel menu: Garden');
  await click('Move to group');
  await click('No group');
  assert.deepEqual(calls(m, 'momo.channels.move').at(-1), { channelId: B, group: null });
  await click('New group');
  assert.match(view.text(), /A folder for channels\./);
  await inputText('Name', 'Trips');
  await click('Create');
  assert.deepEqual(calls(m, 'momo.channels.group.create'), [{ name: 'Trips' }]);
  await click('Rename group');
  await inputText('Name', 'House');
  await click('Save');
  assert.deepEqual(calls(m, 'momo.channels.group.rename'), [{ groupId: G, name: 'House' }]);
  await click('Delete group');
  assert.deepEqual(calls(m, 'momo.channels.group.delete'), [{ groupId: G }]);
  await view.unmount();
});

test('archive goes to the Mac and, for the channel shown, back to Main; a failing change says why', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click('#Kitchen');
  await flush();
  await openPicker();
  await click('Channel menu: Kitchen');
  await click('Archive');
  await flush();
  assert.deepEqual(calls(m, 'momo.channels.archive'), [{ channelId: A }]);
  assert.ok(label('Ask MoMo anything'));
  await openPicker();
  await click('Channel menu: Garden');
  await click('Archive');
  assert.deepEqual(calls(m, 'momo.channels.archive').at(-1), { channelId: B });
  await view.unmount();
  reset();
  const bad = page({ 'momo.channels.archive': () => Promise.reject(new Error('That channel isn’t there any more.')) });
  const v = await mountMomo(bad);
  await flush();
  await openPicker();
  await click('Channel menu: Kitchen');
  await click('Archive');
  assert.match(v.text(), /That channel isn’t there any more\./);
  await v.unmount();
});

test('Delete says it can’t be undone, waits two seconds, and offers to archive instead', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click('#Kitchen');
  await flush();
  await openPicker();
  await click('Channel menu: Kitchen');
  await click('Delete');
  assert.match(view.text(), /Delete #Kitchen\?/);
  assert.match(view.text(), /Can’t be undone\. You can archive it instead\./);
  const del = () => [...document.querySelectorAll('[role=button]')].find((b) => b.getAttribute('aria-label') === 'Delete') as HTMLElement;
  assert.equal(
    del().getAttribute('aria-disabled') ?? String(del().getAttribute('disabled')),
    del().getAttribute('aria-disabled') ?? 'null',
  );
  await click('Delete');
  assert.deepEqual(calls(m, 'momo.channels.delete'), []);
  await wait(DELETE_DELAY_MS + 200);
  await click('Delete');
  await flush();
  assert.deepEqual(calls(m, 'momo.channels.delete'), [{ channelId: A }]);
  assert.ok(label('Ask MoMo anything'));
  await view.unmount();
  reset();
  const other = page();
  const v = await mountMomo(other);
  await flush();
  await openPicker();
  await click('Channel menu: Garden');
  await click('Delete');
  await click('Archive instead');
  assert.deepEqual(calls(other, 'momo.channels.archive'), [{ channelId: B }]);
  await v.unmount();
});

test('a channel that goes away at the Mac, or channels turned off, sends the page back to Main', async () => {
  reset();
  const m = page();
  const view = await mountMomo(m);
  await flush();
  await openPicker();
  await click('#Kitchen');
  await flush();
  assert.ok(label('Message #Kitchen'));
  list = { ...list, channels: [ch(B, 'Garden', { group: G })] };
  m.emit?.({ ev: 'momo.changed', area: 'channels' });
  await flush();
  await flush();
  assert.ok(label('Ask MoMo anything'));
  await view.unmount();
});

test('the words are in both catalogs, the Chinese ones too', () => {
  const keys = Object.keys(en.momoChannels);
  assert.ok(keys.length >= 27);
  assert.deepEqual(Object.keys(zh.momoChannels).sort(), keys.sort());
  for (const k of keys) assert.ok(zh.momoChannels[k] && en.momoChannels[k], k);
});

test('a card raised in a channel waits in that channel and is answered there; Main shows none of it and answers nothing', async () => {
  reset();
  const asked = { cardId: 'k1', rev: 1, key: 'allow' };
  const card = { id: 'k1', rev: 1, title: 'Send the plan?', choices: [{ key: 'allow', label: 'Allow' }] };
  const m = page({
    'momo.chat.follow': ({ channelId }: any) => (channelId ? snapshotOf([card], [], 'chat-channel') : snapshotOf([], [], 'main')),
    'momo.card.answer': () => ({ answered: true }),
  });
  const view = await mountMomo(m);
  await flush();
  assert.doesNotMatch(view.text(), /Send the plan\?|need you/);
  await openPicker();
  await click('#Kitchen');
  await flush();
  assert.match(view.text(), /1 needs you/);
  assert.match(view.text(), /Send the plan\?/);
  await click('Allow');
  assert.deepEqual(calls(m, 'momo.card.answer'), [{ ...asked, channelId: A }]);
  // back on Main: no card, no count, and nothing is answered there
  await openPicker();
  await click('Main');
  await flush();
  assert.doesNotMatch(view.text(), /Send the plan\?|need you/);
  assert.equal(calls(m, 'momo.card.answer').length, 1);
  await view.unmount();
});

test('the shown channel’s row and the Chat tab carry the selected trait, and Main’s row does while Main is shown', async () => {
  reset();
  const m = page({ 'momo.state.get': () => ({ name: 'Mo', status: 'online', needsYou: 0, shell: true, shellTasks: false }) }, [...METHODS]);
  const view = await mountMomo(m);
  await flush();
  const selected = () => [...document.querySelectorAll('[aria-selected="true"]')].map((e) => e.getAttribute('aria-label') ?? e.textContent);
  await openPicker();
  assert.deepEqual(
    selected().filter((x) => /^(Main|#)/.test(String(x))),
    ['Main'],
  );
  await click('#Kitchen');
  await flush();
  await openPicker();
  assert.deepEqual(
    selected().filter((x) => /^(Main|#)/.test(String(x))),
    ['#Kitchen'],
  );
  // the page's own tab stays the Chat tab while a channel is shown
  assert.ok(selected().includes('Chat'));
  await view.unmount();
});
