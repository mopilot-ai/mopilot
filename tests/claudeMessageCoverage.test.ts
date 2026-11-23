// Image conversion behind Claude messages (electron/harness/claude/message.cjs): sips on macOS, Electron's
// nativeImage elsewhere or when sips fails, and the attachment kinds that change the typed text.
// sips (asynchronous execFile) and Electron are faked; nothing is spawned.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const sips: { calls: string[][]; fail: boolean; timeouts: number[] } = { calls: [], fail: false, timeouts: [] };
mock.module('node:child_process', {
  namedExports: {
    execFile: (bin: string, args: string[], opts: { timeout: number }, done: (error: Error | null) => void) => {
      sips.calls.push([bin, ...args]);
      sips.timeouts.push(opts.timeout);
      // answered later, as a real child process is
      setImmediate(() => {
        if (sips.fail) return done(new Error('sips failed'));
        fs.writeFileSync(args[args.length - 1], 'sips-png');
        done(null);
      });
    },
  },
});
const native: { mode: 'ok' | 'empty' | 'throw'; paths: string[] } = { mode: 'ok', paths: [] };
mock.module('electron', {
  namedExports: {
    nativeImage: {
      createFromPath: (p: string) => {
        native.paths.push(p);
        if (native.mode === 'throw') throw new Error('no electron');
        return { isEmpty: () => native.mode === 'empty', toPNG: () => Buffer.from('native-png') };
      },
    },
  },
});

const { buildClaudeMessage, claudeMessage, hasImages, readImage, imageDataUrl } = createRequire(import.meta.url)(
  '../electron/harness/claude/message.cjs',
);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sage-claude-msg-'));
const heic = path.join(dir, 'photo.heic');
fs.writeFileSync(heic, 'heic-bytes');
const b64 = (s: string) => Buffer.from(s).toString('base64');
const realPlatform = process.platform;
const setPlatform = (p: string) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
const reset = (platform: string) => {
  setPlatform(platform);
  sips.calls = [];
  sips.timeouts = [];
  sips.fail = false;
  native.mode = 'ok';
  native.paths = [];
};

test('on macOS a HEIC is converted with sips and its scratch folder is removed', async (t) => {
  t.after(() => setPlatform(realPlatform));
  reset('darwin');
  assert.deepEqual(await readImage(heic), { type: 'base64', media_type: 'image/png', data: b64('sips-png') });
  assert.equal(sips.calls.length, 1);
  assert.deepEqual(sips.timeouts, [20000]);
  assert.deepEqual(sips.calls[0].slice(0, 5), ['/usr/bin/sips', '-s', 'format', 'png', heic]);
  assert.equal(native.paths.length, 0);
  assert.ok(!fs.existsSync(path.dirname(sips.calls[0][sips.calls[0].length - 1])));
});

test('when sips fails, nativeImage converts it; an image it cannot read is not attached', async (t) => {
  t.after(() => setPlatform(realPlatform));
  reset('darwin');
  sips.fail = true;
  assert.deepEqual(await readImage(heic), { type: 'base64', media_type: 'image/png', data: b64('native-png') });
  assert.deepEqual(native.paths, [heic]);
  native.mode = 'empty';
  assert.equal(await readImage(heic), null);
  native.mode = 'throw';
  assert.equal(await readImage(heic), null);
});

test('off macOS sips is never run', async (t) => {
  t.after(() => setPlatform(realPlatform));
  reset('linux');
  assert.deepEqual(await readImage(heic), { type: 'base64', media_type: 'image/png', data: b64('native-png') });
  assert.equal(sips.calls.length, 0);
});

test('a missing API-type image reads as null', async () => {
  assert.equal(await readImage(path.join(dir, 'gone.png')), null);
});

test('a conversion leaves main free while sips runs', async (t) => {
  t.after(() => setPlatform(realPlatform));
  reset('darwin');
  const reading = readImage(heic);
  // other work in main runs while sips is still converting
  let turned = false;
  setImmediate(() => {
    turned = true;
  });
  assert.equal((await reading).data, b64('sips-png'));
  assert.ok(turned);
});

test('a message reads each image once, in the order attached, before it is built', async () => {
  const order: string[] = [];
  const read = async (p: string) => {
    order.push(p);
    await new Promise((resolve) => setImmediate(resolve));
    return p === '/x/bad.heic' ? null : { type: 'base64', media_type: 'image/png', data: path.basename(p) };
  };
  const m = await claudeMessage(
    {
      text: 'look',
      attachments: [
        { kind: 'image', path: '/x/a.heic' },
        { kind: 'file', path: '/x/f.ts' },
        { kind: 'image', path: '/x/bad.heic', name: 'bad.heic' },
        { kind: 'image', path: '/x/a.heic' },
      ],
    },
    read,
  );
  assert.deepEqual(order, ['/x/a.heic', '/x/bad.heic']);
  assert.deepEqual(
    m.content.map((b: any) => (b.type === 'image' ? b.source.data : b.text)),
    ['a.heic', 'a.heic', "look\n@/x/f.ts\n[bad.heic couldn't be attached]"],
  );
  assert.deepEqual(await claudeMessage({ text: 'plain' }), { role: 'user', content: 'plain' });
});

test('only an image attachment makes a message wait for reads', () => {
  assert.equal(hasImages({ text: 'x', attachments: [{ kind: 'image', path: '/a.heic' }] }), true);
  assert.equal(hasImages({ text: 'x', attachments: [{ kind: 'file', path: '/a.ts' }, null] }), false);
  assert.equal(hasImages({ text: 'x' }), false);
  assert.equal(hasImages(undefined), false);
});

test('a message built with no images read names each image as not attached', () => {
  assert.equal(
    buildClaudeMessage({ text: 'hi', attachments: [{ kind: 'image', path: '/a/x.png' }] }).content,
    "hi\n[x.png couldn't be attached]",
  );
});

test('a skill becomes the slash command; an unnamed unreadable image is named by its file', () => {
  const m = buildClaudeMessage(
    {
      text: 'go',
      attachments: [
        { kind: 'skill', name: 'review' },
        { kind: 'image', path: '/x/shot.webp' },
        { kind: 'session', path: 's1', name: 'Old chat', text: 'earlier' },
      ],
    },
    () => null,
  );
  assert.match(m.content, /^<sage-chat-context>\n/);
  assert.match(m.content, /"conversation":"earlier"/);
  assert.ok(m.content.endsWith("/review go\n[shot.webp couldn't be attached]"));
});

test('an image with no text sends only the image; a selection without text is an empty selection', () => {
  const src = { type: 'base64', media_type: 'image/png', data: 'x' };
  assert.deepEqual(
    buildClaudeMessage({ text: undefined as any, attachments: [{ kind: 'image', path: '/a.png' }] }, () => src),
    { role: 'user', content: [{ type: 'image', source: src }] },
  );
  const sel = buildClaudeMessage({ text: 'q', attachments: [{ kind: 'selection' }] }, () => src);
  assert.match(sel.content, /<selected-text>\n\[""\]\n<\/selected-text>/);
});

test('an ACP image is a data URL of an API type: kept as is, converted to PNG, or nothing', async (t) => {
  t.after(() => setPlatform(realPlatform));
  reset('darwin');
  const jpg = path.join(dir, 'shot.JPG');
  fs.writeFileSync(jpg, 'jpeg-bytes');
  assert.equal(await imageDataUrl(jpg), `data:image/jpeg;base64,${b64('jpeg-bytes')}`);
  // not image/heic, which the model APIs refuse
  assert.equal(await imageDataUrl(heic), `data:image/png;base64,${b64('sips-png')}`);
  assert.equal(await imageDataUrl(path.join(dir, 'gone.png')), null);
});
