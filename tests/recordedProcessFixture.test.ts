// Controlled readiness boundaries prevent partial PID publication or an unavailable snapshot from advancing a process fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { waitForRecordedProcess } from './support/recorded-process.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recorded-process-fixture-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = 0;
  return {
    ready: path.join(dir, 'ready'),
    watch: { births: new Map<number, string>() },
    now: () => time,
    wait: async () => {
      time += 10;
    },
    timeout: 30,
  };
}

test('a PID is published only after its complete newline, including an empty file and a valid numeric prefix', async (t) => {
  const f = fixture(t);
  let stage = 0;
  let ticks = 0;
  const result = await waitForRecordedProcess({
    ...f,
    wait: async () => {
      await f.wait();
      assert.equal(ticks, 0, 'pending PID bytes cannot select a process');
      fs.writeFileSync(f.ready, ['', '12', '123\r\n'][stage++]);
    },
    watcher: {
      tick: async () => {
        ticks++;
        f.watch.births.set(123, 'writer');
      },
    },
  });
  assert.deepEqual(result, { pid: 123, birth: 'writer' });
  assert.equal(stage, 3);
  assert.equal(ticks, 1);
});

test('an unavailable snapshot stays pending until this watch records the published PID', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ready, '123\n');
  let ticks = 0;
  const result = await waitForRecordedProcess({
    ...f,
    watcher: {
      tick: async () => {
        if (++ticks === 2) f.watch.births.set(123, 'writer');
      },
    },
  });
  assert.deepEqual(result, { pid: 123, birth: 'writer' });
  assert.equal(ticks, 2);
});

test('the captured PID remains pinned while recording retries and another marker is written', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.ready, '123\n');
  let ticks = 0;
  const result = await waitForRecordedProcess({
    ...f,
    wait: async () => {
      await f.wait();
      fs.writeFileSync(f.ready, '999\n');
    },
    watcher: {
      tick: async () => {
        if (++ticks === 2) f.watch.births.set(123, 'writer');
      },
    },
  });
  assert.deepEqual(result, { pid: 123, birth: 'writer' });
});

test('invalid completed PIDs and malformed completed JSON fail instead of selecting an unrelated process', async (t) => {
  const f = fixture(t);
  for (const value of [null, '123', [], {}, 0, 1, -3, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    fs.writeFileSync(f.ready, `${JSON.stringify(value)}\n`);
    await assert.rejects(
      waitForRecordedProcess({ ...f, watcher: { tick: async () => assert.fail('invalid PID reached the watcher') } }),
      /valid PID/,
    );
  }
  fs.writeFileSync(f.ready, '{broken}\n');
  await assert.rejects(waitForRecordedProcess({ ...f, watcher: { tick: async () => {} } }), SyntaxError);
});

test('missing publication and unavailable recording have a bounded visible no-progress failure', async (t) => {
  for (const published of [false, true]) {
    const f = fixture(t);
    if (published) fs.writeFileSync(f.ready, '123\n');
    await assert.rejects(
      waitForRecordedProcess({ ...f, watcher: { tick: async () => {} } }),
      /controlled writer publishes its recorded identity/,
    );
    assert.equal(f.now(), 30);
  }
});

test('read and watcher failures propagate instead of becoming pending data', async (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.ready);
  await assert.rejects(waitForRecordedProcess({ ...f, watcher: { tick: async () => {} } }));
  fs.rmdirSync(f.ready);
  fs.writeFileSync(f.ready, '123\n');
  const error = new Error('identity read failed');
  await assert.rejects(
    waitForRecordedProcess({
      ...f,
      watcher: {
        tick: async () => {
          throw error;
        },
      },
    }),
    (actual) => actual === error,
  );
});

test('independent paths and watches keep their identities when the second call records first', async (t) => {
  const a = fixture(t);
  const b = fixture(t);
  fs.writeFileSync(a.ready, '123\n');
  fs.writeFileSync(b.ready, '456\n');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = waitForRecordedProcess({
    ...a,
    watcher: {
      tick: async () => {
        await held;
        a.watch.births.set(123, 'first');
      },
    },
  });
  const second = await waitForRecordedProcess({
    ...b,
    watcher: {
      tick: async () => {
        b.watch.births.set(456, 'second');
      },
    },
  });
  assert.deepEqual(second, { pid: 456, birth: 'second' });
  assert.equal(a.watch.births.size, 0);
  release();
  assert.deepEqual(await first, { pid: 123, birth: 'first' });
});
