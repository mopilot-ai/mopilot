// The transcript writer's JS side (electron/platform/transcriptWriter.cjs) on the real core: what its callers rely on. Batching,
// failure recovery and reads under a running write are the crate's, tested in core/crates/transcript.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { metrics } from '../scripts/perf-bench/aggregate.mjs';
import { dir, disk, lines } from './support/transcript-writer.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const probe = require('../electron/perf/probe.cjs');
const { TranscriptWriter } = require('../electron/platform/transcriptWriter.cjs');
const { ItemsLog } = require('../electron/platform/chats.cjs');
const { OperationLog } = require('../electron/capabilities/contract/operationLog.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

const HOUR = 3_600_000;

test('the first line goes out at once; later ones wait for a flush, and a read sees them', async (t) => {
  const file = path.join(dir(t), 'deep', 'a.jsonl');
  const w = new TranscriptWriter({ flushMs: HOUR });
  w.append(file, lines('1'), { mode: 0o600 });
  assert.equal(disk(file), lines('1').join(''));
  w.append(file, lines('2', '3'));
  assert.equal(disk(file), lines('1').join(''));
  assert.ok(w.pending(file) > 0);
  assert.ok(w.has(file));
  assert.equal(await w.readText(file), lines('1', '2', '3').join(''));
  await w.flush(file);
  assert.equal(disk(file), lines('1', '2', '3').join(''));
  assert.equal(w.pending(file), 0);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  w.append(file, []);
  assert.equal(w.pending(file), 0);
});

test('without a core a writer is refused with why, before it holds anything', () => {
  assert.throws(() => new TranscriptWriter({ flushMs: HOUR, addon: null }), { message: 'The Rust core is missing.' });
});

test('lines reach the file by themselves within flushMs', async (t) => {
  const file = path.join(dir(t), 'a.jsonl');
  const w = new TranscriptWriter({ flushMs: 5 });
  w.append(file, lines('1'));
  w.append(file, lines('2'));
  await waitFor(() => fs.existsSync(file) && disk(file) === lines('1', '2').join(''), 'the lines on disk');
});

test('a missing file reads as ENOENT, and a removed one does too, whatever it was given after', async (t) => {
  const file = path.join(dir(t), 'a.jsonl');
  const w = new TranscriptWriter({ flushMs: HOUR });
  await assert.rejects(w.readText(file), (e: any) => e.code === 'ENOENT');
  assert.equal(w.has(file), false);
  w.append(file, lines('1'));
  w.remove(file);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(w.readText(file), (e: any) => e.code === 'ENOENT');
  w.append(file, lines('2'));
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(w.readText(path.dirname(file)), (e: any) => e.code === undefined);
});

test('drain writes everything and then each line as it comes; a quit that did not happen ends that', async (t) => {
  const file = path.join(dir(t), 'a.jsonl');
  const w = new TranscriptWriter({ flushMs: HOUR });
  w.append(file, lines('1'));
  w.append(file, lines('2'));
  await w.drain(20);
  assert.equal(disk(file), lines('1', '2').join(''));
  w.append(file, lines('3'));
  assert.equal(disk(file), lines('1', '2', '3').join(''));
  await new Promise((resolve) => setTimeout(resolve, 30));
  w.append(file, lines('4'));
  assert.equal(disk(file), lines('1', '2', '3').join(''));
  await w.drain();
  await w.drain(0);
});

test('a write that fails is noted and told to every listener, and one that throws does not stop the others', async (t) => {
  const d = dir(t);
  fs.writeFileSync(path.join(d, 'plain'), '');
  const file = path.join(d, 'plain', 'a.jsonl');
  clearIgnored();
  const heard: string[] = [];
  const w = new TranscriptWriter({
    flushMs: HOUR,
    onError: () => {
      throw new Error('a bad listener');
    },
  });
  const stop = w.onError((name: string, e: any) => heard.push(`${path.basename(name)}: ${e.message}`));
  w.append(file, lines('1'), { what: 'write a test log' });
  await w.flush(file);
  assert.equal(heard.length, 1);
  assert.match(heard[0], /^a\.jsonl: /);
  assert.ok(recentIgnored().some((e: any) => e.context === 'write a test log'));
  assert.ok(recentIgnored().some((e: any) => e.context === 'report a transcript write failure'));
  stop();
  assert.equal(w.errorListeners.size, 1);
});

test('a core that refuses an append reports it as a failed write', () => {
  const heard: string[] = [];
  const addon = {
    dispatch: async () => Buffer.alloc(0),
    dispatchSync: (route: string) => {
      if (route === 'transcript.open') return Buffer.from('1');
      throw new Error('the core went away');
    },
    routes: () => [],
  };
  const w = new TranscriptWriter({ addon, onError: (_: string, e: any) => heard.push(e.message) });
  w.append('/a/b.jsonl', ['{}\n']);
  addon.dispatchSync = (() => {
    throw 'plain';
  }) as any;
  w.append('/a/b.jsonl', ['{}\n']);
  assert.deepEqual(heard, ['the core went away', 'plain']);
});

test('ItemsLog through a shared writer: reads include queued records; flush, drain and write errors by chat id', async (t) => {
  const d = dir(t);
  const threads = path.join(d, 'threads');
  const w = new TranscriptWriter({ flushMs: HOUR });
  const log = new ItemsLog(threads, { writer: w });
  const heard: [string, string][] = [];
  log.onWriteError((id: string, e: any) => heard.push([id, e.message]));
  log.append('acp:kimi:1', { t: 'session' });
  log.append('acp:kimi:1', { t: 'update', n: 1 }, { t: 'update', n: 2 });
  assert.deepEqual(
    (await log.readAsync('acp:kimi:1')).map((r: any) => r.n ?? r.t),
    ['session', 1, 2],
  );
  assert.match(await log.readText('acp:kimi:1'), /"n":2/);
  await log.flush('acp:kimi:1');
  assert.equal(disk(log.file('acp:kimi:1')).split('\n').filter(Boolean).length, 3);
  // a second log over the same folder (a restart) sees the first one's queued records through the writer they share,
  // as the app's logs share its one writer (app/sessions.cjs)
  const shared = new TranscriptWriter({ flushMs: HOUR });
  const a = new ItemsLog(threads, { writer: shared });
  const b = new ItemsLog(threads, { writer: shared });
  a.append('acp:kimi:2', { t: 'session' });
  a.append('acp:kimi:2', { t: 'user' });
  assert.deepEqual(
    (await b.readAsync('acp:kimi:2')).map((r: any) => r.t),
    ['session', 'user'],
  );
  await b.drain();
  assert.equal(disk(a.file('acp:kimi:2')).split('\n').filter(Boolean).length, 2);
  // a write failure names the chat; other folders, other files and names that don't decode are not this log's
  for (const fn of w.errorListeners) {
    fn(log.file('acp:kimi:3'), new Error('ENOSPC'));
    fn(path.join(d, 'elsewhere', 'x.items.jsonl'), new Error('no'));
    fn(path.join(threads, 'x.v2'), new Error('no'));
    fn(path.join(threads, '%E0%A4%A.items.jsonl'), new Error('no'));
  }
  assert.deepEqual(heard, [['acp:kimi:3', 'ENOSPC']]);
});

test('the operation log goes through the writer with private permissions', async (t) => {
  const d = dir(t);
  const file = path.join(d, 'ops', 'operations.jsonl');
  const calls: any[] = [];
  const writer = { append: (...a: any[]) => calls.push(a) };
  const ops = new OperationLog({ file, writer });
  ops.add({ tool: 'browser_click' });
  assert.deepEqual(calls, [[file, ['{"tool":"browser_click"}\n'], { mode: 0o600, what: 'append to the tool operation log' }]]);
  assert.deepEqual(ops.recent(), [{ tool: 'browser_click' }]);
});

test('AcpHost tells the chat when its transcript cannot be written; other files are not chats', () => {
  const acp = require('../electron/harness/acp.cjs');
  let report: any = null;
  const items = { read: () => [], onWriteError: (fn: any) => (report = fn) };
  const host = new acp.AcpHost({ items, quirks: () => null, resolveBin: () => null });
  const events: any[] = [];
  host.on('event', (e: any) => events.push(e));
  report('acp:kimi:1', new Error('ENOSPC: no space left on device'));
  report('acp:kimi:2', 'plain');
  report('not-a-chat', new Error('no'));
  assert.deepEqual(events, [
    { key: 'acp:kimi:1', kind: 'transcriptError', error: 'ENOSPC: no space left on device' },
    { key: 'acp:kimi:2', kind: 'transcriptError', error: 'plain' },
  ]);
});

test('AcpHost stops hearing the shared writer once it closes everything', () => {
  const acp = require('../electron/harness/acp.cjs');
  const heard: any[] = [];
  let stopped = 0;
  const items = {
    read: () => [],
    onWriteError: (fn: any) => (heard.push(fn), () => stopped++),
  };
  const host = new acp.AcpHost({ items, quirks: () => null, resolveBin: () => null });
  host.closeAll();
  assert.equal(heard.length, 1);
  assert.equal(stopped, 1);
  // a host over a log without write errors closes too
  new acp.AcpHost({ items: { read: () => [] }, quirks: () => null, resolveBin: () => null }).closeAll();
});

test('ItemsLog matches write errors to its folder however the folder was written', (t) => {
  const d = dir(t);
  const w = new TranscriptWriter({ flushMs: HOUR });
  const log = new ItemsLog(`${path.join(d, 'threads')}${path.sep}`, { writer: w });
  const heard: string[] = [];
  log.onWriteError((id: string) => heard.push(id));
  for (const fn of w.errorListeners) fn(log.file('acp:kimi:9'), new Error('EIO'));
  assert.deepEqual(heard, ['acp:kimi:9']);
});

test('with the probe off nothing is sampled; with it on, real writes fill the report’s write columns', async (t) => {
  const d = dir(t);
  const w = new TranscriptWriter({ flushMs: HOUR });
  const off = path.join(d, 'off.jsonl');
  w.append(off, lines('1'));
  w.append(off, lines('2', '3'));
  await w.flush(off);
  assert.equal(fs.existsSync(path.join(d, 'perf')), false, 'no probe file while it is off');

  const timers = { setInterval: (() => ({ unref: () => undefined })) as any, clearInterval: (() => undefined) as any };
  const sampled = probe.startProbe({ dir: d, id: 'run', now: () => 2000, ...timers });
  t.after(() => probe.stopProbe());
  const log = new ItemsLog(path.join(d, 'items'), { writer: w });
  log.append('acp:chat', { t: 'user' });
  log.append('acp:chat', { t: 'update' }, { t: 'update' });
  await log.flush('acp:chat');
  await probe.stopProbe();
  const samples = fs
    .readFileSync(sampled, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const writes = samples.filter((s) => s.kind === 'write');
  assert.deepEqual(
    writes.map(({ chat, records, reason }) => ({ chat, records, reason })),
    [
      { chat: 'acp:chat', records: 1, reason: 'first' },
      { chat: 'acp:chat', records: 2, reason: 'flush' },
    ],
  );
  for (const s of writes) assert.ok(s.ms >= 0 && s.bytes > 0);
  const m = metrics(samples, { from: 1000, to: 3000 });
  assert.equal(m.queueMax, 2);
  assert.equal(typeof m.writeP95, 'number');
});

test('a read that fails for another reason says so, whatever the core threw', async (t) => {
  const w = new TranscriptWriter({ flushMs: HOUR });
  await assert.rejects(w.readText(dir(t)), (e: any) => e.code === undefined && e.message.length > 0);
  const refusing = {
    routes: () => [],
    subscribe() {},
    dispatchSync: () => Buffer.from('1'),
    dispatch: () => Promise.reject('plain text'),
  };
  await assert.rejects(new TranscriptWriter({ addon: refusing }).readText('f'), /^Error: plain text$/);
});

test("events of another domain on the stream are not a writer's", () => {
  let hear: (event: Buffer) => void = () => undefined;
  const fake = {
    routes: () => [],
    subscribe: (listener: (event: Buffer) => void) => (hear = listener),
    dispatchSync: () => Buffer.from('41'),
  };
  const failures: string[] = [];
  const w = new TranscriptWriter({ addon: fake, onError: (_f: string, e: Error) => failures.push(e.message) });
  assert.equal(w.id, 41);
  hear(Buffer.from('{"framing":1,"records":[]}'));
  assert.deepEqual(failures, []);
  hear(Buffer.from('{"transcript":41,"failed":{"file":"f","what":"write it","message":"disk full"}}'));
  assert.deepEqual(failures, ['disk full']);
});
