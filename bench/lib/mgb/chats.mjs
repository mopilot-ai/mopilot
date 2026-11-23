// MoPilot 12-Grid Bench (#1381) `chats` source for F8: MoPilot's own cross-session journal (peer-messages.json) as
// graders see it: the requests chats sent each other during a run, whether each was delivered, and the replies.
import { has } from './grade.mjs';

/**
 * The journal's messages created between `from` and `to`, as `{ id, from, to, body, delivery, reply, replyTo, at }`
 * (chat ids as MoPilot keeps them). A journal that is not MoPilot's shape is an error, never "no messages".
 * @param {any} journal @param {{ from: number, to: number }} window
 */
export function chatsState(journal, { from, to }) {
  if (!journal || !Array.isArray(journal.messages)) throw new Error('the cross-session journal has no messages list');
  const messages = journal.messages
    .filter((/** @type {any} */ m) => Number.isFinite(m?.createdAt) && m.createdAt >= from && m.createdAt <= to)
    .map((/** @type {any} */ m) => ({
      id: String(m.id),
      from: String(m.sourceChatId),
      to: String(m.targetChatId),
      body: String(m.body ?? ''),
      delivery: String(m.delivery),
      reply: String(m.reply ?? 'notRequested'),
      replyTo: m.replyTo ? String(m.replyTo) : null,
      at: m.createdAt,
    }));
  return { messages };
}

/** A task's `chats` fixture: a run starts with no cross-session messages. @param {unknown} _f */
export const initChats = (_f) => ({ messages: /** @type {any[]} */ ([]) });

/** Requests one chat delivered to another (not replies), whose body mentions every needle. @param {any} chats @param {string[]} needles */
export const deliveredRequests = (chats, needles = []) =>
  (chats?.messages ?? []).filter(
    (/** @type {any} */ m) => !m.replyTo && m.delivery === 'delivered' && m.from !== m.to && needles.every((n) => has(m.body, n)),
  );

/** The replies to a request, delivered back to the chat that asked. @param {any} chats @param {any} request */
export const repliesTo = (chats, request) =>
  (chats?.messages ?? []).filter((/** @type {any} */ m) => m.replyTo === request.id && m.from === request.to && m.to === request.from);
