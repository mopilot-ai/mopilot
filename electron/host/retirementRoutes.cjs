// Main's machine retirement routes and effects for a committed registry removal or end of a connection.
/** @param {{ live?: any, broadcastAll: (channel: string, id: string) => void, readState?: () => { prefs?: { lastNewChatHost?: { id: string } | null } } }} deps */
function machineRetirement(deps) {
  return {
    onRemoteEnd: (/** @type {string} */ id) => deps.live?.hostTabs?.dropHost(id),
    onRemoved: (/** @type {string} */ id) => {
      deps.broadcastAll('host:machineRemoved', id);
      if (deps.readState?.()?.prefs?.lastNewChatHost?.id === id) deps.live?.patchPrefs?.({ lastNewChatHost: null });
    },
  };
}

function retirementRoutes({ handle, chats, machines, allowed, deps }) {
  if (deps?.live) deps.live.runOnName = (id) => (allowed() ? machines().row(id)?.name : undefined);
  handle('host:pendingDeletions', () => chats.pendingDeletions().map(({ hostId, chatId }) => ({ hostId, chatId })));
  handle('host:remove', (id) => {
    const machine = String(id ?? '');
    // the machine goes first: a removal that fails keeps its pending deletions
    const removed = machines().remove(machine);
    chats.dropMachine(machine);
    deps?.live?.hostTabs?.dropHost(machine);
    return removed;
  });
}
module.exports = { retirementRoutes, machineRetirement };
