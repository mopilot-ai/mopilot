// What the Remote Run milestone scenarios share: reading the Host's pending cards, waiting for one, answering it as a client, and killing the app's process.
import { pendingOf } from '../../../shared/host/approvals.mjs';
import { expect, session, until } from '../steps.mjs';

/** The Host's waiting cards and chats that need a person, parsed as every client parses them. @param {any} c */
export async function pending(c) {
  return pendingOf(await c.request('host.pending'));
}

/** Wait until a card of the chat waits on the Host; a turn that ends or fails first, as the client's stream says, is the answer at once, not a timeout. @param {any} c @param {string} chatId */
export async function waitCard(c, chatId) {
  // `until` retries a check that throws, so the end of the chat is a result of the check, and is raised here
  const found = await until(
    async () => {
      const card = (await pending(c)).cards.find((x) => x.chatId === chatId);
      if (card) return { card };
      const over = framesOf(c, chatId).find((e) => e.frame?.item?.event?.kind === 'turnEnd' || e.frame?.item?.t === 'error');
      return over && { over };
    },
    { what: `a card of ${chatId}`, every: 300 },
  );
  if (found.over) throw new Error(`The chat ended without raising a card: ${JSON.stringify(found.over.frame.item).slice(0, 300)}.`);
  return found.card;
}

/** The option of a card that allows or denies. @param {any} card @param {'allow' | 'deny'} kind */
export function optionOf(card, kind) {
  const option = card.options.find((/** @type {any} */ o) => o.kind === kind);
  expect(option, `The card has no ${kind} option (${JSON.stringify(card.options)}).`);
  return option;
}

/** Answer a card as this client does; the key makes the answer one request. @param {any} c @param {any} card @param {string} optionId @param {string} tag */
export const answerCard = (c, card, optionId, tag) =>
  c.request('chat.answer', { chatId: card.chatId, epoch: card.epoch, key: `accept-answer-${tag}`, requestId: card.requestId, optionId });

/** The chat's frames the stream carried to this client. @param {any} c @param {string} chatId */
export const framesOf = (c, chatId) => c.events.filter((/** @type {any} */ e) => e.chatId === chatId);

/** Whether an item of the stream is this event of the chat. @param {string} chatId @param {string} kind @param {Record<string, unknown>} [fields] */
export const eventOf =
  (chatId, kind, fields = {}) =>
  (/** @type {any} */ e) =>
    e.chatId === chatId && e.frame?.item?.event?.kind === kind && Object.entries(fields).every(([k, v]) => e.frame.item.event[k] === v);

/** Only the items that reach this client after this call: a subscribe from revision 0 replays the chat's record, and a wait must not match a replayed item. Call it right before the action whose result is awaited. @param {any} c @param {(e: any) => boolean} match */
export const later = (c, match) => {
  const from = c.events.length;
  return (/** @type {any} */ e) => c.events.indexOf(e) >= from && match(e);
};

/** The app's process on the machine, ended with SIGKILL; what it did is the answer. @param {any} ctx */
export async function killApp(ctx) {
  const found = await ctx.m.run(`pgrep -f '[M]oPilot.app/Contents/MacOS/MoPilot' | head -1`);
  const pid = found.stdout.trim();
  if (!pid) return 'no app process runs on the machine, so only the client connection was dropped';
  await ctx.m.run(`kill -9 ${pid}`);
  return `app process ${pid} killed with SIGKILL`;
}

/** One request on a connection of its own. @param {any} ctx @param {string} method @param {object} [params] */
export async function rpc(ctx, method, params) {
  const c = await session(ctx);
  try {
    return await c.request(method, params);
  } finally {
    c.close();
  }
}

/** The refusal a request gets: its `code`, or null when the Host let it through (a refusal carries its code, a timeout `timeout`). @param {any} ctx @param {string} method @param {object} params */
export async function refusalOf(ctx, method, params) {
  try {
    await rpc(ctx, method, params);
    return null;
  } catch (e) {
    return /** @type {any} */ (e).code;
  }
}
