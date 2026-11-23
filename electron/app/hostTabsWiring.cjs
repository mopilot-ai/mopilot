// The browser tabs of the chats on every Host, as main wires them (design/host/index.html, package 3.4): this Mac's tabs plus one RemoteTabs per Host.
const { TabsByHost } = require('../capabilities/browser/tabsByHost.cjs');

/**
 * A chat's tabs belong to its Host (hostId, chatId): a call reaches the tabs of the Host that runs the chat when it is made. The ownership
 * record and the RemoteTabs factory are main's late-bound services (`live.hostOwnership`, `live.remoteBrowserTabs`); until a Host has them, every chat is on this Mac.
 * A Host's tabs changing for a chat redraws the pane through the same onChange this Mac's tabs have.
 * @param {{ live: any, local: ConstructorParameters<typeof TabsByHost>[0]['local'] }} o
 */
function createHostTabs({ live, local }) {
  return new TabsByHost({
    local,
    ownerOf: (chatId) => live.hostOwnership?.get(chatId).hostId ?? 'local',
    make: (hostId) => live.remoteBrowserTabs?.(hostId, { onChange: (chatId) => local.o.onChange?.(chatId) }),
  });
}

module.exports = { createHostTabs };
