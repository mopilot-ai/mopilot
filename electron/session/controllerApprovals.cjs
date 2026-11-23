// Approval publication, notifications and resolution preserve native display identity while keeping answer owners private.
const { ControllerSends } = require('./controllerSends.cjs');
const { busy } = require('./controllerEvents.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { publishApproval, approvalHarness } = require('../../shared/approvalOrigin.mjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */
class ControllerApprovals extends ControllerSends {
  /** @type {((chatId: string) => void) | null} a turn started waiting on the user (orchestration/reportRoute.cjs hooks it) */
  onAwaitingUser = null;

  /* -- approvals ---------------------------------------------------- */
  /** @this {ChatController} */
  addApproval(chatId, a) {
    const s = this.state.get(chatId);
    if (s.approvals.some((x) => x.id === a.id)) return;
    // read before the patch, which may update this same state object
    const waited = s.approvals.length > 0;
    const { source, approval } = publishApproval(a);
    if (source) this.rt(chatId).approvalOwners.set(a.id, source);
    // a running turn now waits on the user (the session store derives the turn from its approvals)
    this.state.patch(chatId, { approvals: [...s.approvals, approval] });
    // a linked session that waits on the user lets its parent's wake be checked again (orchestration/reportRoute.cjs)
    if (busy(s)) this.onAwaitingUser?.(chatId);
    // a scheduled task set to skip doesn't wait for anyone: its run stops here
    if (s.scheduled?.unattended && s.scheduled.onApproval === 'skip') {
      // an unattended run is skipped either way, and onSkipped reports it
      this.stopChat(chatId).catch((error) => noteIgnored('stop a skipped scheduled run', error));
      this.onSkipped(chatId);
      return;
    }
    const who =
      a.method === 'mcpServer/elicitation/request'
        ? `${a.params?.serverName ?? 'An MCP server'} needs input`
        : `${this.labelOf(approvalHarness(approval, this.kindOf(chatId)) ?? '') || 'The agent'} needs your approval`;
    // a chat that already waits on the person has told them: a card that joins it adds no banner and no push. The need ends when its
    // cards are answered, so the next card after that is a new need and says so again
    if (waited) return;
    // the card this banner is for: MoMo's "needs you" push names it, so a tap opens MoMo at that card (momo/notices.cjs)
    this.afterName(chatId, () =>
      this.say('approval', chatId, { title: who, body: this.chatTitle(chatId) || '', cardId: String(approval.id) }),
    );
  }
  /**
   * A card leaves its chat's state. An answer names only the card (a window does not say which chat holds it), so it is found in any chat; an agent's own cancel
   * names its chat, and only that chat's card is cancelled, so one chat (a Host's included) cannot cancel another's card by naming its id.
   * @this {ChatController} @param {string} id @param {string} [only] the one chat whose card this may be
   */
  resolveApproval(id, only) {
    for (const chatId of this.state.all()) {
      if (only !== undefined && chatId !== only) continue;
      const s = this.state.get(chatId);
      if (!s.approvals.some((x) => x.id === id)) continue;
      const approvals = s.approvals.filter((x) => x.id !== id);
      this.setApprovals(chatId, approvals);
      return true;
    }
    return false;
  }
}

module.exports = { ControllerApprovals };
