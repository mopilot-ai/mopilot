// The native browser plugin's viewport (browser_viewport_set) on the tabs it holds: put on and taken off over CDP, with the page held at 100% zoom meanwhile (pageZoom.cjs).
const { holdNativeScale } = require('../pageZoom.cjs');

/**
 * Puts the plugin's viewport on a tab it holds.
 * @param {{ viewport: { width: number, height: number } | null, sized: Set<any> }} b the backend
 */
async function sizeTab(b, tab) {
  const v = b.viewport;
  // a device the user picked for the tab is the user's
  // a tab with no renderer can't take it (size emulation there crashes the app): it is sized once it comes back
  if (!v || tab.emulated || tab.rendererGone()) return;
  // at 100%: Chromium divides a desktop viewport by the page's zoom
  holdNativeScale(tab.backend, true);
  try {
    await tab.send('Emulation.setDeviceMetricsOverride', { width: v.width, height: v.height, deviceScaleFactor: 0, mobile: false });
  } catch (error) {
    // no override went on: the page keeps its fitted zoom
    holdNativeScale(tab.backend, false);
    throw error;
  }
  b.sized.add(tab);
}

/**
 * Takes the plugin's viewport off a tab, restoring the pane's own size.
 * A device the user picked for the tab (tab.emulated) is the user's, and stays.
 * @param {{ sized: Set<any> }} b the backend
 */
async function unsizeTab(b, tab) {
  b.sized.delete(tab);
  if (!tab.emulated) holdNativeScale(tab.backend, false);
  // a gone renderer took the viewport with it
  if (tab.closed || tab.backend.isDestroyed() || tab.emulated || tab.rendererGone()) return;
  await tab.send('Emulation.clearDeviceMetricsOverride', {});
}

/** The turn ended: the plugin's viewport stays on no tab it held (their CDP sessions end it). */
function forgetViewport(b) {
  for (const tab of b.sized) if (!tab.emulated) holdNativeScale(tab.backend, false);
  b.sized.clear();
  b.viewport = null;
}

module.exports = { sizeTab, unsizeTab, forgetViewport };
