// Linked-session configuration never escalates cost or permissions, and notes remain scoped to one private family directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  boundedSettings,
  createChildOptions,
  createSharedNotes,
  cleanupSharedNotes,
} = require('../electron/session/orchestration/childSetup.cjs');

test('model and effort inherit, can decrease, and ignore unknown or higher costs', () => {
  const own = { model: 'claude-opus-4', effort: 'high', permission: 'default' };
  assert.deepEqual(boundedSettings(own, {}), { ...own, ignored: [] });
  assert.deepEqual(boundedSettings(own, { model: 'sonnet', effort: 'low', permission: 'plan' }), {
    model: 'sonnet',
    effort: 'low',
    permission: 'plan',
    ignored: [],
  });
  assert.equal(boundedSettings(own, { model: own.model, effort: 'high', permission: 'default' }).ignored.length, 0);
  for (const picked of [{ model: 'mythos' }, { model: 'unknown' }, { effort: 'max' }, { effort: 'unknown' }])
    assert.equal(boundedSettings(own, picked).ignored.length, 1);
  const missing = boundedSettings({}, { model: 'sonnet', effort: 'low' });
  assert.deepEqual([missing.model, missing.effort, missing.permission, missing.ignored.length], [null, null, 'default', 2]);
  assert.deepEqual(boundedSettings({}, {}), { model: null, effort: null, permission: 'default', ignored: [] });
  assert.throws(() => boundedSettings(own, { permission: 'full-access' }), /higher permissions/);
  assert.throws(() => boundedSettings(own, { permission: 'unknown' }), /higher permissions/);
  assert.throws(() => boundedSettings({ permission: 'unknown' }, { permission: 'default' }), /higher permissions/);
  assert.deepEqual(boundedSettings(own, { model: 'mythos', effort: 'max', userSelected: true }), {
    model: 'mythos',
    effort: 'max',
    permission: 'default',
    ignored: [],
  });
  assert.equal(boundedSettings(own, { effort: 'unknown', userSelected: true }).ignored.length, 1);
  assert.deepEqual(boundedSettings(own, { model: 'gpt-user-picked', effort: 'high', userSelected: true }, false), {
    model: 'gpt-user-picked',
    effort: 'high',
    permission: 'default',
    ignored: [],
  });
  const cross = boundedSettings(own, { model: 'sonnet', effort: 'low' }, false);
  assert.deepEqual([cross.model, cross.effort, cross.permission, cross.ignored.length], [null, null, 'default', 2]);
});

test('adapter settings belong to the parent chat and ACP reports native model defaults truthfully', async () => {
  const live: any = {
    controller: {
      ref: (id: string) => ({ kind: id }),
      state: { get: () => ({ acp: { modes: { currentModeId: 'default' }, anchors: { default: 'ask' } } }) },
    },
    claudeTurns: {
      settings: (id: string, opts: unknown) => (
        assert.deepEqual([id, opts], ['claude', {}]),
        {
          model: 'opus',
          effort: 'max',
          permission: 'read-only',
        }
      ),
    },
    chats: { records: new Map([['codex', { meta: { config: { model: 'gpt-own', effort: 'medium' } } }]]) },
  };
  const setup = createChildOptions({ live, prefs: () => ({ model: 'global', effort: 'high', permission: 'default' }) });
  assert.deepEqual(await setup('claude', 'claude', { model: 'haiku', effort: 'medium' }), {
    model: 'haiku',
    effort: 'medium',
    permission: 'read-only',
    ignored: [],
  });
  assert.deepEqual(await setup('codex', 'codex', {}), { model: 'gpt-own', effort: 'medium', permission: 'default', ignored: [] });
  live.chats.records.clear();
  assert.equal((await setup('codex', 'codex', {})).model, 'global');
  live.chats.records.set('codex', {});
  assert.equal((await setup('codex', 'codex', {})).model, 'global');
  assert.equal((await setup('claude', 'codex', {})).model, null);
  assert.equal((await setup('claude', 'acp:kimi', { model: 'haiku' })).ignored.length, 3);
  assert.equal((await setup('acp:kimi', 'acp:kimi', {})).ignored.length, 1);
  assert.equal((await setup('acp:kimi', 'acp:kimi', { effort: 'high' })).ignored.length, 3);
  const defaults = createChildOptions({ live, prefs: () => null });
  assert.equal((await defaults('codex', 'codex', {})).permission, 'default');
  live.controller.state = { get: () => ({ permission: 'read-only', plan: false }) };
  assert.equal((await setup('codex', 'codex', {})).permission, 'read-only');
  live.controller.state.get = () => ({ permission: 'bypassPermissions', plan: false });
  assert.equal((await setup('codex', 'codex', {})).permission, 'full-access');
  live.controller.state.get = () => ({ permission: null, plan: false });
  assert.equal((await setup('codex', 'codex', {})).permission, 'default');
  live.controller.state.get = () => ({ permission: 'full-access', plan: true });
  assert.equal((await setup('codex', 'codex', {})).permission, 'plan');
  live.claudeTurns.settings = () => ({ model: 'opus', effort: 'high', permission: 'default', account: 'parent-account' });
  assert.equal((await setup('claude', 'claude', {})).account, 'parent-account');
  assert.equal((await setup('claude', 'codex', {})).account, undefined);
  live.claudeTurns.settings = () => ({ model: 'opus', effort: 'high', permission: 'default', additionalDirectories: ['/parent-extra'] });
  assert.deepEqual((await setup('claude', 'claude', {})).additionalDirectories, ['/parent-extra']);
  assert.deepEqual(
    (await setup('claude', 'codex', {})).additionalDirectories,
    ['/parent-extra'],
    'a mixed pair keeps the same authorized filesystem scope',
  );
  live.chats.records.set('acp:kimi', { meta: { config: { additionalDirectories: ['/basic-extra'] } } });
  live.controller.state.get = () => ({ acp: { modes: { currentModeId: 'default' }, anchors: { default: 'ask' } } });
  assert.deepEqual((await setup('acp:kimi', 'acp:kimi', {})).additionalDirectories, ['/basic-extra']);
});

test('notes create idempotently per encoded family, clean only that family and propagate storage errors', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'linked-notes-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const notes = createSharedNotes(root);
  const [one, repeated, other] = await Promise.all([notes.prepare('../first'), notes.prepare('../first'), notes.prepare('other')]);
  assert.deepEqual(one, repeated);
  assert.deepEqual(one.additionalDirectories, [one.path]);
  assert.equal(path.dirname(one.path), path.join(root, 'side-session-notes'));
  assert.notEqual(one.path, other.path);
  await fs.writeFile(path.join(one.path, 'finding.md'), 'handover');
  await notes.cleanup('../first');
  await assert.rejects(fs.stat(one.path), { code: 'ENOENT' });
  assert.ok((await fs.stat(other.path)).isDirectory());
  await notes.cleanup('../first');
  await assert.rejects(notes.prepare(''), /family identity/);
  await assert.rejects(notes.cleanup(null), /family identity/);
  const broken = createSharedNotes(root, {
    mkdir: async () => {
      throw new Error('no disk');
    },
  });
  await assert.rejects(broken.prepare('family'), /no disk/);
  await assert.rejects(broken.prepare('family'), /no disk/, 'a failed action does not poison a later queued one');
});

test('notes retirement is serialized and rechecks detached/live references immediately before removal', async () => {
  const rows: any[] = [];
  let unblock!: () => void;
  const notes = createSharedNotes('/private/app', {
    mkdir: async () => {
      rows.push('mkdir');
      await new Promise<void>((r) => {
        unblock = r;
      });
    },
    rm: async () => {
      rows.push('rm');
    },
  });
  const records = new Map([
    ['parent', {}],
    ['child', {}],
  ]);
  const archived = new Set<string>();
  const orch: any = {
    o: { chats: { records }, cleanupNotes: (...args: any[]) => notes.cleanup(...args) },
    journal: { data: { children: { child: { notesRoot: 'parent', detached: true } } } },
    archived: (id: string) => archived.has(id),
  };
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false);
  archived.add('parent');
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'a detached live child still owns the notes');
  archived.add('child');
  orch.starting = new Map([['parent', 1]]);
  assert.equal(
    await cleanupSharedNotes(orch, 'parent'),
    false,
    'an in-flight start reserves the root notes before its child is registered',
  );
  orch.starting = new Map([['child', 1]]);
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'a descendant start retains the root notes too');
  orch.starting.clear();
  const prepared = notes.prepare('parent');
  await new Promise((r) => setImmediate(r));
  const removed = cleanupSharedNotes(orch, 'parent');
  archived.delete('child');
  unblock();
  await prepared;
  assert.equal(await removed, false, 'a reference restored while cleanup waited prevents removal');
  assert.deepEqual(rows, ['mkdir']);
  records.clear();
  assert.equal(await cleanupSharedNotes(orch, 'parent'), true);
  assert.deepEqual(rows, ['mkdir', 'rm']);
  orch.journal.data.children.other = { notesRoot: 'another-family' };
  orch.o.cleanupNotes = async () => {
    throw new Error('cleanup unavailable');
  };
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'cleanup cannot reverse an already completed archive');
  assert.equal(await cleanupSharedNotes(orch, ''), false);
  delete orch.o.cleanupNotes;
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false);
});

test('deleted records retained for lifecycle bookkeeping no longer hold the shared notes reference', async () => {
  const deleted = new Set(['parent', 'child']);
  const orch: any = {
    o: {
      chats: {
        records: new Map([
          ['parent', {}],
          ['child', {}],
        ]),
        isDeleted: (id: string) => deleted.has(id),
      },
      cleanupNotes: async (_id: string, when: () => boolean) => when(),
    },
    journal: { data: { children: { child: { notesRoot: 'parent' } } } },
    archived: () => false,
  };
  assert.equal(await cleanupSharedNotes(orch, 'parent'), true);
  deleted.delete('child');
  orch.deleted = new Set(['child']);
  assert.equal(await cleanupSharedNotes(orch, 'parent'), true);
  orch.deleted.clear();
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false);
});

test('notes inherited by a detached grandchild retain the old directory and retirement removes only that saved grant', async () => {
  const directory = '/app/side-session-notes/root';
  const records = new Map<string, any>([
    ['parent', { meta: { config: { permission: 'default', additionalDirectories: [directory, '/user-dir'] } } }],
    ['grandchild', { meta: { config: { additionalDirectories: [directory] } } }],
    ['irrelevant', {}],
  ]);
  const retired = new Set(['parent']);
  let writable = true;
  const children: any = {
    grandchild: { notesRoot: 'other-root', settings: { additionalDirectories: [directory, '/user-dir'] } },
    unrelated: {},
  };
  const orch: any = {
    o: {
      notesDirectory: () => directory,
      cleanupNotes: async (_id: string, when: () => boolean) => when(),
      chats: {
        records,
        patchMeta: (id: string, meta: any) => {
          if (!writable) return false;
          records.get(id).meta = meta;
          return true;
        },
      },
    },
    journal: { data: { children }, change: (fn: any) => fn({ children }) },
    archived: (id: string) => retired.has(id),
  };
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'grandchild inherited the old notes despite a new family root');
  delete children.grandchild;
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'the live saved configuration also retains the directory');
  children.grandchild = { settings: { additionalDirectories: [directory, '/user-dir'] } };
  retired.add('grandchild');
  writable = false;
  assert.equal(await cleanupSharedNotes(orch, 'parent'), false, 'failed metadata persistence retains the notes for a later retry');
  writable = true;
  assert.equal(await cleanupSharedNotes(orch, 'parent'), true);
  assert.deepEqual(records.get('parent').meta.config, { permission: 'default', additionalDirectories: ['/user-dir'] });
  assert.deepEqual(records.get('grandchild').meta.config.additionalDirectories, []);
  assert.deepEqual(children.grandchild.settings.additionalDirectories, ['/user-dir']);
  assert.equal(await cleanupSharedNotes(orch, 'parent'), true, 'restored sessions no longer carry a grant to the retired directory');
});

test('initial plan settings retain the underlying permission for both native and copied plan modes', async () => {
  const live: any = {
    controller: { ref: () => ({ kind: 'codex' }), state: { get: () => ({ plan: true }) } },
    chats: { records: new Map() },
  };
  const setup = createChildOptions({ live, prefs: () => ({ permission: 'read-only' }) });
  assert.equal((await setup('p', 'codex', {})).planBasePermission, 'read-only');
  live.chats.records.set('p', { meta: { config: { permission: 'plan', planBasePermission: 'default' } } });
  assert.equal((await setup('p', 'codex', {})).planBasePermission, 'default');
});

test('a copied plan without a stored base uses the safe default and native adapter bases remain authoritative', async () => {
  const live: any = {
    controller: { ref: () => ({ kind: 'claude' }) },
    chats: { records: new Map() },
    claudeTurns: { settings: () => ({ permission: 'plan' }) },
  };
  const setup = createChildOptions({ live, prefs: () => ({ permission: 'full-access' }) });
  assert.equal((await setup('p', 'claude', {})).planBasePermission, 'default');
  live.claudeTurns.settings = () => ({ permission: 'plan', basePermission: 'read-only' });
  assert.equal((await setup('p', 'claude', {})).planBasePermission, 'read-only');
});
