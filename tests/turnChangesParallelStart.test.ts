// A turn's start snapshot taken alongside turn/start (#1651): late finishes wait, early tool items void it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const { TurnChanges } = createRequire(import.meta.url)('../electron/session/turnChanges.cjs');

/** Captures that resolve only when the test says so, in the order they were asked for. */
function gatedCaptures() {
  const pending: { scope: string; resolve: (tree: string) => void }[] = [];
  const capture = (scope: string) => new Promise<string>((resolve) => pending.push({ scope, resolve }));
  const changes = new TurnChanges(
    capture,
    async (_cwd: string, before: string, after: string) => `${before}->${after}`,
    null,
    (cwd: string) => cwd,
  );
  return { changes, pending };
}

test('a turn that ends before its start snapshot is taken waits for it and still gets its diff', async () => {
  const { changes, pending } = gatedCaptures();
  const begun = changes.begin('t', '/work');
  // text items never void the snapshot, even before it is taken
  for (const type of ['userMessage', 'agentMessage', 'reasoning', 'plan']) changes.itemStarted('t', { type });
  const finished = changes.finish('t', 'turn-1');
  await tick();
  assert.equal(pending.length, 1);
  pending[0].resolve('before');
  await begun;
  await tick();
  assert.equal(pending.length, 2);
  pending[1].resolve('after');
  assert.equal(await finished, 'before->after');
  assert.deepEqual(changes.restore('t', [{ id: 'turn-1' }]), [{ id: 'turn-1', diff: 'before->after' }]);
});

test('a tool item that starts before the start snapshot is taken leaves the turn to native attribution', async () => {
  const { changes, pending } = gatedCaptures();
  changes.begin('t', '/work');
  changes.itemStarted('t', { type: 'fileChange' });
  changes.itemStarted('other', { type: 'commandExecution' });
  pending[0].resolve('before');
  await tick();
  assert.equal(await changes.finish('t', 'turn-1'), undefined);
  assert.equal(pending.length, 1);

  // after the snapshot is taken, the same items are the turn's own writes
  const later = gatedCaptures();
  const begun = later.changes.begin('t', '/work');
  later.pending[0].resolve('before');
  await begun;
  later.changes.itemStarted('t', { type: 'fileChange' });
  later.changes.itemStarted('t', undefined);
  const finished = later.changes.finish('t', 'turn-2');
  await tick();
  later.pending[1].resolve('after');
  assert.equal(await finished, 'before->after');
});

test('a finish waiting on its start snapshot yields to an abort or a newer turn on the thread', async () => {
  for (const interrupt of ['abort', 'begin'] as const) {
    const { changes, pending } = gatedCaptures();
    changes.begin('t', '/work');
    const finished = changes.finish('t', 'turn-1');
    if (interrupt === 'abort') changes.abort('t');
    else changes.begin('t', '/work');
    pending[0].resolve('before');
    assert.equal(await finished, undefined);
  }
});
