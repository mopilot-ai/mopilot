// The app's URL inbox: macOS delivers `mopilot://` links ('open-url') possibly before the app can act on them, so they wait here until the quick-actions IPC module (electron/app/ipc/quickActions.cjs) sets the handler that opens them.

/** Links that arrive before a handler is set are kept, up to this many (a flood of them is not a user's clicks). */
const MAX_WAITING = 8;

/**
 * @param {(error: unknown) => void} onError where a handler that throws or rejects is reported
 */
function createLinkInbox(onError) {
  /** @type {string[]} */
  let waiting = [];
  /** @type {((url: string) => unknown) | null} */
  let handler = null;
  const run = (/** @type {string} */ url) => {
    try {
      Promise.resolve(handler?.(url)).catch(onError);
    } catch (error) {
      onError(error);
    }
  };
  return {
    /** @param {string} url */
    push(url) {
      if (handler) return run(url);
      waiting = [...waiting, url].slice(-MAX_WAITING);
    },
    /** The handler gets every link kept so far, then each new one; a later call replaces it. */
    setHandler(/** @type {(url: string) => unknown} */ fn) {
      handler = fn;
      const kept = waiting;
      waiting = [];
      for (const url of kept) run(url);
    },
  };
}

const inbox = createLinkInbox((error) => console.warn('open a link failed:', error));

/** macOS: every `open-url` event goes to the inbox. Called once, before the app is ready. */
function listenForLinks(/** @type {{ on(event: string, cb: (event: { preventDefault(): void }, url: string) => void): unknown }} */ app) {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    inbox.push(url);
  });
}

module.exports = { createLinkInbox, inbox, listenForLinks, MAX_WAITING };
