// Transcript fixtures wait for every owned writer, preserve failed cleanup and isolate independent owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { transcriptFixture } from './support/transcript-fixture.ts';
import { gate } from './support/transcript-writer.ts';

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function folder(t: any) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

for (const reverse of [false, true]) {
  test(`cleanup stops producers and awaits every writer, reversed completion ${reverse}`, async (t) => {
    const dir = folder(t);
    const fixture = transcriptFixture(dir);
    const gates = [gate(), gate()];
    let stopped = false;
    const drains: number[] = [];
    fixture.stopWith(() => {
      stopped = true;
    });
    for (const [index, held] of gates.entries()) {
      const log = { drain: async () => (assert.equal(stopped, true), drains.push(index), held.p) };
      assert.equal(fixture.own(log), log);
    }
    const cleanup = fixture.cleanup();
    try {
      await turn();
      assert.deepEqual(drains, [0, 1]);
      assert.throws(() => fixture.own({ drain: async () => {} }), /begun cleanup/);
      assert.throws(() => fixture.stopWith(() => {}), /begun cleanup/);
      gates[reverse ? 1 : 0].open();
      await turn();
      assert.equal(fs.existsSync(dir), true, 'one completed writer cannot retire the directory');
    } finally {
      for (const held of gates) held.open();
      await cleanup;
    }
    assert.equal(fs.existsSync(dir), false);
  });
}

test('a rejected drain waits for other writers, preserves the directory and supports cleanup retry', async (t) => {
  const dir = folder(t);
  const fixture = transcriptFixture(dir);
  const held = gate();
  const failure = new Error('writer failed');
  let fail = true;
  fixture.own({
    drain: async () => {
      if (fail) throw failure;
    },
  });
  fixture.own({ drain: () => held.p });
  let settled = false;
  const cleanup = fixture.cleanup();
  void cleanup.then(
    () => (settled = true),
    () => (settled = true),
  );
  const rejected = assert.rejects(cleanup, (error: any) => error instanceof AggregateError && error.errors.includes(failure));
  await turn();
  assert.equal(settled, false);
  assert.equal(fs.existsSync(dir), true);
  held.open();
  await rejected;
  assert.equal(fs.existsSync(dir), true);
  fail = false;
  await fixture.cleanup();
  assert.equal(fs.existsSync(dir), false);
});

test('a failed producer stop still drains all writers and keeps the directory for retry', async (t) => {
  const dir = folder(t);
  const fixture = transcriptFixture(dir);
  const failure = new Error('producer did not stop');
  let fail = true;
  let drained = 0;
  fixture.stopWith(() => {
    if (fail) throw failure;
  });
  fixture.own({ drain: async () => void drained++ });
  await assert.rejects(fixture.cleanup(), (error: any) => error instanceof AggregateError && error.errors.includes(failure));
  assert.equal(drained, 1);
  assert.equal(fs.existsSync(dir), true);
  fail = false;
  await fixture.cleanup();
  assert.equal(drained, 2);
  assert.equal(fs.existsSync(dir), false);
});

test('overlapping cleanup shares work while independent fixture owners remain live', async (t) => {
  const aDir = folder(t);
  const bDir = folder(t);
  const a = transcriptFixture(aDir);
  const b = transcriptFixture(bDir);
  const held = gate();
  let aDrains = 0;
  let bDrains = 0;
  a.own({ drain: async () => (aDrains++, held.p) });
  b.own({ drain: async () => void bDrains++ });
  const first = a.cleanup();
  assert.equal(a.cleanup(), first);
  await turn();
  assert.equal(aDrains, 1);
  assert.equal(bDrains, 0);
  held.open();
  await first;
  assert.equal(fs.existsSync(aDir), false);
  assert.equal(fs.existsSync(bDir), true);
  await b.cleanup();
  assert.equal(bDrains, 1);
  assert.equal(fs.existsSync(bDir), false);
  await transcriptFixture(folder(t)).cleanup();
});

test('an asynchronous producer stop holds all writer drains and directory removal', async (t) => {
  const dir = folder(t);
  const fixture = transcriptFixture(dir);
  const stopped = gate();
  let drains = 0;
  fixture.stopWith(() => stopped.p);
  fixture.own({ drain: async () => void drains++ });
  const cleanup = fixture.cleanup();
  try {
    await turn();
    assert.equal(drains, 0, 'no writer drains before its producers stop');
    assert.equal(fs.existsSync(dir), true);
  } finally {
    stopped.open();
    await cleanup;
  }
  assert.equal(drains, 1);
  assert.equal(fs.existsSync(dir), false);
});

test('an async stop rejection waits for other stops and drains, then retains the directory', async (t) => {
  const dir = folder(t);
  const fixture = transcriptFixture(dir);
  const stopped = gate();
  const failure = new Error('child could not stop');
  let drains = 0;
  fixture.stopWith(async () => {
    throw failure;
  });
  fixture.stopWith(() => stopped.p);
  fixture.own({ drain: async () => void drains++ });
  const cleanup = fixture.cleanup();
  const rejected = assert.rejects(cleanup, (error: any) => error instanceof AggregateError && error.errors.includes(failure));
  await turn();
  assert.equal(drains, 0);
  stopped.open();
  await rejected;
  assert.equal(drains, 1);
  assert.equal(fs.existsSync(dir), true);
});
