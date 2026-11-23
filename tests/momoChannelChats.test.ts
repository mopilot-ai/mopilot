// The chats behind MoMo's channels (A2, electron/momo/channelChats.cjs over the main chat service): a channel's journal is a MoMo chat tagged for it, made on the first open with MoMo's one brain and kept on it afterwards (the same pending switch, picks or replacement as main), concurrent opens make one chat, archive ends its turn and keeps the chat, delete removes the chat and then the channel, and everything is refused while MoMo is not allowed or channels are off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createChannels, memoryStorage } = require('../electron/momo/channels.cjs');
const { createChannelChats } = require('../electron/momo/channelChats.cjs');
const { momoChannelIdOf, isMomoMeta } = require('../shared/momoChat.mjs');

const BRAIN = { harness: 'claude', model: 'opus', modelLabel: 'Opus', effort: null, account: null };

function rig(o: { plan?: string; busy?: boolean; gone?: boolean; brain?: any } = {}) {
  let n = 0;
  const channels = createChannels({ storage: memoryStorage(), newId: () => (++n).toString(16).padStart(16, '0') });
  const records = new Map<string, any>();
  const deleted = new Set<string>();
  const log: string[] = [];
  const state = {
    allowed: true,
    enabled: true,
    plan: o.plan ?? 'now',
    busy: o.busy ?? false,
    gone: o.gone ?? false,
    brain: o.brain === undefined ? BRAIN : o.brain,
    started: 0,
  };
  const chats = {
    records,
    isDeleted: (id: string) => deleted.has(id),
    patchMeta: (id: string, patch: any) => {
      const r = records.get(id);
      if (!r) return false;
      r.meta = { ...r.meta, ...patch };
      return true;
    },
  };
  let tail = Promise.resolve();
  const mainChat = {
    serial: (fn: () => Promise<unknown>) => {
      const before = tail;
      let release!: () => void;
      tail = new Promise<void>((r) => (release = r));
      return before.then(fn).finally(release);
    },
    busy: () => state.busy,
    gone: async () => state.gone,
    brain: () => state.brain,
    brainOrDefault: async () => BRAIN,
    planFor: () => state.plan,
    reconcile: () => (log.push('reconcile'), { applied: state.plan, warning: state.plan === 'nextMessage' ? 'later' : null }),
    retire: (id: string) => (log.push(`retire ${id}`), chats.patchMeta(id, { momo: 'previous' })),
    startBackground: async (brain: any, tag: any) => {
      await new Promise((r) => setTimeout(r, 5));
      const id = `chat-${++state.started}`;
      records.set(id, { meta: { ...tag } });
      log.push(`start ${id} ${tag.momo} ${brain.harness}`);
      return id;
    },
  };
  const svc = createChannelChats({
    channels,
    mainChat: mainChat as any,
    chats,
    allowed: () => state.allowed,
    enabled: () => state.enabled,
    stop: (id: string) => log.push(`stop ${id}`),
    deleteChat: async (id: string) => (log.push(`delete ${id}`), void deleted.add(id)),
    changed: (id: string) => log.push(`changed ${id}`),
  });
  return { svc, channels, records, state, log, deleted };
}
const code = (p: Promise<unknown> | (() => unknown), c: string) =>
  typeof p === 'function' ? assert.throws(p, (e: any) => e.code === c) : assert.rejects(p, (e: any) => e.code === c);

test('the first open makes the channel’s chat on MoMo’s brain, tagged for it and linked; the next open is that chat', async () => {
  const { svc, channels, records, log } = rig();
  const a = await channels.create('Trip');
  const first = await svc.ensure(a.id);
  assert.deepEqual(first, { chatId: 'chat-1', warning: null });
  assert.equal(momoChannelIdOf(records.get('chat-1').meta), a.id);
  assert.equal(isMomoMeta(records.get('chat-1').meta), true);
  assert.equal(channels.chatIdOf(a.id), 'chat-1');
  assert.equal(svc.chatIdOf(a.id), 'chat-1');
  assert.equal((await svc.ensure(a.id)).chatId, 'chat-1');
  // the second open brought the chat to the brain: its picks were told to the windows
  assert.deepEqual(log, ['start chat-1 channel:' + a.id + ' claude', 'changed chat-1']);
});

test('opening twice at once makes one chat, and two channels make two', async () => {
  const { svc, channels, log } = rig();
  const a = await channels.create('A');
  const b = await channels.create('B');
  const [x, y, z] = await Promise.all([svc.ensure(a.id), svc.ensure(a.id), svc.ensure(b.id)]);
  assert.deepEqual([x.chatId, y.chatId, z.chatId], ['chat-1', 'chat-1', 'chat-2']);
  assert.equal(log.filter((l) => l.startsWith('start')).length, 2);
});

test('an unknown, archived or deleted channel is gone, and nothing is made for it', async () => {
  const { svc, channels, log } = rig();
  const a = await channels.create('A');
  await code(svc.ensure('ch_ffffffffffffffff'), 'gone');
  await code(svc.ensure(7), 'gone');
  assert.throws(
    () => svc.chatIdOf('nope'),
    (e: any) => e.code === 'gone',
  );
  await svc.archive(a.id);
  await code(svc.ensure(a.id), 'gone');
  assert.deepEqual(log, []);
});

test('a channel with no chat yet has none to read, and no chat is made by reading', async () => {
  const { svc, channels, log } = rig();
  const a = await channels.create('A');
  assert.equal(svc.chatIdOf(a.id), null);
  assert.deepEqual(log, []);
});

test('MoMo not allowed, or channels off, refuse every call before anything happens', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  r.state.allowed = false;
  await code(r.svc.ensure(a.id), 'not_allowed');
  assert.throws(
    () => r.svc.chatIdOf(a.id),
    (e: any) => e.code === 'not_allowed',
  );
  await code(
    Promise.resolve().then(() => r.svc.archive(a.id)),
    'not_allowed',
  );
  await code(
    Promise.resolve().then(() => r.svc.remove(a.id)),
    'not_allowed',
  );
  r.state.allowed = true;
  r.state.enabled = false;
  await code(r.svc.ensure(a.id), 'unavailable');
  assert.deepEqual(r.log, []);
});

test('MoMo turned off while an open waited its turn: nothing is made', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  const hold = r.svc.ensure(a.id);
  const second = r.svc.ensure(a.id);
  r.state.enabled = false;
  await code(hold, 'unavailable');
  await code(second, 'unavailable');
  assert.deepEqual(r.log, []);
});

test('the chat is retired when the channel goes while it starts', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  const original = r.channels.linkChat;
  r.channels.linkChat = async (...args: any[]) => {
    await r.channels.archive(a.id);
    return original(...args);
  };
  await code(r.svc.ensure(a.id), 'gone');
  assert.deepEqual(r.log, [`start chat-1 channel:${a.id} claude`, 'retire chat-1']);
  assert.equal(r.records.get('chat-1').meta.momo, 'previous');
});

test('a chat on the brain’s harness keeps its picks; one a switch can carry waits for its next message; a busy one that cannot move says so', async () => {
  const now = rig();
  const a = await now.channels.create('A');
  await now.svc.ensure(a.id);
  assert.deepEqual(await now.svc.ensure(a.id), { chatId: 'chat-1', warning: null });
  assert.ok(now.log.some((l) => l === 'changed chat-1'));

  const next = rig({ plan: 'nextMessage' });
  const b = await next.channels.create('B');
  await next.svc.ensure(b.id);
  assert.deepEqual(await next.svc.ensure(b.id), { chatId: 'chat-1', warning: 'later' });

  const stuck = rig({ plan: 'newChat', busy: true });
  const c = await stuck.channels.create('C');
  await stuck.svc.ensure(c.id);
  const kept = await stuck.svc.ensure(c.id);
  assert.equal(kept.chatId, 'chat-1');
  assert.match(kept.warning ?? '', /once this chat is free/);
});

test('a chat no harness can carry to the brain is replaced by a new one and the old one stays MoMo’s, hidden', async () => {
  const r = rig({ plan: 'newChat' });
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  const second = await r.svc.ensure(a.id);
  assert.equal(second.chatId, 'chat-2');
  assert.equal(r.channels.chatIdOf(a.id), 'chat-2');
  assert.equal(r.records.get('chat-1').meta.momo, 'previous');
  assert.equal(isMomoMeta(r.records.get('chat-1').meta), true);
});

test('a chat whose session the harness lost is replaced and the user is told; a harness probe is not asked while a message waits', async () => {
  const r = rig({ gone: true });
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  const second = await r.svc.ensure(a.id);
  assert.equal(second.chatId, 'chat-2');
  assert.match(second.warning ?? '', /could not be reopened/);
  const busy = rig({ gone: true, busy: true });
  const b = await busy.channels.create('B');
  await busy.svc.ensure(b.id);
  assert.equal((await busy.svc.ensure(b.id)).chatId, 'chat-1');
});

test('no brain saved yet leaves the chat as it is', async () => {
  const r = rig({ brain: null });
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  assert.deepEqual(await r.svc.ensure(a.id), { chatId: 'chat-1', warning: null });
});

test('a chat that was archived or deleted by other means is made again', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  r.records.get('chat-1').meta.archived = 5;
  assert.equal((await r.svc.ensure(a.id)).chatId, 'chat-2');
  r.deleted.add('chat-2');
  assert.equal(r.svc.chatIdOf(a.id), null);
  assert.equal((await r.svc.ensure(a.id)).chatId, 'chat-3');
  // a chat tagged for another channel is not this one's
  r.records.get('chat-3').meta.momo = 'channel:ch_0000000000000099';
  assert.equal((await r.svc.ensure(a.id)).chatId, 'chat-4');
});

test('archive ends the turn, keeps the chat and the channel’s name out of the list; the chat is not deleted', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  assert.deepEqual(await r.svc.archive(a.id), { id: a.id });
  assert.ok(r.log.includes('stop chat-1'));
  assert.ok(!r.log.some((l) => l.startsWith('delete')));
  assert.deepEqual(r.channels.list().channels, []);
  assert.equal(r.records.get('chat-1').meta.momo, `channel:${a.id}`);
  const none = await r.channels.create('B');
  assert.deepEqual(await r.svc.archive(none.id), { id: none.id });
  await code(r.svc.archive('missing'), 'gone');
});

test('delete stops the turn, deletes the chat, then forgets the channel; a chat that cannot be deleted keeps the channel', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  assert.deepEqual(await r.svc.remove(a.id), { id: a.id });
  assert.deepEqual(r.log.slice(-2), ['stop chat-1', 'delete chat-1']);
  assert.deepEqual(r.channels.list().channels, []);
  const none = await r.channels.create('B');
  assert.deepEqual(await r.svc.remove(none.id), { id: none.id });
  await code(r.svc.remove('missing'), 'gone');

  const failing = createChannelChats({
    channels: r.channels,
    mainChat: { serial: (fn: () => unknown) => Promise.resolve().then(fn) } as any,
    chats: r.records && { records: r.records, isDeleted: () => false, patchMeta: () => true },
    allowed: () => true,
    enabled: () => true,
    stop: () => Promise.reject(new Error('stop failed')),
    deleteChat: async () => {
      throw new Error('cannot delete');
    },
    changed: () => undefined,
  });
  const c = await r.channels.create('C');
  await r.channels.linkChat(c.id, 'chat-x');
  r.records.set('chat-x', { meta: { momo: `channel:${c.id}` } });
  await assert.rejects(failing.remove(c.id), /cannot delete/);
  assert.equal(r.channels.get(c.id)?.name, 'C');
});

test('a turn that will not stop does not keep a channel from being archived', async () => {
  const r = rig();
  const a = await r.channels.create('A');
  await r.svc.ensure(a.id);
  const failing = createChannelChats({
    channels: r.channels,
    mainChat: { serial: (fn: () => unknown) => Promise.resolve().then(fn) } as any,
    chats: { records: r.records, isDeleted: () => false, patchMeta: () => true },
    allowed: () => true,
    enabled: () => true,
    stop: () => Promise.reject(new Error('stop failed')),
    deleteChat: async () => undefined,
    changed: () => undefined,
  });
  assert.deepEqual(await failing.archive(a.id), { id: a.id });
});
