// Reproduce #4201 in the real main process with fake Claude events, then apply the phone's real presentation path.
import path from 'node:path';
import { test, expect } from './fixtures/app';
import { phoneLiveSteer } from './fixtures/phoneLiveSteer';
import { displayRows, snapshot, update } from '../../mobile/src/presentation/thread';

test.use({ harnesses: 'claude' });

test('a phone following a Claude turn keeps replies, tools and two steers in order across history catch-up', async ({ harness }) => {
  const result = await harness.app.evaluate(phoneLiveSteer, path.resolve(__dirname, '../..'));
  const expected = ['A', 'T1', 'step one', 'T2', 'step two', 'B', 'T3', 'step three', 'C', 'T4'];
  for (const value of [result.live, result.caughtUp]) {
    const thread = snapshot({ ...value, rev: 1, session: { turn: 'running' } });
    expect(displayRows(thread).map((r) => r.text)).toEqual(expected);
    const retired = update(thread, { ev: 'turn.state', feedSeq: thread.feedSeq + 1, turnId: 'next', status: 'inProgress' });
    expect(displayRows(retired).map((r) => r.text)).toEqual(expected);
  }
  expect(result.events.filter((event: any) => event.ev === 'turn.state' && event.started)).toHaveLength(1);
});
