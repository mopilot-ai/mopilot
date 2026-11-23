// The window's side of the chat controller and the adapters in main (electron/session/controller.cjs,
// electron/harness/{codex,claude,acpTurns}.cjs): intents over IPC. A window never runs a turn; it
// says what the user did, and main starts, queues, steers, stops or pauses it, with or without a
// window open. What comes back is state (`session:patch`) and the adapters' events, which the
// harness modules in this folder's parent turn into what the thread view shows.
import { acceptSendReceipt } from '../../../shared/sendReceipt.mjs';
import { native } from '../../lib/native';
import { noteIgnored } from '../../lib/ignored';
import type { QueuedOptions } from '../../../shared/model/session';
import type { Attachment } from '../../../shared/model/store';
import type { ClaudeOwn } from '../claude/own';

export type FollowUp = 'queue' | 'steer';
export type GoalAction = 'pause' | 'resume' | 'extend' | 'clear';

export const chatProxy = {
  /** A message: main starts it, queues it behind the running turn, or steers it into it. */
  send(
    chatId: string,
    text: string,
    attachments: Attachment[] = [],
    opts: QueuedOptions & { retryAtRevision?: number } = {},
    followUp?: FollowUp,
    requestId?: string,
  ) {
    const { retryAtRevision, ...queuedOpts } = opts;
    return native.session
      .send(chatId, {
        text,
        attachments,
        opts: queuedOpts,
        ...(retryAtRevision !== undefined ? { retryAtRevision } : {}),
        ...(requestId ? { id: requestId } : {}),
        ...(followUp ? { followUp } : {}),
      })
      .then((receipt) => {
        acceptSendReceipt(receipt);
        return receipt;
      });
  },
  removeQueued: (chatId: string, queueId: string) => native.session.removeQueued(chatId, queueId),
  /** "Steer" on a queued message: into the running turn, or as the next one. */
  sendNow: (chatId: string, queueId: string) => native.session.sendNow(chatId, queueId),

  /** Stop on a Claude chat: its goal is paused first when one is active, then the turn is interrupted. */
  stopClaude: (chatId: string, turnId?: string) => native.session.claudeStop(chatId, turnId),
  /** Stop on an ACP chat: session/cancel. */
  stopAcp: (key: string, turnId?: string) => native.session.acpCancel(key, turnId),
  /** A goal button on a Claude chat; Codex's goal runs through its own app-server request. */
  claudeGoal: (chatId: string, action: GoalAction, human = false) => native.session.claudeGoal(chatId, action, human),

  /**
   * A native session this window just created: main starts it with its first message instead of resuming it.
   * A request that fails answers false, as when main refuses it.
   */
  newClaudeSession: (key: string, info: { cwd?: string | null; ephemeral?: boolean; forkFrom?: string | null }) =>
    native.session.claudeNew(key, info).catch((error) => (noteIgnored('register a new Claude Code session with main', error), false)),
  newAcpSession: (key: string, info: { cwd?: string | null }) =>
    native.session.acpNew(key, info).catch((error) => (noteIgnored('register a new ACP session with main', error), false)),
  /** What a Claude chat picked for itself (its model and effort, its login); main starts its turns with it. */
  claudeOwn: (chatId: string, own: ClaudeOwn | null) => native.session.claudeOwn(chatId, own),
  /**
   * A new chat on a basic harness carries a summary of this one: main asks the harness the chat is on
   * to write it. (A switch between Codex and Claude Code is only the chat's `pendingSwitch`, which main
   * settles with the next message: electron/session/switch.cjs.)
   */
  handoffNote: (chatId: string, targetLabel: string) => native.session.handoffNote(chatId, targetLabel),
  /** A Claude chat is moving to another login with its goal carried: the turn that ran out isn't the goal's end. */
  claudeHandover: (chatId: string, on: boolean) => native.session.claudeHandover(chatId, on),
};
