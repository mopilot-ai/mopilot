// Puts a page the user pinch-zoomed back to its layout scale before an agent acts on it (#5405): the agent's coordinates (read_page, find, the screenshot's frame) are layout CSS pixels, and Chromium reads CDP mouse positions in the zoomed visual viewport, so a click at a button's layout point would land elsewhere.
const { noteIgnored } = require('../../ignored.cjs');

/** The visual viewport's scale: 1 is the page as laid out; a user's pinch (pageZoom.cjs allowPinch) raises it. */
const SCALE = 'visualViewport ? visualViewport.scale : 1';

/**
 * Resets a pinch-zoomed page to scale 1; a page at 1 costs one read. Never fails the action it prepares.
 * @param {{ send: (method: string, params?: object) => Promise<any> }} tab
 * @returns {Promise<boolean>} whether it had to reset
 */
async function levelPinch(tab) {
  try {
    const { result } = await tab.send('Runtime.evaluate', { expression: SCALE, returnByValue: true });
    if (!(result?.value > 1)) return false;
    await tab.send('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
    return true;
  } catch (error) {
    // a page that can't be read or levelled is acted on as it is
    noteIgnored("level a pinch-zoomed page before an agent's action", error);
    return false;
  }
}

module.exports = { levelPinch };
