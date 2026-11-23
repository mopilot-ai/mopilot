// Terminal deletion receipts cannot block final private-notes retirement; restorable and late live holders keep their ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deferred, tick } from './support/async-scenarios.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { ChatsStore } = require('../electron/platform/chats.cjs');
const { ChatDeletion } = require('../electron/session/chatDeletion.cjs');
const { createSharedNotes, cleanupSharedNotes } = require('../electron/session/orchestration/childSetup.cjs');
const { OrchestrationJournal } = require('../electron/session/orchestration/journal.cjs');

async function fixture(t: any) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deleted-notes-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const chats = new ChatsStore(path.join(dir, 'threads'), { legacyMirror: false });
  const notes = createSharedNotes(dir);
  const { path: directory } = await notes.prepare('root');
  const other = (await notes.prepare('other')).path;
  const nativeCalls: any[] = [];
  const deletion = new ChatDeletion({
    store: chats,
    remove: { codex: async (target: any) => nativeCalls.push(target), claude: async (target: any) => nativeCalls.push(target) },
    broadcast: () => undefined,
  });
  const journal = new OrchestrationJournal({ file: path.join(dir, 'orchestration.json') });
  const orch: any = {
    o: { chats, notesDirectory: notes.directory, cleanupNotes: notes.cleanup },
    journal,
    starting: new Map(),
    archived: (id: string) => chats.records.get(id)?.meta.archived != null,
  };
  const add = (id: string, directories = [directory], archived: number | null = null) => {
    assert.equal(chats.ensure(id), true);
    assert.equal(chats.patchMeta(id, { config: { permission: 'read-only', additionalDirectories: directories }, archived }), true);
  };
  const child = (id: string) =>
    journal.change((data: any) => {
      data.children[id] = {
        parentId: 'root',
        notesRoot: 'root',
        driven: [],
        settings: { additionalDirectories: [directory, '/separate-grant'] },
      };
    });
  return { dir, chats, notes, directory, other, deletion, nativeCalls, journal, orch, add, child };
}

test('the final deleted canonical chat and its retained aliases retire notes without rewriting terminal metadata', async (t) => {
  const f = await fixture(t);
  f.add('root', [f.directory, '/human-grant']);
  f.chats.setSegments('root', [
    { harness: 'codex', nativeId: 'root' },
    { harness: 'claude', nativeId: 'switched' },
  ]);
  const before = f.chats.records.get('root');
  await f.deletion.delete('root');
  assert.equal(f.chats.isDeleted('root'), true);
  assert.equal(f.chats.isDeleted('claude:switched'), true);
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), true);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  assert.equal(f.chats.records.get('root'), before, 'a cleanup never rewrites terminal history');
  assert.equal(f.chats.patchMeta('root', { archived: null }), false);
  assert.equal(f.chats.ensure('claude:switched'), false, 'a deleted native alias cannot become a live holder');
  await fs.stat(f.other);
  assert.equal(f.nativeCalls.length, 2);
});

test('deleting the last child retires root notes, revoking only restorable archived grants and preserving unrelated families', async (t) => {
  const f = await fixture(t);
  f.add('root', [f.directory]);
  f.add('child', [f.directory]);
  f.child('child');
  f.add('archived-sibling', [f.directory, '/user-directory'], 1000);
  f.child('archived-sibling');
  f.add('other', [f.other]);
  await f.deletion.delete('root');
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), false, 'a still-live child owns the root directory');
  await fs.stat(f.directory);
  await f.deletion.delete('child');
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), true);
  await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
  assert.deepEqual(f.chats.records.get('archived-sibling').meta.config, {
    permission: 'read-only',
    additionalDirectories: ['/user-directory'],
  });
  assert.deepEqual(f.journal.child('archived-sibling').settings.additionalDirectories, ['/separate-grant']);
  assert.equal(f.chats.patchMeta('archived-sibling', { archived: null }), true);
  assert.deepEqual(f.chats.records.get('archived-sibling').meta.config.additionalDirectories, ['/user-directory']);
  assert.deepEqual(f.chats.records.get('other').meta.config.additionalDirectories, [f.other]);
  await fs.stat(f.other);
});

test('a live inherited holder or pending child admitted while cleanup waits still prevents removal after permanent deletion', async (t) => {
  for (const holder of ['record', 'pending'])
    await t.test(holder, async (t) => {
      const f = await fixture(t);
      f.add('root');
      await f.deletion.delete('root');
      const gate = deferred<void>();
      const entered = deferred<void>();
      f.orch.o.cleanupNotes = async (id: string, current: () => boolean) => {
        entered.resolve();
        await gate.promise;
        return f.notes.cleanup(id, current);
      };
      const cleanup = cleanupSharedNotes(f.orch, 'root');
      await entered.promise;
      f.add('late-holder');
      if (holder === 'pending') {
        f.chats.patchMeta('late-holder', { archived: 1000 });
        f.child('late-holder');
        f.orch.starting.set('late-holder', 1);
      }
      gate.resolve();
      assert.equal(await cleanup, false);
      await fs.stat(f.directory);
      f.orch.starting.clear();
      await f.deletion.delete('late-holder');
      assert.equal(await cleanupSharedNotes(f.orch, 'root'), true);
      await assert.rejects(fs.stat(f.directory), { code: 'ENOENT' });
    });
});

test('a failed native deletion or restorable archived metadata write retains notes until a successful retry', async (t) => {
  const f = await fixture(t);
  f.add('root');
  f.deletion.remove.codex = async () => {
    throw new Error('native delete refused');
  };
  await assert.rejects(f.deletion.delete('root'), /native delete refused/);
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), false);
  f.deletion.remove.codex = async () => undefined;
  await f.deletion.delete('root');
  f.add('archived', [f.directory, '/other'], 1000);
  const patch = f.chats.patchMeta.bind(f.chats);
  f.chats.patchMeta = () => false;
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), false);
  await fs.stat(f.directory);
  f.chats.patchMeta = patch;
  assert.equal(await cleanupSharedNotes(f.orch, 'root'), true);
  assert.deepEqual(f.chats.records.get('archived').meta.config.additionalDirectories, ['/other']);
  await tick();
});
