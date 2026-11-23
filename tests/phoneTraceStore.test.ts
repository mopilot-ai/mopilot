// The launch and chat-open timings live in a SQLite table of step names and milliseconds; only the last few of each kind stay.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const table = new Map<string, { kind: string; id: number; at: number; steps: string }>();
const statements: string[] = [];
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async () => ({
      execAsync: async (sql: string) => void statements.push(sql),
      getAllAsync: async () => [...table.values()],
      runAsync: async (sql: string, ...args: any[]) => {
        if (sql.startsWith('INSERT')) {
          const [kind, id, at, steps] = args;
          table.set(`${kind}:${id}`, { kind, id, at, steps });
        } else {
          const [kind, , limit] = args;
          const newest = [...table.values()]
            .filter((r) => r.kind === kind)
            .sort((a, b) => b.id - a.id)
            .slice(0, limit)
            .map((r) => r.id);
          for (const [key, row] of table) if (row.kind === kind && !newest.includes(row.id)) table.delete(key);
        }
      },
    }),
  },
});
// through a variable, so the desktop typecheck does not follow into React Native's global types
const storePath = '../mobile/src/platform/traceStore.ts';
const tracePath = '../mobile/src/launchTrace';
const { openTraceStore } = await import(storePath);
const { KEPT } = await import(tracePath);

test('a record is saved again as it grows, read back with its steps, and only the last few of its kind stay', async () => {
  const store = await openTraceStore();
  assert.match(statements[0], /CREATE TABLE IF NOT EXISTS trace/);
  assert.deepEqual(await store.load(), []);
  await store.save({ kind: 'launch', id: 1, at: 10, steps: [['vault', 5]] });
  await store.save({
    kind: 'launch',
    id: 1,
    at: 10,
    steps: [
      ['vault', 5],
      ['list-answer', 90],
    ],
  });
  assert.deepEqual(await store.load(), [
    {
      kind: 'launch',
      id: 1,
      at: 10,
      steps: [
        ['vault', 5],
        ['list-answer', 90],
      ],
    },
  ]);
  for (let id = 2; id <= KEPT.launch + 3; id++) await store.save({ kind: 'launch', id, at: id, steps: [] });
  await store.save({ kind: 'chat', id: 1, at: 1, steps: [['open', 0]] });
  const all = await store.load();
  assert.equal(all.filter((r: any) => r.kind === 'launch').length, KEPT.launch);
  assert.ok(!all.some((r: any) => r.kind === 'launch' && r.id === 1), 'the oldest launch went');
  assert.equal(all.filter((r: any) => r.kind === 'chat').length, 1, 'a chat open is not counted against launches');
});
