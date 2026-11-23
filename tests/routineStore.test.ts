// Action memory's store (#3571, G4; electron/capabilities/routines/routineStore.cjs): routines saved sealed, found by id
// or name, changed only at the revision a writer saw (a lost race writes nothing), run counts that are no change of what
// a routine does, and every refusal: bad fields, a taken name, the limits, no keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const { RoutineStore, MAX_ROUTINES, MAX_STEPS } = createRequire(import.meta.url)('../electron/capabilities/routines/routineStore.cjs');

/** A sealed file in memory: what was written, and whether the keychain is there. */
const memory = (initial: Buffer | null = null) => {
  const m = { bytes: initial, available: true, writes: 0 };
  return {
    m,
    sealed: {
      read: () => m.bytes,
      write: (b: Buffer) => {
        m.bytes = b;
        m.writes++;
      },
      available: () => m.available,
    },
  };
};
const make = (o: any = {}) => {
  let n = 0;
  let t = 1000;
  const mem = memory(o.initial);
  const store = new RoutineStore({ sealed: mem.sealed, newId: () => `id${++n}`, now: () => (t += 10) });
  return { store, mem };
};
const STEP = { tool: 'browser_navigate', args: { url: 'https://a.test/' } };
const draft = (name: string, extra: any = {}) => ({ kind: 'browser', name, steps: [STEP], params: [], ...extra });

test('save, get by id or name in any case, list newest change first; the file holds them sealed', () => {
  const { store, mem } = make();
  const a = store.save(draft(' Order beans ', { description: 'Reorders coffee.' }));
  assert.deepEqual(a, {
    id: 'id1',
    kind: 'browser',
    name: 'Order beans',
    description: 'Reorders coffee.',
    steps: [STEP],
    params: [],
    prompts: [],
    rev: 1,
    createdAt: 1010,
    updatedAt: 1010,
    runs: 0,
    handoffs: 0,
  });
  const b = store.save({ kind: 'desktop', name: 'Second', steps: [STEP] });
  assert.deepEqual(b.params, [], 'parameters default to none');
  assert.equal(store.get('id1'), a);
  assert.equal(store.get('ORDER BEANS'), a);
  assert.equal(store.get('nope'), null);
  assert.equal(store.get(undefined), null);
  assert.deepEqual(
    store.list().map((r: any) => r.id),
    ['id2', 'id1'],
  );
  assert.deepEqual(JSON.parse(mem.m.bytes!.toString()).routines.length, 2);
  // a second store reads what the first wrote, dropping records that aren't routines
  const raw = JSON.parse(mem.m.bytes!.toString());
  raw.routines.push({ id: 'bad', kind: 'other' }, null);
  const again = new RoutineStore({ sealed: memory(Buffer.from(JSON.stringify(raw))).sealed });
  assert.deepEqual(
    again.list().map((r: any) => r.id),
    ['id2', 'id1'],
  );
  assert.deepEqual(new RoutineStore({ sealed: memory(Buffer.from('{}')).sealed }).list(), []);
  assert.deepEqual(new RoutineStore({ sealed: memory(null).sealed }).list(), []);
});

test('save refuses bad fields, a taken name and the limits, writing nothing', () => {
  const { store, mem } = make();
  store.save(draft('Taken'));
  const writes = mem.m.writes;
  const refuses = (r: any, code: string) =>
    assert.throws(
      () => store.save(r),
      (e: any) => e.code === code,
    );
  refuses(draft(''), 'bad_args');
  refuses(draft('x'.repeat(81)), 'bad_args');
  refuses(draft('ok', { description: 'y'.repeat(501) }), 'bad_args');
  refuses(draft('ok', { kind: 'phone' }), 'bad_args');
  refuses(draft('ok', { steps: [] }), 'bad_args');
  refuses(draft('ok', { steps: 'x' }), 'bad_args');
  refuses(draft('ok', { steps: Array(MAX_STEPS + 1).fill(STEP) }), 'bad_args');
  refuses(draft('TAKEN'), 'exists');
  assert.equal(mem.m.writes, writes);
  for (let i = 1; i < MAX_ROUTINES; i++) store.save(draft(`r${i}`));
  refuses(draft('one more'), 'limit');
});

test('without the keychain nothing is written and the save says why', () => {
  const { store, mem } = make();
  mem.m.available = false;
  assert.throws(
    () => store.save(draft('a')),
    (e: any) => e.code === 'unavailable' && /keychain/.test(e.message),
  );
  assert.equal(mem.m.bytes, null);
  assert.deepEqual(store.list(), []);
});

test('update: only at the revision the writer saw; a change bumps rev, a run count does not', () => {
  const { store } = make();
  const r = store.save(draft('Mine'));
  store.save(draft('Other'));
  const ran = store.update(r.id, 1, { ran: true, handedOff: true });
  assert.equal(ran.rev, 1);
  assert.equal(ran.runs, 1);
  assert.equal(ran.handoffs, 1);
  assert.equal(ran.updatedAt, r.updatedAt);
  const changed = store.update(r.id, 1, { steps: [STEP, STEP], params: [{ name: 'q', example: 'x' }] });
  assert.equal(changed.rev, 2);
  assert.equal(changed.steps.length, 2);
  // an older replay's update loses: nothing is written
  assert.equal(store.update(r.id, 1, { steps: [STEP] }), null);
  assert.equal(store.get(r.id).steps.length, 2);
  assert.equal(store.update('gone', 1, { ran: true }), null);
  // an edit of the name and description
  const named = store.update(r.id, 2, { name: 'Renamed', description: 'Does it.' });
  assert.equal(named.name, 'Renamed');
  assert.equal(store.update(r.id, 3, { description: '' }).description, '');
  assert.throws(
    () => store.update(r.id, 4, { name: 'other' }),
    (e: any) => e.code === 'exists',
  );
  assert.throws(
    () => store.update(r.id, 4, { steps: [] }),
    (e: any) => e.code === 'bad_args',
  );
  assert.equal(store.update(r.id, 4, { name: 'Renamed' }).rev, 5, 'its own name is not taken');
});

test('remove, and onChange after each write until stopped; two saves before any read both survive', () => {
  const { store } = make();
  const seen: number[] = [];
  const off = store.onChange((all: any[]) => seen.push(all.length));
  const a = store.save(draft('A'));
  const b = store.save(draft('B'));
  assert.deepEqual(
    store.list().map((r: any) => r.name),
    ['B', 'A'],
  );
  assert.equal(store.remove(a.id), true);
  assert.equal(store.remove(a.id), false);
  off();
  store.remove(b.id);
  assert.deepEqual(seen, [1, 2, 1]);
});

test('a real sealed file: what one store writes, the next reads (the platform SealedFile)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routines-'));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().slice(4),
  };
  try {
    const o = { file: path.join(dir, 'routines.sealed'), keyFile: path.join(dir, 'routines.key'), safeStorage };
    new RoutineStore(o).save(draft('Kept'));
    assert.equal(new RoutineStore(o).get('kept').name, 'Kept');
    assert.ok(!fs.readFileSync(o.file).includes('Kept'), 'sealed at rest');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a name that is not text is refused', () => {
  const { store } = make();
  assert.throws(
    () => store.save(draft(5 as any)),
    (e: any) => e.code === 'bad_args',
  );
});
