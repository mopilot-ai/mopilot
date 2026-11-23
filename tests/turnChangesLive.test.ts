// A thread's next turn after its last one (it waits for that turn's final snapshot) and a running turn's diff so far (peek).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const { TurnChanges } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

/** Captures that resolve only when the test says so, in the order they were asked for. */
function gatedCaptures(compare = async (_cwd: string, before: string, after: string) => `${before}->${after}`) {
  const pending: { scope: string; resolve: (tree: string) => void; reject: (e: Error) => void }[] = [];
  const capture = (scope: string) => new Promise<string>((resolve, reject) => pending.push({ scope, resolve, reject }));
  let scope = (cwd: string) => cwd;
  const changes = new TurnChanges(capture, compare, null, (cwd: string) => scope(cwd));
  return {
    changes,
    pending,
    moveScope: (fn: (cwd: string) => string) => {
      scope = fn;
    },
  };
}

test("a thread's next turn waits for its last turn's final snapshot and both keep their diffs", async () => {
  const { changes, pending } = gatedCaptures();
  const first = changes.begin('thread', '/work');
  pending.shift()!.resolve('t0');
  await first;
  const finishing = changes.finish('thread', 'one');
  // the next queued message starts before the last turn's final snapshot is taken
  const second = changes.begin('thread', '/work');
  await tick();
  assert.equal(pending.length, 1, 'only the final snapshot is being taken');
  pending.shift()!.resolve('t1');
  assert.equal(await finishing, 't0->t1');
  await tick();
  pending.shift()!.resolve('t1');
  await second;
  const next = changes.finish('thread', 'two');
  pending.shift()!.resolve('t2');
  assert.equal(await next, 't1->t2');
  assert.equal(changes.saved('thread', 'one'), 't0->t1');
  assert.equal(changes.saved('thread', 'two'), 't1->t2');
  assert.equal(changes.saved('thread', 'three'), undefined);
  assert.equal(changes.saved('other', 'one'), undefined);
});

test("a tool call of the next turn during the last turn's final snapshot voids that snapshot, not the next turn's", async () => {
  const { changes, pending } = gatedCaptures();
  const first = changes.begin('thread', '/work');
  pending.shift()!.resolve('t0');
  await first;
  const finishing = changes.finish('thread', 'one');
  const second = changes.begin('thread', '/work');
  // a text-only item writes nothing
  changes.itemStarted('thread', { type: 'agentMessage' });
  changes.itemStarted('thread', { type: 'commandExecution' });
  pending.shift()!.resolve('t1');
  assert.equal(await finishing, undefined);
  await tick();
  pending.shift()!.resolve('t1');
  await second;
  // the next turn's own start snapshot raced the call too
  const next = changes.finish('thread', 'two');
  assert.equal(await next, undefined);
});

test("another thread's turn in the same folder still overlaps a thread waiting on its own last turn", async () => {
  const { changes, pending } = gatedCaptures();
  const first = changes.begin('a', '/work');
  pending.shift()!.resolve('t0');
  await first;
  const finishing = changes.finish('a', 'one');
  const next = changes.begin('a', '/work');
  const other = changes.begin('b', '/work');
  await tick();
  // b's start snapshot and a's final one run together; a's next turn waits
  for (const p of pending.splice(0)) p.resolve('t1');
  assert.equal(await finishing, undefined);
  await tick();
  for (const p of pending.splice(0)) p.resolve('t1');
  await Promise.all([next, other]);
  const ends = [changes.finish('a'), changes.finish('b')];
  for (const p of pending.splice(0)) p.resolve('t2');
  assert.deepEqual(await Promise.all(ends), [undefined, undefined]);
});

test("peek reads a running turn's diff so far and nothing it can't attribute", async () => {
  const { changes, pending, moveScope } = gatedCaptures();
  assert.equal(await changes.peek('none'), undefined);
  const start = changes.begin('thread', '/work');
  const early = changes.peek('thread');
  pending.shift()!.resolve('t0');
  await start;
  await tick();
  pending.shift()!.resolve('t1');
  assert.equal(await early, 't0->t1', 'a peek waits for the start snapshot');
  // the turn ends while a peek captures: it says nothing
  const late = changes.peek('thread');
  await tick();
  const finishing = changes.finish('thread', 'one');
  pending.shift()!.resolve('t2');
  assert.equal(await late, undefined);
  pending.shift()!.resolve('t3');
  assert.equal(await finishing, 't0->t3');
  // the folder moved: nothing
  const moved = changes.begin('moved', '/work');
  pending.shift()!.resolve('m0');
  await moved;
  moveScope(() => '/elsewhere');
  assert.equal(await changes.peek('moved'), undefined);
  moveScope((cwd) => cwd);
  changes.abort('moved');
  // a start snapshot that failed or raced a tool call: nothing
  const failed = changes.begin('failed', '/fail');
  pending.shift()!.reject(new Error('capture'));
  await failed;
  assert.equal(await changes.peek('failed'), undefined);
  const raced = changes.begin('raced', '/raced');
  changes.itemStarted('raced', { type: 'fileChange' });
  pending.shift()!.resolve('r0');
  await raced;
  assert.equal(await changes.peek('raced'), undefined);
});

test('peek gives nothing when its capture or comparison fails, or the turn ends while it compares', async () => {
  let compares = 0;
  let endCompare!: (diff: string) => void;
  const { changes, pending } = gatedCaptures(async (_cwd, before, after) => {
    compares++;
    if (compares === 1) throw new Error('compare');
    if (compares === 2) return new Promise<string>((r) => (endCompare = r));
    return `${before}->${after}`;
  });
  const start = changes.begin('thread', '/work');
  pending.shift()!.resolve('t0');
  await start;
  const failedCompare = changes.peek('thread');
  await tick();
  pending.shift()!.resolve('t1');
  assert.equal(await failedCompare, undefined);
  const failedCapture = changes.peek('thread');
  await tick();
  pending.shift()!.reject(new Error('capture'));
  assert.equal(await failedCapture, undefined);
  const comparing = changes.peek('thread');
  await tick();
  pending.shift()!.resolve('t2');
  await tick();
  // the turn ends during the comparison
  const finishing = changes.finish('thread');
  endCompare('t0->t2');
  assert.equal(await comparing, undefined);
  pending.shift()!.resolve('t3');
  assert.equal(await finishing, 't0->t3');
});

test('a next turn retired while it waited on the last turn reserves nothing against its replacement', async () => {
  const { changes, pending } = gatedCaptures();
  const first = changes.begin('thread', '/work');
  pending.shift()!.resolve('t0');
  await first;
  const finishing = changes.finish('thread', 'one');
  const retired = changes.begin('thread', '/work');
  changes.abort('thread');
  const replacement = changes.begin('thread', '/work');
  pending.shift()!.resolve('t1');
  assert.equal(await finishing, undefined, 'the abort took the last turn back');
  await tick();
  assert.equal(pending.length, 1, 'only the replacement takes its start snapshot');
  pending.shift()!.resolve('t1');
  await Promise.all([retired, replacement]);
  const end = changes.finish('thread', 'two');
  pending.shift()!.resolve('t2');
  assert.equal(await end, 't1->t2');
});
