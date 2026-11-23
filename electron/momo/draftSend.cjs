// Sending a MoMo draft from its card (MoMo's draft card design): the one place a draft becomes mail. The user's click on Send (never a model's tool call: no tool reaches this) hands the card's words and the account they chose to the connector hub's send_mail tool with a one-time press bound to exactly those words (recipients, subject, body, account) and to the draft's id: that press is the approval, so there is no second card, the audit log records it as user-pressed with the draft id, and a send whose content differs from what was shown, or with no press, is refused. It is refused while MoMo is off or the account is paused. The note in the chat keeps how far it got (shared/momoDraftSend.mjs), which is the receipt: asked, chosen, sent. One send per note at a time and never a second after one went (a double click, a retry, a second window); a send the app stopped on, or whose result is unknown, is "unsure" and offers no Send again, because sending twice is worse than asking the user to look.
const { readDraft, draftLine } = require('../../shared/momoDraft.mjs');
const { SEND_TOOL, STATES, WHY, readSend, fromName } = require('../../shared/momoDraftSend.mjs');
const { ConnectorError } = require('./connectors/hub.cjs');

/** @typedef {import('../../shared/momoDraftSend.mjs').Send} Send */
/** @typedef {{ ok: true, send: Send } | { ok: false, reason: string, why?: string, send?: Send | null }} Sent */
/**
 * What the chooser lists: every connected account that has a send_mail tool. `ok` is false (with `why`) for one that can't send now.
 * @typedef {{ id: string, label: string, account: string, ok: boolean, why: string | null }} MailAccount
 */

/** A refusal's own word (the hub's `reason`) as the card's reason. */
const REFUSED = Object.freeze({
  paused: WHY.PAUSED,
  'read only': WHY.READ_ONLY,
  'MoMo is off': WHY.NOT_ALLOWED,
  'press mismatch': WHY.FAILED,
});

/**
 * @param {object} o
 * @param {Pick<InstanceType<typeof import('./connectors/hub.cjs').ConnectorHub>, 'list' | 'call' | 'press'>} o.hub
 * @param {{ record(id: string): any, patchMeta(id: string, patch: object): boolean }} o.chats
 * @param {() => Iterable<[string, any]>} o.records every chat's record, for the start-up settling of a send the app stopped on
 * @param {() => boolean} o.allowed
 * @param {(chatId: string) => boolean} o.isMomoChat
 * @param {(chatId: string, noteId: string, send: Send | null) => void} o.changed the note's send moved: tell the windows
 * @param {() => number} [o.now]
 */
function createDraftSender({ hub, chats, records, allowed, isMomoChat, changed, now = Date.now }) {
  /** @type {Set<string>} the sends running now, by chat and note */
  const running = new Set();
  const keyOf = (/** @type {string} */ chatId, /** @type {string} */ noteId) => `${chatId}\u0000${noteId}`;

  /** The draft note, or null when the chat or the note is gone (or is not a draft). */
  function noteOf(/** @type {string} */ chatId, /** @type {string} */ noteId) {
    const notes = chats.record(chatId)?.meta?.notes;
    return Array.isArray(notes) ? (notes.find((/** @type {any} */ n) => n?.id === noteId && n.kind === 'draft') ?? null) : null;
  }

  /** Writes the note's send (null removes it) and its words when given, then tells the windows; false when the chat is gone. */
  function save(
    /** @type {string} */ chatId,
    /** @type {string} */ noteId,
    /** @type {Send | null} */ send,
    /** @type {import('../../shared/momoDraft.mjs').Draft | null} */ draft = null,
  ) {
    const notes = chats.record(chatId)?.meta?.notes;
    if (!Array.isArray(notes)) return false;
    const next = notes.map((/** @type {any} */ n) => {
      if (n?.id !== noteId || n.kind !== 'draft') return n;
      const { send: _gone, ...rest } = n;
      return {
        ...rest,
        ...(draft ? { draft, text: draftLine(draft) } : {}),
        ...(send ? { send } : {}),
      };
    });
    // patchMeta-changes: every save moves the note's send (a new step, or its removal), so the notes always change
    if (!chats.patchMeta(chatId, { notes: next })) return false;
    changed(chatId, noteId, send);
    return true;
  }

  /** @returns {MailAccount[]} */
  function accounts() {
    if (allowed() !== true) return [];
    return hub
      .list()
      .filter((c) => c.connected && c.tools.some((t) => t.name === SEND_TOOL && t.kind === 'change'))
      .map((c) => {
        // a connected account never needs signing in again (the hub drops the tokens then), so only its level can stop a send
        const why = c.level === 'blocked' ? WHY.PAUSED : c.level === 'read' ? WHY.READ_ONLY : null;
        return {
          id: c.id,
          label: c.label,
          account: c.account ?? '',
          ok: why === null,
          why,
        };
      });
  }

  /**
   * Sends the draft note's words (the card's edited ones) from the account `from`, on the person's press. Answers at once with
   * a reason when it can't start; otherwise when the send ended: sent, or why it went back to the user.
   * @param {{ chatId: string, noteId: string, from: string, words: unknown }} input @returns {Promise<Sent>}
   */
  async function send({ chatId, noteId, from, words }) {
    if (allowed() !== true) return { ok: false, reason: WHY.NOT_ALLOWED };
    if (typeof chatId !== 'string' || typeof noteId !== 'string' || !isMomoChat(chatId)) return { ok: false, reason: WHY.NO_DRAFT };
    const key = keyOf(chatId, noteId);
    // before anything is awaited: a second click, window or retry meets this and does nothing
    if (running.has(key)) return { ok: false, reason: WHY.BUSY };
    const note = noteOf(chatId, noteId);
    if (!note) return { ok: false, reason: WHY.NO_DRAFT };
    const before = readSend(note.send);
    if (before) return { ok: false, reason: WHY.ALREADY, send: before };
    running.add(key);
    try {
      const read = readDraft(words);
      if (!read.ok) return { ok: false, reason: read.reason, why: read.why };
      if (!read.draft.to.length) return { ok: false, reason: WHY.NO_RECIPIENT };
      const account = accounts().find((a) => a.id === from);
      if (!account)
        return {
          ok: false,
          reason: typeof from === 'string' && from ? WHY.NOT_CONNECTED : WHY.NO_ACCOUNT,
        };
      if (!account.ok) return { ok: false, reason: /** @type {string} */ (account.why) };
      /** @type {import('../../shared/momoDraftSend.mjs').From} */
      const who = {
        id: account.id,
        label: account.label,
        account: account.account,
      };
      /** @type {(state: Send['state']) => Send} */
      const at = (state) => ({ state, from: who, at: now() });
      if (!save(chatId, noteId, at(STATES.ASKED), read.draft)) return { ok: false, reason: WHY.NO_DRAFT };
      const args = { from: fromName(who), to: read.draft.to, subject: read.draft.subject, body: read.draft.body };
      let chose = false;
      try {
        await hub.call({
          connector: account.id,
          tool: SEND_TOOL,
          chatId,
          // the user's press on this card's Send, bound to exactly what the card showed: the hub runs it with no second card
          press: hub.press(account.id, chatId, args, noteId),
          args,
          onAllowed: () => {
            chose = true;
            save(chatId, noteId, at(STATES.CHOSE));
          },
        });
      } catch (e) {
        // what ran is done even if the account was disconnected meanwhile (the hub says so): the mail went
        if (chose && e instanceof ConnectorError && e.code === 'stale') return done(chatId, noteId, at(STATES.SENT));
        save(chatId, noteId, null);
        return { ok: false, reason: reasonOf(e) };
      }
      return done(chatId, noteId, at(STATES.SENT));
    } finally {
      running.delete(key);
    }
  }

  /** The send ended well: the note keeps it as the receipt. @returns {Sent} */
  function done(/** @type {string} */ chatId, /** @type {string} */ noteId, /** @type {Send} */ sent) {
    // the chat was deleted meanwhile: the mail still went, and the audit log has it
    save(chatId, noteId, sent);
    return { ok: true, send: sent };
  }

  /** Why a failed hub call went back to the user, as the card's reason. */
  function reasonOf(/** @type {unknown} */ e) {
    if (!(e instanceof ConnectorError)) return WHY.FAILED;
    if (e.code === 'refused') return REFUSED[/** @type {keyof typeof REFUSED} */ (/** @type {any} */ (e).reason)] ?? WHY.DECLINED;
    if (e.code === 'not_connected') return WHY.NOT_CONNECTED;
    if (e.code === 'reconnect') return WHY.RECONNECT;
    // a disconnect before the mail went: nothing ran
    if (e.code === 'stale') return WHY.NOT_CONNECTED;
    return WHY.FAILED;
  }

  /** The note's send as the window reads it: null for a chat or note that is gone, or while MoMo is off. */
  function state(/** @type {string} */ chatId, /** @type {string} */ noteId) {
    if (allowed() !== true || typeof chatId !== 'string' || !isMomoChat(chatId)) return null;
    return readSend(noteOf(chatId, noteId)?.send);
  }

  /**
   * At start: a send the app stopped on (asked or chosen, nothing running now) is unsure, offering no Send again.
   * Returns how many were settled.
   */
  function settle() {
    let n = 0;
    for (const [chatId, rec] of records()) {
      for (const note of Array.isArray(rec?.meta?.notes) ? rec.meta.notes : []) {
        const s = note?.kind === 'draft' ? readSend(note.send) : null;
        if (s && (s.state === STATES.ASKED || s.state === STATES.CHOSE) && save(chatId, note.id, { ...s, state: STATES.UNSURE })) n++;
      }
    }
    return n;
  }

  return { accounts, send, state, settle };
}

module.exports = { createDraftSender };
