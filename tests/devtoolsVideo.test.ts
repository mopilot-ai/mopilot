// browser_record's video (devtools/movWriter.cjs, files.cjs, videoRecorder.cjs): the .mov parses back to its frames, durations and sizes, free file names never overwrite, and the recorder follows the screencast within its gates and caps.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { MovWriter, jpegSize, LAST_MS } = require('../electron/capabilities/browser/devtools/movWriter.cjs');
const { freeFile, cleanName } = require('../electron/capabilities/browser/devtools/files.cjs');
const { VideoRecorder } = require('../electron/capabilities/browser/devtools/videoRecorder.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs.reverse()) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vid-'));
  dirs.push(d);
  return d;
};

/** A tiny JPEG: SOI, APP0, DQT, DHT, JPG and DAC segments (none is a frame header), SOF0 with the size, a COM pad, EOI. */
function jpeg(width: number, height: number, pad = 0) {
  const seg = (marker: number, body: number[]) => Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body]);
  const sof = Buffer.from([
    0xff,
    0xc0,
    0,
    17,
    8,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    3,
    1,
    0x11,
    0,
    2,
    0x11,
    0,
    3,
    0x11,
    0,
  ]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, new Array(14).fill(0)),
    seg(0xdb, [1, 2]),
    seg(0xc4, [1, 2]),
    seg(0xc8, [1]),
    seg(0xcc, [1]),
    sof,
    seg(0xfe, new Array(pad).fill(0x41)),
    Buffer.from([0xff, 0xd9]),
  ]);
}

/* ---------- a box reader for the movie ---------- */

type Box = { type: string; start: number; end: number };
function boxes(buf: Buffer, start = 0, end = buf.length): Box[] {
  const out: Box[] = [];
  for (let i = start; i < end; ) {
    const size = buf.readUInt32BE(i);
    out.push({ type: buf.toString('latin1', i + 4, i + 8), start: i, end: i + size });
    i += size;
  }
  return out;
}
const child = (buf: Buffer, parent: Box, type: string) => {
  const b = boxes(buf, parent.start + 8, parent.end).find((x) => x.type === type);
  assert.ok(b, type);
  return b;
};
const dive = (buf: Buffer, ...types: string[]) => {
  let cur: Box = { type: 'file', start: -8, end: buf.length };
  for (const t of types) cur = child(buf, cur, t);
  return cur;
};

/* ---------- movWriter ---------- */

test('jpegSize reads the SOF marker and is null without one', () => {
  assert.deepEqual(jpegSize(jpeg(640, 480)), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from('this is not a jpeg at all')), null);
  assert.equal(jpegSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), Buffer.alloc(14), Buffer.from([0xff, 0xd9])])), null);
});

test('MovWriter writes a movie that parses back to its frames', () => {
  const file = path.join(tmp(), 'a.mov');
  const w = new MovWriter(file);
  const frames = [jpeg(64, 48, 3), jpeg(64, 48, 10), jpeg(64, 48, 5), jpeg(32, 24, 1)];
  const at = [0, 100, 200, 250];
  assert.equal(w.add(Buffer.from('not a jpeg, but long enough'), 0), false);
  frames.forEach((f, i) => assert.equal(w.add(f, at[i]), true));
  assert.equal(
    w.bytes,
    frames.reduce((a, f) => a + f.length, 0),
  );
  const out = w.finish();
  assert.equal(w.add(frames[0], 300), false);
  assert.equal(w.finish(), null);
  const buf = fs.readFileSync(file);
  assert.equal(out.bytes, buf.length);
  assert.equal(out.frames, 4);
  assert.equal(out.ms, 100 + 100 + 50 + LAST_MS);
  assert.deepEqual([out.width, out.height], [64, 48]);

  const top = boxes(buf);
  assert.deepEqual(
    top.map((b) => b.type),
    ['ftyp', 'mdat', 'moov'],
  );
  const mdat = top[1];
  assert.equal(mdat.end - mdat.start, 8 + w.bytes);

  const stbl = dive(buf, 'moov', 'trak', 'mdia', 'minf', 'stbl');
  const stsd = child(buf, stbl, 'stsd');
  const entry = stsd.start + 8 + 8;
  assert.equal(buf.toString('latin1', entry + 4, entry + 8), 'jpeg');
  assert.equal(buf.readUInt16BE(entry + 8 + 24), 64);
  assert.equal(buf.readUInt16BE(entry + 8 + 26), 48);

  const stts = child(buf, stbl, 'stts');
  const n = buf.readUInt32BE(stts.start + 12);
  const runs = Array.from({ length: n }, (_, i) => [buf.readUInt32BE(stts.start + 16 + i * 8), buf.readUInt32BE(stts.start + 20 + i * 8)]);
  assert.deepEqual(runs, [
    [2, 100],
    [1, 50],
    [1, LAST_MS],
  ]);

  const stsz = child(buf, stbl, 'stsz');
  assert.equal(buf.readUInt32BE(stsz.start + 16), 4);
  const sizes = frames.map((_, i) => buf.readUInt32BE(stsz.start + 20 + i * 4));
  assert.deepEqual(
    sizes,
    frames.map((f) => f.length),
  );

  const stco = child(buf, stbl, 'stco');
  frames.forEach((f, i) => {
    const off = buf.readUInt32BE(stco.start + 16 + i * 4);
    assert.ok(buf.subarray(off, off + f.length).equals(f));
  });
});

test('MovWriter removes the file when no frame was kept', () => {
  const file = path.join(tmp(), 'empty.mov');
  const w = new MovWriter(file);
  assert.equal(w.add(Buffer.from('xxxxxxxxxxxxxxxxxxxx'), 0), false);
  assert.equal(w.finish(), null);
  assert.equal(fs.existsSync(file), false);
});

/* ---------- files.cjs ---------- */

test('freeFile names: default with time, cleaned, and never overwriting', () => {
  const root = tmp();
  const dflt = freeFile(root, 'rec', undefined, 'recording', 'mov');
  assert.match(path.basename(dflt), /^recording-\d{4}-\d\d-\d\dT[\d-]+Z\.mov$/);
  assert.equal(path.dirname(dflt), path.join(root, 'rec'));
  const a = freeFile(root, 'rec', '../My Rec!.mov', 'recording', 'mov');
  assert.equal(path.basename(a), 'My-Rec.mov');
  assert.equal(path.basename(freeFile(root, 'rec', '../My Rec!.mov', 'recording', 'mov')), 'My-Rec-2.mov');
  assert.equal(path.basename(freeFile(root, 'rec', 'My Rec!', 'recording', 'mov')), 'My-Rec-3.mov');
  assert.equal(fs.statSync(a).mode & 0o777, 0o600);
  assert.equal(cleanName(null, 'mov'), '');
  assert.equal(path.basename(freeFile(root, 'rec', '...', 'x', 'mov')).startsWith('x-'), true);
});

test('freeFile rethrows an error that is not "taken"', { skip: process.getuid?.() === 0 }, () => {
  const root = tmp();
  freeFile(root, 'ro', 'one', 'x', 'mov');
  fs.chmodSync(path.join(root, 'ro'), 0o500);
  after(() => fs.chmodSync(path.join(root, 'ro'), 0o700));
  assert.throws(
    () => freeFile(root, 'ro', 'two', 'x', 'mov'),
    (e: any) => e.code === 'EACCES',
  );
});

/* ---------- videoRecorder ---------- */

function makeTab(over: Record<string, unknown> = {}) {
  const dbg = new EventEmitter();
  const calls: string[] = [];
  const tab: any = {
    chatId: 'c',
    url: 'https://a.test/',
    backend: { debugger: dbg },
    password: false,
    failStart: false,
    failStop: false,
    calls,
    send(method: string) {
      calls.push(method);
      if (method === 'Runtime.evaluate') return Promise.resolve({ result: { value: tab.password } });
      if (method === 'Page.startScreencast' && tab.failStart) return Promise.reject(new Error('no start'));
      if (method === 'Page.stopScreencast' && tab.failStop) return Promise.reject(new Error('no stop'));
      return Promise.resolve({});
    },
    ...over,
  };
  return { tab, dbg, calls };
}
const emit = (dbg: EventEmitter, buf: Buffer, sessionId?: string, method = 'Page.screencastFrame') =>
  dbg.emit('message', {}, method, { sessionId: 7, data: buf.toString('base64') }, sessionId);
const count = (calls: string[], m: string) => calls.filter((c) => c === m).length;

async function setup(o: Record<string, unknown> = {}, tabOver: Record<string, unknown> = {}) {
  let t = 1000;
  const clock = { set: (n: number) => (t = n) };
  const rec = new VideoRecorder({ now: () => t, ...o });
  const { tab, dbg, calls } = makeTab(tabOver);
  const file = freeFile(tmp(), 'rec', null, 'recording', 'mov');
  const before = await rec.start('c', tab, file);
  return { rec, tab, dbg, calls, file, clock, before };
}

test('start probes the page, casts once, acknowledges and records frames', async () => {
  const { rec, tab, dbg, calls, clock, before } = await setup();
  assert.equal(before, null);
  assert.equal(count(calls, 'Runtime.evaluate'), 1);
  assert.equal(count(calls, 'Page.startScreencast'), 1);
  await rec.touch(tab);
  assert.equal(count(calls, 'Page.startScreencast'), 1);
  clock.set(1100);
  emit(dbg, jpeg(64, 48));
  emit(dbg, jpeg(64, 48), 'child');
  emit(dbg, jpeg(64, 48), undefined, 'Page.other');
  assert.equal(count(calls, 'Page.screencastFrameAck'), 1);
  clock.set(1110); // within the gap: dropped
  emit(dbg, jpeg(64, 48));
  clock.set(1200);
  emit(dbg, jpeg(64, 48));
  const out = rec.stop('c');
  assert.equal(out.saved.frames, 2);
  assert.equal(out.skipped, 0);
  assert.equal(out.why, null);
  assert.equal(rec.stop('c'), null);
  await tick();
  assert.equal(count(calls, 'Page.stopScreencast'), 1);
});

test('frames are skipped, counted, on pages that must not be recorded', async () => {
  const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
    ['risky', { riskOf: () => ({ level: 'high' }) }, {}],
    ['credentials', { riskOf: () => ({ level: 'normal', credentials: true }) }, {}],
    ['password', {}, { password: true }],
    ['signin', {}, { signin: true }],
    ['takenOver', {}, { takenOver: true }],
    ['no url', {}, { url: '' }],
  ];
  for (const [name, o, tabOver] of cases) {
    const { rec, dbg } = await setup(o, tabOver);
    emit(dbg, jpeg(64, 48));
    const out = rec.stop('c');
    assert.equal(out.saved, null, name);
    assert.equal(out.skipped, 1, name);
  }
});

test('frames are fitted to the first frame width through images', async () => {
  let width = 20;
  let fail = false;
  const resized: number[] = [];
  const images = {
    fromBuffer: () => {
      if (fail) throw new Error('bad image');
      return {
        getSize: () => ({ width }),
        resize: (o: { width: number }) => (resized.push(o.width), { toJPEG: () => jpeg(o.width, 10) }),
      };
    },
  };
  const { rec, dbg, clock } = await setup({ images });
  emit(dbg, jpeg(20, 10)); // first frame: nothing to fit to
  clock.set(1100);
  width = 30;
  emit(dbg, jpeg(30, 10)); // wider: resized
  clock.set(1200);
  width = 20;
  emit(dbg, jpeg(20, 10)); // same: kept
  clock.set(1300);
  fail = true;
  emit(dbg, jpeg(20, 10)); // image failure: skipped
  const out = rec.stop('c');
  assert.deepEqual(resized, [20]);
  assert.equal(out.saved.frames, 3);
  assert.equal(out.skipped, 1);
});

test('a frame that is no JPEG is skipped', async () => {
  const { rec, dbg } = await setup();
  emit(dbg, Buffer.from('definitely not a jpeg image'));
  assert.equal(rec.stop('c').skipped, 1);
});

test('the time and size caps end the recording and the next call is told once', async () => {
  const a = await setup({ maxMs: 1000 });
  a.clock.set(2500);
  emit(a.dbg, jpeg(64, 48));
  assert.equal(a.rec.stop('c'), null);
  const endedA = a.rec.takeEnded('c');
  assert.equal(endedA.why, 'it reached 10 minutes');
  assert.equal(endedA.saved, null);
  assert.equal(a.rec.takeEnded('c'), null);

  const b = await setup({ maxBytes: 10 });
  emit(b.dbg, jpeg(64, 48));
  const endedB = b.rec.takeEnded('c');
  assert.equal(endedB.why, 'it reached 512 MB');
  assert.equal(endedB.saved.frames, 1);
  assert.equal(b.rec.stop('c'), null);

  // a recording the chat no longer holds is finished by whoever stopped it
  const c = await setup({ maxMs: 1000 });
  const stale = c.rec.chats.get('c');
  c.rec.stop('c');
  c.clock.set(5000);
  c.rec.frame(stale, jpeg(64, 48));
  assert.equal(c.rec.takeEnded('c'), null);
});

test('endTurn keeps the saved recording for the next call; with none it does nothing', async () => {
  const { rec, dbg } = await setup();
  rec.endTurn('none');
  assert.equal(rec.takeEnded('none'), null);
  emit(dbg, jpeg(64, 48));
  rec.endTurn('c');
  const ended = rec.takeEnded('c');
  assert.equal(ended.why, 'the turn ended');
  assert.equal(ended.saved.frames, 1);
});

test('start while recording finishes and returns the previous recording', async () => {
  const { rec, dbg, tab } = await setup();
  emit(dbg, jpeg(64, 48));
  const before = await rec.start('c', tab, freeFile(tmp(), 'rec', null, 'recording', 'mov'));
  assert.equal(before.saved.frames, 1);
  assert.equal(rec.stop('c').saved, null);
});

test('a detached debugger is cast again on the next touch; a new debugger replaces the listeners', async () => {
  const { rec, tab, dbg, calls } = await setup();
  dbg.emit('detach');
  await rec.touch(tab);
  assert.equal(count(calls, 'Page.startScreencast'), 2);
  assert.equal(dbg.listenerCount('message'), 1);

  const next = new EventEmitter();
  tab.backend.debugger = next;
  await rec.touch(tab);
  assert.equal(dbg.listenerCount('message'), 0);
  assert.equal(dbg.listenerCount('detach'), 0);
  assert.equal(next.listenerCount('message'), 1);
  assert.equal(count(calls, 'Page.stopScreencast'), 1);
  assert.equal(count(calls, 'Page.startScreencast'), 3);

  // a debugger that cannot drop listeners, then none at all
  const odd: any = new EventEmitter();
  odd.removeListener = undefined;
  tab.backend.debugger = odd;
  await rec.touch(tab);
  tab.backend.debugger = { on: () => {} };
  await rec.touch(tab);
  tab.backend = undefined;
  await rec.touch(tab);
  tab.backend = {};
  await rec.touch(tab);
  rec.stop('c');
});

test('a frame arriving after the recording stopped is acknowledged but not recorded', async () => {
  const { rec, dbg, calls } = await setup();
  dbg.removeListener = () => dbg; // the listeners stay, as with a debugger that ignores removal
  const saved = rec.chats.get('c');
  rec.stop('c');
  emit(dbg, jpeg(64, 48));
  assert.equal(count(calls, 'Page.screencastFrameAck'), 1);
  assert.equal(saved.skipped, 0);
  assert.equal(saved.last, 0);
});

test('screencast start and stop failures are tolerated', async () => {
  const { rec, tab, calls } = await setup({}, { failStart: true });
  await tick();
  assert.equal(count(calls, 'Page.startScreencast'), 1);
  tab.failStart = false;
  await rec.touch(tab); // the failed start is tried again
  assert.equal(count(calls, 'Page.startScreencast'), 2);
  await rec.touch(tab);
  assert.equal(count(calls, 'Page.startScreencast'), 2);
  tab.failStop = true;
  assert.equal(rec.stop('c').saved, null);
  await tick();
  assert.equal(count(calls, 'Page.stopScreencast'), 1);
});

test('touch on an unrecorded tab does nothing and a throwing tab is caught', async () => {
  const { rec, tab, calls } = await setup();
  const before = calls.length;
  await rec.touch(makeTab().tab);
  assert.equal(calls.length, before);
  Object.defineProperty(tab, 'backend', {
    get() {
      throw new Error('gone');
    },
  });
  await rec.touch(tab);
  rec.chats.get('c').casting = false;
  rec.chats.get('c').dbg = null;
  rec.stop('c');
});
