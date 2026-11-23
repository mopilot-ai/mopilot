// The actual E2E callback must run in Playwright's serialized context without CommonJS globals.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { phoneLiveSteer } from './e2e/fixtures/phoneLiveSteer';
import { displayRows, snapshot, update } from '../mobile/src/presentation/thread';

test('the real E2E callback runs without global require and preserves both phone snapshot orders', async () => {
  const execute = runInNewContext(`(${phoneLiveSteer.toString()})`, { process });
  // Playwright returns serialized values into the caller's realm.
  const result = structuredClone(await execute(undefined, fileURLToPath(new URL('..', import.meta.url))));
  const expected = ['A', 'T1', 'step one', 'T2', 'step two', 'B', 'T3', 'step three', 'C', 'T4'];
  for (const value of [result.live, result.caughtUp]) {
    const thread = snapshot({ ...value, rev: 1, session: { turn: 'running' } });
    assert.deepEqual(
      displayRows(thread).map((r) => r.text),
      expected,
    );
    const retired = update(thread, { ev: 'turn.state', feedSeq: thread.feedSeq + 1, turnId: 'next', status: 'inProgress' });
    assert.deepEqual(
      displayRows(retired).map((r) => r.text),
      expected,
    );
  }
  assert.equal(result.events.filter((event: any) => event.ev === 'turn.state' && event.started).length, 1);
});
