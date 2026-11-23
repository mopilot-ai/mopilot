// Real main chat-store archive generations reject archive/restore ABA even when every write uses the same clock tick.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { tmp } from './support/chat-store-profile.ts';
import { orchestration } from './support/orchestration-harness.ts';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { quietWorktree } = require('../electron/session/orchestration/archiveFacts.cjs');
const { archiveFamily } = require('../electron/session/orchestration/lifecycle.cjs');
const ok = (stdout = '') => ({ ok: true, stdout, stderr: '' });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('only successful archive transitions advance the owner generation, independently of time and other metadata', (t) => {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads, { legacyMirror: false, now: () => 1000 });
  assert.equal(store.archiveEpoch('child'), 0);
  store.ensure('child');
  store.patchMeta('child', { pinned: true });
  assert.equal(store.archiveEpoch('child'), 0);
  for (const expected of [2, 4, 6]) {
    store.patchMeta('child', { archived: 1000 });
    assert.equal(store.archiveEpoch('child'), expected - 1);
    assert.equal(store.patchMeta('child', { archived: 1000 }), false);
    assert.equal(store.archiveEpoch('child'), expected - 1);
    store.patchMeta('child', { archived: null });
    assert.equal(store.archiveEpoch('child'), expected);
    assert.equal(store.records.get('child').meta.activeAt, 1000, 'the timestamp alone cannot distinguish repeated restoration');
  }
  store.admitCommit = () => false;
  assert.equal(store.patchMeta('child', { archived: 1000 }), false);
  assert.equal(store.archiveEpoch('child'), 6);
});

test('failed persistence does not retire the committed owner, and a later retry still advances it', (t) => {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads, { legacyMirror: false, now: () => 1000 });
  store.ensure('child');
  const file = store.file('child');
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => store.patchMeta('child', { archived: 1000 }));
  assert.equal(store.archiveEpoch('child'), 0);
  assert.equal(store.records.get('child').meta.archived, null);
  fs.rmdirSync(file);
  store.patchMeta('child', { archived: 1000 });
  assert.equal(store.archiveEpoch('child'), 1);
  store.commit({ ...store.records.get('child'), meta: undefined });
  assert.equal(store.archiveEpoch('child'), 2, 'a supported record without meta clears its prior archive state');
});

test('a real archive epoch retires child facts after a same-tick cycle while the legacy timestamp control cannot', async (t) => {
  for (const strongOwner of [false, true]) {
    const { threads } = tmp(t);
    const store = new ChatsStore(threads, { legacyMirror: false, now: () => 1000 });
    store.ensure('child');
    store.patchMeta('child', { archived: 1000 });
    store.patchMeta('child', { archived: null });
    const pending = deferred<any>();
    const h = orchestration({
      run: {
        git: async (args: string[]) => ok(args[0] === 'status' ? '' : 'worker'),
        gh: async () => pending.promise,
      },
    });
    h.orch.o.chats = strongOwner ? store : { records: store.records, isDeleted: () => false };
    h.journal.change(
      (d: any) =>
        (d.children.child = {
          parentId: 'top',
          name: 'child',
          title: 'child',
          cwd: '/repo/worker',
          useWorktree: true,
          createdAt: 1,
          driven: [],
          lastReport: null,
        }),
    );
    const result = quietWorktree(h.orch, 'child');
    await tick();
    store.patchMeta('child', { archived: 1000 });
    store.patchMeta('child', { archived: null });
    pending.resolve(ok('[]'));
    assert.equal(await result, !strongOwner);
  }
});

test('a parent restored during a main-owned family read is not rearchived by that old request', async (t) => {
  const { threads } = tmp(t);
  const store = new ChatsStore(threads, { legacyMirror: false, now: () => 1000 });
  for (const id of ['top', 'child']) store.ensure(id);
  store.patchMeta('top', { archived: 1000 });
  store.patchMeta('top', { archived: null });
  const pending = deferred<any>();
  const h = orchestration({
    run: {
      git: async (args: string[]) => ok(args[0] === 'status' ? '' : 'worker'),
      gh: async () => pending.promise,
    },
  });
  h.orch.o.chats = store;
  h.journal.change(
    (d: any) =>
      (d.children.child = {
        parentId: 'top',
        name: 'child',
        title: 'child',
        cwd: '/repo/worker',
        useWorktree: true,
        createdAt: 1,
        driven: [],
        lastReport: null,
      }),
  );
  const result = archiveFamily(h.orch, 'top');
  await tick();
  store.patchMeta('top', { archived: 1000 });
  store.patchMeta('top', { archived: null });
  pending.resolve(ok('[]'));
  await assert.rejects(result, (error: any) => error.code === 'archive_cancelled');
  assert.equal(store.records.get('top').meta.archived, null);
  assert.equal(store.records.get('child').meta.archived, null);
});
