// Opens a Chrome tab even when Chrome runs with no normal window (#3714): on macOS Chrome keeps running after its last
// window closes (and starts so with --no-startup-window), and chrome.tabs.create without a windowId then throws
// "No current window". The tab opens in a new normal window instead, unfocused unless asked, so the user's work in
// another app keeps the focus. Overlapping opens while that window is being made share it rather than each making one.

const NO_WINDOW = /no current window/i;

/**
 * Makes the extension's one tab opener (every chrome.tabs.create of the service worker goes through one;
 * tests/chromeTabsCreate.invariant.test.ts checks).
 * @param {any} chrome @param {(what: string, error: unknown) => void} log where a fallback's failure goes
 * @returns {(props: { url?: string, active?: boolean, windowId?: number }, o?: { focused?: boolean }) => Promise<any>}
 */
export function tabOpener(chrome, log) {
  /** @type {Promise<any> | null} the window being made for a windowless Chrome, shared by the opens that overlap it */
  let opening = null;
  /** @param {any} props @param {boolean} focused @param {boolean} joined whether this open already tried a shared window */
  const open = async (props, focused, joined) => {
    try {
      return await chrome.tabs.create(props);
    } catch (error) {
      if (props.windowId != null || !NO_WINDOW.test(String(/** @type {any} */ (error)?.message ?? error))) throw error;
    }
    if (opening && !joined) {
      // the shared window may fail to open, or close with its first tab before this one lands: then open as if first
      try {
        return await chrome.tabs.create({ ...props, windowId: (await opening).id });
      } catch (error) {
        log('open a tab in the window opened for a windowless Chrome', error);
      }
      return open(props, focused, true);
    }
    const made = Promise.resolve(chrome.windows.create({ url: props.url, focused, type: 'normal' }));
    opening = made;
    try {
      const window = await made;
      // Chrome returns the window with the tab it opened on the url; open one there if it did not say
      return window?.tabs?.[0] ?? (await chrome.tabs.create({ ...props, windowId: window.id }));
    } finally {
      if (opening === made) opening = null;
    }
  };
  return (props, { focused = false } = {}) => open(props, focused, false);
}
