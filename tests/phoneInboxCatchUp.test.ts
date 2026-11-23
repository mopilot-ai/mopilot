// The catch-up that follows an inbox overflow: immediate the first time, spaced after that, silent unless the reconnect itself fails.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATCH_UP_GAP_MS, catchUpHandler, createCatchUp } from '../mobile/src/inboxCatchUp.ts';

const rig = (delay: number | undefined, reopen: (owner: number) => Promise<unknown> = async () => {}) => {
  const log: string[] = [];
  const catchUp = createCatchUp(
    { delayMs: () => delay },
    async (owner) => {
      log.push(`reopen ${owner}`);
      return reopen(owner);
    },
    (error) => log.push(`lost ${error}`),
    () => 1,
    async (ms) => {
      log.push(`sleep ${ms}`);
    },
  );
  return { log, catchUp };
};

test('the first catch-up reopens at once and a repeat waits the gap first', async () => {
  const first = rig(0);
  await first.catchUp(1);
  assert.deepEqual(first.log, ['reopen 1']);
  const repeat = rig(undefined);
  await repeat.catchUp(1);
  assert.deepEqual(repeat.log, [`sleep ${CATCH_UP_GAP_MS}`, 'reopen 1']);
});

test('a connection that was replaced meanwhile is left alone', async () => {
  const { log, catchUp } = rig(0);
  await catchUp(2);
  assert.deepEqual(log, []);
});

test('only a failed reopen of the current connection is reported, with its message or a fallback', async () => {
  const named = rig(0, async () => {
    throw new Error('relay down');
  });
  await named.catchUp(1);
  assert.deepEqual(named.log, ['reopen 1', 'lost relay down']);
  const bare = rig(0, async () => Promise.reject('nope'));
  await bare.catchUp(1);
  assert.deepEqual(bare.log, ['reopen 1', 'lost Connection lost. Reconnecting…']);
});

test('a reopen that fails after the connection was replaced stays silent', async () => {
  let current = 1;
  const log: string[] = [];
  const catchUp = createCatchUp(
    { delayMs: () => 0 },
    async () => {
      current = 2;
      throw new Error('late');
    },
    (error) => log.push(error),
    () => current,
  );
  await catchUp(1);
  assert.deepEqual(log, []);
});

test('the walk handler: a start needs the live connection, an end always clears the flag and only a live done reconnects', () => {
  for (const live of [true, false]) {
    const log: string[] = [];
    const handle = catchUpHandler(
      () => live,
      (patch) => log.push(`publish ${patch.catchingUp}`),
      (line, delay) => log.push(`lost ${line} ${delay}`),
    );
    handle('start');
    handle('failed');
    handle('start');
    handle('done');
    const lost = 'lost Catching up with your computer… 0';
    assert.deepEqual(
      log,
      live ? ['publish true', 'publish false', 'publish true', 'publish false', lost] : ['publish false', 'publish false'],
      live ? 'live' : 'gone',
    );
  }
});
