// The dev host's generated test pictures and the [test] Pictures chat that carries them: valid PNGs of the stated sizes, a grid, and the chat's pictures read back by place.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { gridPng } from '../scripts/mobile-dev-host/fakeImages.mjs';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

const decode = (b64: string) => {
  const png = Buffer.from(b64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'a PNG signature');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  // the one IDAT chunk follows the 25-byte signature + header
  const idatLength = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), 'IDAT');
  const raw = inflateSync(png.subarray(41, 41 + idatLength));
  return { width, height, raw };
};

test('a grid picture is a PNG of the asked size with a white cross at the centre and dark grid lines', () => {
  const { width, height, raw } = decode(gridPng(300, 200, [10, 20, 30]));
  assert.equal(width, 300);
  assert.equal(height, 200);
  assert.equal(raw.length, (300 * 3 + 1) * 200, 'one filter byte and three bytes a pixel per row');
  const at = (x: number, y: number) => [...raw.subarray(y * 901 + 1 + x * 3, y * 901 + 4 + x * 3)];
  assert.deepEqual(at(150, 60), [255, 255, 255], 'the vertical bar of the cross');
  assert.deepEqual(at(10, 100), [255, 255, 255], 'the horizontal bar of the cross');
  assert.deepEqual(at(0, 20), [20, 20, 20], 'a thick line every 250 px');
  assert.deepEqual(at(60, 20).length, 3);
  const grid = at(51, 20);
  assert.deepEqual(grid, [90, 90, 90], 'a thin line every 50 px');
  const tinted = at(120, 60);
  assert.ok(tinted[0] <= 10 && tinted[1] <= 20 && tinted[2] <= 30, 'the gradient never goes above the tint');
});

test('the [test] Pictures chat holds a tall, a wide and a square picture the phone can read by place', async () => {
  const app = createFakeApp({ repo: '/repo', now: () => 1_000_000, status: async () => '' });
  const chat = app.chats.get('dev-seed-pictures');
  assert.equal(chat.title, '[test] Pictures');
  const sizes: number[][] = [];
  for (const row of chat.rows) {
    if (!row.images) continue;
    const picture = app.ops.userImage(chat.id, row.id, 0);
    assert.ok(picture, `row ${row.id} keeps its picture`);
    const { width, height } = decode(picture.data);
    sizes.push([width, height]);
  }
  assert.deepEqual(sizes, [
    [600, 2000],
    [2000, 500],
    [900, 900],
  ]);
});
