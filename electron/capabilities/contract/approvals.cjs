// Approval requests Sage itself asks for (not a harness): computerAccess (control an app),
// computerConfirm (an action that can't be undone), browserOrigin (a site) and visionConsent
// (screenshots go to a vision model of another vendor); for the desktop_* tools, computerAccessSet
// (a set of apps at their tiers) and computerTakeover (take over the screen); devServer (run a command
// to start a dev server, browser_preview_start); terminalTab (open a shell in a folder, open_terminal_tab); browserPermission (a page the user drives in the built-in
// browser asks for the camera, microphone, location or notifications); momoAction (MoMo's trust layer asks before
// one of MoMo's actions, electron/momo/actionAsk.cjs); momoConnect (a MoMo chat's tool needs Calendar or Reminders connected, electron/momo/sources/connectAsk.cjs); consent (a setting, connector or sidebar section an agent's tool asks
// to change, once); hostAsk (one question with its details and a button per choice, for the folder, editor, keep-awake and
// worktree tools, electron/app/hostToolsWiring.cjs); gatewayTool (a tool of an MCP server the gateway runs, with Allow once / Always allow,
// electron/gateway/offer.cjs); remotePair (the user confirms the safety number of a phone being paired,
// electron/remote/pairApproval.cjs). They join the chat's
// SessionState approvals, so every window shows the same card, and the first answer wins.

const KINDS = new Set([
  'computerAccess',
  'computerConfirm',
  'browserOrigin',
  'browserPermission',
  'visionConsent',
  'computerAccessSet',
  'computerTakeover',
  'devServer',
  'terminalTab',
  'momoAction',
  'momoConnect',
  'sessionStart',
  'consent',
  'hostAsk',
  'gatewayTool',
  'remotePair',
]);
const METHOD_PREFIX = 'sage/';

class ApprovalBroker {
  /** @param {{ controller: { addApproval(chatId: string, a: object): void, resolveApproval(id: string): boolean } }} o */
  constructor(o) {
    this.controller = o.controller;
    this.pending = new Map();
    this.seq = 0;
  }

  /**
   * Shows a card in the chat and resolves with the user's answer, or null when the card went away
   * unanswered (the turn ended, the harness stopped, or `signal` aborted). A card asked inside a tool call
   * passes the call's signal: aborting the call withdraws the card from every window, so a late click
   * answers nothing, and a call already aborted puts no card up (#1865). A card that is not a tool call's
   * passes `{ signal: null }`.
   * @param {string} chatId
   * @param {string} kind
   * @param {object} params
   * @param {{ signal?: AbortSignal | null }} [o]
   * @returns {Promise<any> & { id?: string }}
   */
  ask(chatId, kind, params, { signal = null } = {}) {
    if (!KINDS.has(kind)) return Promise.reject(new Error(`unknown approval kind: ${kind}`));
    const id = `sage-${kind}-${++this.seq}`;
    /** @type {Promise<any> & { id?: string }} */
    const answer = signal?.aborted
      ? Promise.resolve(null)
      : new Promise((resolve) => {
          const withdraw = () => this.answer(id, null);
          // whichever settles the card (an answer, the sweep, the abort) lets go of the signal
          const settle = (/** @type {any} */ result) => {
            signal?.removeEventListener('abort', withdraw);
            resolve(result);
          };
          this.pending.set(id, { chatId, resolve: settle });
          signal?.addEventListener('abort', withdraw, { once: true });
          this.controller.addApproval(chatId, { id, method: METHOD_PREFIX + kind, params: { kind, ...params } });
        });
    // for a caller that has to withdraw the card itself (answer(id, null))
    answer.id = id;
    return answer;
  }

  /** A window's answer. Only the first one counts. */
  answer(id, result) {
    const p = this.pending.get(id);
    if (!p) return false;
    this.pending.delete(id);
    this.controller.resolveApproval(id);
    p.resolve(result ?? null);
    return true;
  }

  /** The chat's approvals changed: a card of ours that is no longer there was dropped unanswered. */
  sweep(chatId, approvals) {
    const live = new Set((approvals || []).map((a) => a.id));
    for (const [id, p] of this.pending) {
      if (p.chatId !== chatId || live.has(id)) continue;
      this.pending.delete(id);
      p.resolve(null);
    }
  }
}

module.exports = { ApprovalBroker, KINDS, METHOD_PREFIX };
