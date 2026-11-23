// list_sidebar's listing in pages (electron/capabilities/tools/chatList.cjs): a start offset, the archive alone, and the cap a paging caller raises.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listChats } = require('../electron/capabilities/tools/chatList.cjs');

const H = 3600_000;
const rec = (archived: number | null = null) => ({ segments: [{ kind: 'codex' }], meta: { archived, projectId: null, worktreeOf: null } });
/** Four chats, newest first: c1..c4; c2 and c4 are archived in MoPilot. */
function world() {
  const records = new Map<string, any>([
    ['c1', rec()],
    ['c2', rec(5)],
    ['c3', rec()],
    ['c4', rec(5)],
  ]);
  const natives: [string, string[]][] = [
    ['c1', ['c1']],
    ['c2', ['c2']],
    ['c3', ['c3']],
    ['c4', ['c4']],
  ];
  const codex = [4, 3, 2, 1].map((n) => ({ key: `c${5 - n}`, title: `Chat ${5 - n}`, cwd: '/x', at: n * H }));
  return { projects: [], records, natives, sessions: { codex } as Record<string, any[]> };
}

test('paging: a start offset, the archive alone, and a cap only a caller that pages can raise', () => {
  const ids = (o: any, args: any) => listChats(o, args).chats.map((c: any) => c.id);
  assert.deepEqual(ids(world(), {}), ['c1', 'c3']);
  assert.deepEqual(ids(world(), { limit: 1, offset: 1 }), ['c3']);
  assert.equal(listChats(world(), { limit: 1 }).more, 1);
  const last = listChats(world(), { limit: 1, offset: 1 });
  assert.equal(last.more, undefined, 'the last page has no rest');
  assert.deepEqual(ids(world(), { offset: 2 }), []);
  for (const offset of [-3, 1.5, undefined]) assert.equal(listChats(world(), { offset }).chats.length, 2, `offset ${String(offset)}`);
  // the archive is its own list: its pages count archived chats only
  assert.deepEqual(ids(world(), { include_archived: true, only_archived: true }), ['c2', 'c4']);
  assert.deepEqual(ids(world(), { include_archived: true, only_archived: true, limit: 1, offset: 1 }), ['c4']);
  assert.equal(listChats(world(), { include_archived: true, only_archived: true, limit: 1 }).more, 1);
  // the model-facing tool keeps its bound; a caller that pages asks for one more row than a page
  const many = world();
  many.sessions.codex = Array.from({ length: 230 }, (_, i) => ({ key: `n${i}`, title: `Chat ${i}`, cwd: '/tmp/n', at: 1000 - i }));
  many.records.clear();
  many.natives.length = 0;
  assert.equal(listChats(many, { limit: 500 }).chats.length, 200);
  assert.equal(listChats({ ...many, maxLimit: 201 }, { limit: 500 }).chats.length, 201);
});

test('chats with the same time keep one order from call to call, so a page boundary never repeats or skips one', () => {
  const tied = (order: string[]) => {
    const w = world();
    w.sessions.codex = order.map((key) => ({ key, title: key, cwd: '/x', at: 5 * H }));
    return w;
  };
  const ids = (w: any, args: any) => listChats(w, args).chats.map((c: any) => c.id);
  const forward = ['c1', 'c3'];
  assert.deepEqual(ids(tied(forward), {}), ids(tied([...forward].reverse()), {}));
  const [a, b] = ids(tied(forward), {});
  assert.deepEqual(ids(tied(forward), { limit: 1 }), [a]);
  assert.deepEqual(ids(tied([...forward].reverse()), { limit: 1, offset: 1 }), [b]);
});
