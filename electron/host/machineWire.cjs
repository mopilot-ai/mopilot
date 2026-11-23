// Owns what the app sets up on a new connection to a machine: the app's hook runs, and a failure in it leaves the connection as it is. `follow` watches the connection itself (linkWatch.cjs: when it drops, for the row); it ends with the connection even when the app's hook failed.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @template H
 * @param {((id: string, host: H) => (() => void) | void) | undefined} onRemoteHost told when a connection is made; what it returns is called when the connection ends
 * @param {(id: string, host: H) => () => void} [follow] watches the connection; what it returns ends the watch
 * @returns {(id: string, host: H) => (() => void) | void}
 */
function createWireHost(onRemoteHost, follow) {
  return (id, host) => {
    const unfollow = follow?.(id, host);
    try {
      const detach = onRemoteHost?.(id, host);
      return unfollow ? () => (unfollow(), detach?.()) : detach;
    } catch (error) {
      noteIgnored('set up a new connection to a machine', error);
      return unfollow;
    }
  };
}

module.exports = { createWireHost };
