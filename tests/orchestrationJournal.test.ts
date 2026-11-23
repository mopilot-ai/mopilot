// electron/session/orchestration/journal.cjs: the record of which chat started which survives a restart, an
// unreadable one is kept on disk and turns linked sessions off (never an empty record), and a failed write changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  OrchestrationJournal,
  emptyParent,
  validJournal,
  DELIVERIES_KEPT,
  DRIVEN_KEPT,
} = require('../electron/session/orchestration/journal.cjs');

function tmp(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-journal-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'sub', 'orchestration.json');
}
const child = (over: any = {}) => ({ parentId: 'p', name: 'c', title: 'T', driven: [], lastReport: null, createdAt: 1, ...over });

test('a missing journal starts empty; a change is written privately and published, then read back after a restart', (t) => {
  const file = tmp(t);
  const published: any[] = [];
  const j = new OrchestrationJournal({ file, publish: (d: any) => published.push(d) });
  assert.equal(j.startupError, null);
  assert.equal(j.child('c'), null);
  assert.equal(j.parent('p'), null);
  const r = j.change((d: any) => {
    d.children.c = child();
    d.parents.p = emptyParent();
    return 'done';
  });
  assert.equal(r, 'done');
  assert.equal(published.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new OrchestrationJournal({ file });
  assert.deepEqual(again.child('c'), child());
  assert.deepEqual(again.parent('p'), { wakes: 0, held: false, cutShort: false, notes: [] });
  // a publish that throws is only presentation: the change stays
  const loud = new OrchestrationJournal({
    file,
    publish: () => {
      throw new Error('window gone');
    },
  });
  loud.change((d: any) => (d.children.c2 = child({ name: 'c2' })));
  assert.ok(new OrchestrationJournal({ file }).child('c2'));
});

test('an unreadable or wrong-shaped journal is kept as it is and turns the journal off', (t) => {
  const file = tmp(t);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const body of ['{not json', JSON.stringify({ schemaVersion: 2, children: {}, parents: {}, deliveries: {} })]) {
    fs.writeFileSync(file, body);
    const j = new OrchestrationJournal({ file });
    assert.equal(j.startupError, 'journal_unavailable');
    assert.throws(() => j.draft(), /journal_unavailable/);
    assert.throws(() => j.commit({}), /journal_unavailable/);
    assert.equal(fs.readFileSync(file, 'utf8'), body);
  }
});

test('validJournal checks every child, parent and delivery', () => {
  const base = () => ({ schemaVersion: 1, children: { c: child() }, parents: { p: emptyParent() }, deliveries: {} as any });
  assert.equal(validJournal(base()), true);
  assert.equal(validJournal(null), false);
  assert.equal(validJournal({ ...base(), children: [] }), false);
  assert.equal(validJournal({ ...base(), children: { c: child({ driven: [1] }) } }), false);
  assert.equal(validJournal({ ...base(), children: { c: child({ lastReport: 'x' }) } }), false);
  assert.equal(validJournal({ ...base(), children: { c: child({ parentId: '' }) } }), false);
  assert.equal(validJournal({ ...base(), children: { c: child({ createdAt: undefined }) } }), false);
  assert.equal(validJournal({ ...base(), parents: { p: { ...emptyParent(), wakes: 1.5 } } }), false);
  assert.equal(validJournal({ ...base(), parents: { p: { ...emptyParent(), notes: [{ childId: 'c', body: 'b' }] } } }), false);
  const withNote = base();
  withNote.parents.p.notes = [{ childId: 'c', body: 'b', wakes: true }] as any;
  assert.equal(validJournal(withNote), true);
  const delivered = base();
  delivered.deliveries.x = { kind: 'wake', chatId: 'p', at: 1, notes: [] };
  assert.equal(validJournal(delivered), true);
  delivered.deliveries.y = { kind: 'other', chatId: 'p', at: 1 };
  assert.equal(validJournal(delivered), false);
});

test('a failed write changes nothing; commits keep the newest deliveries and driven ids', (t) => {
  const file = tmp(t);
  let fail = false;
  const written: any[] = [];
  const j = new OrchestrationJournal({
    file,
    write: (d: any) => {
      if (fail) throw new Error('disk full');
      written.push(d);
    },
  });
  fail = true;
  assert.throws(() => j.change((d: any) => (d.children.c = child())), /disk full/);
  assert.equal(j.child('c'), null);
  fail = false;
  j.change((d: any) => {
    d.children.c = child({ driven: Array.from({ length: DRIVEN_KEPT + 3 }, (_, i) => `i${i}`) });
    for (let i = 0; i < DELIVERIES_KEPT + 2; i++) d.deliveries[`d${i}`] = { kind: 'message', chatId: 'c', from: 'p', body: '', at: i };
  });
  assert.equal(j.child('c').driven.length, DRIVEN_KEPT);
  assert.equal(j.child('c').driven[0], 'i3');
  assert.equal(Object.keys(j.data.deliveries).length, DELIVERIES_KEPT);
  assert.ok(!j.data.deliveries.d0 && !j.data.deliveries.d1 && j.data.deliveries.d2);
});

test('childrenOf lists a chat’s children oldest first', (t) => {
  const j = new OrchestrationJournal({ file: tmp(t), write: () => {} });
  j.change((d: any) => {
    d.children.b = child({ createdAt: 2 });
    d.children.a = child({ createdAt: 1 });
    d.children.x = child({ parentId: 'other' });
    d.children.n = child({ createdAt: 0 });
  });
  assert.deepEqual(j.childrenOf('p'), ['n', 'a', 'b']);
  assert.deepEqual(j.childrenOf('none'), []);
});
