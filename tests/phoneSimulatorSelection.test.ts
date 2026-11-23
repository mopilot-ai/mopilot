// Native smoke tests create a new simulator only from an already available runtime and compatible iPhone type.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectSimulator } from '../design/mobile-remote/spike/expo/simulatorSelection.mjs';

test('chooses a type represented by an available iPhone on the chosen runtime', () => {
  const result = selectSimulator(
    [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: true }],
    [
      { identifier: 'phone17', name: 'iPhone 17' },
      { identifier: 'phone16', name: 'iPhone 16' },
    ],
    { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16', isAvailable: true, deviceTypeIdentifier: 'phone16' }] },
  );
  assert.deepEqual(result, { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', device: 'phone16' });
});
test('rejects absent compatible devices rather than guessing', () => {
  assert.throws(() =>
    selectSimulator(
      [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: true }],
      [{ identifier: 'phone17', name: 'iPhone 17' }],
      { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16', isAvailable: true, deviceTypeIdentifier: 'phone16' }] },
    ),
  );
  assert.throws(() =>
    selectSimulator(
      [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: false }],
      [{ identifier: 'phone16', name: 'iPhone 16' }],
      { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16', isAvailable: true, deviceTypeIdentifier: 'phone16' }] },
    ),
  );
  assert.throws(() => selectSimulator([{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: true }], [], {}));
});

test('maps an exact available device name when the type identifier is absent', () => {
  assert.deepEqual(
    selectSimulator(
      [{ identifier: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', isAvailable: true }],
      [{ identifier: 'phone16', name: 'iPhone 16' }],
      { 'com.apple.CoreSimulator.SimRuntime.iOS-18-5': [{ name: 'iPhone 16', isAvailable: true }] },
    ),
    { runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-18-5', device: 'phone16' },
  );
});

test('ignores unavailable devices and devices on other runtimes', () => {
  const rt = 'com.apple.CoreSimulator.SimRuntime.iOS-18-5';
  assert.throws(() =>
    selectSimulator([{ identifier: rt, isAvailable: true }], [{ identifier: 'phone16', name: 'iPhone 16' }], {
      [rt]: [
        { name: 'iPhone 16', isAvailable: false, deviceTypeIdentifier: 'phone16' },
        { name: 'iPad', isAvailable: true, deviceTypeIdentifier: 'phone16' },
      ],
      other: [{ name: 'iPhone 16', isAvailable: true, deviceTypeIdentifier: 'phone16' }],
    }),
  );
  assert.throws(() => selectSimulator([{ identifier: 'com.apple.CoreSimulator.SimRuntime.tvOS-18-5', isAvailable: true }], [], {}));
  assert.throws(() =>
    selectSimulator([{ identifier: rt, isAvailable: true }], [{ identifier: 'phone16', name: 'iPhone 16' }], {
      [rt]: [{ name: 'iPhone 17', isAvailable: true }],
    }),
  );
});
