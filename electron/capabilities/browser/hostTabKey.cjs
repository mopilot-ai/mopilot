// The pane key of an agent's browser tab on a Host: (hostId, tab id), encoded as JSON so no hostId or tab id can collide through a delimiter.
//
// A tab on this Mac keeps its plain key (its browser_* id, or null for the chat's original tab), so the pane, saved layouts and the
// local tools see no change. A tab on another Host is `["host", hostId, tabId]`: the same chat can hold tabs on two Hosts after a
// continue, and a key without the Host would name one tab on either (design/host/index.html, package 3.4, scenario I2).

/** The Host this app runs on: the chat's tabs here are Electron views, not a Host's headless Chromium. */
const LOCAL_HOST = 'local';

const TAG = 'host';

/**
 * The pane key of a tab: unchanged on this Mac, structured on another Host.
 * @param {string} hostId @param {string | null} tabKey the tab's browser_* id, or null for the chat's original tab
 * @returns {string | null}
 */
function encodeTabKey(hostId, tabKey) {
  return hostId === LOCAL_HOST ? tabKey : JSON.stringify([TAG, hostId, tabKey]);
}

/**
 * The Host and tab a pane key names. Anything that is not a structured key (a plain id, null, a malformed string) is a tab here.
 * @param {unknown} key
 * @returns {{ hostId: string, tabKey: string | null }}
 */
function decodeTabKey(key) {
  const here = { hostId: LOCAL_HOST, tabKey: typeof key === 'string' && key ? key : null };
  if (typeof key !== 'string' || !key.startsWith('[')) return here;
  let parsed;
  try {
    parsed = JSON.parse(key);
  } catch {
    return here;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== TAG) return here;
  const [, hostId, tabKey] = parsed;
  if (typeof hostId !== 'string' || !hostId || hostId === LOCAL_HOST || typeof tabKey !== 'string' || !tabKey) return here;
  return { hostId, tabKey };
}

module.exports = { LOCAL_HOST, encodeTabKey, decodeTabKey };
