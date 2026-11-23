// MoMo task watches (shared/momoTasks/watch.ts): validation, fingerprints, what changed, and the read-only rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertWatchToolReadOnly,
  compareReading,
  describeEntryChanges,
  describeWatch,
  nextWatchAt,
  parseWatch,
  readFiles,
  readItems,
  readWhole,
  stableStringify,
  WatchError,
} from '../shared/momoTasks/watch.ts';

const ok = (v: unknown) => (parseWatch(v) as { watch: any }).watch;
const bad = (v: unknown) => (parseWatch(v) as { error: string }).error;

test('a watch is checked: kind, interval, fields, HTTPS only', () => {
  assert.match(bad(null), /Say what/);
  assert.match(bad({ kind: 'command' }), /Watch files/);
  assert.match(bad({ kind: 'tool', tool: 'x', everyMinutes: 4 }), /from 5 to 1440/);
  assert.match(bad({ kind: 'tool', tool: 'x', everyMinutes: 5.5 }), /from 5 to 1440/);
  assert.match(bad({ kind: 'files', paths: ['a'], track: ['id'] }), /tool or an HTTPS/);
  assert.match(bad({ kind: 'tool', tool: 'x', track: [] }), /one to five/);
  assert.match(bad({ kind: 'tool', tool: 'x', track: 'id' }), /one to five/);
  assert.match(bad({ kind: 'tool', tool: 'x', track: [1] }), /one to five/);
  assert.match(bad({ kind: 'files' }), /one to twenty/);
  assert.match(bad({ kind: 'files', paths: [''] }), /one to twenty/);
  assert.match(bad({ kind: 'files', paths: [3] }), /one to twenty/);
  assert.match(bad({ kind: 'tool' }), /Pick a tool/);
  assert.match(bad({ kind: 'tool', tool: 'x'.repeat(201) }), /Pick a tool/);
  for (const url of ['http://a.com', 'https://u:p@a.com', 'https://a.com:8443', 'https://a.com/#x', 'nope', undefined])
    assert.match(bad({ kind: 'http', url }), /HTTPS URL/);
  assert.deepEqual(ok({ kind: 'files', paths: [' /tmp/a '] }), { kind: 'files', everyMinutes: 15, paths: ['/tmp/a'] });
  assert.deepEqual(ok({ kind: 'tool', tool: 'gmail.search', args: { q: 'invoice' }, track: ['id', 'subject'], everyMinutes: 60 }), {
    kind: 'tool',
    everyMinutes: 60,
    tool: 'gmail.search',
    args: { q: 'invoice' },
    track: ['id', 'subject'],
  });
  assert.equal(ok({ kind: 'tool', tool: 'x', args: [1] }).args, undefined);
  assert.equal(ok({ kind: 'http', url: ' https://a.com/status ' }).url, 'https://a.com/status');
});

test('the next check, and a description that never copies a URL', () => {
  assert.equal(nextWatchAt({ everyMinutes: 15 }, 1000), 1000 + 15 * 60_000);
  assert.equal(describeWatch(ok({ kind: 'files', paths: ['a', 'b'] })), 'a, b');
  assert.equal(describeWatch(ok({ kind: 'http', url: 'https://a.com/?token=secret' })), 'HTTPS page');
  assert.equal(describeWatch(ok({ kind: 'tool', tool: 'gmail.search' })), 'gmail.search');
  assert.equal(describeWatch({ kind: 'files', everyMinutes: 5 }), '');
  assert.equal(describeWatch({ kind: 'tool', everyMinutes: 5 }), '');
});

test('a tool that can change things is refused before it runs', () => {
  assertWatchToolReadOnly('t', true);
  assert.throws(
    () => assertWatchToolReadOnly('gmail.send', false),
    (e: unknown) => e instanceof WatchError && /cannot ask for approval/.test((e as Error).message),
  );
});

test('stable stringify sorts keys and handles every JSON shape', () => {
  assert.equal(stableStringify({ b: [1, { d: 1, c: null }], a: 'x' }), '{"a":"x","b":[1,{"c":null,"d":1}]}');
  assert.equal(stableStringify(undefined), 'null');
  assert.equal(readWhole({ a: 1, b: 2 }).fingerprint, readWhole({ b: 2, a: 1 }).fingerprint);
  assert.notEqual(readWhole({ a: 1 }).fingerprint, readWhole({ a: 2 }).fingerprint);
});

const state = (r: ReturnType<typeof readItems>, at = 0) => compareReading(null, r, at).state;

test('first reading is a baseline, the same reading is unchanged, a different one changed', () => {
  const a = readWhole([1]);
  const base = compareReading(null, a, Date.parse('2026-11-23T10:00:00Z'));
  assert.equal(base.changed, false);
  assert.equal(base.state.outcome, 'baseline');
  assert.equal(base.state.checkedAt, '2026-11-23T10:00:00.000Z');
  assert.equal(compareReading(base.state, a, 1).state.outcome, 'unchanged');
  const changed = compareReading(base.state, { ...readWhole([2]), detail: 'Something moved.' }, 2);
  assert.deepEqual([changed.changed, changed.state.outcome, changed.state.detail], [true, 'changed', 'Something moved.']);
  assert.equal(compareReading(base.state, readWhole([3]), 2).state.detail, null);
  // the first good reading after a failed one only records where things stand
  assert.equal(compareReading({ ...base.state, fingerprint: null }, a, 3).state.outcome, 'baseline');
  assert.equal(compareReading(base.state, { fingerprint: 'x', detail: 'y'.repeat(700) }, 2).state.detail?.length, 601);
});

const invoices = (rows: unknown[]) => ({ result: { invoices: rows } });

test('tracked items: identity is the first field, only the listed fields count, and the note names new, updated and gone items', () => {
  const before = readItems(
    invoices([
      { id: 'a', status: 'open', title: 'AWS invoice', fetched: 1 },
      { id: 'b', status: 'open', title: 'Rent', fetched: 1 },
    ]),
    ['id', 'status'],
  );
  const same = readItems(
    invoices([
      { id: 'b', status: 'open', title: 'Rent', fetched: 99 },
      { id: 'a', status: 'open', title: 'AWS invoice', fetched: 99 },
    ]),
    ['id', 'status'],
  );
  assert.equal(before.fingerprint, same.fingerprint);
  const after = readItems(
    invoices([
      { id: 'a', status: 'due', title: 'AWS invoice' },
      { id: 'c', status: 'open', name: 'Phone' },
      { id: 7, status: 'x' },
    ]),
    ['id', 'status'],
  );
  const note = describeEntryChanges(before.entries as Record<string, string>, after.entries as Record<string, string>);
  assert.equal(note, 'New: 7, Phone\nUpdated: AWS invoice\nGone: Rent');
  assert.equal(compareReading(state(before), after, 1).state.detail, note);
  // an object with no usable identity is not an item; an empty result has no items
  assert.deepEqual(readItems({ id: { x: 1 }, list: [null, 3, 'x'] }, ['id']).entries, {});
  // repeated ids keep every object's values
  const dup = readItems(
    [
      { id: 'a', s: 1, title: 'T' },
      { id: 'a', s: 2 },
    ],
    ['id', 's'],
  );
  assert.equal(JSON.parse((dup.entries as any).a.slice(5)).fields.length, 2);
  // a title the item does not have falls back to its identity, and the same ids with changed fields say "updated"
  assert.equal(
    describeEntryChanges({ a: 'item:{"fields":"[1]","title":null}' }, { a: 'item:{"fields":"[2]","title":null}' }),
    'Updated: a',
  );
  assert.equal(
    describeEntryChanges({ a: 'item:{"fields":"[1]","title":"A"}' }, { a: 'item:{"fields":"[1]","title":"B"}' }),
    'The watched items changed.',
  );
});

test('many items keep the fingerprint only, and the note says so', () => {
  const rows = Array.from({ length: 501 }, (_, i) => ({ id: i, s: 0 }));
  const big = readItems(rows, ['id', 's']);
  assert.equal(big.entries, undefined);
  assert.match(big.detail as string, /501 watched items/);
  assert.equal(
    compareReading({ checkedAt: '', outcome: 'baseline', fingerprint: 'old', detail: null, entries: {} }, big, 1).state.detail,
    big.detail,
  );
});

test('files compare by name, size and modified time; very large sets keep only the fingerprint', () => {
  const before = readFiles([
    { path: 'a.txt', size: 1, mtimeMs: 10 },
    { path: 'b.txt', size: 2, mtimeMs: 10 },
  ]);
  const after = readFiles([
    { path: 'a.txt', size: 5, mtimeMs: 11 },
    { path: 'c.txt', size: 2, mtimeMs: 10 },
  ]);
  assert.equal(compareReading(state(before), after, 1).state.detail, 'New: c.txt\nEdited: a.txt\nRemoved: b.txt');
  assert.equal(describeEntryChanges({ a: '1:1' }, { a: '1:1' }), 'The watched files changed.');
  const names = Array.from({ length: 12 }, (_, i) => `f${String(i).padStart(2, '0')}`);
  const long = describeEntryChanges({}, Object.fromEntries(names.map((n) => [n, '1:1'])));
  assert.match(long, /New: f00, f01, f02, f03, f04, f05, f06, f07 \(and 4 more\)/);
  const huge = readFiles(Array.from({ length: 2001 }, (_, i) => ({ path: `p${i}`, size: 1, mtimeMs: 1 })));
  assert.equal(huge.entries, undefined);
  assert.match(huge.detail as string, /2001 watched files/);
});

test('mixed signatures and an item with a missing tracked field still describe a change', () => {
  // a watch whose kind changed between readings: files before, tracked items after
  assert.equal(describeEntryChanges({ 'a.txt': '1:1' }, { b: 'item:{"fields":["x"],"title":"B"}' }), 'New: B\nGone: a.txt');
  const missing = readItems([{ id: 'a' }, { id: 'b', s: 1 }], ['id', 's']);
  assert.equal(JSON.parse((missing.entries as any).a.slice(5)).fields[0], '[null]');
});
