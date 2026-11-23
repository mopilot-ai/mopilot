// The channels' IPC (A2, electron/momo/channelsIpc.cjs): every handler is refused while MoMo is not allowed, and while `momo.channels` is off (the list then says so and shows nothing); a registry refusal comes back with its code and words; a change is told to the windows and a read is not; the handlers go when removed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChannels, memoryStorage } = require('../electron/momo/channels.cjs');
const { registerChannelsIpc, CHANNELS, NOT_ALLOWED, OFF } = require('../electron/momo/channelsIpc.cjs');

function rig() {
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  let n = 0;
  const channels = createChannels({ storage: memoryStorage(), newId: () => (++n).toString(16).padStart(16, '0') });
  const state = { allowed: true, enabled: true };
  const told: string[] = [];
  const chats = {
    ensure: async (id: unknown) => {
      if (!channels.get(id)) throw Object.assign(new Error('That channel isn’t there any more.'), { code: 'gone' });
      return { chatId: 'chat-1', warning: null };
    },
    archive: async (id: unknown) => ({ id: (await channels.archive(id)).id }),
    restore: async (id: unknown) => ({ channel: await channels.restore(id) }),
    remove: async (id: unknown) => ({ id: (await channels.remove(id)).id }),
  };
  const everything = { list: (only?: unknown) => ({ rows: [], filters: [{ id: 'main', name: 'Main' }], unavailable: false, only }) };
  const off = registerChannelsIpc(ipcMain as any, {
    channels,
    chats: chats as any,
    everything: everything as any,
    allowed: () => state.allowed,
    enabled: () => state.enabled,
    broadcast: (ch) => told.push(ch),
  });
  const call = (ch: string, ...args: any[]) => handlers.get(ch)!(null, ...args);
  return { call, state, told, handlers, off, channels };
}

test('create, rename, move, instructions, the first row and groups answer ok and tell the windows; reads and a chat open tell nobody', async () => {
  const r = rig();
  const list0: any = await r.call('momoChannels:list');
  assert.deepEqual([list0.ok, list0.enabled, list0.channels, list0.room], [true, true, [], 12]);
  const group: any = await r.call('momoChannels:group:create', 'Home');
  assert.equal(group.ok, true);
  const made: any = await r.call('momoChannels:create', 'Kitchen', group.group.id);
  assert.deepEqual([made.ok, made.channel.name, made.channel.group], [true, 'Kitchen', group.group.id]);
  const id = made.channel.id;
  assert.equal(((await r.call('momoChannels:rename', id, 'Kitchen 2')) as any).channel.name, 'Kitchen 2');
  assert.equal(((await r.call('momoChannels:move', id, null)) as any).channel.group, null);
  assert.equal(((await r.call('momoChannels:reorder', id, 'up')) as any).channel.id, id, 'one place up, told to the windows');
  assert.equal(((await r.call('momoChannels:instructions:set', id, 'Be brief.')) as any).channel.hasInstructions, true);
  assert.equal(((await r.call('momoChannels:instructions:get', id)) as any).text, 'Be brief.');
  assert.equal(((await r.call('momoChannels:welcome', id, 'yes')) as any).channel.welcome, 'yes');
  assert.equal(((await r.call('momoChannels:group:rename', group.group.id, 'House')) as any).group.name, 'House');
  assert.equal(((await r.call('momoChannels:group:delete', group.group.id)) as any).removed, true);
  assert.equal(r.told.length, 9);
  assert.deepEqual(await r.call('momoChannels:chat', id), { ok: true, chatId: 'chat-1', warning: null });
  // Everything is a read: all the rows, or one channel's
  const all: any = await r.call('momoChannels:everything');
  assert.deepEqual([all.ok, all.rows, all.unavailable, all.only], [true, [], false, undefined]);
  assert.equal(((await r.call('momoChannels:everything', id)) as any).only, id);
  await r.call('momoChannels:list');
  await r.call('momoChannels:instructions:get', id);
  assert.equal(r.told.length, 9);
  assert.deepEqual(await r.call('momoChannels:archive', id), { ok: true, id });
  assert.equal(r.told.length, 10);
  const other: any = await r.call('momoChannels:create', 'B');
  assert.deepEqual(await r.call('momoChannels:delete', other.channel.id), { ok: true, id: other.channel.id });
  assert.ok(r.told.every((t) => t === 'momoChannels:changed'));
});

test('a refusal comes back as a value with its reason and words, and tells nobody', async () => {
  const r = rig();
  await r.call('momoChannels:create', 'Kitchen');
  const dup: any = await r.call('momoChannels:create', 'kitchen');
  assert.deepEqual([dup.ok, dup.reason, dup.error], [false, 'duplicate', 'You already have one with that name.']);
  const bad: any = await r.call('momoChannels:create', '');
  assert.equal(bad.reason, 'bad_args');
  const gone: any = await r.call('momoChannels:chat', 'ch_ffffffffffffffff');
  assert.deepEqual([gone.ok, gone.reason], [false, 'gone']);
  const missing: any = await r.call('momoChannels:instructions:get', 'ch_ffffffffffffffff');
  assert.equal(missing.reason, 'gone');
  // an error with no code the windows know is `failed`
  r.channels.rename = () => Promise.reject(new Error('disk full'));
  const failed: any = await r.call('momoChannels:rename', 'x', 'y');
  assert.deepEqual([failed.ok, failed.reason, failed.error], [false, 'failed', 'disk full']);
  assert.equal(r.told.length, 1);
});

test('the twelfth channel is the last: the thirteenth is refused with a short message', async () => {
  const r = rig();
  for (let i = 0; i < 12; i++) assert.equal(((await r.call('momoChannels:create', `c${i}`)) as any).ok, true);
  const more: any = await r.call('momoChannels:create', 'more');
  assert.deepEqual([more.ok, more.reason, more.error], [false, 'cap', 'That’s 12 channels. Archive one to add another.']);
});

test('an account MoMo is not allowed for is refused everywhere, before anything is read or changed', async () => {
  const r = rig();
  r.state.allowed = false;
  for (const ch of CHANNELS) assert.deepEqual(await r.call(ch, 'x', 'y'), NOT_ALLOWED, ch);
  assert.deepEqual(r.channels.list().channels, []);
  assert.deepEqual(r.told, []);
});

test('with channels off the list says so and shows nothing, and every other call is refused', async () => {
  const r = rig();
  await r.call('momoChannels:create', 'Kitchen');
  r.state.enabled = false;
  assert.deepEqual(await r.call('momoChannels:list'), { ok: true, enabled: false, channels: [], groups: [], room: 0 });
  for (const ch of CHANNELS.filter((c: string) => c !== 'momoChannels:list')) assert.deepEqual(await r.call(ch, 'x', 'y'), OFF, ch);
  assert.equal(r.channels.list().channels.length, 1);
});

test('removing the handlers leaves none, and a registration without a broadcast still answers', async () => {
  const r = rig();
  r.off();
  assert.equal(r.handlers.size, 0);
  const handlers = new Map<string, Function>();
  registerChannelsIpc({ handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: () => undefined } as any, {
    channels: r.channels,
    chats: {} as any,
    everything: {} as any,
    allowed: () => true,
    enabled: () => true,
  });
  assert.equal((await handlers.get('momoChannels:create')!(null, 'Quiet')).ok, true);
  assert.equal((await handlers.get('momoChannels:group:delete')!(null, 'gr_0000000000000000')).reason, 'gone');
});

test('restore and a group’s restore answer ok and tell the windows; a restore of what is not archived is a refusal that tells nobody', async () => {
  const r = rig();
  const g: any = await r.call('momoChannels:group:create', 'Home');
  const made: any = await r.call('momoChannels:create', 'Kitchen', g.group.id);
  const told = r.told.length;
  assert.equal(((await r.call('momoChannels:restore', made.channel.id)) as any).reason, 'gone');
  assert.equal(r.told.length, told);
  await r.call('momoChannels:archive', made.channel.id);
  await r.call('momoChannels:group:delete', g.group.id);
  const back: any = await r.call('momoChannels:group:restore', g.group, [made.channel.id]);
  assert.deepEqual([back.ok, back.group], [true, g.group]);
  const restored: any = await r.call('momoChannels:restore', made.channel.id);
  assert.deepEqual([restored.ok, restored.channel.name], [true, 'Kitchen']);
  assert.equal(r.told.length, told + 4);
  assert.ok(CHANNELS.includes('momoChannels:restore') && CHANNELS.includes('momoChannels:group:restore'));
});
