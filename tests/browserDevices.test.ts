// Device emulation presets for the in-app browser (IAB-08, electron/capabilities/browser/devices.cjs):
// what each preset and size emulates, the CDP Emulation commands that apply it and that reset it on
// 'desktop', and what the pane's toolbar shows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEVICE_PRESETS,
  MOBILE_UA,
  TABLET_UA,
  deviceOf,
  emulationCommands,
  resetCommands,
  deviceView,
} = require('../electron/capabilities/browser/devices.cjs');

test('deviceOf: presets are full devices; sizes are viewports (a phone under 768 px wide); bad input is null', () => {
  assert.deepEqual(deviceOf({ preset: 'mobile' }), {
    preset: 'mobile',
    width: 375,
    height: 812,
    dpr: 3,
    mobile: true,
    touch: true,
    userAgent: MOBILE_UA,
  });
  assert.deepEqual(deviceOf({ preset: 'tablet' }), {
    preset: 'tablet',
    width: 768,
    height: 1024,
    dpr: 2,
    mobile: true,
    touch: true,
    userAgent: TABLET_UA,
  });
  assert.match(MOBILE_UA, /Mobile Safari/);
  assert.doesNotMatch(TABLET_UA, /Mobile/);
  assert.deepEqual(Object.keys(DEVICE_PRESETS), ['mobile', 'tablet']);
  // a preset wins over a size; an unknown preset (and 'desktop', which is a reset) is not a device
  assert.equal(deviceOf({ preset: 'mobile', width: 1000, height: 1000 }).width, 375);
  assert.equal(deviceOf({ preset: 'watch' }), null);
  assert.equal(deviceOf({ preset: 'desktop' }), null);
  assert.deepEqual(deviceOf({ width: 1280.4, height: 719.6 }), {
    preset: null,
    width: 1280,
    height: 720,
    dpr: 0,
    mobile: false,
    touch: false,
    userAgent: null,
  });
  assert.deepEqual(deviceOf({ width: 390, height: 844 }), {
    preset: null,
    width: 390,
    height: 844,
    dpr: 0,
    mobile: true,
    touch: true,
    userAgent: MOBILE_UA,
  });
  for (const bad of [{ width: 199, height: 500 }, { width: 500, height: 4001 }, { width: 'x', height: 500 }, { width: 500 }, {}])
    assert.equal(deviceOf(bad), null, JSON.stringify(bad));
  assert.equal(deviceOf(), null);
});

test("emulationCommands: size and DPR, touch, user agent; a device without an agent of its own restores the tab's", () => {
  assert.deepEqual(emulationCommands(deviceOf({ preset: 'mobile' }), 'Real UA'), [
    [
      'Emulation.setDeviceMetricsOverride',
      { width: 375, height: 812, deviceScaleFactor: 3, mobile: true, screenWidth: 375, screenHeight: 812 },
    ],
    ['Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }],
    ['Emulation.setUserAgentOverride', { userAgent: MOBILE_UA }],
  ]);
  assert.deepEqual(emulationCommands(deviceOf({ width: 1440, height: 900 }), 'Real UA'), [
    [
      'Emulation.setDeviceMetricsOverride',
      { width: 1440, height: 900, deviceScaleFactor: 0, mobile: false, screenWidth: 1440, screenHeight: 900 },
    ],
    ['Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 }],
    ['Emulation.setUserAgentOverride', { userAgent: 'Real UA' }],
  ]);
});

test("resetCommands: desktop clears the size override, turns touch off and puts the tab's own user agent back", () => {
  assert.deepEqual(resetCommands('Real UA'), [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: 'Real UA' }],
  ]);
});

test('deviceView: the pane shows a preset by name and a size by its size; nothing when not emulating', () => {
  assert.equal(deviceView(null), null);
  assert.equal(deviceView(undefined), null);
  assert.deepEqual(deviceView({ preset: 'tablet', w: 768, h: 1024 }), { preset: 'tablet', label: 'Tablet', width: 768, height: 1024 });
  assert.deepEqual(deviceView({ w: 1280, h: 720 }), { preset: null, label: '1280×720', width: 1280, height: 720 });
});

test('reserved device names retain the unknown-preset result', () => {
  for (const preset of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) assert.equal(deviceOf({ preset }), null);
});
