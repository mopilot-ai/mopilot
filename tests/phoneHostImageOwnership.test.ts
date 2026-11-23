// The source Host's exact chat ownership remains current through the final phone decoder boundary, including microtask moves and connection replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createPhoneSteps } = require('../electron/app/phoneSteps.cjs');
const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
const imageId = createHash('sha256').update(bytes).digest('hex');
for (const change of ['epoch', 'connection'])
  test(`Host ${change} changes after the final chunk check but before decoding: no image is decoded or published`, async () => {
    let owner = { hostId: 'A', epoch: 1 },
      reads = 0,
      decoded = 0;
    const host = {
      state: () => 'online',
      speaks: () => true,
      call: async () => ({ imageId, size: 8, mime: 'image/png', data: bytes.toString('base64'), nextOffset: 8, done: true }),
    };
    let connection: any = host;
    const live = {
      peerRuntime: { readHistory: { userImage: async () => ({ hostImage: { hostId: 'A', imageId } }) } },
      hostOwnership: {
        get() {
          if (++reads === 4)
            queueMicrotask(() => {
              if (change === 'epoch') owner = { hostId: 'B', epoch: 2 };
              else connection = { ...host };
            });
          return owner;
        },
      },
      imageHostFor: () => connection,
    };
    const picture = { getSize: () => ({ width: 8, height: 8 }), toJPEG: () => Buffer.from('jpeg') };
    const steps = createPhoneSteps({
      live,
      images: () => ({
        createFromBuffer() {
          decoded++;
          return picture;
        },
      }),
    });
    assert.equal(await steps.userImage('chat', 'u', 0, 360, () => {}), null);
    assert.equal(decoded, 0);
  });

test('unavailable image slots keep their original position before a valid Host reference', () => {
  const { pictureAt } = require('../electron/session/userImage.cjs');
  const item = { content: [{ type: 'image' }, { type: 'localImage', path: 7 }, { type: 'image', url: `host-image:${imageId}` }] };
  assert.equal(pictureAt(item, 0), null);
  assert.equal(pictureAt(item, 1), null);
  assert.deepEqual(pictureAt(item, 2), { hostImage: { hostId: null, imageId } });
});
