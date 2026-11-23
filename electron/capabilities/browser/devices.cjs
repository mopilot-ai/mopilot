// Device emulation for an in-app browser tab (IAB-08), harness-neutral: browser_resize_window's
// presets and sizes as CDP Emulation commands, and the commands that undo them. The tab's pane shows
// the active preset (agentTabs.cjs `device`).
//
// - 'mobile': 375x812 at 3x, touch, a phone user agent.
// - 'tablet': 768x1024 at 2x, touch, a tablet user agent.
// - 'desktop': no emulation (the pane's own size, DPR, input and user agent).
// - A custom size keeps the screen's DPR; under 768 px wide it is a phone (touch and the phone agent).
// - Default pages keep their view's natural viewport during agent control; no implicit scaling.

const { ownTable } = require('../../../shared/ownTable.mjs');
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const TABLET_UA = 'Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

/** preset -> what it emulates */
const DEVICE_PRESETS = ownTable({
  mobile: { label: 'Mobile', width: 375, height: 812, dpr: 3, mobile: true, touch: true, userAgent: MOBILE_UA },
  tablet: { label: 'Tablet', width: 768, height: 1024, dpr: 2, mobile: true, touch: true, userAgent: TABLET_UA },
});
const MIN_SIDE = 200;
const MAX_SIDE = 4000;

/**
 * What a resize asks for: a preset's device, or a custom size (null when the size is out of range).
 * Throws nothing; 'desktop' and unknown presets are the caller's.
 * @returns {{ preset: string | null, width: number, height: number, dpr: number, mobile: boolean, touch: boolean, userAgent: string | null } | null}
 */
/** @param {{ width?: number, height?: number, preset?: string }} [options] */
function deviceOf({ width, height, preset } = {}) {
  if (preset) {
    const d = DEVICE_PRESETS[preset];
    return d ? { preset, width: d.width, height: d.height, dpr: d.dpr, mobile: d.mobile, touch: d.touch, userAgent: d.userAgent } : null;
  }
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!(w >= MIN_SIDE && w <= MAX_SIDE && h >= MIN_SIDE && h <= MAX_SIDE)) return null;
  const mobile = w < 768;
  // DPR 0 keeps the screen's own
  return { preset: null, width: w, height: h, dpr: 0, mobile, touch: mobile, userAgent: mobile ? MOBILE_UA : null };
}

/**
 * The CDP commands that emulate `device` on a tab whose own user agent is `defaultUA`, as [method, params]
 * in order. A device with no agent of its own puts the tab's back (a phone's would otherwise stay).
 */
function emulationCommands(device, defaultUA) {
  return [
    [
      'Emulation.setDeviceMetricsOverride',
      {
        width: device.width,
        height: device.height,
        deviceScaleFactor: device.dpr,
        mobile: device.mobile,
        screenWidth: device.width,
        screenHeight: device.height,
      },
    ],
    ['Emulation.setTouchEmulationEnabled', { enabled: device.touch, maxTouchPoints: device.touch ? 5 : 1 }],
    ['Emulation.setUserAgentOverride', { userAgent: device.userAgent || defaultUA }],
  ];
}

/** The CDP commands that end emulation ('desktop'): size, DPR, touch and user agent back to the tab's own. */
function resetCommands(defaultUA) {
  return [
    ['Emulation.clearDeviceMetricsOverride', {}],
    ['Emulation.setTouchEmulationEnabled', { enabled: false }],
    ['Emulation.setUserAgentOverride', { userAgent: defaultUA }],
  ];
}

/** What the pane shows for a tab's emulation, or null for none. */
function deviceView(emulated) {
  if (!emulated) return null;
  return {
    preset: emulated.preset ?? null,
    label: emulated.preset ? DEVICE_PRESETS[emulated.preset].label : `${emulated.w}×${emulated.h}`,
    width: emulated.w,
    height: emulated.h,
  };
}

module.exports = {
  DEVICE_PRESETS,
  MOBILE_UA,
  TABLET_UA,
  deviceOf,
  emulationCommands,
  resetCommands,
  deviceView,
};
