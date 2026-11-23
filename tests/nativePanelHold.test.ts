// Native test holds preserve their minimum and acknowledgement ordering, and always release after a refused or failed wait.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { releaseAfterHold } from './e2e/fixtures/nativePanelHold.mjs';

test('native release waits for both the minimum hold and actual UI acknowledgement', async () => {
  const events: string[] = [];
  await releaseAfterHold(
    1100,
    async () => {
      events.push('acknowledged');
    },
    async () => {
      events.push('release');
    },
    async (ms: number) => {
      events.push('minimum:' + ms);
    },
  );
  assert.deepEqual(events, ['minimum:1100', 'acknowledged', 'release']);
  events.length = 0;
  await releaseAfterHold(0, undefined, async () => {
    events.push('release');
  });
  assert.deepEqual(events, ['release']);
  events.length = 0;
  await releaseAfterHold(
    1,
    async () => {
      events.push('acknowledged');
    },
    async () => {
      events.push('release');
    },
  );
  assert.deepEqual(events, ['acknowledged', 'release']);
});

test('a failed minimum or acknowledgement wait still releases the native pointer', async () => {
  for (const phase of ['minimum', 'acknowledgement']) {
    let released = 0;
    const fail = async () => {
      throw new Error(phase);
    };
    await assert.rejects(
      releaseAfterHold(
        1100,
        phase === 'acknowledgement' ? fail : undefined,
        async () => {
          released++;
        },
        phase === 'minimum' ? fail : async () => {},
      ),
      new RegExp(phase),
    );
    assert.equal(released, 1);
  }
});
