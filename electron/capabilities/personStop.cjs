// A person stopped computer use from the desktop (Esc, or the control pill's Stop): the chat holding the screen stops,
// and so does every chat working in apps in the background, on any harness; each stopped turn reads "You stopped
// after Ns", and MoPilot comes back to the front on the chat once its screen is given back (Claude Desktop's
// computer use returns to its window after Esc; the Codex app says "You stopped after {time}").

const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {{ stop(chatId: string): Promise<void> }} o.cu
 * @param {() => { workingChats(): string[] } | null} o.apps the background (app-scoped) control, once it exists
 * @param {() => { frontAfterStop(chatId: string, show: () => void): void } | null} o.desktop the desktop_* control, once it exists
 * @param {(channel: string, payload: object) => void} o.broadcast to every window: computer:changed tells them the chat's
 *   running turn was stopped by its person
 * @param {(chatId: string) => void} [o.showChat] MoPilot to the front on the chat
 * @returns {(chatId: string) => Promise<void>}
 */
function personStop(o) {
  return async (chatId) => {
    const others = (o.apps()?.workingChats() ?? []).filter((c) => c !== chatId);
    const chats = [chatId, ...others];
    // the windows learn it before the turns end, while each chat's turn is still the running one
    for (const c of chats) o.broadcast('computer:changed', { chatId: c, stoppedByYou: true });
    const show = o.showChat;
    if (show) {
      const desktop = o.desktop();
      if (desktop) desktop.frontAfterStop(chatId, () => show(chatId));
      else show(chatId);
    }
    const ends = await Promise.allSettled(chats.map((c) => o.cu.stop(c)));
    for (const e of ends) if (e.status === 'rejected') noteIgnored("stop a chat on a person's Esc", e.reason);
  };
}

module.exports = { personStop };
