// The remote methods on a card and on the menus that change a chat: answer a card, pick a model, set a permission.
const { RemoteError } = require('../serviceErrors.cjs');
const { capPermission } = require('../permissionCap.cjs');
const { deviceAnswerer, mayAnswer, REFUSED } = require('../../../shared/answerOwner.mjs');
const { CARD_ANSWERED: STALE } = require('../../../shared/remote/cardAnswered.mjs');

/** A permission a phone sets is capped; the panel's is as the app's menu has it. */
function permitted(/** @type {any} */ svc, /** @type {any} */ client, /** @type {string} */ value) {
  if (client.kind === 'phone') capPermission(value, svc.policy.permissionCeiling?.() ?? 'auto-review');
}

/**
 * A phone's answer, checked the way a window's is: the device follows the chat, the card is still up, the rev is not
 * older than the card's, the key is one the card offered, and a choice that makes an allowance permanent only when the Mac allows it.
 * Returns the card's id and version once all hold.
 */
async function checkedAnswer(/** @type {any} */ svc, /** @type {any} */ client, /** @type {any} */ p) {
  if (!mayAnswer(deviceAnswerer(client.follows), p.chatId)) throw new RemoteError('forbidden', REFUSED.device);
  if (p.rev === undefined) throw new RemoteError('invalid', 'Say which version of the card you answered.');
  const state = svc.ops.state.get(p.chatId);
  const card = (await svc.ops.cardsOf(p.chatId)).find((c) => c.id === p.cardId);
  // a hand-off only the Mac finishes (phoneCards.cjs waiting cards) is never answered here
  if (!card && svc.waiting?.of(p.chatId).some((/** @type {any} */ c) => c.id === p.cardId))
    throw new RemoteError('forbidden', 'Finish this on your Mac.');
  if (!card) throw new RemoteError('stale', STALE);
  svc.ledger.note(p.chatId, card.version, state.rev);
  const raised = svc.ledger.revOf(p.chatId, card.version);
  if (p.rev < raised) throw new RemoteError('stale', STALE);
  // a card only the Mac finishes (one with no controls, a payment): the phone shows it, never answers it
  if (card.inApp || card.macOnly) throw new RemoteError('forbidden', 'Finish this on your Mac.');
  const choice = card.choices?.find((c) => c.key === p.key);
  if (card.choices && !choice) throw new RemoteError('invalid', 'Choose an option offered by this request.');
  if (choice?.confirm && !svc.policy.allowPersistent?.()) throw new RemoteError('forbidden', 'Allow this from your Mac.');
  // the checks above awaited: a phone the Mac removed meanwhile does not approve anything
  svc.assertPaired(client);
  return card;
}

module.exports = {
  'card.answer': async (svc, client, p) => {
    const card = client.kind === 'phone' ? await checkedAnswer(svc, client, p) : null;
    const answered = await svc.ops.answer({
      chatId: p.chatId,
      approvalId: p.cardId,
      choice: p.key,
      ...(card ? { version: card.version } : p.version !== undefined ? { version: p.version } : {}),
      ...(p.values !== undefined ? { values: p.values } : {}),
    });
    if (!answered) throw new RemoteError('stale', STALE);
    return { answered: true };
  },
  'card.choose': async (svc, _client, p) => {
    await svc.ops.choose(p);
    return { chosen: true };
  },
  'card.permit': async (svc, client, p) => {
    permitted(svc, client, p.value);
    await svc.ops.permit(p);
    return { permitted: true };
  },
  'options.set': async (svc, client, p) => {
    if (p.value !== undefined) {
      permitted(svc, client, p.value);
      await svc.ops.permit(p);
      return { permitted: true };
    }
    await svc.ops.choose(p);
    return { chosen: true };
  },
};
