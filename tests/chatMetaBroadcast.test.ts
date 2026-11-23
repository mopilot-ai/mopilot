// electron/app/chatMetaBroadcast.cjs: every window hears a chat whose config, notes or login changed, whoever changed it,
// once per turn of changes; a change to anything else, or one windows already heard, sends nothing (#2520).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tmp } from './support/chat-store-profile.ts';

const require = createRequire(import.meta.url);
const { createChatMetaBroadcast } = require('../electron/app/chatMetaBroadcast.cjs');
const { ChatsStore, registerChats } = require('../electron/platform/chats.cjs');

function world() {
  const sent: [string, unknown][] = [];
  const failures: [string, string][] = [];
  let throwFor: string | null = null;
  const queued: (() => void)[] = [];
  const chats = new Map<string, any>();
  const b = createChatMetaBroadcast({
    broadcast: (id: string, chat: unknown) => {
      if (id === throwFor) throw new Error('Object has been destroyed');
      sent.push([id, chat]);
    },
    get: (id: string) => chats.get(id) ?? null,
    failed: (what: string, error: unknown) => failures.push([what, String(error)]),
    defer: (fn: () => void) => queued.push(fn),
  });
  const flush = () => queued.splice(0).forEach((fn) => fn());
  const change = (id: string, meta: any) => (chats.set(id, { id, meta }), b.changed(id, { id, meta }));
  return { b, sent, flush, change, chats, failures, failOn: (id: string | null) => (throwFor = id) };
}

test('a config, notes or login change goes to every window once, with the chat as it is when sent', () => {
  const w = world();
  w.b.seed('c', { config: { model: 'opus' } });
  // what windows loaded: nothing to send
  w.change('c', { config: { model: 'opus' } });
  w.flush();
  assert.deepEqual(w.sent, []);
  // main keeps a turn's effort, then a note: one send, with both
  w.change('c', { config: { model: 'opus', effort: 'low' } });
  w.change('c', { config: { model: 'opus', effort: 'low' }, notes: [{ id: 'n' }] });
  w.change('d', { account: { id: 'work', pinned: false } });
  assert.deepEqual(w.sent, []);
  w.flush();
  assert.deepEqual(
    w.sent.map(([id, chat]: any) => [id, chat.meta]),
    [
      ['c', { config: { model: 'opus', effort: 'low' }, notes: [{ id: 'n' }] }],
      ['d', { account: { id: 'work', pinned: false } }],
    ],
  );
});

test('a change to anything else, or a chat that is gone, sends nothing', () => {
  const w = world();
  w.b.seed('c', { config: { model: 'opus' } });
  w.change('c', { config: { model: 'opus' }, pinned: true, unread: true });
  w.b.changed('c', null);
  w.flush();
  assert.deepEqual(w.sent, []);
  // gone, then back: heard again
  w.change('c', { config: { model: 'opus' } });
  w.flush();
  assert.equal(w.sent.length, 1);
});

test('with the chat store: the window that sent a change hears the config main merged it into', (t) => {
  const { threads, ui } = tmp(t);
  const sent: [string, any][] = [];
  const queued: (() => void)[] = [];
  let store: any;
  const heard = createChatMetaBroadcast({
    broadcast: (id: string, chat: unknown) => sent.push([id, chat]),
    get: (id: string) => store.get(id),
    failed: () => {},
    defer: (fn: () => void) => queued.push(fn),
  });
  store = new ChatsStore(threads, { uiState: ui, onChange: (id: string, v: unknown) => heard.changed(id, v) });
  const h = new Map<string, any>();
  registerChats({ handle: (ch: string, f: any) => h.set(ch, f) }, { store, uiState: ui, broadcast: () => {} });
  // main keeps a turn's effort; the window, on its older copy, sets the permission
  store.patchMeta('c', { config: { model: 'opus', effort: 'low' } });
  h.get('chats:patchMeta')({ sender: 'w1' }, 'c', { configKeys: { set: { permission: 'plan' }, unset: [] } });
  queued.splice(0).forEach((fn) => fn());
  assert.deepEqual(sent.at(-1)?.[1].meta.config, { model: 'opus', effort: 'low', permission: 'plan' });
});

test('a send that fails is reported and costs only its own chat: later changes still go', () => {
  const w = world();
  w.failOn('c');
  w.change('c', { config: { effort: 'low' } });
  w.change('d', { config: { effort: 'high' } });
  w.flush();
  assert.deepEqual(
    w.sent.map(([id]) => id),
    ['d'],
  );
  assert.deepEqual(w.failures, [["tell the windows about a chat's changed settings", 'Error: Object has been destroyed']]);
  w.failOn(null);
  w.change('c', { config: { effort: 'max' } });
  w.flush();
  assert.deepEqual(
    w.sent.map(([id]) => id),
    ['d', 'c'],
  );
});
