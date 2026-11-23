// The look at a Host's screenshot before the app decodes it (electron/capabilities/browser/screenshotCheck.cjs): a PNG or JPEG of a plausible size passes, everything else is refused with a tool error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { checkScreenshot, MAX_BYTES, MAX_SIDE, MAX_PIXELS } = require('../electron/capabilities/browser/screenshotCheck.cjs');

/** The head of a PNG that says it is `w` by `h`. */
function png(w: number, h: number, chunk = 'IHDR') {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write(chunk, 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
const refused = { code: 'capture_failed' };

test('M5: a PNG within the limits and a JPEG pass, and the same bytes come back', () => {
  for (const ok of [png(1, 1), png(1280, 720), png(4000, 8000), png(MAX_SIDE, 3000), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])])
    assert.equal(checkScreenshot(ok), ok);
});

test('M5: bytes that are not an image, a header with a size no screenshot has, and too many bytes are refused before decoding', () => {
  for (const bad of [
    Buffer.alloc(0),
    Buffer.from('x'),
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    Buffer.from('GIF89a......................'),
    png(10, 10, 'IDAT'),
    png(0, 10),
    png(10, 0),
    png(MAX_SIDE + 1, 10),
    png(10, MAX_SIDE + 1),
    png(0xffffffff, 0xffffffff),
    png(Math.floor(Math.sqrt(MAX_PIXELS)) + 1, Math.floor(Math.sqrt(MAX_PIXELS)) + 1),
    Buffer.concat([png(10, 10), Buffer.alloc(MAX_BYTES)]),
    Buffer.alloc(MAX_BYTES + 1, 0xff),
  ])
    assert.throws(() => checkScreenshot(bad), refused);
  assert.throws(() => checkScreenshot(Buffer.alloc(10, 0)), /not a PNG or JPEG/);
});
