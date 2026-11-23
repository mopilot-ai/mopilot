// The scheduled-task run ledger (electron/platform/runLedger.cjs): one claim per task and time across processes,
// the record of what happened, giving a time back, the baseline, and pruning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { RunLedger, KEEP } = require('../electron/platform/runLedger.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

function dir(t: any) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('two ledgers on one folder (two MoPilots) racing for a time: exactly one wins', async (t) => {
  const d = dir(t);
  const a = new RunLedger({ dir: d, by: { pid: 1 }, now: () => 5 });
  const b = new RunLedger({ dir: d, by: { pid: 2 }, now: () => 5 });
  const results = await Promise.all([
    ...Array.from({ length: 8 }, () => a.claim('daily/review', 1000, { status: 'starting' })),
    ...Array.from({ length: 8 }, () => b.claim('daily/review', 1000, { status: 'starting' })),
  ]);
  const won = results.filter(Boolean);
  assert.equal(won.length, 1);
  assert.deepEqual(Object.keys(won[0]).sort(), ['by', 'claimedAt', 'scheduledFor', 'status', 'taskId']);
  assert.equal(won[0].taskId, 'daily/review');
  // the id is one folder, whatever it holds
  assert.deepEqual(fs.readdirSync(d), [encodeURIComponent('daily/review')]);
  assert.equal(await a.latest('daily/review'), 1000);
  assert.equal(await b.claim('daily/review', 2000, {}).then((r: any) => r.by.pid), 2);
  assert.equal(await a.latest('daily/review'), 2000);
});

test('a record is updated in place, listed newest first, and a time given back can be claimed again', async (t) => {
  const d = dir(t);
  const l = new RunLedger({ dir: d });
  assert.equal(l.by.pid, process.pid);
  await l.claim('t', 100, { status: 'starting' });
  await l.claim('t', 300, { status: 'skipped', reason: 'missed' });
  await l.update('t', 100, { status: 'started', chatId: 'c1' });
  const list = await l.list('t');
  assert.deepEqual(
    list.map((r: any) => [r.scheduledFor, r.status, r.chatId ?? null]),
    [
      [300, 'skipped', null],
      [100, 'started', 'c1'],
    ],
  );
  assert.equal((await l.list('t', 1)).length, 1);
  await l.release('t', 300);
  assert.equal(await l.latest('t'), 100);
  assert.ok(await l.claim('t', 300, { status: 'starting' }));
  // a file being written reads as its time only; other files in the folder are not times
  fs.writeFileSync(path.join(d, 't', '400.json'), '');
  fs.writeFileSync(path.join(d, 't', 'notes.txt'), 'x');
  assert.deepEqual(await l.times('t'), [400, 300, 100]);
  assert.deepEqual((await l.list('t'))[0], { taskId: 't', scheduledFor: 400 });
  // an update to a record no one wrote makes one
  await l.update('t', 500, { status: 'failed' });
  assert.equal((await l.list('t'))[0].status, 'failed');
});

test('a task with no records has none; forgetting a task removes them', async (t) => {
  const d = dir(t);
  const l = new RunLedger({ dir: d });
  assert.deepEqual(await l.times('none'), []);
  assert.equal(await l.latest('none'), 0);
  assert.deepEqual(await l.list('none'), []);
  await l.claim('gone', 1, {});
  await l.forget('gone');
  assert.deepEqual(await l.times('gone'), []);
});

test('only the newest records are kept', async (t) => {
  const d = dir(t);
  const l = new RunLedger({ dir: d, keep: 3 });
  for (const at of [1, 2, 3, 4, 5]) await l.claim('t', at, {});
  assert.deepEqual(await l.times('t'), [5, 4, 3]);
  assert.equal(KEEP, 200);
});

test('the last run outlives pruning however many skips follow it', async (t) => {
  const l = new RunLedger({ dir: dir(t), keep: 3 });
  assert.equal(await l.lastRun('t'), null);
  await l.claim('t', 1, { status: 'skipped', reason: 'missed' });
  assert.equal(await l.lastRun('t'), null, 'only skips');
  await l.claim('t', 2, { status: 'started', chatId: 'c' });
  for (const at of [3, 4, 5, 6, 7]) await l.claim('t', at, { status: 'skipped', reason: 'previous-running' });
  assert.deepEqual(await l.times('t'), [7, 6, 5, 2]);
  assert.equal((await l.lastRun('t')).chatId, 'c');
  // a newer run replaces it, and the old one is pruned
  await l.claim('t', 8, { status: 'failed', reason: 'no window' });
  assert.deepEqual(await l.times('t'), [8, 7, 6]);
  assert.equal((await l.lastRun('t')).status, 'failed');
});

test('a claim that fails for another reason than "taken" throws', async (t) => {
  const d = dir(t);
  fs.mkdirSync(path.join(d, 't'));
  fs.chmodSync(path.join(d, 't'), 0o555);
  await assert.rejects(new RunLedger({ dir: d }).claim('t', 1, {}), /EACCES/);
  fs.chmodSync(path.join(d, 't'), 0o755);
});

test('the baseline is made once, by whichever ledger comes first, and kept', async (t) => {
  const d = dir(t);
  const a = new RunLedger({ dir: d });
  assert.equal(await a.baseline(50), 50);
  assert.equal(await a.baseline(90), 50, 'remembered');
  assert.equal(await new RunLedger({ dir: d }).baseline(70), 50, 'another MoPilot reads the first one');
  fs.writeFileSync(path.join(d, '.baseline'), 'garbage');
  assert.equal(await new RunLedger({ dir: d }).baseline(80), 80, 'an unreadable baseline is now');
  const unreadable = dir(t);
  fs.mkdirSync(path.join(unreadable, '.baseline'));
  await assert.rejects(new RunLedger({ dir: unreadable }).baseline(1), /EISDIR/);
  const readOnly = dir(t);
  fs.chmodSync(readOnly, 0o555);
  await assert.rejects(new RunLedger({ dir: readOnly }).baseline(1), /EACCES/);
  fs.chmodSync(readOnly, 0o755);
});

test('manual runs persist history, preserve the scheduled watermark through pruning, and keep colliding runs distinct', async (t) => {
  const l = new RunLedger({ dir: dir(t), now: () => 100, keep: 2 });
  await l.recordManual('t', 'first', 'codex');
  assert.equal(await l.latest('t'), 0);
  assert.ok(await l.claim('t', 100, { status: 'started' }), 'a manual run does not claim the scheduled occurrence');
  await l.recordManual('t', 'second', 'claude');
  await l.recordManual('t', 'third', 'acp:gemini');
  assert.equal(await l.latest('t'), 100);
  const saved = await new RunLedger({ dir: l.dir, keep: 2 }).list('t');
  assert.deepEqual(
    saved.map((r: any) => [r.chatId, r.harness, r.manual]),
    [
      ['third', 'acp:gemini', true],
      ['second', 'claude', true],
      [undefined, undefined, undefined],
    ],
  );
  assert.equal(await new RunLedger({ dir: l.dir, keep: 2 }).latest('t'), 100);
});

test('incomplete and malformed records cannot hide or prune the last real run', async (t) => {
  const l = new RunLedger({ dir: dir(t), keep: 1 });
  await l.claim('t', 1, { status: 'started', chatId: 'running' });
  const invalid = ['', 'null', '[]', '4', '"text"', '{}', '{"status":"future-unknown"}'];
  for (let i = 0; i < invalid.length; i++) {
    fs.writeFileSync(l.fileOf('t', i + 2), invalid[i]);
    assert.equal((await l.lastRun('t')).chatId, 'running');
  }
  assert.equal(await l.latest('t'), 8, 'a claimed time stays claimed even when its record is incomplete');
  await l.prune('t');
  assert.deepEqual(await l.times('t'), [8, 1]);
  assert.equal((await l.lastRun('t')).chatId, 'running');
  for (const status of ['starting', 'failed', 'started']) {
    await l.claim('t', 9, { status });
    assert.equal((await l.lastRun('t')).status, status);
    await l.release('t', 9);
  }
});

test('non-object JSON records list only their claimed time and do not count as runs', async (t) => {
  const l = new RunLedger({ dir: dir(t) });
  await l.claim('t', 1, { status: 'skipped' });
  for (const data of ['null', '[]', '42', 'true', '"text"']) {
    fs.writeFileSync(l.fileOf('t', 2), data);
    assert.deepEqual((await l.list('t', 1))[0], { taskId: 't', scheduledFor: 2 });
    assert.equal(await l.lastRun('t'), null);
  }
});

test('empty and dot task ids cannot remove the ledger or its parent', async (t) => {
  for (const id of ['', '.', '..'])
    await t.test(JSON.stringify(id), async (s) => {
      const root = dir(s);
      const l = new RunLedger({ dir: path.join(root, 'runs') });
      await l.claim('safe', 1, { status: 'starting' });
      const marker = path.join(root, 'outside.txt');
      fs.writeFileSync(marker, 'keep');
      await assert.rejects(l.forget(id), /isn't a task id/);
      assert.equal(fs.readFileSync(marker, 'utf8'), 'keep');
      assert.equal(await l.latest('safe'), 1);
      for (const operation of [() => l.claim(id, 2, {}), () => l.update(id, 2, {}), () => l.release(id, 2)])
        await assert.rejects(operation(), /isn't a task id/);
      assert.throws(() => l.fileOf(id, 2), /isn't a task id/);
      assert.deepEqual(await l.list(id), []);
      assert.equal(await l.latest(id), 0);
      assert.equal(await l.lastRun(id), null);
    });
});

test('retention failure cannot turn a written claim into a rejected run', async (t) => {
  const l = new RunLedger({ dir: dir(t), keep: 1 });
  await l.claim('t', 1, { status: 'skipped' });
  fs.mkdirSync(l.fileOf('t', 2));
  assert.equal((await l.claim('t', 3, { status: 'starting' })).status, 'starting');
  assert.equal(await l.latest('t'), 3);
  assert.equal(await l.claim('t', 3, { status: 'starting' }), null, 'the committed claim still prevents duplicates');
  assert.equal(recentIgnored().at(-1).context, 'prune scheduled task run history');
  fs.rmSync(l.fileOf('t', 2), { recursive: true });
  await l.claim('t', 4, { status: 'started' });
  assert.deepEqual(await l.times('t'), [4], 'later claims retry retention');
});

test('manual run history survives retention failure without reserving a scheduled time', async (t) => {
  const l = new RunLedger({ dir: dir(t), keep: 1, now: () => 3 });
  fs.mkdirSync(l.fileOf('t', 1), { recursive: true });
  fs.mkdirSync(l.fileOf('t', 2));
  await l.recordManual('t', 'manual-chat', 'claude');
  assert.equal((await l.list('t'))[0].chatId, 'manual-chat');
  assert.equal((await l.list('t'))[0].manual, true);
  assert.equal(await l.latest('t'), 2);
  assert.ok(await l.claim('t', 3, { status: 'starting' }), 'manual history still leaves the scheduled occurrence available');
});

test('a claim reports its write error even if closing the file also fails', async (t) => {
  const writeError = new Error('claim write failed');
  const closeError = new Error('claim close failed');
  let failWrite = true;
  let closes = 0;
  t.mock.method(fs.promises, 'open', async () => ({
    writeFile: async () => {
      if (failWrite) throw writeError;
    },
    close: async () => {
      closes++;
      throw closeError;
    },
  }));
  const l = new RunLedger({ dir: dir(t) });
  await assert.rejects(l.claim('t', 1, {}), (e) => e === writeError);
  failWrite = false;
  await assert.rejects(l.claim('t', 2, {}), (e) => e === closeError);
  assert.equal(closes, 2);
});

test('noncanonical and unsafe time filenames cannot alias records or advance the ledger watermark', async (t) => {
  const l = new RunLedger({ dir: dir(t), keep: 1 });
  await l.claim('t', 1, { status: 'started', chatId: 'real' });
  const names = ['01.json', '-0.json', '9007199254740992.json', '9007199254740993.json', `${'9'.repeat(200)}.json`, '1.5.json'];
  for (const name of names) fs.writeFileSync(path.join(l.dir, 't', name), JSON.stringify({ status: 'started', chatId: 'wrong' }));
  assert.deepEqual(await l.times('t'), [1]);
  assert.equal(await l.latest('t'), 1);
  assert.deepEqual(
    (await l.list('t')).map((r: any) => [r.scheduledFor, r.chatId]),
    [[1, 'real']],
  );
  assert.equal((await l.lastRun('t')).chatId, 'real');
  await l.prune('t');
  for (const name of names) assert.equal(fs.existsSync(path.join(l.dir, 't', name)), true);
  await l.claim('t', 2, { status: 'started', chatId: 'next' });
  assert.deepEqual(await l.times('t'), [2]);
  assert.equal(await l.latest('t'), 2);
  assert.equal((await l.lastRun('t')).chatId, 'next');
});

test('updating an unreadable run record cannot erase its existing metadata', async (t) => {
  const l = new RunLedger({ dir: dir(t) });
  await l.claim('t', 1, { status: 'started', chatId: 'existing-chat', harness: 'claude' });
  const file = l.fileOf('t', 1);
  const original = fs.readFileSync(file, 'utf8');
  fs.chmodSync(file, 0o200);
  try {
    await assert.rejects(l.update('t', 1, { status: 'failed' }), /EACCES/);
  } finally {
    fs.chmodSync(file, 0o600);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), original);
});

test('updates preserve malformed run records while history readers tolerate them', async (t) => {
  const l = new RunLedger({ dir: dir(t) });
  await l.claim('t', 1, {});
  const file = l.fileOf('t', 1);
  for (const text of ['', '{torn', 'null', '[]', '7']) {
    fs.writeFileSync(file, text);
    assert.deepEqual(await l.list('t'), [{ taskId: 't', scheduledFor: 1 }]);
    await assert.rejects(l.update('t', 1, { status: 'failed' }), /Unreadable scheduled run record/);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('updates propagate read failures without changing the run file', async (t) => {
  const l = new RunLedger({ dir: dir(t) });
  await l.claim('t', 1, { status: 'started', chatId: 'keep' });
  const file = l.fileOf('t', 1);
  const original = fs.readFileSync(file, 'utf8');
  const read = fs.promises.readFile;
  let failure: any;
  t.mock.method(fs.promises, 'readFile', async (target: any, ...args: any[]) => {
    if (target === file) throw failure;
    return read.apply(fs.promises, [target, ...args] as any);
  });
  for (failure of [Object.assign(new Error('disk read failed'), { code: 'EIO' }), new Error('read failed'), null, undefined]) {
    let caught = false;
    try {
      await l.update('t', 1, { status: 'failed' });
    } catch (error) {
      caught = true;
      assert.equal(error, failure);
    }
    assert.equal(caught, true);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
  }
});

test('a non-finite baseline cannot permanently disable scheduled runs', async (t) => {
  const d = dir(t);
  for (const text of ['Infinity', '-Infinity', '1e999', 'NaN', '0']) {
    fs.writeFileSync(path.join(d, '.baseline'), text);
    const ledger = new RunLedger({ dir: d });
    assert.equal(await ledger.baseline(80), 80, text);
    assert.equal(await ledger.baseline(90), 80, 'the recovered baseline remains stable for this run');
    assert.equal(fs.readFileSync(path.join(d, '.baseline'), 'utf8'), text, 'recovery preserves the source');
  }
});

test('a canonical filename outside the Date range cannot advance the scheduler watermark', async (t) => {
  const ledger = new RunLedger({ dir: dir(t) });
  await ledger.claim('t', 1, { status: 'started' });
  const file = ledger.fileOf('t', 9_000_000_000_000_000);
  fs.writeFileSync(file, '{"status":"started"}');
  assert.deepEqual(await ledger.times('t'), [1]);
  assert.equal(await ledger.latest('t'), 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"status":"started"}');
});

for (const stage of ['write', 'close']) {
  test(`a failed claim ${stage} releases its occurrence for another ledger`, async (t) => {
    const l = new RunLedger({ dir: dir(t) });
    const other = new RunLedger({ dir: l.dir });
    const open = fs.promises.open.bind(fs.promises);
    const failure = new Error(`claim ${stage} failed`);
    const mock = t.mock.method(fs.promises, 'open', async (...args: any[]) => {
      const handle = await (open as any)(...args);
      return {
        writeFile: async (text: string) => {
          if (stage === 'write') {
            await handle.writeFile('{ partial');
            throw failure;
          }
          await handle.writeFile(text);
        },
        close: async () => {
          await handle.close();
          if (stage === 'close') throw failure;
        },
      };
    });
    await assert.rejects(l.claim('t', 100, { status: 'starting' }), (error) => error === failure);
    mock.mock.restore();
    assert.equal(await other.latest('t'), 0, 'a failed claim must not advance the scheduler watermark');
    assert.ok(await other.claim('t', 100, { status: 'starting' }), 'another profile can retry the occurrence');
  });
}

test('rollback failure cannot hide the original claim failure', async (t) => {
  const l = new RunLedger({ dir: dir(t) });
  const failure = new Error('write failed');
  let released = false;
  t.mock.method(fs.promises, 'open', async () => ({
    writeFile: async () => {
      throw failure;
    },
    close: async () => {},
  }));
  l.release = async () => {
    released = true;
    throw new Error('rollback failed');
  };
  await assert.rejects(l.claim('t', 100, {}), (error) => error === failure);
  assert.equal(released, true);
});

for (const harness of ['codex', 'claude', 'acp:opencode']) {
  test(`failed ${harness} manual history writes do not leave a phantom run`, async (t) => {
    const l = new RunLedger({ dir: dir(t), now: () => 100 });
    const open = fs.promises.open.bind(fs.promises);
    const failure = new Error('manual record write failed');
    const mock = t.mock.method(fs.promises, 'open', async (...args: any[]) => {
      const handle = await (open as any)(...args);
      return {
        writeFile: async () => {
          throw failure;
        },
        close: () => handle.close(),
      };
    });
    await assert.rejects(l.recordManual('t', 'chat', harness), (error) => error === failure);
    mock.mock.restore();
    assert.deepEqual(await l.list('t'), []);
    await l.recordManual('t', 'chat', harness);
    assert.deepEqual(await l.times('t'), [-100]);
    assert.equal((await l.lastRun('t')).harness, harness);
    assert.equal(await l.latest('t'), 0);
  });
}
