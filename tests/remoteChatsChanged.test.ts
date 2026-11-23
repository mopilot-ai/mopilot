// A phone's chat list is kept live by events, not polled: one `chats.changed` for a burst of changes on the Mac (a state, a new chat, a harness's list landing late), and the full list on the next read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig } from './support/remote-kit.ts';

const require = createRequire(import.meta.url);
const { createChatsChanged, QUIET_MS, MAX_MS } = require('../electron/remote/chatsChanged.cjs');
const { createPhoneSources, readAll } = require('../electron/app/phoneListSources.cjs');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phone = { kind: 'phone', pairId: 'p2', follows: new Set() };

function clock() {
  const queue = new Map<number, { at: number; fn: () => void }>();
  let id = 0;
  let now = 0;
  return {
    timers: {
      setTimeout: (fn: () => void, ms: number) => {
        queue.set(++id, { at: now + ms, fn });
        return { id, unref() {} } as any;
      },
      clearTimeout: (t: any) => void queue.delete(t.id),
    },
    advance(ms: number) {
      now += ms;
      for (const [k, v] of [...queue]) if (v.at <= now) queue.delete(k), v.fn();
    },
    now: () => now,
  };
}

test('a burst of changes is one event after it goes quiet, and a burst that never goes quiet still sends within the maximum', () => {
  const c = clock();
  let sent = 0;
  const list = createChatsChanged({ send: () => void sent++, timers: c.timers as any });
  list.changed(c.now());
  c.advance(QUIET_MS - 50);
  list.changed(c.now());
  c.advance(QUIET_MS - 50);
  assert.equal(sent, 0, 'each change starts the quiet wait over');
  c.advance(60);
  assert.equal(sent, 1);
  // a change that keeps coming: sent at the maximum since the first
  for (let i = 0; i < 20; i++) {
    list.changed(c.now());
    c.advance(100);
  }
  assert.ok(sent >= 2, `sent ${sent} times while changes kept coming`);
  assert.ok(MAX_MS >= QUIET_MS);
  list.changed(c.now() + MAX_MS * 5);
  c.advance(MAX_MS * 10);
});

test('every paired phone hears one chats.changed for a burst, and none for a device the policy does not allow the list', async () => {
  const r = rig();
  const p = r.phone('p1');
  const q = r.phone('p2');
  r.service.onChatsChanged();
  r.service.onChatsChanged();
  r.service.onSessionPatch({ chatId: 'c2', rev: 1, patch: { turn: 'running' } });
  await sleep(QUIET_MS + 150);
  assert.equal(p.events('chats.changed').length, 1);
  assert.equal(q.events('chats.changed').length, 1);
  const closed = rig({ policy: { allow: (pair: string) => pair !== 'p1' } });
  const refused = closed.phone('p1');
  const allowed = closed.phone('p2');
  closed.service.onChatsChanged();
  await sleep(QUIET_MS + 150);
  assert.equal(refused.events('chats.changed').length, 0, 'a device the Mac does not let list chats is not told of them');
  assert.equal(allowed.events('chats.changed').length, 1);
});

test('a harness that answers after the first list is told to the phone, which then reads the full list', async () => {
  const r = rig();
  let late: (v: any[]) => void = () => undefined;
  const sources = createPhoneSources(
    {
      claude: async () => [{ key: 'claude:1', title: 'Claude chat', at: 1 }],
      codex: () => new Promise<any[]>((resolve) => (late = resolve)),
    },
    { coldMs: 20, warmMs: 10, changed: () => r.service.onChatsChanged() },
  );
  // the Mac's list is its harnesses' lists as they stand
  r.ops.recent = async () => {
    const all = await readAll(sources, false);
    return Object.values(all)
      .filter((l: any) => Array.isArray(l))
      .flat()
      .map((c: any) => ({ id: c.key, title: c.title, harness: 'x', at: c.at, project: null, pinned: false }));
  };
  const p = r.phone('p1');
  const first = await r.service.call(phone as any, 'chats.recent', { limit: 50, offset: 0 });
  assert.deepEqual(
    first.chats.map((c: any) => c.id),
    ['claude:1'],
    'the first list answers without the slow harness',
  );
  await sleep(QUIET_MS + 100);
  const before = p.events('chats.changed').length;
  late([{ key: 'codex:1', title: 'Codex chat', at: 2 }]);
  await sleep(QUIET_MS + 150);
  assert.equal(p.events('chats.changed').length, before + 1, 'the late list reached the phone as an event');
  const second = await r.service.call(phone as any, 'chats.recent', { limit: 50, offset: 0 });
  assert.deepEqual(second.chats.map((c: any) => c.id).sort(), ['claude:1', 'codex:1'], 'and the next read has every chat');
});

test('a list that is read again and holds the same sessions is no news; a failing notification never fails a read', async () => {
  let t = 0;
  let n = 0;
  let told = 0;
  const sources = createPhoneSources(
    { claude: async () => (n++, [{ key: 'a', title: 'T', at: 1 }]) },
    {
      now: () => t,
      freshMs: 10,
      warmMs: 20,
      coldMs: 20,
      changed: () => {
        told++;
        if (told === 2) throw new Error('service not ready');
      },
    },
  );
  await sources.claude(false);
  assert.equal(told, 1, 'the first list is news');
  t = 100;
  await sources.claude(false);
  await sleep(5);
  assert.equal(told, 1, 'the same sessions again are not');
  const moved = createPhoneSources(
    { claude: async () => [{ key: 'a', title: `T${++n}`, at: 1 }] },
    {
      now: () => t,
      freshMs: 10,
      warmMs: 20,
      coldMs: 20,
      changed: () => {
        told++;
        if (told >= 2) throw new Error('service not ready');
      },
    },
  );
  await moved.claude(false);
  t = 200;
  assert.equal((await moved.claude(false)).length, 1, 'a renamed session is news, and a notification that throws does not fail the read');
  assert.ok(told >= 3);
});
