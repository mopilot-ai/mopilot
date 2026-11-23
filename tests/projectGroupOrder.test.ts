// Project-group ranking equivalence, bounded aggregate work, and fresh snapshot ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectRecency, sortProjectGroups } from '../src/lib/projectGroupOrder.ts';

type Group = Parameters<typeof sortProjectGroups>[0][number];
const group = (id: string | null, values: number[], name = id ?? 'folder', path = '/folder'): Group => ({
  id,
  name,
  path,
  threads: values.map((updatedAt) => ({ updatedAt })),
});

test('submitted chats promote their original project immediately without becoming native chats', () => {
  const recent = group('recent', [50]);
  const starting = { ...group('starting', [10]), starting: [{ updatedAt: 100 }] };
  assert.equal(projectRecency(starting), 100);
  assert.deepEqual(
    sortProjectGroups([recent, starting], [], [], 'updated').map((g) => g.id),
    ['starting', 'recent'],
  );
  assert.equal(starting.threads.length, 1);
});

// A simple reference comparator for supported snapshots, including stable NaN ties and append-only discovery.
function reference(groups: Group[], order: string[], pinned: string[], sort: string) {
  const rank = new Map(order.map((key, i) => [key, i]));
  const last = (g: Group) => Math.max(0, ...g.threads.map((t) => Math.max(t.updatedAt, t.recencyAt ?? 0)));
  return groups.sort((a, b) => {
    const pin = Number(pinned.includes(b.id ?? b.path)) - Number(pinned.includes(a.id ?? a.path));
    if (pin) return pin;
    if (sort === 'updated') return last(b) - last(a);
    if (sort === 'name') return a.name.localeCompare(b.name);
    return (rank.get(a.id ?? a.path) ?? order.length) - (rank.get(b.id ?? b.path) ?? order.length);
  });
}

test('recency preserves empty, negative, zero, nullish, NaN, infinity and manual chat order semantics', () => {
  for (const values of [[], [-5, -1], [-0, 0], [NaN, 2], [Infinity, 2], [-Infinity], [Number.MAX_SAFE_INTEGER, 1]]) {
    assert.equal(projectRecency(group('a', values)), Math.max(0, ...values));
  }
  const g = group('a', []);
  g.threads = [
    { updatedAt: 4, recencyAt: 0 },
    { updatedAt: 4, recencyAt: undefined },
    { updatedAt: 5, recencyAt: 10 },
  ];
  assert.equal(projectRecency(g), 10);
  // a chat's later timestamp is its activity: an earlier one seen here doesn't hide the harness's newer write
  g.threads = [{ updatedAt: 100, recencyAt: 10 }];
  assert.equal(projectRecency(g), 100);
  assert.equal(projectRecency({ threads: [{ updatedAt: 9, recencyAt: null }] }), 9);
  assert.equal(
    projectRecency(
      group(
        'large',
        Array.from({ length: 150000 }, (_, i) => i),
      ),
    ),
    149999,
  );
});

test('ranking matches the reference policy across modes, aliases, repeated manual keys and numeric edge cases', () => {
  let seed = 41;
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  const values = [-10, -0, 0, 1, 4, 4, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER];
  for (let sample = 0; sample < 100; sample++) {
    const groups = Array.from({ length: sample % 29 }, (_, i) => {
      const g = group(i % 4 ? `id:${i % 13}:"\\` : null, [], ['z', 'A', 'é', 'A'][random() % 4], `/path:${i % 9}`);
      g.threads = Array.from({ length: random() % 13 }, () => ({
        updatedAt: values[random() % values.length],
        ...(random() % 2 ? { recencyAt: values[random() % values.length] } : {}),
      }));
      Object.freeze(g.threads);
      return Object.freeze(g);
    });
    const keys = groups.map((g) => g.id ?? g.path);
    const order = [...keys.filter((_, i) => i % 2).reverse(), ...keys.slice(0, 3)];
    const pins = keys.filter((_, i) => i % 3 === 0);
    for (const mode of ['updated', 'name', 'custom']) {
      const input = [...groups];
      const actual = sortProjectGroups(input, order, pins, mode);
      assert.equal(actual, input, 'sorts the supplied group array');
      const expected = reference([...groups], order, pins, mode);
      actual.forEach((g, i) => assert.equal(g, expected[i], `sample ${sample}, ${mode}, index ${i}`));
    }
  }
});

test('each group activity is scanned once per updated sort, with no timestamp reads for other orders', () => {
  let reads = 0;
  const groups = Array.from({ length: 80 }, (_, i) => ({
    ...group(`p${i}`, []),
    threads: Array.from({ length: 50 }, () => ({
      get updatedAt() {
        reads++;
        return (i * 37) % 80;
      },
    })),
  }));
  sortProjectGroups([...groups], [], [], 'updated');
  assert.equal(reads, 4000);
  reads = 0;
  reference([...groups], [], [], 'updated');
  assert.ok(reads > 4000 * 4, `baseline scanned ${reads} timestamps`);
  reads = 0;
  sortProjectGroups([...groups], [], [], 'name');
  sortProjectGroups([...groups], ['p1', 'p2'], ['p7'], 'custom');
  assert.equal(reads, 0);
});

test('fresh calls do not reuse recency or pin/rank state, including reused ids and group objects', () => {
  const a = group('same', [1], 'A');
  const b = group('same', [2], 'B');
  assert.deepEqual(sortProjectGroups([a, b], [], [], 'updated'), [b, a]);
  a.threads = [{ updatedAt: 3 }];
  assert.deepEqual(sortProjectGroups([a, b], [], [], 'updated'), [a, b]);
  const fresh = { ...a, threads: [{ updatedAt: 0 }] };
  assert.deepEqual(sortProjectGroups([fresh, b], [], [], 'updated'), [b, fresh]);
  const c = group(null, [0], 'C', 'path:quoted"');
  assert.deepEqual(sortProjectGroups([a, c], [], [c.path], 'updated'), [c, a]);
  assert.deepEqual(sortProjectGroups([a, c], [], [], 'updated'), [a, c]);
  assert.deepEqual(sortProjectGroups([a, c], ['same', c.path, 'same'], [], 'custom'), [c, a]);
  assert.deepEqual(sortProjectGroups([a, c], [c.path, 'same'], [], 'custom'), [c, a]);
});
