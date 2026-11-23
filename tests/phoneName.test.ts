// The phone's own name for the Mac's pairing card and the account's device list (mobile/src/phoneName.ts): the system's device name, cleaned
// and cut short, else the platform's name; never a made-up "My phone".
import { test } from 'node:test';
import assert from 'node:assert/strict';
const phoneNamePath = '../mobile/src/phoneName.ts';
const { phoneName, MAX_PHONE_NAME } = await import(phoneNamePath);

test('the system name is used as it reads, without hidden characters', () => {
  assert.equal(phoneName({ deviceName: 'iPhone', platform: { ios: {} } }), 'iPhone');
  assert.equal(phoneName({ deviceName: '  Pixel‮ 8\n ', platform: { android: {} } }), 'Pixel 8');
});

test('an iPhone that only says "iPhone" goes by its model, so two phones read apart', () => {
  assert.equal(phoneName({ deviceName: 'iPhone', platform: { ios: {} } }, 'iPhone 18 Pro Max'), 'iPhone 18 Pro Max');
  assert.equal(phoneName({ deviceName: 'iPad', platform: { ios: {} } }, 'iPad Air'), 'iPad Air');
  assert.equal(phoneName({ platform: { ios: {} } }, 'iPhone 16'), 'iPhone 16');
  assert.equal(phoneName({ deviceName: 'Ann’s iPhone', platform: { ios: {} } }, 'iPhone 16'), 'Ann’s iPhone', 'a name the person set wins');
  assert.equal(phoneName({ deviceName: 'iPhone', platform: { ios: {} } }, 'iPhone99,1'), 'iPhone', 'a hardware id is not a name');
  assert.equal(phoneName({ deviceName: 'iPhone', platform: { ios: {} } }, null), 'iPhone');
  assert.equal(phoneName({ platform: { android: {} } }, 'Pixel 9'), 'Android phone', 'only iOS withholds its name');
});

test('a long name is cut to one short line, by whole characters', () => {
  const name = phoneName({ deviceName: '📱'.repeat(MAX_PHONE_NAME + 10) });
  assert.equal([...name].length, MAX_PHONE_NAME);
  assert.equal(name, '📱'.repeat(MAX_PHONE_NAME));
});

test('no usable system name falls back to the platform, then to Phone', () => {
  assert.equal(phoneName({ deviceName: '​ ', platform: { ios: {} } }), 'iPhone');
  assert.equal(phoneName({ deviceName: 42, platform: { android: {} } }), 'Android phone');
  assert.equal(phoneName({ platform: null }), 'Phone');
  assert.equal(phoneName(undefined), 'Phone');
});
