// The hold through main's runtime and notices: only the receiving chat's window answers it, main expires it with no
// window open, and the receiving user is told once that a message waits for them (electron/app/peerNotices.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { PeerRuntime } = require('../electron/session/peerRuntime.cjs');
const { HOLD_MS } = require('../electron/session/peerHold.cjs');
const { createPeerNotices } = require('../electron/app/peerNotices.cjs');

function setup(t: any, modes: Record<string, string> = { A: 'default', B: 'full-access' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-hold-runtime-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = new Map([
    ['A', { segments: [{ kind: 'claude', nativeId: 'native-A' }], meta: {}, updatedAt: 1 }],
    ['B', { segments: [{ kind: 'codex', nativeId: 'native-B' }], meta: {}, updatedAt: 2 }],
  ]);
  const sent: any[] = [];
  const controller: any = {
    rt: () => ({ token: null }),
    state: { get: () => ({ turn: 'idle', queue: [] }) },
    send: (...args: any[]) => sent.push(args),
    peerCapabilities: () => ({ messaging: true, read: true, steer: false }),
    removeQueued: () => {},
  };
  const asked: string[] = [];
  const runtime = new PeerRuntime({
    file: path.join(dir, 'journal.json'),
    controller,
    chats: { records },
    registry: new Registry(),
    sourceWindow: (e: any) => e.source,
    gate: () => null,
    read: () => ({}),
    permission: (id: string) => (asked.push(id), modes[id]),
  });
  t.after(() => runtime.dispose());
  const handlers = new Map<string, any>();
  runtime.registerIpc({ handle: (name: string, handler: any) => handlers.set(name, handler) });
  return { runtime, handlers, sent, records, asked, modes };
}

test('only the receiving chat’s window allows or declines a held message', async (t) => {
  const { handlers, sent } = setup(t);
  const send = (requestId: string) =>
    handlers.get('peer:send')({ source: 'A' }, 'A', { targetChatId: 'B', requestId, body: `Deploy ${requestId}` });
  const first = await send('r1');
  assert.equal(first.delivery, 'held');
  // the sender's window speaks for A, which is not the receiver
  await assert.rejects(handlers.get('peer:approve')({ source: 'A' }, 'A', first.id), /cannot_approve/);
  // a window that does not show B cannot speak for it
  assert.throws(() => handlers.get('peer:approve')({ source: 'A' }, 'B', first.id), /invalid_source_window/);
  assert.equal((await handlers.get('peer:approve')({ source: 'B' }, 'B', first.id)).delivery, 'queued');
  assert.equal(sent.length, 1);
  const second = await send('r2');
  assert.equal((await handlers.get('peer:decline')({ source: 'B' }, 'B', second.id)).delivery, 'declined');
  assert.equal(sent.length, 1);
});

test('main expires a held message on its own timer, with no window open', async (t) => {
  const clock = useFakeClock(t, 0);
  const { runtime, asked, records } = setup(t);
  const m = await runtime.service.send('A', { targetChatId: 'B', requestId: 'r1', body: 'Deploy' });
  assert.equal(m.delivery, 'held');
  // a chat main no longer has reads as no mode
  records.delete('A');
  asked.length = 0;
  assert.equal(runtime.service.permission('A'), null);
  assert.deepEqual(asked, []);
  records.set('A', { segments: [{ kind: 'claude', nativeId: 'native-A' }], meta: {}, updatedAt: 1 } as any);
  clock.advance(HOLD_MS + 15000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runtime.service.get('A', m.id).delivery, 'expired');
  // a sweep's failure is noted, never thrown into the timer
  runtime.service.update = () => {
    throw new Error('disk full');
  };
  runtime.service.data.messages[0].delivery = 'held';
  await runtime.sweepHeld();
  // a disabled journal sweeps nothing
  runtime.service.startupError = 'journal_unavailable';
  await runtime.sweepHeld();
});

test('the receiving user is told once that a message waits, and once that one arrived; startup announces nothing', () => {
  const broadcasts: any[] = [];
  const notes: any[] = [];
  const unread: string[] = [];
  let inView = false;
  const records = new Map([['B', {}]]);
  const notices = createPeerNotices({
    broadcastAll: (channel: string, data?: any) => broadcasts.push([channel, data?.id]),
    chatInView: () => inView,
    chats: { records, patchMeta: (id: string) => unread.push(id), get: (id: string) => ({ id }) },
    notifier: () => ({ notify: (_kind: string, id: string, n: any) => notes.push([id, n.title, n.chatTitle]) }),
    chatName: (id: string) => (id === 'A' ? 'Planner' : ''),
  });
  const m = { id: 'm1', sourceChatId: 'A', targetChatId: 'B', body: 'Deploy', delivery: 'held' };
  const old = { ...m, id: 'old', delivery: 'delivered' };
  notices.publish({ messages: [m] });
  assert.deepEqual(notes, [], 'nothing before the journal is loaded');
  notices.start({ messages: [old, { ...m, id: 'oldheld' }, { ...m, id: 'queued', delivery: 'queued' }] });
  notices.publish({ messages: [old, m] });
  assert.deepEqual(notes, [['B', 'Message from Planner needs your approval', undefined]]);
  assert.deepEqual(unread, ['B']);
  notices.publish({ messages: [m] });
  assert.equal(notes.length, 1, 'once per hold');
  inView = true;
  notices.publish({ messages: [{ ...m, delivery: 'delivered', sourceChatId: 'C' }] });
  assert.deepEqual(notes.at(-1), ['B', 'Message from another chat', undefined]);
  assert.deepEqual(unread, ['B'], 'a chat in view is not marked unread');
  // a chat main no longer has is only notified
  inView = false;
  notices.publish({ messages: [{ ...m, id: 'gone', targetChatId: 'Z' }] });
  assert.deepEqual(unread, ['B']);
  assert.ok(broadcasts.filter(([c]) => c === 'peer:changed').length >= 4);
  // no notifier yet: nothing throws
  const quiet = createPeerNotices({
    broadcastAll: () => {},
    chatInView: () => true,
    chats: { records },
    notifier: () => null,
    chatName: () => 'X',
  });
  quiet.start({ messages: [] });
  quiet.publish({ messages: [m] });
});
