// MoMo's channels and groups (A2, electron/momo/channels.cjs over its storage seam; the sealed file is wired in app/momoChannels.cjs): opaque Mac-made ids that last, a name only, names unique among the open channels, at most 12 open, rename, archive (leaves the rail, keeps its chat), delete, move into a group and out, groups as folders, instructions of at most 2,000 characters, the answer to the first row, and a sealed file that keeps all of it across a restart and goes with Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/momo-memory.ts';

const require = createRequire(import.meta.url);
const {
  createChannels,
  channelsShape,
  memoryStorage,
  ChannelError,
  cleanName,
  MAX_CHANNELS,
  MAX_GROUPS,
  MAX_ARCHIVED,
  MAX_NAME,
  MAX_INSTRUCTIONS,
} = require('../electron/momo/channels.cjs');
const { openChannels, channelsOn, channelContext, FILE } = require('../electron/app/momoChannels.cjs');
const { CHANNEL_ID } = require('../shared/momoChat.mjs');

function rig() {
  let n = 0;
  const clock = { at: Date.UTC(2026, 10, 15, 12) };
  const channels = createChannels({
    storage: memoryStorage(),
    now: () => clock.at,
    newId: () => (++n).toString(16).padStart(16, '0'),
  });
  return { channels, clock };
}
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: any) => e instanceof ChannelError && e.code === c);

test('a channel is made by name only: an id the Mac made, no group, no instructions, no chat yet', async () => {
  const { channels, clock } = rig();
  assert.deepEqual(channels.list(), { channels: [], groups: [], room: MAX_CHANNELS });
  const c = await channels.create('  Home   renovation ');
  assert.match(c.id, CHANNEL_ID);
  assert.deepEqual(c, { id: c.id, name: 'Home renovation', group: null, createdAt: clock.at, hasInstructions: false, welcome: null });
  assert.equal(channels.chatIdOf(c.id), null);
  assert.equal(channels.instructionsOf(c.id), '');
  assert.deepEqual(channels.get(c.id), c);
  assert.equal(channels.get('nope'), null);
  assert.equal(channels.list().room, MAX_CHANNELS - 1);
});

test('names are 1 to 40 characters with no control characters; a bad one is refused and nothing is made', async () => {
  const { channels } = rig();
  for (const bad of ['', '   ', 'x'.repeat(MAX_NAME + 1), 7, null, undefined]) await code(channels.create(bad), 'bad_args');
  assert.equal((await channels.create('a\u0000b\tc')).name, 'a b c');
  assert.equal((await channels.create('x'.repeat(MAX_NAME))).name.length, MAX_NAME);
  assert.equal(cleanName('ok'), 'ok');
  assert.equal(cleanName(3), null);
  assert.equal(channels.list().channels.length, 2);
});

test('a name already used by an open channel is refused, in any case; main and Everything are taken; an archived name is free again', async () => {
  const { channels } = rig();
  const a = await channels.create('Kitchen');
  await code(channels.create('kitchen'), 'duplicate');
  await code(channels.create('  KITCHEN  '), 'duplicate');
  for (const reserved of ['Main', 'everything', 'New channel']) await code(channels.create(reserved), 'duplicate');
  await channels.archive(a.id);
  assert.equal((await channels.create('Kitchen')).name, 'Kitchen');
});

test('at most 12 channels are open: the 13th says so, an archived one frees a place, and a refusal changes nothing', async () => {
  const { channels } = rig();
  for (let i = 0; i < MAX_CHANNELS; i++) await channels.create(`c${i}`);
  await code(channels.create('one more'), 'cap');
  assert.equal(channels.list().room, 0);
  assert.equal(channels.list().channels.length, MAX_CHANNELS);
  await channels.archive(channels.list().channels[0].id);
  assert.equal((await channels.create('one more')).name, 'one more');
});

test('rename keeps the id and the rest, refuses a taken or bad name, and lets a channel keep its own name in another case', async () => {
  const { channels } = rig();
  const a = await channels.create('Trip');
  await channels.create('Work');
  const renamed = await channels.rename(a.id, 'TRIP 2027');
  assert.deepEqual([renamed.id, renamed.name], [a.id, 'TRIP 2027']);
  await code(channels.rename(a.id, 'work'), 'duplicate');
  await code(channels.rename(a.id, ''), 'bad_args');
  assert.equal((await channels.rename(a.id, 'trip 2027')).name, 'trip 2027');
  await code(channels.rename('missing', 'x'), 'gone');
});

test('archive takes a channel out of the list and its lookups and hands back its chat; it can be neither renamed, moved nor archived again', async () => {
  const { channels, clock } = rig();
  const a = await channels.create('Trip');
  await channels.linkChat(a.id, 'chat-1');
  assert.equal(channels.chatIdOf(a.id), 'chat-1');
  assert.equal(channels.byChatId('chat-1')?.id, a.id);
  await channels.setInstructions(a.id, 'Plan in euros.');
  clock.at += 1;
  const done = await channels.archive(a.id);
  assert.deepEqual([done.id, done.chatId], [a.id, 'chat-1']);
  assert.deepEqual(channels.list().channels, []);
  assert.deepEqual(
    [channels.get(a.id), channels.chatIdOf(a.id), channels.byChatId('chat-1'), channels.instructionsOf(a.id)],
    [null, null, null, ''],
  );
  for (const call of [
    () => channels.archive(a.id),
    () => channels.rename(a.id, 'x'),
    () => channels.move(a.id, null),
    () => channels.setInstructions(a.id, 'x'),
  ])
    await code(call(), 'gone');
});

test('delete forgets the channel, open or archived, and says which chat was its journal; an unknown one is gone', async () => {
  const { channels } = rig();
  const a = await channels.create('A');
  const b = await channels.create('B');
  await channels.linkChat(a.id, 'chat-a');
  await channels.archive(b.id);
  assert.deepEqual(await channels.remove(a.id), { id: a.id, chatId: 'chat-a' });
  assert.deepEqual(await channels.remove(b.id), { id: b.id, chatId: null });
  await code(channels.remove(a.id), 'gone');
  await code(channels.remove(7), 'gone');
  assert.deepEqual(channels.list().channels, []);
});

test('groups are folders: a channel moves in and out, a group is renamed, deleting one frees its channels, names are unique', async () => {
  const { channels } = rig();
  const home = await channels.createGroup(' Home ');
  assert.match(home.id, /^gr_[0-9a-f]{16}$/);
  assert.deepEqual(channels.list().groups, [home]);
  const a = await channels.create('Kitchen', home.id);
  assert.equal(a.group, home.id);
  const b = await channels.create('Garden');
  assert.equal((await channels.move(b.id, home.id)).group, home.id);
  assert.equal((await channels.move(b.id, null)).group, null);
  await code(channels.move(b.id, 'gr_0000000000000000'), 'gone');
  await code(channels.move(b.id, 5), 'gone');
  await code(channels.create('Other', 'gr_0000000000000000'), 'gone');
  await code(channels.createGroup('home'), 'duplicate');
  await code(channels.createGroup(''), 'bad_args');
  const work = await channels.createGroup('Work');
  assert.equal((await channels.renameGroup(work.id, 'Office')).name, 'Office');
  await code(channels.renameGroup(work.id, 'HOME'), 'duplicate');
  await code(channels.renameGroup(work.id, ' '), 'bad_args');
  await code(channels.renameGroup('gr_0000000000000000', 'x'), 'gone');
  assert.equal(await channels.removeGroup(home.id), true);
  assert.equal(channels.get(a.id)?.group, null);
  await code(channels.removeGroup(home.id), 'gone');
  assert.deepEqual(
    channels.list().groups.map((g: any) => g.name),
    ['Office'],
  );
});

test('at most 12 groups', async () => {
  const { channels } = rig();
  for (let i = 0; i < MAX_GROUPS; i++) await channels.createGroup(`g${i}`);
  await code(channels.createGroup('more'), 'cap');
});

test('instructions are the channel’s own, at most 2,000 characters, trimmed; empty clears them; the list shows only that there are some', async () => {
  const { channels } = rig();
  const a = await channels.create('Trip');
  const b = await channels.create('Work');
  assert.equal((await channels.setInstructions(a.id, '  Answer in French.  ')).hasInstructions, true);
  assert.equal(channels.instructionsOf(a.id), 'Answer in French.');
  assert.equal(channels.instructionsOf(b.id), '');
  assert.ok(!JSON.stringify(channels.list()).includes('French'));
  await code(channels.setInstructions(a.id, 'x'.repeat(MAX_INSTRUCTIONS + 1)), 'bad_args');
  await code(channels.setInstructions(a.id, 5), 'bad_args');
  assert.equal((await channels.setInstructions(a.id, 'x'.repeat(MAX_INSTRUCTIONS))).hasInstructions, true);
  assert.equal((await channels.setInstructions(a.id, '  ')).hasInstructions, false);
  assert.equal(channels.instructionsOf(a.id), '');
});

test('the answer to the first row is recorded as given and nothing else is kept', async () => {
  const { channels } = rig();
  const a = await channels.create('Trip');
  for (const answer of ['yes', 'no', 'later']) assert.equal((await channels.answerWelcome(a.id, answer)).welcome, answer);
  await code(channels.answerWelcome(a.id, 'maybe'), 'bad_args');
  await code(channels.answerWelcome(a.id, null), 'bad_args');
  await code(channels.answerWelcome('missing', 'yes'), 'gone');
  assert.equal(channels.get(a.id)?.welcome, 'later');
});

test('a channel keeps its id and chat through a restart; main-written ids are opaque and never repeat', async () => {
  const storage = memoryStorage();
  const first = createChannels({ storage });
  const a = await first.create('A');
  const b = await first.create('B');
  assert.notEqual(a.id, b.id);
  await first.linkChat(a.id, 'chat-a');
  const again = createChannels({ storage });
  assert.deepEqual(
    again.list().channels.map((c: any) => c.id),
    [a.id, b.id],
  );
  assert.equal(again.chatIdOf(a.id), 'chat-a');
});

test('the kept registry drops what is not a channel: bad ids, names, duplicates, a group that is gone; archived ones are the newest 50', () => {
  const ok = {
    id: 'ch_0000000000000001',
    name: 'A',
    group: 'gr_0000000000000001',
    chatId: 'c',
    archived: null,
    createdAt: 5,
    instructions: 'i',
    welcome: 'yes',
  };
  const kept = channelsShape({
    groups: [
      { id: 'gr_0000000000000001', name: 'G' },
      { id: 'gr_0000000000000001', name: 'dup' },
      { id: 'bad', name: 'x' },
      { id: 'gr_0000000000000002', name: '' },
      null,
    ],
    channels: [
      ok,
      { ...ok, name: 'dup id' },
      {
        ...ok,
        id: 'ch_0000000000000002',
        group: 'gr_0000000000000009',
        chatId: 7,
        archived: 'x',
        createdAt: 'x',
        instructions: 3,
        welcome: 'maybe',
      },
      { ...ok, id: 'bad' },
      { ...ok, id: 'ch_0000000000000003', name: 7 },
      'junk',
    ],
  });
  assert.deepEqual(kept.groups, [{ id: 'gr_0000000000000001', name: 'G' }]);
  assert.deepEqual(kept.channels, [
    ok,
    { id: 'ch_0000000000000002', name: 'A', group: null, chatId: null, archived: null, createdAt: 0, instructions: '', welcome: null },
  ]);
  assert.deepEqual(channelsShape('nope'), { channels: [], groups: [] });
  const many = Array.from({ length: MAX_ARCHIVED + 3 }, (_, i) => ({
    ...ok,
    id: `ch_${String(i).padStart(16, '0')}`,
    name: `n${i}`,
    archived: 100 + i,
  }));
  const trimmed = channelsShape({ channels: [...many, { ...ok, id: 'ch_ffffffffffffffff', name: 'open' }] });
  assert.equal(trimmed.channels.length, MAX_ARCHIVED + 1);
  assert.ok(!trimmed.channels.some((c: any) => c.name === 'n0'));
  assert.ok(trimmed.channels.some((c: any) => c.name === 'open'));
});

test('a sealed file keeps the registry across a restart, holds none of it in plain text, and Reset removes it', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-channels-'));
  const safe = fakeSafe();
  const first = openChannels({ dir, safeStorage: safe });
  const c = await first.channels.create('Secret plans');
  await first.channels.setInstructions(c.id, 'Never mention the budget.');
  const raw = fs.readFileSync(path.join(dir, FILE), 'utf8');
  assert.ok(!raw.includes('Secret') && !raw.includes('budget'));
  const second = openChannels({ dir, safeStorage: safe });
  assert.equal(second.channels.get(c.id)?.name, 'Secret plans');
  assert.equal(second.channels.instructionsOf(c.id), 'Never mention the budget.');
  await second.erase();
  assert.equal(fs.existsSync(path.join(dir, FILE)), false);
  assert.deepEqual(openChannels({ dir, safeStorage: safe }).channels.list().channels, []);
});

test('the flag is read at every call, and a chat’s channel context is its own instructions while the flag is on', async () => {
  let momo: any = {};
  const readState = () => ({ prefs: { momo } });
  assert.equal(channelsOn(readState), false);
  momo = { channels: true };
  assert.equal(channelsOn(readState), true);
  const { channels } = rig();
  const a = await channels.create('Trip');
  await channels.linkChat(a.id, 'chat-a');
  await channels.setInstructions(a.id, 'Plan in euros.');
  let on = true;
  const ctx = channelContext(channels, () => on);
  assert.deepEqual(ctx('chat-a'), { name: 'Trip', instructions: 'Plan in euros.' });
  assert.equal(ctx('momo-main'), null);
  on = false;
  assert.equal(ctx('chat-a'), null);
});

test('an id or chat id that is not a string is no channel anywhere', async () => {
  const { channels } = rig();
  await channels.create('A');
  for (const bad of [7, null, undefined, {}]) {
    assert.equal(channels.get(bad), null);
    assert.equal(channels.chatIdOf(bad), null);
    assert.equal(channels.instructionsOf(bad), '');
    assert.equal(channels.byChatId(bad), null);
    await code(channels.rename(bad, 'x'), 'gone');
    await code(channels.remove(bad), 'gone');
  }
  assert.equal(channels.byChatId(''), null);
});

test('restore undoes an archive: the channel is back with its journal; refused for one not archived, a name taken meanwhile and a full rail', async () => {
  const { channels } = rig();
  const a = await channels.create('Kitchen');
  await channels.linkChat(a.id, 'chat-a');
  await code(channels.restore(a.id), 'gone');
  await channels.archive(a.id);
  assert.equal((await channels.restore(a.id)).name, 'Kitchen');
  assert.equal(channels.chatIdOf(a.id), 'chat-a');
  await code(channels.restore('ch_0000000000000000'), 'gone');
  await channels.archive(a.id);
  await channels.create('kitchen');
  await code(channels.restore(a.id), 'duplicate');
  const { channels: full } = rig();
  const first = await full.create('Zero');
  await full.archive(first.id);
  for (let i = 0; i < MAX_CHANNELS; i++) await full.create(`c${i}`);
  await code(full.restore(first.id), 'cap');
});

test('restoreGroup undoes a group delete: the same id and name, and the open channels that were in it and are still loose', async () => {
  const { channels } = rig();
  const home = await channels.createGroup('Home');
  const a = await channels.create('Kitchen', home.id);
  const b = await channels.create('Garden', home.id);
  const c = await channels.create('Study', home.id);
  await channels.removeGroup(home.id);
  // one went into another group, one was archived, one stayed loose
  const other = await channels.createGroup('Work');
  await channels.move(b.id, other.id);
  await channels.archive(c.id);
  assert.deepEqual(await channels.restoreGroup(home, [a.id, b.id, c.id, 7]), home);
  assert.deepEqual(
    channels.list().channels.map((x: any) => [x.name, x.group]),
    [
      ['Kitchen', home.id],
      ['Garden', other.id],
    ],
  );
  await code(channels.restoreGroup(home, []), 'duplicate');
  await code(channels.restoreGroup({ id: 'gr_00000000000000ff', name: 'HOME' }, []), 'duplicate');
  await code(channels.restoreGroup({ id: 'nope', name: 'X' }, []), 'bad_args');
  await code(channels.restoreGroup(null, []), 'bad_args');
  await code(channels.restoreGroup({ id: 'gr_00000000000000ff', name: ' ' }, []), 'bad_args');
  // no list of channels is fine
  assert.equal((await channels.restoreGroup({ id: 'gr_00000000000000fe', name: 'Spare' }, 'x')).name, 'Spare');
  while (channels.list().groups.length < MAX_GROUPS) await channels.createGroup(`g${channels.list().groups.length}`);
  await code(channels.restoreGroup({ id: 'gr_00000000000000fd', name: 'More' }, []), 'cap');
});

test('reorder moves a channel one place among those beside it (its group’s, or the loose ones) and the order is the list’s order (#4926)', async () => {
  const { channels } = rig();
  const home = await channels.createGroup('Home');
  const a = await channels.create('A');
  const g1 = await channels.create('G1', home.id);
  const b = await channels.create('B');
  const g2 = await channels.create('G2', home.id);
  const c = await channels.create('C');
  const names = () => channels.list().channels.map((x: any) => x.name);
  assert.deepEqual(names(), ['A', 'G1', 'B', 'G2', 'C']);
  // loose channels only swap with loose ones: a group's channels in between do not count
  await channels.reorder(c.id, 'up');
  assert.deepEqual(names(), ['A', 'G1', 'C', 'G2', 'B']);
  await channels.reorder(a.id, 'down');
  assert.deepEqual(names(), ['C', 'G1', 'A', 'G2', 'B']);
  // at an end it stays, and says the same
  assert.equal((await channels.reorder(c.id, 'up')).name, 'C');
  assert.equal((await channels.reorder(b.id, 'down')).name, 'B');
  assert.deepEqual(names(), ['C', 'G1', 'A', 'G2', 'B']);
  await channels.reorder(g2.id, 'up');
  assert.deepEqual(names(), ['C', 'G2', 'A', 'G1', 'B']);
  // an archived channel is not beside anything; a bad direction or a gone channel is refused
  await channels.archive(a.id);
  await channels.reorder(c.id, 'down');
  assert.deepEqual(names(), ['B', 'G2', 'G1', 'C']);
  await code(channels.reorder(b.id, 'sideways'), 'bad_args');
  await code(channels.reorder('ch_0000000000000000', 'up'), 'gone');
  await code(channels.reorder(a.id, 'up'), 'gone');
  assert.equal(g1.group, home.id);
});
