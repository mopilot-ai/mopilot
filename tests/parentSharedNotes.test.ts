// Shared notes grants preserve the parent's own configuration, report native limitations and never dispatch a control to a replaced session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createParentNotesGrant } = require('../electron/session/orchestration/parentNotes.cjs');

function fixture(kind = 'claude') {
  const record = { meta: { config: { model: 'parent-model', additionalDirectories: ['/existing'] } } };
  const records = new Map<string, any>([['parent', record]]);
  const calls: any[] = [];
  const ref: any = { kind, key: 'original' };
  const live: any = {
    chats: {
      records,
      patchMeta: (id: string, patch: any) => (records.set(id, { ...records.get(id), meta: { ...records.get(id).meta, ...patch } }), true),
    },
    controller: { ref: () => ({ ...ref }) },
    claudeTurns: {
      api: {
        isLive: () => true,
        control: async (...a: any[]) => {
          calls.push(a);
        },
      },
    },
  };
  return { live, ref, calls, record, grant: createParentNotesGrant({ live }) };
}

test('a running Claude process receives the saved directory grant without losing other settings; repeated setup is idempotent', async () => {
  const f = fixture();
  const result = await f.grant('parent', '/notes');
  assert.equal(result.granted, true);
  assert.equal(result.previousRecord, f.record);
  assert.deepEqual(result.record.meta.config, { model: 'parent-model', additionalDirectories: ['/existing', '/notes'] });
  assert.deepEqual(f.calls, [['original', 'addDirectories', ['/existing', '/notes']]]);
  const again = await f.grant('parent', '/notes');
  assert.equal(again.previousRecord, again.record);
  assert.deepEqual(again.record.meta.config.additionalDirectories, ['/existing', '/notes']);
});

test('absent config and idle Claude processes retain the grant for their next process; unsupported native updates are reported', async () => {
  const f = fixture();
  f.live.chats.records.set('parent', { meta: {} });
  f.live.claudeTurns.api.isLive = () => false;
  assert.equal((await f.grant('parent', '/notes')).granted, true);
  assert.deepEqual(f.calls, []);
  f.live.claudeTurns.api.isLive = () => true;
  f.live.claudeTurns.api.control = async () => {
    throw new Error('unsupported');
  };
  assert.match((await f.grant('parent', '/notes')).degraded, /could not add/);
  for (const kind of ['codex', 'acp:kimi']) {
    const other = fixture(kind);
    assert.match(
      (await other.grant('parent', '/notes')).degraded,
      kind === 'codex' ? /current turn/ : /native approval.*current and future turns/,
    );
    assert.deepEqual(other.calls, []);
  }
  f.live.chats.patchMeta = () => false;
  assert.equal((await f.grant('parent', '/new')).granted, false);
  f.live.chats.records.clear();
  await assert.rejects(f.grant('parent', '/notes'), /no longer exists/);
});

test('a native switch before dispatch or while control waits cannot change or claim the replacement process', async () => {
  const f = fixture();
  let reads = 0;
  f.live.controller.ref = () => ({ ...f.ref, key: ++reads > 1 ? 'replacement' : 'original' });
  assert.match((await f.grant('parent', '/notes')).degraded, /current process was not changed/);
  assert.deepEqual(f.calls, []);
  f.live.controller.ref = () => ({ ...f.ref });
  f.live.claudeTurns.api.control = async (...a: any[]) => {
    f.calls.push(a);
    f.ref.key = 'replacement';
  };
  assert.match((await f.grant('parent', '/notes')).degraded, /new process uses/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][0], 'original');
});

test('directory choices written during a native grant are combined, while continuous changes have a bounded truthful exit', async () => {
  const f = fixture();
  let calls = 0;
  f.live.claudeTurns.api.control = async (...a: any[]) => {
    f.calls.push(a);
    if (++calls === 1) f.live.chats.patchMeta('parent', { config: { additionalDirectories: ['/notes', '/new-user-directory'] } });
  };
  assert.equal((await f.grant('parent', '/notes')).granted, true);
  assert.deepEqual(f.calls[1][2], ['/existing', '/notes', '/new-user-directory']);
  f.live.claudeTurns.api.control = async () => {
    f.live.chats.patchMeta('parent', { config: { additionalDirectories: [`/changing-${++calls}`] } });
  };
  assert.match((await f.grant('parent', '/notes')).degraded, /kept changing/);
  f.live.claudeTurns.api.control = async () => {
    f.live.chats.records.set('parent', { meta: {} });
  };
  assert.equal((await f.grant('parent', '/notes')).granted, true);
});
