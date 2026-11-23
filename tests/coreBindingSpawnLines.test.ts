// A harness child's stdout framed by the core (core/crates/proc/src/spawn/lines.rs, electron/platform/coreChild.cjs
// `lines`), through the built addon and real processes: the lines as the reader always read them, the limit, and what a
// line costs while nobody reads it. Skipped without a built addon unless MOPILOT_CORE_REQUIRED says the run must have it.
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corePath, loadCore } = require('../electron/platform/core.cjs');
const { spawnCore } = require('../electron/platform/coreChild.cjs');
const { spawnGroup } = require('../electron/platform/winbin.cjs');
const { JsonReader } = require('../electron/transport/jsonReader.cjs');

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';
const skip = !addon?.routes().includes('proc.spawn') && !required && `no Rust core with proc.spawn built at ${corePath()}`;

const started = new Set<any>();
afterEach(() => {
  for (const child of started) child.kill('SIGKILL');
  started.clear();
});

/** A node child running `script`, as a harness is started. */
function node(script: string, options: object = {}) {
  const child: any = spawnGroup(spawnCore, process.execPath, ['-e', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
    ...options,
  });
  started.add(child);
  return child;
}

const closed = (child: any) => new Promise<[number | null, string | null]>((resolve) => child.once('close', (...why: any) => resolve(why)));

test('a framed stdout comes as lines: CRLF, blank, split and invalid UTF-8 as before, and no line left unended', { skip }, async () => {
  const script = `
    const out = (bytes) => new Promise((resolve) => process.stdout.write(Buffer.from(bytes), () => setTimeout(resolve, 20)));
    (async () => {
      await out('{"a":"');
      await out([0xe4, 0xb8]);
      await out([0xad]);
      await out('"}\\r\\n\\n7\\n"');
      await out([0xf0, 0x9f]);
      await out([0x98, 0x80, 0x22, 0x0a]);
      await out([0x22, 0xff, 0x22, 0x0a]);
      await out('{"unended":1}');
    })();`;
  const child = node(script, { lines: {} });
  const chunks: any[] = [];
  const values: any[] = [];
  const reader = new JsonReader({ stream: child.stdout, onValue: (value: any) => values.push(value), onError: assert.fail });
  child.stdout.on('data', (chunk: any) => (chunks.push(chunk), reader.push(chunk)));
  await new Promise<void>((resolve) => child.on('exit', () => reader.finishInput(resolve)));
  assert.deepEqual(values, [{ a: '中' }, 7, '😀', '\ufffd']);
  assert.ok(
    chunks.every((chunk) => Array.isArray(chunk.lines)),
    'lines, never bytes',
  );
});

test('a framed stdout meets its limit in UTF-16 units, as the reader always did', { skip }, async () => {
  const child = node(`process.stdout.write('"ok"\\n"' + 'é'.repeat(10) + '"\\n')`, { lines: { maxUnits: 11 } });
  const values: any[] = [];
  const failed = new Promise<Error>((resolve) => {
    const reader = new JsonReader({ stream: child.stdout, onValue: (value: any) => values.push(value), onError: resolve });
    child.stdout.on('data', (chunk: any) => reader.push(chunk));
  });
  const error = await failed;
  assert.equal(error.name, 'RangeError');
  assert.equal(error.message, 'JSON message exceeds the transport size limit');
  assert.deepEqual(values, ['ok']);
  await closed(child);
});

test('framed lines nobody takes stop at a bound, and every one comes whole once read', { skip }, async () => {
  const lines = 48;
  const script = `
    const line = '"' + 'ab'.repeat(1 << 19) + '"\\n';
    let left = ${lines};
    const go = () => { while (left > 0) { left--; if (!process.stdout.write(line)) return process.stdout.once('drain', go); } };
    go();`;
  const child = node(script, { lines: {} });
  child.stderr.resume();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const rss = process.memoryUsage().rss;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(process.memoryUsage().rss - rss < 16 << 20, 'nothing piles up here while nobody reads');
  assert.ok(child.stdout.readableLength <= 1, `${child.stdout.readableLength} reads waited`);
  const values: string[] = [];
  const reader = new JsonReader({ stream: child.stdout, onValue: (value: string) => values.push(value), onError: assert.fail });
  child.stdout.on('data', (chunk: any) => reader.push(chunk));
  await new Promise<void>((resolve) => child.on('exit', () => reader.finishInput(resolve)));
  assert.equal(values.length, lines);
  assert.ok(values.every((value) => value === 'ab'.repeat(1 << 19)));
});

test('a framed line still arriving that nobody reads costs a window; read, it comes whole however long', { skip }, async () => {
  const size = 64 << 20;
  const child = node(`process.stdout.write('"' + 'x'.repeat(${size}) + '"\\n', () => process.exit(3))`, { lines: {} });
  child.stderr.resume();
  await new Promise((resolve) => setTimeout(resolve, 600));
  const rss = process.memoryUsage().rss;
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(process.memoryUsage().rss - rss < 16 << 20, 'the line waits in the pipe, not here');
  assert.equal(child.exitCode, null, 'the child blocks in its write');
  const values: string[] = [];
  const reader = new JsonReader({ stream: child.stdout, onValue: (value: string) => values.push(value), onError: assert.fail });
  child.stdout.on('data', (chunk: any) => reader.push(chunk));
  await new Promise<void>((resolve) => child.on('exit', () => reader.finishInput(resolve)));
  assert.equal(child.exitCode, 3);
  assert.deepEqual(
    values.map((value) => value.length),
    [size],
  );
});

test('a framed stdout destroyed with a line still arriving drops it all: the child runs to its end, and nothing piles up', {
  skip,
}, async () => {
  const size = 96 << 20;
  const child = node(`process.stdout.write(Buffer.alloc(${size}, 'x'), () => process.exit(4))`, { lines: {} });
  child.stderr.resume();
  child.stdout.destroy();
  const rss = process.memoryUsage().rss;
  assert.deepEqual(await closed(child), [4, null]);
  assert.ok(process.memoryUsage().rss - rss < 32 << 20, 'the line went nowhere, not into memory here');
});
