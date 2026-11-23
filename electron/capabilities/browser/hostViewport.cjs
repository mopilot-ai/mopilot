// Browser page visibility before input or screenshots; page layout remains owned by its view.
const { noteIgnored } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { FRAME_MS, FRAME_SCRIPT, sleep, withTimeout } = require('./hostUtil.cjs');
const { isViewTab } = require('./views.cjs');

/** @typedef {InstanceType<typeof import('./host.cjs').BrowserTabs>} BrowserTabs */
/** @typedef {import('./host.cjs').Tab} Tab */

/**
 * Input and screenshots need the page painted in its window. A pane tab the window doesn't lay out
 * (display: none) still reports itself visible, takes no input reliably, and captures as nothing or
 * never: ask its window to show it (in front in its chat's view, painted behind the pane in another
 * chat's) and wait a little for the report and a frame. The report is only a hint: with none (or a
 * late one) the action is still tried, and only a capture that comes back blank fails. Popups are
 * windows of their own, and a view tab paints in its parking window when no window shows it.
 * @param {BrowserTabs} host
 */
async function paint(host, tab) {
  // a view paints whether or not a window shows it (views.cjs); its input lands once Tab.attach emulated its focus
  if (tab.kind !== 'tab' || isViewTab(tab.backend)) return;
  if (tab.layer === 'front' || tab.layer === 'back') return;
  // a page in another browser's window (the user's Chrome) is no pane's to lay out: it draws while its focus is
  // emulated (Tab.attach), so only the frame wait applies
  if (!host.o.inputWhileHidden) {
    try {
      host.o.select(tab);
    } catch (error) {
      // if it stays hidden the wait below gives up
      noteIgnored('bring a hidden pane tab to the front to paint', error);
    }
    const deadline = Date.now() + host.showMs;
    while (tab.layer !== 'front' && tab.layer !== 'back' && Date.now() < deadline) {
      if (tab.closed || tab.backend.isDestroyed()) throw new ToolError(`Tab ${tab.id} was closed.`, 'tab_closed');
      await sleep(50);
    }
  }
  // the first frame after the page is laid out again (bounded: a hidden guest may never draw one)
  await withTimeout(
    tab.send('Runtime.evaluate', { expression: FRAME_SCRIPT, awaitPromise: true, returnByValue: true }).catch((error) => {
      // no frame drawn: the wait just ends
      noteIgnored('wait for a browser tab to paint a frame', error);
    }),
    FRAME_MS,
    () => {
      /* timed out: carry on without the frame */
    },
  );
}

module.exports = { paint };
