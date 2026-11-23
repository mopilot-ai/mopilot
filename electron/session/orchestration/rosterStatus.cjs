// "Linked sessions now" kept current in every linked chat, on every harness: the user's next message to a chat carries the roster (who is linked and what each is doing) in a hidden status block whenever it changed since that chat last saw it, in a brief, a wake-up, a family message or an earlier message.
const { rosterFor } = require('./family.cjs');
const { withRosterBlock, withoutRosterBlock } = require('../../../shared/sideSessions.mjs');
const { hasSkill } = require('../../../shared/userInput.mjs');

class RosterStatus {
  /** @param {any} orch the Orchestrator */
  constructor(orch) {
    this.orch = orch;
    /** chat and native segment (a switch or a new session has seen nothing) → the roster line it last saw */
    this.seen = new Map();
    /** item → [chat, roster line] it carries, until the harness took it or refused it */
    this.sent = new WeakMap();
  }

  /** `chatId`'s roster line now: '' for a chat in no family, or whose linked chats are all archived. */
  now(chatId) {
    const { orch } = this;
    return rosterFor(orch.o.controller, orch.journal, chatId, orch.archived, orch.o.notesDirectory);
  }

  /**
   * An input about to reach `chatId` (ChatController beforeDispatch). The user's own message carries the roster when
   * it changed; a brief, wake-up or family message carries it already. Never a slash command, a skill chip or a goal
   * (the harness reads those from the text's start), nor a peer message, whose text is the peer service's.
   * @param {{ chatId: string, item: any, ref?: { key?: string } | null }} delivery ref: the chat's native segment
   */
  attach({ chatId, item, ref }) {
    if (typeof item?.text !== 'string' || item.peer) return;
    const key = `${chatId}\n${ref?.key ?? ''}`;
    if (item.sideSession) {
      const roster = this.now(chatId);
      if (roster && item.text.includes(roster)) this.sent.set(item, [key, roster]);
      return;
    }
    if (item.opts?.human !== true || item.opts.goal || item.text.trimStart().startsWith('/') || hasSkill(item.attachments)) return;
    const roster = this.now(chatId);
    // a message sent before (and refused) keeps no stale block
    const own = withoutRosterBlock(item.text);
    if (!roster || roster === this.seen.get(key)) {
      item.text = own;
      return;
    }
    item.text = withRosterBlock(own, roster);
    this.sent.set(item, [key, roster]);
  }

  /**
   * The harness took the input or refused it (ChatController onDispatchResult): a roster it took is the one the chat
   * has seen; a refused one goes again with the next message.
   * @param {{ item: any, result?: { started?: boolean } | null }} delivery
   */
  settled({ item, result }) {
    const sent = item && typeof item === 'object' ? this.sent.get(item) : undefined;
    if (!sent) return;
    this.sent.delete(item);
    if (result?.started === true) this.seen.set(sent[0], sent[1]);
  }

  /** A deleted chat is forgotten, every segment of it. */
  forget(chatId) {
    for (const key of this.seen.keys()) if (key.startsWith(`${chatId}\n`)) this.seen.delete(key);
  }
}

module.exports = { RosterStatus };
