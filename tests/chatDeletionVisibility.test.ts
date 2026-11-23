// Terminal visibility uses monotonic canonical identities across all state-write shapes and component-local sources.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DeletionVisibility } from '../src/store/deletionVisibility.ts';
const receipt = (id = 'root', nativeKeys = [id]) => ({ chatId: id, nativeKeys, nativeDeleted: true, metadata: 'retained' });
test('invalid receipts have no effect; duplicate valid receipts are monotonic and subscription cleanup works', () => {
  const v = new DeletionVisibility(),
    seen: number[] = [];
  const off = v.subscribe(() => seen.push(v.snapshot()));
  const empty = {};
  assert.equal(v.filter(empty), empty);
  for (const r of [
    null,
    {},
    { ...receipt(), nativeDeleted: false },
    { ...receipt(), metadata: 'deleted' },
    { ...receipt(), chatId: 1 },
    { ...receipt(), chatId: '' },
    { ...receipt(), nativeKeys: null },
    { ...receipt(), nativeKeys: ['other'] },
    { ...receipt(), nativeKeys: ['root', 1] },
    { ...receipt(), nativeKeys: ['root', ''] },
    { ...receipt(), retainedAliasKeys: null },
    { ...receipt(), retainedAliasKeys: [1] },
    { ...receipt(), retainedAliasKeys: [''] },
  ])
    assert.deepEqual(v.accept(r), []);
  assert.equal(v.snapshot(), 0);
  assert.deepEqual(v.accept(receipt('root', ['root', 'alias'])), ['root', 'alias']);
  assert.deepEqual(seen, [1]);
  assert.deepEqual(v.accept(receipt('root', ['root', 'alias'])), []);
  assert.equal(v.snapshot(), 1);
  off();
  v.accept(receipt('next'));
  assert.deepEqual(seen, [1]);
});
test('every canonical/alias visibility map and list is filtered without disturbing unrelated identities', () => {
  const v = new DeletionVisibility();
  v.accept(receipt('root', ['root', 'alias']));
  const patch: any = {};
  for (const key of [
    'threads',
    'pinned',
    'unread',
    'worktreeOf',
    'chatProject',
    'claudeArchived',
    'claudeChats',
    'chatNotes',
    'chatConfig',
    'chatInitialTitles',
    'navigationBookmarks',
    'segments',
  ])
    patch[key] = { root: key === 'segments' ? [] : true, alias: key === 'segments' ? [] : true, other: key === 'segments' ? [] : true };
  patch.threadOrder = ['root', 'other', 'alias'];
  patch.archived = [{ id: 'root' }, { id: 'other' }, { id: 'alias' }];
  const out: any = v.filter(patch);
  for (const key of Object.keys(patch).filter((k) => !['threadOrder', 'archived'].includes(k)))
    assert.deepEqual(Object.keys(out[key]), ['other']);
  assert.deepEqual(out.threadOrder, ['other']);
  assert.deepEqual(out.archived, [{ id: 'other' }]);
  assert.equal(patch.threadOrder.length, 3);
  const unaffected: any = { threads: { other: {} }, threadOrder: ['other'], archived: [{ id: 'other' }] };
  assert.equal(v.filter(unaffected), unaffected);
  assert.deepEqual(
    v.sources({
      local: [
        { id: 'root', updatedAt: 1 },
        { id: 'other', updatedAt: 1 },
      ],
      codex: [],
      claude: [{ id: 'alias', updatedAt: 1 }],
      sage: [],
    }),
    { local: [{ id: 'other', updatedAt: 1 }], codex: [], claude: [], sage: [] },
  );
});
test('stale segments cannot add terminal identities; only an authoritative receipt publishes an added alias', () => {
  const v = new DeletionVisibility();
  v.accept(receipt());
  let notified = 0;
  v.subscribe(() => notified++);
  const out: any = v.filter({
    segments: { root: [{ nativeId: 'alias' }] },
    threads: { alias: { id: 'alias' }, other: { id: 'other' } },
    threadOrder: ['alias', 'other'],
  } as any);
  assert.equal(v.has('alias'), false);
  assert.equal(notified, 0);
  assert.deepEqual(out.threadOrder, ['alias', 'other']);
  assert.deepEqual(out.segments, {});
  v.accept({ ...receipt(), retainedAliasKeys: ['alias'] });
  assert.equal(notified, 1);
  v.accept(receipt());
  v.accept({ ...receipt(), retainedAliasKeys: ['alias'] });
  assert.equal(notified, 1);
  assert.deepEqual(v.filter(out).threadOrder, ['other']);
});

test('preload deletion API forwards canonical identity and delivers receipts with unsubscribe', async () => {
  const { default: spec } = await import('../electron/bridge/chats.cjs');
  const { buildApi } = await import('../electron/bridge/spec.cjs');
  const calls: any[] = [];
  const listeners = new Map<string, (...args: any[]) => void>();
  const r = receipt();
  const api = buildApi(spec, {
    webUtils: {},
    ipcRenderer: {
      invoke: async (...args: any[]) => {
        calls.push(args);
        return args[0] === 'chats:deletions' ? [r] : r;
      },
      on: (name: string, cb: (...args: any[]) => void) => listeners.set(name, cb),
      removeListener: (name: string, cb: (...args: any[]) => void) => {
        assert.equal(listeners.get(name), cb);
        listeners.delete(name);
      },
    },
  });
  assert.deepEqual(await api.delete('root', 'discard'), r);
  assert.deepEqual(await api.deletions(), [r]);
  assert.deepEqual(calls, [['chats:delete', 'root'], ['chats:deletions']]);
  const v = new DeletionVisibility();
  const off = api.onDeleted((value: unknown) => v.accept(value));
  listeners.get('chats:deleted')!({}, r);
  assert.equal(v.has('root'), true);
  off();
  assert.equal(listeners.size, 0);
});
