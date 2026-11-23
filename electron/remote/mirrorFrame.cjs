// The frame source for the in-app browser: the model's own capture (hostCapture.cjs), so password fields and the agent cursor are kept out exactly as in the screenshots the model gets, shrunk to a phone-sized JPEG.
/** A frame is a fraction of the viewport: small enough for one sealed message. */
const FRAME_SCALE = 0.4;

/**
 * @param {{ capture: (tab: any, st: any, opts: { scale: number }) => Promise<{ data: string, width: number, height: number }>, current: (chatId: string) => any }} tabs the browser host
 * The page is the chat's current tab, never a new one, and it is read without bringing it to the front.
 */
function browserFrame(tabs) {
  return async (/** @type {string} */ chatId) => {
    const tab = tabs.current(chatId);
    if (!tab) return null;
    const shot = await tabs.capture(tab, await tab.agent('state'), { scale: FRAME_SCALE });
    return { data: shot.data, width: shot.width, height: shot.height };
  };
}

module.exports = { browserFrame, FRAME_SCALE };
