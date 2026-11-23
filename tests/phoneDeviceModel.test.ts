// The phone's model name for its pairing name: what the device module says, or nothing on a native shell built before that module (mobile/src/platform/deviceModel.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
const modelPath = '../mobile/src/platform/deviceModel.ts';
const { deviceModel } = await import(modelPath);

test('the model comes from the device module', () => {
  assert.equal(
    deviceModel(() => ({ modelName: 'iPhone 18 Pro Max' })),
    'iPhone 18 Pro Max',
  );
  assert.equal(
    deviceModel(() => ({ modelName: null })),
    null,
  );
  assert.equal(
    deviceModel(() => ({})),
    null,
  );
});

test('a shell without the device module has no model, and the app still starts', () => {
  assert.equal(
    deviceModel(() => {
      throw new Error("Cannot find native module 'ExpoDevice'");
    }),
    null,
  );
  assert.equal(deviceModel(), null, 'outside a build there is no module either');
});
