// The one route for an answer to a card on the ACP event bus, from any surface (a window, the side panel, a phone): a card of a chat on a Host goes to that Host and leaves this Mac's state only once the Host took it or no longer had it; this Mac's own card goes to the local ACP host.

/**
 * @param {object} o
 * @param {{ answer(requestId: string, optionId: string | null): Promise<boolean> | null } | null | undefined} o.remote the chats on other machines (electron/host/remoteChats.cjs); answers null for a card that is not one of theirs
 * @param {(requestId: string, optionId: string | null) => boolean} o.local the local ACP host's answer
 * @param {(requestId: string) => void} o.resolve the card leaves the controller's state (and its needs-you with it)
 * @param {string} requestId
 * @param {string | null} optionId null: dismissed
 * @returns {boolean | Promise<boolean>} whether the agent that asked took the answer (a Host's answer comes later, and rejects when the Host cannot be reached, with the card kept to answer again)
 */
function answerAcpCard({ remote, local, resolve }, requestId, optionId) {
  const there = remote?.answer(requestId, optionId) ?? null;
  if (there === null) {
    resolve(requestId);
    return local(requestId, optionId);
  }
  // taken, or the Host had closed it already: either way the card is done here
  return there.then((took) => {
    resolve(requestId);
    return took;
  });
}

/**
 * The routes answerAcpCard takes, from the parts every caller has: main's Host chats (`live.remoteChats`, set up with Host), the local ACP host, and how a card leaves the controller.
 * @param {(() => { answer(requestId: string, optionId: string | null): Promise<boolean> | null } | null | undefined) | undefined} remoteChats
 * @param {{ permission(requestId: string, optionId: string | null): boolean }} acpHost
 * @param {(requestId: string) => void} resolve
 */
const acpCardRoutes = (remoteChats, acpHost, resolve) => ({
  remote: remoteChats?.(),
  local: (/** @type {string} */ id, /** @type {string | null} */ option) => acpHost.permission(id, option),
  resolve,
});

/**
 * answerAcpCard with main's `live` (the side panel's and a phone's answers).
 * @param {any} live @param {string} requestId @param {string | null} optionId
 */
const answerLiveAcpCard = (live, requestId, optionId) =>
  answerAcpCard(
    acpCardRoutes(live.remoteChats, live.acpHost, (id) => void live.controller.resolveApproval(id)),
    requestId,
    optionId,
  );

module.exports = { answerAcpCard, acpCardRoutes, answerLiveAcpCard };
