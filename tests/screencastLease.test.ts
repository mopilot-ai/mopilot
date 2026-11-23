// A tab's CDP screencast shared by its recorders (browser/screencastLease.cjs, #3752): the turn trace, browser_record and the GIF recorder start it with the first and stop it with the last, in either order, per tab, across detaches and failures.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { TurnTraces } = require('../electron/capabilities/browser/devtools/turnTrace.cjs');
const { VideoRecorder } = require('../electron/capabilities/browser/devtools/videoRecorder.cjs');
const { GifRecorder } = require('../electron/capabilities/browser/gifRecorder.cjs');
const lease = require('../electron/capabilities/browser/screencastLease.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-'));
  dirs.push(d);
  return d;
};
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11, 8, 0, 40, 0, 64, 1, 1, 0x11, 0, 0xff, 0xd9]);
const tick = () => new Promise((r) => setTimeout(r, 5));

/** A tab whose fake CDP casts as the real one does: one screencast per tab, any stop ends it for everyone. */
function castTab(id: string, chatId = 'c') {
  const dbg = new EventEmitter();
  const tab: any = {
    id,
    chatId,
    url: 'https://a.example/',
    backend: { debugger: dbg },
    casting: false,
    starts: 0,
    failStart: false,
    send: async (method: string) => {
      if (method === 'Runtime.evaluate') return { result: { value: false } };
      if (method === 'Page.startScreencast') {
        if (tab.failStart) throw new Error('no start');
        tab.casting = true;
        tab.starts++;
      }
      if (method === 'Page.stopScreencast') tab.casting = false;
      return {};
    },
  };
  /** a frame as CDP sends it: only while casting */
  tab.frame = () => {
    if (tab.casting) dbg.emit('message', {}, 'Page.screencastFrame', { data: jpeg().toString('base64'), sessionId: 1 }, '');
  };
  return tab;
}

function rig() {
  let clock = 1_700_000_000_000;
  const root = tmp();
  const traces = new TurnTraces({ enabled: () => true, root: (c: string) => path.join(root, c), now: () => clock, onSaved: () => {} });
  const video = new VideoRecorder({ now: () => clock, gapMs: 0 });
  const advance = () => (clock += 500);
  const frame = (tab: any) => {
    advance();
    tab.frame();
  };
  const explicit = async (chat: string, tab: any) =>
    video.start(chat, tab, '', { add: () => true, finish: () => ({ frames: 1 }), width: 64, bytes: 0 });
  return { traces, video, frame, explicit, frames: (chat: string) => traces.chats.get(chat)?.frames.frames.length ?? 0 };
}

test('an explicit recording that stops mid-turn leaves the turn trace casting', async () => {
  const { traces, video, frame, explicit, frames } = rig();
  const tab = castTab('t1');
  await traces.touch(tab);
  await explicit('other', tab);
  frame(tab);
  assert.equal(frames('c'), 1);
  video.stop('other');
  await tick();
  assert.equal(tab.casting, true);
  frame(tab);
  assert.equal(frames('c'), 2);
  await traces.touch(tab);
  assert.equal(tab.starts, 1);
  await traces.endTurn('c');
  await tick();
  assert.equal(tab.casting, false);
});

test('a turn that ends while an explicit recording runs leaves the recording casting', async () => {
  const { traces, video, frame, explicit } = rig();
  const tab = castTab('t1');
  await explicit('other', tab);
  await traces.touch(tab);
  await traces.endTurn('c');
  await tick();
  assert.equal(tab.casting, true);
  const counted: number[] = [];
  frame(tab);
  assert.equal(video.stop('other')?.saved.frames, 1);
  counted.push(1);
  await tick();
  assert.equal(tab.casting, false);
});

test('tabs are isolated: stopping one tab leaves another tab casting', async () => {
  const { traces, video, explicit } = rig();
  const a = castTab('a', 'c');
  const b = castTab('b', 'other');
  await traces.touch(a);
  await explicit('other', b);
  video.stop('other');
  await tick();
  assert.equal(b.casting, false);
  assert.equal(a.casting, true);
});

test('the GIF recorder and the video recorder share a tab the same way', async () => {
  const { video, explicit } = rig();
  const gif = new GifRecorder({ images: null });
  const tab = castTab('t1');
  gif.start('c');
  await gif.touch(tab);
  await explicit('c', tab);
  assert.equal(tab.starts, 1);
  video.stop('c');
  await tick();
  assert.equal(tab.casting, true);
  gif.stop('c');
  await tick();
  assert.equal(tab.casting, false);
  gif.start('c');
  await gif.touch(tab);
  gif.clear('c');
  await tick();
  assert.equal(tab.casting, false);
});

test('a detached debugger is cast again once for every holder; a failed start is retried', async () => {
  const { traces, video, explicit } = rig();
  const tab = castTab('t1');
  await traces.touch(tab);
  await explicit('other', tab);
  tab.casting = false;
  tab.backend.debugger.emit('detach');
  await traces.touch(tab);
  await video.touch(tab);
  assert.equal(tab.starts, 2);
  assert.equal(tab.casting, true);

  const bad = castTab('t2');
  bad.failStart = true;
  const gif = new GifRecorder({ images: null });
  gif.start('c');
  await gif.touch(bad);
  await tick();
  bad.failStart = false;
  await gif.touch(bad);
  await tick();
  assert.equal(bad.casting, true);
  gif.stop('c');
});

test('lease edge cases: release by a non-holder or on an unknown tab, a failed start, detach on an unknown tab', async () => {
  const tab = castTab('t1');
  const a = {};
  lease.release(tab, a);
  lease.detached(tab);
  lease.acquire(tab, a, {});
  lease.release(tab, {});
  assert.equal(tab.casting, true);
  lease.release(tab, a);
  await tick();
  assert.equal(tab.casting, false);

  const bad = castTab('t2');
  bad.failStart = true;
  lease.acquire(bad, a, {});
  await tick();
  lease.release(bad, a);
  await tick();
  assert.equal(bad.casting, false);
});

test('a GIF recording whose debugger detached or start failed no longer holds the tab (review finding)', async () => {
  const { traces } = rig();
  const gif = new GifRecorder({ images: null });
  const tab = castTab('t1');
  gif.start('c');
  await gif.touch(tab);
  tab.casting = false;
  tab.backend.debugger.emit('detach');
  gif.stop('c');
  await traces.touch(tab);
  assert.equal(tab.casting, true);
  await traces.endTurn('c');
  await tick();
  assert.equal(tab.casting, false);

  const bad = castTab('t2');
  bad.failStart = true;
  gif.start('c');
  await gif.touch(bad);
  await tick();
  gif.stop('c');
  bad.failStart = false;
  await traces.touch(bad);
  await traces.endTurn('c');
  await tick();
  assert.equal(bad.casting, false);
});

test('a start that fails after a newer start began leaves the newer one standing', async () => {
  const tab = castTab('t1');
  const a = {};
  let fail: (e: Error) => void = () => {};
  let n = 0;
  tab.send = async (method: string) => {
    if (method === 'Page.startScreencast' && n++ === 0) return new Promise((_, rej) => (fail = rej));
    if (method === 'Page.startScreencast') tab.casting = true;
    if (method === 'Page.stopScreencast') tab.casting = false;
    return {};
  };
  let failed = 0;
  lease.acquire(tab, a, {}, () => failed++);
  lease.detached(tab);
  lease.acquire(tab, a, {}, () => failed++);
  fail(new Error('detached'));
  await tick();
  assert.equal(failed, 0);
  lease.release(tab, a);
  await tick();
  assert.equal(tab.casting, false);
});
