// The bounded log of the stall and renderer records (electron/perf/stalls.cjs createBoundedLog, #5398): the folder is made once, size counts bytes, and a disk that cannot be written warns once a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { createBoundedLog } = createRequire(import.meta.url)('../electron/perf/stalls.cjs');

function fakeFsp(size = 0) {
  const calls: string[] = [];
  const fsp = {
    mkdir: async () => void calls.push('mkdir'),
    stat: async () => ({ size }),
    rename: async () => void calls.push('rename'),
    appendFile: async (_f: string, text: string) => void calls.push(`append ${Buffer.byteLength(text)}`),
  };
  return { fsp: fsp as any, calls };
}

test('the folder is made once, not for every line', async () => {
  const { fsp, calls } = fakeFsp();
  const log = createBoundedLog('/x/perf/r.jsonl', { fsp });
  for (const line of ['a', 'b', 'c']) await log.append(line);
  assert.equal(calls.filter((c) => c === 'mkdir').length, 1);
});

test('the size is counted in bytes: text in other scripts rotates the file at its bound', async () => {
  const { fsp, calls } = fakeFsp();
  // two characters of three bytes each, and the newline: 7 bytes a line, though 3 characters long
  const line = '你好';
  const log = createBoundedLog('/x/perf/r.jsonl', { fsp, max: 14 });
  for (let i = 0; i < 3; i++) await log.append(line);
  // 7 bytes a line: after two (14) the file is at its bound and the third line starts a new one
  assert.deepEqual(
    calls.filter((c) => c !== 'mkdir'),
    ['append 7', 'append 7', 'rename', 'append 7'],
  );
});

test('a disk that cannot be written warns once a minute, says how many lines it stood for, and looks at the folder again', async () => {
  const { fsp, calls } = fakeFsp();
  let at = 0;
  let failing = true;
  fsp.appendFile = async () => {
    if (failing) throw new Error('disk full');
  };
  const warned: unknown[][] = [];
  const log = createBoundedLog('/x/perf/r.jsonl', { fsp, warn: (...a: unknown[]) => void warned.push(a), now: () => at });
  for (let i = 0; i < 5; i++) await log.append('x');
  assert.equal(warned.length, 1, 'five failures in the same minute warn once');
  at = 59_000;
  await log.append('x');
  assert.equal(warned.length, 1);
  at = 61_000;
  await log.append('x');
  assert.equal(warned.length, 2);
  assert.match(String(warned[1][2]), /5 more lines failed/);
  failing = false;
  await log.append('x');
  assert.equal(calls.filter((c) => c === 'mkdir').length >= 2, true, 'the folder is made again after a failure (it may have been removed)');
  assert.equal(warned.length, 2);
});
