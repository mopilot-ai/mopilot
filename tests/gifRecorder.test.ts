// browser_gif_creator (gifRecorder.cjs, gifEncode.cjs): the GIF decodes back to the frames' palette colors with only the changed box per frame, frames come from tool calls and the screencast within their bounds, risky pages are left out, and the tool's actions on both surfaces.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { makeTabs, OriginGrants } from './support/browser-host-tools/fixture.ts';
import { tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { encodeGif, lzw, PALETTE } = require('../electron/capabilities/browser/gifEncode.cjs');
const { GifRecorder, writeGif, SUBFOLDER } = require('../electron/capabilities/browser/gifRecorder.cjs');
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { createChromeTools } = require('../electron/capabilities/browser/chromeTools.cjs');

const dirs: string[] = [];
after(() => {
  for (const d of dirs.reverse()) {
    fs.chmodSync(d, 0o700);
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gif-'));
  dirs.push(d);
  return d;
};

/* ---------- a GIF decoder, enough to read back what encodeGif writes ---------- */

function unlzw(min: number, data: number[], count: number) {
  const out: number[] = [];
  let size = min + 1;
  const clear = 1 << min;
  let dict: number[][] = [];
  const reset = () => {
    dict = Array.from({ length: clear + 2 }, (_, i) => [i]);
    size = min + 1;
  };
  reset();
  let prev: number[] | null = null;
  let bit = 0;
  for (;;) {
    let code = 0;
    for (let i = 0; i < size; i++) code |= ((data[(bit + i) >> 3] >> ((bit + i) & 7)) & 1) << i;
    bit += size;
    if (code === clear) {
      reset();
      prev = null;
      continue;
    }
    if (code === clear + 1) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else entry = [...(prev as number[]), (prev as number[])[0]];
    out.push(...entry);
    if (prev) dict.push([...prev, entry[0]]);
    prev = entry;
    if (dict.length === 1 << size && size < 12) size++;
  }
  assert.equal(out.length, count);
  return out;
}

function decode(gif: Buffer) {
  assert.equal(gif.subarray(0, 6).toString(), 'GIF89a');
  const w = gif.readUInt16LE(6);
  const h = gif.readUInt16LE(8);
  let i = 13 + 256 * 3;
  const frames: any[] = [];
  let delay = 0;
  let loops = false;
  for (;;) {
    const b = gif[i++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = gif[i++];
      if (label === 0xf9) delay = gif.readUInt16LE(i + 2);
      if (label === 0xff) loops = gif.subarray(i + 1, i + 12).toString() === 'NETSCAPE2.0';
      while (gif[i]) i += gif[i] + 1;
      i++;
      continue;
    }
    assert.equal(b, 0x2c);
    const box = { x: gif.readUInt16LE(i), y: gif.readUInt16LE(i + 2), w: gif.readUInt16LE(i + 4), h: gif.readUInt16LE(i + 6) };
    i += 9;
    const min = gif[i++];
    const data: number[] = [];
    while (gif[i]) {
      data.push(...gif.subarray(i + 1, i + 1 + gif[i]));
      i += gif[i] + 1;
    }
    i++;
    frames.push({ box, delay, px: unlzw(min, data, box.w * box.h) });
  }
  return { w, h, frames, loops };
}

const rgbOf = (index: number) => [PALETTE[index * 3], PALETTE[index * 3 + 1], PALETTE[index * 3 + 2]];
/** A solid BGRA frame. */
const solid = (width: number, height: number, [r, g, b]: number[], delayMs = 100) => {
  const bgra = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) bgra.set([b, g, r, 255], p * 4);
  return { width, height, bgra, delayMs };
};

test('encodeGif: solid frames decode to their exact palette colors; each frame after the first carries only what changed', async () => {
  const red = solid(8, 6, [255, 0, 0], 200);
  const blue = solid(8, 6, [0, 0, 255], 300);
  // a frame that changes one 2x1 box of the blue one
  const patch = solid(8, 6, [0, 0, 255], 120);
  for (const x of [3, 4]) patch.bgra.set([0, 255, 0, 255], (2 * 8 + x) * 4);
  // the same as the frame before: shows it longer
  const same = { ...patch, delayMs: 80 };
  const small = solid(4, 3, [255, 255, 255], 5);
  const { gif, width, height, frames } = await encodeGif([red, blue, patch, same, small]);
  assert.deepEqual([width, height, frames], [8, 6, 4]);
  const d = decode(gif);
  assert.equal(d.loops, true);
  assert.deepEqual([d.w, d.h], [8, 6]);
  assert.deepEqual(
    d.frames.map((f) => [f.box, f.delay]),
    [
      [{ x: 0, y: 0, w: 8, h: 6 }, 20],
      [{ x: 0, y: 0, w: 8, h: 6 }, 30],
      [{ x: 3, y: 2, w: 2, h: 1 }, 20],
      // a smaller frame (another tab) is drawn over black: the whole screen changes (5 ms shows as 20 ms, the shortest)
      [{ x: 0, y: 0, w: 8, h: 6 }, 2],
    ],
  );
  assert.deepEqual(rgbOf(d.frames[0].px[0]), [255, 0, 0]);
  assert.deepEqual(rgbOf(d.frames[1].px[47]), [0, 0, 255]);
  assert.deepEqual(d.frames[2].px.map(rgbOf), [
    [0, 255, 0],
    [0, 255, 0],
  ]);
  assert.deepEqual(rgbOf(d.frames[3].px[0]), [255, 255, 255]);
  assert.deepEqual(rgbOf(d.frames[3].px[47]), [0, 0, 0]);
});

test('encodeGif: a frame larger than one dictionary (4096 codes) round-trips through the clear code; a frame wider than the screen part is cut', async () => {
  const width = 120;
  const height = 90;
  const bgra = new Uint8Array(width * height * 4);
  let seed = 7;
  for (let p = 0; p < bgra.length; p++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bgra[p] = seed >> 16;
  }
  const noise = { width, height, bgra, delayMs: 100 };
  const { gif } = await encodeGif([noise], { yieldEvery: async () => undefined });
  const d = decode(gif);
  assert.equal(d.frames[0].px.length, width * height);
  // a frame is indexed only inside the screen: with a smaller screen nothing past its edge is read
  const out = await encodeGif([solid(2, 2, [0, 0, 0]), { ...noise, delayMs: 10 }]);
  assert.deepEqual([out.width, out.height], [width, height]);
  // lzw alone: one index still ends the stream
  assert.ok(lzw(new Uint8Array([5])).length > 3);
});

/* ---------- the recorder ---------- */

/** Fake nativeImage: the buffer is JSON {w, h, rgb}; toBitmap fills that color. */
const images = {
  fromBuffer: (buf: Buffer) => {
    const m = JSON.parse(buf.toString());
    const img: any = {
      getSize: () => ({ width: m.w, height: m.h }),
      resize: ({ width }: { width: number }) =>
        images.fromBuffer(Buffer.from(JSON.stringify({ ...m, w: width, h: Math.round((m.h * width) / m.w) }))),
      toJPEG: () => Buffer.from(JSON.stringify(m)),
      toBitmap: () => solid(m.w, m.h, m.rgb).bgra,
    };
    return img;
  },
};
const shot = (w: number, h: number, rgb = [255, 0, 0]) => Buffer.from(JSON.stringify({ w, h, rgb })).toString('base64');

function fakeTab(o: any = {}) {
  const dbg = new EventEmitter();
  const sent: any[] = [];
  const tab: any = {
    id: o.id ?? 't1',
    chatId: o.chatId ?? 'c1',
    url: o.url ?? 'https://a.example/',
    wc: { debugger: dbg },
    get backend() {
      return this.wc;
    },
    sent,
    fail: {} as Record<string, Error>,
    send: async (method: string, params?: any) => {
      sent.push([method, params]);
      if (tab.fail[method]) throw tab.fail[method];
      if (method === 'Runtime.evaluate') return { result: { value: !!tab.password } };
      return method === 'Page.captureScreenshot' ? { data: tab.shot ?? shot(1280, 800) } : {};
    },
  };
  return tab;
}
const frame = (dbg: EventEmitter, data: string, sessionId = '') =>
  dbg.emit('message', {}, 'Page.screencastFrame', { data, sessionId: 9 }, sessionId);

test('recorder: a tool call adds its tab frame and starts its screencast; frames are throttled, shrunk, halved past the cap, and left out on risky pages', async () => {
  let now = 1000;
  const rec = new GifRecorder({
    images,
    now: () => now,
    maxFrames: 4,
    riskOf: (url: string) =>
      url.includes('bank') ? { level: 'high' } : url.includes('@') ? { level: 'normal', credentials: true } : { level: 'normal' },
  });
  const tab = fakeTab();
  // nothing records yet
  await rec.touch(tab);
  assert.deepEqual(tab.sent, []);
  assert.equal(rec.start('c1'), 0);
  await rec.touch(tab);
  assert.deepEqual(
    tab.sent.map((s: any) => s[0]),
    ['Page.startScreencast', 'Runtime.evaluate', 'Page.captureScreenshot'],
  );
  const s = rec.chats.get('c1');
  // a 1280-wide capture is kept at 640
  assert.equal(JSON.parse(s.frames[0].jpeg.toString()).w, 640);
  // the screencast's frames: acknowledged, and a burst inside the gap keeps its last
  now += 50;
  frame(tab.wc.debugger, shot(640, 400, [0, 0, 255]));
  assert.equal(s.frames.length, 1);
  assert.deepEqual(JSON.parse(s.frames[0].jpeg.toString()).rgb, [0, 0, 255]);
  assert.deepEqual(tab.sent.at(-1), ['Page.screencastFrameAck', { sessionId: 9 }]);
  // a child session's frame and other events are not this tab's screencast
  frame(tab.wc.debugger, shot(10, 10), 'child');
  tab.wc.debugger.emit('message', {}, 'Page.loadEventFired', {}, '');
  // a second touch doesn't start a second screencast
  now += 200;
  await rec.touch(tab);
  assert.equal(tab.sent.filter((x: any) => x[0] === 'Page.startScreencast').length, 1);
  for (let i = 0; i < 4; i++) {
    now += 200;
    frame(tab.wc.debugger, shot(640, 400));
  }
  // the fifth frame went past the cap of 4: every other one went (the last stays), then the sixth came
  assert.equal(s.frames.length, 4);
  assert.equal(s.frames.at(-1).at, now);
  // a risky page, a page with credentials and sign-in are left out, both from touches and from the screencast
  const before = s.frames.length;
  tab.url = 'https://bank.example/';
  now += 200;
  await rec.touch(tab);
  frame(tab.wc.debugger, shot(10, 10));
  tab.url = 'https://u:p@a.example/';
  await rec.touch(tab);
  tab.url = 'https://a.example/';
  tab.signin = true;
  await rec.touch(tab);
  tab.url = '';
  tab.signin = false;
  await rec.touch(tab);
  // a tab the user took over, and a page with a password field (until a call finds none there)
  tab.url = 'https://a.example/';
  tab.takenOver = true;
  await rec.touch(tab);
  tab.takenOver = false;
  tab.password = true;
  await rec.touch(tab);
  frame(tab.wc.debugger, shot(10, 10));
  tab.password = false;
  assert.equal(s.frames.length, before);
  assert.equal(s.skipped, 8);
  // a failed capture is noted, never thrown; a failed screencast start lets the next touch try again
  tab.url = 'https://a.example/';
  tab.fail['Page.captureScreenshot'] = new Error('gone');
  await rec.touch(tab);
  const other = fakeTab({ id: 't2' });
  other.fail['Page.startScreencast'] = new Error('no');
  await rec.touch(other);
  await flush();
  assert.equal(s.casting.has(other), false);
  // a failed ack is noted too
  tab.fail['Page.screencastFrameAck'] = new Error('detached');
  frame(tab.wc.debugger, shot(10, 10));
  await flush();
  // the debugger went: the screencast went with it, and the next touch starts it again
  tab.wc.debugger.emit('detach');
  assert.equal(s.casting.size, 0);
  delete tab.fail['Page.captureScreenshot'];
  await rec.touch(tab);
  assert.equal(tab.sent.filter((x: any) => x[0] === 'Page.startScreencast').length, 2);
  // a frame after stop is acknowledged but not kept
  const kept = s.frames.length;
  rec.stop('c1');
  assert.deepEqual(tab.sent.at(-1), ['Page.stopScreencast', undefined]);
  frame(tab.wc.debugger, shot(10, 10));
  assert.equal(s.frames.length, kept);
  // a tab without a debugger still gets frames from its tool calls
  rec.start('c1');
  const bare = fakeTab();
  delete bare.wc;
  await rec.touch(bare);
  assert.equal(rec.chats.get('c1').frames.length, 1);
});

test('recorder: start drops an earlier recording, stop and clear end it, and at most ten chats keep one', async () => {
  const rec = new GifRecorder({ images });
  const tab = fakeTab();
  rec.start('c1');
  await rec.touch(tab);
  assert.equal(rec.start('c1'), 1);
  // the earlier screencast was stopped
  assert.ok(tab.sent.some((x: any) => x[0] === 'Page.stopScreencast'));
  assert.equal(rec.stop('nobody'), null);
  tab.fail['Page.stopScreencast'] = new Error('detached');
  await rec.touch(tab);
  rec.clear('c1');
  await flush();
  assert.equal(rec.chats.has('c1'), false);
  for (let i = 0; i < 11; i++) rec.start(`chat${i}`);
  assert.equal(rec.chats.size, 10);
  assert.equal(rec.chats.has('chat0'), false);
});

test('recorder: export writes the GIF in recordings/ under a free name, cuts long pauses, shrinks wide frames and halves the frames when the GIF is too large', async () => {
  let now = 0;
  const rec = new GifRecorder({ images, now: () => now, width: 64 });
  const root = tmp();
  await assert.rejects(rec.export('c1', root), { code: 'bad_args' });
  const tab = fakeTab();
  tab.shot = shot(32, 20, [0, 255, 0]);
  rec.start('c1');
  await rec.touch(tab);
  // a frame from the screencast that is wider than the recording keeps (the width changed): shrunk on export
  now += 10_000;
  frame(tab.wc.debugger, shot(128, 40, [255, 0, 0]));
  const r = await rec.export('c1', root, '../My demo!.gif');
  assert.equal(path.dirname(r.file), path.join(root, SUBFOLDER));
  assert.equal(path.basename(r.file), 'My-demo-.gif');
  // the 10 s pause shows for 4 s, the last frame for 1.5 s
  assert.deepEqual([r.frames, r.width, r.height, r.ms, r.skipped], [2, 64, 20, 5500, 0]);
  const d = decode(fs.readFileSync(r.file));
  assert.deepEqual(
    d.frames.map((f) => f.delay),
    [400, 150],
  );
  // the same name again gets -2; no name gets a time-stamped one
  assert.match(path.basename((await rec.export('c1', root, 'My demo!')).file), /^My-demo--2\.gif$/);
  assert.match(path.basename((await rec.export('c1', root)).file), /^recording-\d{4}-.*\.gif$/);
  // too large: encoded again from every other frame (the last kept) until it fits or two are left
  const tiny = new GifRecorder({ images, now: () => now, maxBytes: 10 });
  tiny.start('c1');
  for (let i = 0; i < 5; i++) {
    now += 1000;
    tab.shot = shot(
      16,
      16,
      [
        [255, 255, 255],
        [0, 0, 0],
        [255, 0, 0],
        [0, 0, 0],
        [0, 0, 255],
      ][i],
    );
    await tiny.touch(tab);
  }
  assert.equal((await tiny.export('c1', root, 'tiny')).frames, 2);
  // a folder it can't write to fails the export
  const locked = tmp();
  fs.mkdirSync(path.join(locked, SUBFOLDER));
  fs.chmodSync(path.join(locked, SUBFOLDER), 0o500);
  dirs.push(path.join(locked, SUBFOLDER));
  assert.throws(() => writeGif(locked, Buffer.from('x'), 'a'), { code: 'EACCES' });
});

test('browser_gif_creator: start, stop, export and clear through the browser_* and chrome_* tools, frames from each call past its page gate', async () => {
  const uploads = tmp();
  const grants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({ decision: 'deny' }) });
  grants.set('https://a.example', 'write');
  const tabs = makeTabs();
  tabs.o = { images };
  tabs.tab.id = 'tab_aaaaaa';
  tabs.tab.wc = tabs.tab.backend = { tabId: 7, debugger: new EventEmitter() };
  tabs.tab.send = async (method: string) =>
    method === 'Page.captureScreenshot' ? { data: shot(40, 30) } : method === 'Runtime.evaluate' ? { result: { value: false } } : {};
  const deps = { tabs, grants, folders: () => ({ uploads, downloads: uploads }) };
  const browser = createBrowserTools(deps);
  const chrome = createChromeTools(deps);
  const ctx = { chatId: 'c1', segmentId: 's1' };
  const call = (tools: any[], name: string, args: any) => tools.find((x) => x.name === name).handler(args, ctx);
  const text = (out: any[]) => out[0].text;
  // the chrome_* surface shares the host's recorder
  assert.equal(chrome.find((x: any) => x.name === 'chrome_gif_creator').schema.required.join(), 'action,tabId');
  assert.match(
    text(await call(chrome, 'chrome_gif_creator', { action: 'start_recording', tabId: 7, options: { quality: 5 } })),
    /Recording this chat's tabs, starting with 7/,
  );
  await flush();
  assert.equal(tabs.gif.chats.get('c1').frames.length, 1);
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'stop_recording' })), /Stopped recording: 1 frame kept/);
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'stop_recording' })), /Stopped recording: 1 frame kept/);
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'stop_recording', tabId: 'tab_aaaaaa' })), /1 frame kept/);
  // two frames: the count reads as a plural
  tabs.gif.chats.get('c1').frames.push({ ...tabs.gif.chats.get('c1').frames[0], at: Date.now() + 1000 });
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'stop_recording' })), /2 frames kept/);
  tabs.gif.chats.get('c1').frames.pop();
  assert.match(
    text(await call(chrome, 'chrome_gif_creator', { action: 'export', tabId: 7, download: true, filename: 'flow' })),
    /Saved a GIF of 1 frames \(40x30, 1\.5 s, 1 KB\) to .*flow\.gif\. Attach it with file_upload/,
  );
  // starting again drops what was not exported; export while recording ends the recording first
  tabs.tab.url = 'https://risky.example/';
  grants.set('https://risky.example', 'write');
  tabs.gif.riskOf = (url: string) => ({ level: url.includes('risky') ? 'high' : 'normal' });
  assert.match(
    text(await call(browser, 'browser_gif_creator', { action: 'start_recording' })),
    /earlier recording \(1 frames, not exported\) was dropped/,
  );
  // the start's frame (read after its credential probe) is of the risky page
  await flush();
  tabs.tab.url = 'https://a.example/';
  await call(browser, 'browser_gif_creator', { action: 'stop_recording' });
  await flush();
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'export' })), /1 frame was left out \(high-risk pages/);
  // export while recording: the last frame first (here a risky page, left out), then the recording ends
  await call(browser, 'browser_gif_creator', { action: 'start_recording' });
  await flush();
  tabs.tab.url = 'https://risky.example/';
  await tabs.gif.touch(tabs.tab);
  await flush();
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'export' })), /Saved a GIF of 1 frames .* 2 frames were left out/);
  assert.equal(tabs.gif.chats.get('c1').recording, false);
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'clear' })), /Cleared/);
  assert.match(text(await call(browser, 'browser_gif_creator', { action: 'stop_recording' })), /Nothing was recording/);
  await assert.rejects(call(browser, 'browser_gif_creator', { action: 'export' }), /Nothing is recorded/);
  await assert.rejects(call(browser, 'browser_gif_creator', { action: 'rewind' }), /action must be/);
  // no upload folder: saving is off
  const off = createBrowserTools({ tabs, grants });
  await call(off, 'browser_gif_creator', { action: 'start_recording' });
  await flush();
  await assert.rejects(call(off, 'browser_gif_creator', { action: 'export' }), /Saving recordings is turned off/);
});

test('the page gate feeds the recorder only for a page the chat may read', async () => {
  const { pageGates } = require('../electron/capabilities/browser/hostPageGates.cjs');
  const grants = new OriginGrants({ file: null, anchor: () => 'ask', ask: async () => ({ decision: 'deny' }) });
  grants.set('https://a.example', 'write');
  const touched: string[] = [];
  const tabs: any = { awaitUser: async (_t: any, p: any) => p, gif: { touch: async (tb: any) => void touched.push(tb.url) } };
  // the user said no to this site in this chat
  grants.denied.set('c1', new Set(['https://denied.example']));
  const { pageGate } = pageGates({ grants, tabs, live: () => undefined });
  const ctx = { chatId: 'c1', segmentId: 's1' };
  await pageGate({ url: 'https://a.example/x' }, 'read', ctx);
  await assert.rejects(pageGate({ url: 'https://denied.example/' }, 'read', ctx));
  assert.deepEqual(touched, ['https://a.example/x']);
  // no recorder: nothing to feed
  tabs.gif = null;
  await pageGate({ url: 'https://a.example/y' }, 'read', ctx);
});

test('recorder: a sign-in form in a cross-origin frame (its own session) or a frame it cannot read keeps the tab out of the recording', async () => {
  const rec = new GifRecorder({ images, now: () => 1000, riskOf: () => ({ level: 'normal' }) });
  const tab = fakeTab();
  tab.frames = new Map([['F1', {}]]);
  tab.send = async (method: string, _params: any, sessionId = '') => {
    tab.sent.push([method, sessionId]);
    if (method === 'Runtime.evaluate') {
      if (tab.frameFails) throw new Error('detached');
      return { result: { value: sessionId === 'F1' } };
    }
    return method === 'Page.captureScreenshot' ? { data: shot(640, 400) } : {};
  };
  rec.start('c1');
  await rec.touch(tab);
  assert.deepEqual(
    tab.sent.filter((s: any) => s[0] === 'Runtime.evaluate').map((s: any) => s[1]),
    ['', 'F1'],
  );
  assert.equal(tab.sent.filter((s: any) => s[0] === 'Page.captureScreenshot').length, 0);
  assert.equal(rec.chats.get('c1').skipped, 1);
  tab.frameFails = true;
  await rec.touch(tab);
  assert.equal(rec.chats.get('c1').skipped, 2, 'fails closed');
});
