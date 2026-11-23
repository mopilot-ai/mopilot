// electron/transport/jsonReader.cjs on the real core's framing: lines and their order as the transport has always read them,
// the size limit in UTF-16 units, backpressure, responsive slices, EOF sealing and every way a reader stops.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { JsonReader, HIGH_BYTES, LOW_BYTES, DISPATCH_MS } = require('../electron/transport/jsonReader.cjs');
const { openFramer, TOO_LONG } = require('../electron/platform/coreFraming.cjs');

/** A reader with what it said recorded, on a stream that counts its pauses. */
function fixture(options: any = {}) {
  const values: any[] = [];
  const errors: Error[] = [];
  const invalid: string[] = [];
  const stream = {
    pauses: 0,
    resumes: 0,
    pause() {
      this.pauses++;
    },
    resume() {
      this.resumes++;
    },
  };
  const reader = new JsonReader({
    onValue: (value: any) => values.push(value),
    onError: (error: Error) => errors.push(error),
    onInvalid: (error: Error, line: string) => {
      assert.equal(error.name, 'SyntaxError');
      invalid.push(line);
    },
    stream,
    ...options,
  });
  return { reader, values, errors, invalid, stream };
}

/** Slices run by hand, on a clock that moves `step` ms each read. */
function manual(step = 0) {
  const jobs: Array<() => void> = [];
  const cancelled: number[] = [];
  let now = 0;
  return {
    jobs,
    cancelled,
    options: {
      schedule: (fn: () => void) => jobs.push(fn),
      cancel: (id: number) => cancelled.push(id),
      clock: () => (now += step),
    },
  };
}

test('bytes one at a time: blank, CRLF and invalid lines, split characters and invalid UTF-8 read as they always did', () => {
  const f = fixture();
  const wire = Buffer.concat([
    Buffer.from('\n \r\n{"text":"😀中é"}\r\nnull\n[]\n7\nfalse\n"ok"\nnot json\n'),
    Buffer.from([0x22, 0xff, 0xe2, 0x98, 0x22, 0x0a]),
    Buffer.from('{"unterminated":true}'),
  ]);
  for (const byte of wire) f.reader.push(Buffer.from([byte]));
  assert.deepEqual(f.values, [{ text: '😀中é' }, null, [], 7, false, 'ok', '��']);
  assert.deepEqual(f.invalid, ['not json']);
  let done = false;
  f.reader.finishInput(() => (done = true));
  assert.ok(done, 'nothing queued: sealed at once');
  assert.equal(f.values.length, 7, 'a line without its newline at the end is no line');
  f.reader.push(Buffer.from('{}\n'));
  assert.equal(f.values.length, 7, 'nothing after the end');
});

test('a large record, then an invalid line and small ones, in order, however the reads are cut', async () => {
  const f = fixture();
  const record = { id: 'a:"😀', text: '中😀x'.repeat(200_000) };
  const wire = Buffer.from(JSON.stringify(record) + '\ninvalid\nnull\n{"id":"second"}\n');
  for (let at = 0; at < wire.length; at += 1023) f.reader.push(wire.subarray(at, at + 1023));
  // the record's parse can spend a slice's budget, as on a loaded runner: what follows it waits for main's next turn
  await new Promise<void>((resolve) => f.reader.finishInput(resolve));
  assert.deepEqual(f.values, [record, null, { id: 'second' }]);
  assert.deepEqual(f.invalid, ['invalid']);
  assert.deepEqual(f.errors, []);
  f.reader.close();
});

test('the size limit is in UTF-16 units, as a JS string counts them, while a line arrives and when it ends', () => {
  const units = (max: number, ...chunks: string[]) => {
    const f = fixture({ maxUnits: max });
    for (const chunk of chunks) f.reader.push(Buffer.from(chunk));
    return { values: f.values, error: f.errors[0] };
  };
  // é is two bytes and one unit, 😀 four bytes and two units
  assert.deepEqual(units(3, '"é"\n'), { values: ['é'], error: undefined });
  assert.deepEqual(units(4, '"😀"\n'), { values: ['😀'], error: undefined });
  const past = units(3, '1\n"😀"\n2\n');
  assert.deepEqual(past.values, [1], 'the lines before it still go');
  assert.equal(past.error.name, 'RangeError');
  assert.equal(past.error.message, TOO_LONG);
  // a line that never ends still meets the limit
  assert.equal(units(3, '"ab', 'c').error.message, TOO_LONG);
  assert.equal(units(3, '"ab').error, undefined);
  assert.equal(units(Infinity, 'x'.repeat(10_000) + '\n').error, undefined);
});

test('a line past the limit ends the input: the lines before it are delivered, then its error, whatever comes after', () => {
  // each line spends the budget, so the error waits a turn behind the lines
  const run = manual(DISPATCH_MS);
  const f = fixture({ maxUnits: 10, ...run.options });
  f.reader.push(Buffer.from(`1\n2\n3\n${'x'.repeat(20)}`));
  assert.deepEqual(f.values, [1]);
  // the core let its framer go with the line: what comes next is not framed, nor taken as a failure of its own
  f.reader.push(Buffer.from('4\n'));
  f.reader.push({ lines: [Buffer.from('5')], tooLong: false });
  while (run.jobs.length) run.jobs.shift()!();
  assert.deepEqual(f.values, [1, 2, 3]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].name, 'RangeError');
  assert.equal(f.errors[0].message, TOO_LONG);
});

test('queued lines past the high mark pause the stream, and it resumes below the low one', () => {
  // each line spends the budget, so a slice delivers one
  const run = manual(DISPATCH_MS);
  const f = fixture(run.options);
  const line = Buffer.from(`"${'x'.repeat(64 * 1024)}"\n`);
  // the first push leaves its second line queued behind a scheduled slice, so the rest queue too
  f.reader.push(Buffer.concat([line, line]));
  for (let i = 0; i < Math.ceil(HIGH_BYTES / line.length); i++) f.reader.push(line);
  assert.equal(f.stream.pauses, 1);
  assert.ok(f.reader.bytes >= HIGH_BYTES);
  while (f.stream.resumes === 0) run.jobs.shift()!();
  assert.ok(f.reader.bytes <= LOW_BYTES);
  assert.ok(f.reader.bytes > LOW_BYTES - line.length);
  while (run.jobs.length) run.jobs.shift()!();
  assert.equal(f.reader.bytes, 0);
  assert.equal(f.stream.resumes, 1);
  assert.ok(LOW_BYTES < HIGH_BYTES);
});

test('lines go in order within the time budget, and a stopped reader delivers nothing it had queued', () => {
  const run = manual(DISPATCH_MS / 2);
  const f = fixture(run.options);
  f.reader.push(Buffer.from('1\n2\n3\n4\n5\n'));
  assert.deepEqual(f.values, [1, 2], 'two reads of the clock fit the budget');
  run.jobs.shift()!();
  assert.deepEqual(f.values, [1, 2, 3, 4]);
  f.reader.push(Buffer.from('6\n'));
  assert.equal(run.jobs.length, 1, 'a push behind a scheduled slice waits its turn');
  f.reader.close();
  assert.deepEqual(run.cancelled, [1]);
  run.jobs.shift()!();
  assert.deepEqual(f.values, [1, 2, 3, 4]);
});

test('a handler that stops the reader, pushes or throws is taken as it happens', () => {
  const stopping = fixture();
  stopping.reader.o.onValue = (value: any) => {
    stopping.values.push(value);
    stopping.reader.close();
  };
  stopping.reader.push(Buffer.from('1\n2\n'));
  assert.deepEqual(stopping.values, [1]);
  const pushing = fixture();
  pushing.reader.o.onValue = (value: any) => {
    pushing.values.push(value);
    if (value === 1) pushing.reader.push(Buffer.from('3\n'));
  };
  pushing.reader.push(Buffer.from('1\n2\n'));
  assert.deepEqual(pushing.values, [1, 2, 3], 'what a handler pushes goes after what was queued');
  const throwing = fixture({
    onValue: () => {
      throw new Error('listener failed');
    },
  });
  throwing.reader.push(Buffer.from('{}\n{}\n'));
  assert.equal(throwing.errors.length, 1);
  assert.match(throwing.errors[0].message, /listener failed/);
  assert.equal(throwing.reader.closed, true);
  throwing.reader.fail('again');
  assert.equal(throwing.errors.length, 1);
  const odd = fixture();
  odd.reader.fail('not an error');
  assert.equal(odd.errors[0].message, 'not an error');
});

test('framed lines from a core child are taken as they are; anything but bytes, text or lines is refused', () => {
  const f = fixture();
  f.reader.push({ lines: [Buffer.from('{"a":1}\r'), Buffer.from(''), Buffer.from('2')], tooLong: false });
  f.reader.push({ lines: [Buffer.from('3')], tooLong: true });
  assert.deepEqual(f.values, [{ a: 1 }, 2, 3]);
  assert.equal(f.errors[0].message, TOO_LONG);
  const odd = fixture();
  odd.reader.push(7);
  assert.equal(odd.errors[0].name, 'TypeError');
});

test('decoded text is read as its bytes, with a surrogate pair split between chunks made whole', () => {
  const f = fixture({ maxUnits: 11 });
  const wire = '\n{"t":"😀"}\r\n"中"\n';
  for (let at = 0; at < wire.length; at++) f.reader.push(wire.slice(at, at + 1));
  f.reader.push('');
  assert.deepEqual(f.values, [{ t: '😀' }, '中']);
  assert.deepEqual(f.errors, []);
  f.reader.push('"😀😀😀😀😀"\n');
  assert.equal((f.errors as Error[])[0].message, TOO_LONG, 'the limit counts the units the text has');
});

test('finishInput waits for the stream to end, takes data after the exit, and seals once all is delivered', async () => {
  for (const size of [10, 200_000]) {
    const stream = new PassThrough();
    const values: any[] = [];
    const reader = new JsonReader({ stream, onValue: (v: any) => values.push(v), onError: assert.fail });
    stream.on('data', (chunk) => reader.push(chunk));
    let finished = false;
    const done = new Promise<void>((resolve) =>
      reader.finishInput(() => {
        finished = true;
        resolve();
      }),
    );
    assert.equal(finished, false);
    stream.end(JSON.stringify({ text: 'x'.repeat(size) }) + '\n');
    await done;
    assert.deepEqual(values, [{ text: 'x'.repeat(size) }]);
    assert.equal(stream.listenerCount('end'), 0);
    assert.equal(stream.listenerCount('close'), 0);
  }
  const stream = new PassThrough();
  const reader = new JsonReader({ stream, onValue: () => {}, onError: () => {} });
  const done = new Promise<void>((resolve) => reader.finishInput(resolve));
  stream.destroy();
  await done;
  assert.equal(reader.closed, true);
});

test('what is queued at the end is delivered before every finishInput is told, and a stop still tells them', async () => {
  const run = manual(DISPATCH_MS);
  const f = fixture(run.options);
  f.reader.push(Buffer.from('1\n2\n3\n'));
  const told: string[] = [];
  f.reader.finishInput(() => told.push('first'));
  f.reader.finishInput(() => told.push('second'));
  f.reader.push(Buffer.from('4\n'));
  assert.deepEqual(told, []);
  while (run.jobs.length) run.jobs.shift()!();
  await Promise.resolve();
  assert.deepEqual(f.values, [1, 2, 3]);
  assert.deepEqual(told, ['first', 'second']);
  // a handler that seals the reader inside a slice
  const inside = fixture();
  inside.reader.o.onValue = (value: any) => {
    inside.values.push(value);
    if (value === 1) inside.reader.finishInput(() => inside.values.push('done'));
  };
  inside.reader.push(Buffer.from('1\n2\n'));
  await Promise.resolve();
  assert.deepEqual(inside.values, [1, 2, 'done']);
  const stopped = manual(DISPATCH_MS);
  const g = fixture(stopped.options);
  g.reader.push(Buffer.from('1\n2\n'));
  let stoppedTold = false;
  g.reader.finishInput(() => (stoppedTold = true));
  g.reader.close();
  await Promise.resolve();
  assert.equal(stoppedTold, true);
  assert.deepEqual(g.values, [1]);
  let late = false;
  g.reader.finishInput(() => (late = true));
  assert.equal(late, true, 'a closed reader is finished at once');
});

test('the core framer is opened with the limit on the first bytes, and let go when the reader stops', () => {
  const opened: any[] = [];
  let closed = 0;
  const f = fixture({
    maxUnits: 9,
    open: (max: number) => {
      const framer = openFramer(max);
      opened.push(max);
      return { push: framer.push, close: () => (closed++, framer.close()) };
    },
  });
  f.reader.push(Buffer.from('1\n'));
  f.reader.push(Buffer.from('2\n'));
  assert.deepEqual(opened, [9]);
  f.reader.close();
  f.reader.close();
  assert.equal(closed, 1);
  assert.deepEqual(f.values, [1, 2]);
});

test('without a core a stream of bytes fails with why, and nothing frames it in JS', () => {
  const f = fixture({ open: (max: number) => openFramer(max, null) });
  f.reader.push(Buffer.from('{}\n'));
  assert.deepEqual(f.values, []);
  assert.equal(f.errors[0].message, 'The Rust core is missing.');
});
