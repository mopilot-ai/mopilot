// How main wires MoMo's channels (A2, electron/app/momoChannels.cjs): the chat service over the real main chat service and chats store, a channel's turn stopped and its chat deleted through the app's own chat deletion (one already deleted is not deleted again, and the store forgets it), the windows told of a chat main changed, Everything read from the history index's `recent` for Main and the open channels, and the flag read at every call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoWorld.ts';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { openChannels, registerMomoChannels } = require('../electron/app/momoChannels.cjs');
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');

async function rig(o: { chatDeletion?: any } = {}) {
  const w = world();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-channels-wiring-'));
  const { channels } = openChannels({ dir, safeStorage: fakeSafe() });
  const handlers = new Map<string, Function>();
  const told: any[] = [];
  const stopped: string[] = [];
  const deleted: string[] = [];
  const forgotten: string[] = [];
  const prefs = { channels: true };
  const index = new HistoryIndex({ dir: path.join(dir, 'history'), safeStorage: fakeSafe(), saveMs: 1e9 });
  const live: any = {
    chats: Object.assign(w.chats, {
      forgetDeleted: (id: string) => forgotten.push(id),
      get: (id: string) => ({ id, meta: w.chats.records.get(id)?.meta }),
    }),
    controller: { ...w.controller, stopChat: (id: string) => stopped.push(id) },
    chatDeletion:
      o.chatDeletion === undefined
        ? { isDeleted: (id: string) => deleted.includes(`done:${id}`), delete: async (id: string) => void deleted.push(id) }
        : o.chatDeletion,
  };
  const { chats, enabled } = registerMomoChannels(
    { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: () => undefined },
    {
      store: { channels },
      mainChat: w.svc,
      live,
      allowed: () => w.allowed,
      readState: () => ({ prefs: { momo: prefs } }),
      broadcastAll: (ch: string, payload?: unknown) => told.push([ch, payload]),
      history: () => index,
    },
  );
  const call = (ch: string, ...args: any[]) => handlers.get(ch)!(null, ...args);
  return { w, channels, chats, enabled, call, told, stopped, deleted, forgotten, prefs, index, live };
}

test('the flag is read at every call; with it off nothing is made and the list says so', async () => {
  const r = await rig();
  assert.equal(r.enabled(), true);
  r.prefs.channels = false;
  assert.equal(r.enabled(), false);
  assert.equal(((await r.call('momoChannels:list')) as any).enabled, false);
  assert.equal(((await r.call('momoChannels:create', 'Trip')) as any).reason, 'unavailable');
  r.prefs.channels = true;
  assert.equal(((await r.call('momoChannels:create', 'Trip')) as any).ok, true);
});

test('a channel’s chat is made through the main chat service, a change main makes is told to every window with the chat as it is', async () => {
  const r = await rig();
  const trip: any = (await r.call('momoChannels:create', 'Trip')).channel;
  const first: any = await r.call('momoChannels:chat', trip.id);
  assert.equal(first.ok, true);
  assert.equal(r.w.chats.records.get(first.chatId).meta.momo, `channel:${trip.id}`);
  // the brain's picks reach the chat on the next open, and the windows read its meta again
  r.w.prefs = { ...r.w.prefs, momo: { brain: { main: { harness: 'codex', effort: 'high' } } } };
  const again: any = await r.call('momoChannels:chat', trip.id);
  assert.equal(again.chatId, first.chatId);
  assert.ok(r.told.some(([ch, p]) => ch === 'chats:changed' && p.id === first.chatId && p.chat.meta.momo === `channel:${trip.id}`));
  assert.ok(r.told.some(([ch]) => ch === 'momoChannels:changed'));
});

test('archive stops the channel’s turn and keeps the chat; delete stops it and deletes the chat through the app’s deletion, and the store forgets it', async () => {
  const r = await rig();
  const a: any = (await r.call('momoChannels:create', 'A')).channel;
  const b: any = (await r.call('momoChannels:create', 'B')).channel;
  const ca = (await r.call('momoChannels:chat', a.id)).chatId;
  const cb = (await r.call('momoChannels:chat', b.id)).chatId;
  assert.equal(((await r.call('momoChannels:archive', a.id)) as any).ok, true);
  assert.deepEqual([r.stopped, r.deleted], [[ca], []]);
  // Undo: the channel is back on the rail with the same journal, and nothing was stopped or deleted for it
  const back: any = await r.call('momoChannels:restore', a.id);
  assert.deepEqual([back.ok, back.channel.id, (await r.call('momoChannels:chat', a.id)).chatId], [true, a.id, ca]);
  assert.equal(((await r.call('momoChannels:archive', a.id)) as any).ok, true);
  assert.equal(((await r.call('momoChannels:delete', b.id)) as any).ok, true);
  assert.deepEqual([r.stopped, r.deleted, r.forgotten], [[ca, ca, cb], [cb], [cb]]);
  // a chat the app's deletion already took is not deleted twice
  const c: any = (await r.call('momoChannels:create', 'C')).channel;
  const cc = (await r.call('momoChannels:chat', c.id)).chatId;
  r.deleted.push(`done:${cc}`);
  assert.equal(((await r.call('momoChannels:delete', c.id)) as any).ok, true);
  assert.deepEqual(
    r.deleted.filter((x: string) => x === cc),
    [],
  );
  assert.deepEqual(r.forgotten, [cb, cc]);
});

test('before the chats are open a delete says so and keeps the channel', async () => {
  const r = await rig({ chatDeletion: null });
  const a: any = (await r.call('momoChannels:create', 'A')).channel;
  await r.call('momoChannels:chat', a.id);
  const refused: any = await r.call('momoChannels:delete', a.id);
  assert.deepEqual([refused.ok, refused.reason], [false, 'failed']);
  assert.match(refused.error, /can't be deleted before the chats are open/);
  assert.equal(r.channels.get(a.id)?.name, 'A');
});

test('Everything reads Main’s and the open channels’ rows from the history index, and only those', async () => {
  const r = await rig();
  const main = (await r.w.svc.ensureMainChat()).chatId;
  const a: any = (await r.call('momoChannels:create', 'A')).channel;
  const ca = (await r.call('momoChannels:chat', a.id)).chatId;
  const chunk = (chatId: string, turnId: string, at: number) => ({
    chatId,
    turnId,
    at,
    harness: 'claude',
    kind: 'main',
    user: `u${turnId}`,
    assistant: `a${turnId}`,
  });
  r.index.add([chunk(main, 't1', 100), chunk(ca, 't2', 200), chunk('coding', 't3', 300)]);
  const all: any = await r.call('momoChannels:everything');
  assert.deepEqual(
    all.rows.map((x: any) => [x.name, x.turnId]),
    [
      ['A', 't2'],
      ['Main', 't1'],
    ],
  );
  assert.deepEqual(
    ((await r.call('momoChannels:everything', a.id)) as any).rows.map((x: any) => x.turnId),
    ['t2'],
  );
  assert.deepEqual(
    ((await r.call('momoChannels:everything', 'main')) as any).rows.map((x: any) => x.turnId),
    ['t1'],
  );
  r.w.allowed = false;
  assert.equal(((await r.call('momoChannels:everything')) as any).reason, 'not_allowed');
});

test('inside MoMo’s services the channels’ IPC is registered and Everything reads the index made after it', async () => {
  const { world: appWorld } = await import('./support/momoAppWorld.ts');
  const w = appWorld({ allowed: true, prefs: { momo: { channels: true } } });
  const list: any = await w.handlers.get('momoChannels:list')(null);
  assert.deepEqual([list.ok, list.enabled, list.channels], [true, true, []]);
  // with a main chat there is something to read: the index main made after the channels' IPC
  w.chats.patchMeta('mc', { momo: 'main' });
  const all: any = await w.handlers.get('momoChannels:everything')(null);
  assert.deepEqual([all.ok, all.rows, all.filters], [true, [], [{ id: 'main', name: 'Main' }]]);
  await w.m.close();
});
