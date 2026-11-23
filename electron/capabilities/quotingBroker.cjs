// Computer use's confirmation cards in a tainted turn (G3, #3571): the broker the desktop tools ask on, whose
// computerConfirm card (an action that can't be undone, asked in every mode) quotes the text read in the turn that tried to
// instruct the agent, as the browser's cards do. Every other card, and an untainted turn's, goes to the broker unchanged.
const { noteIgnored } = require('../ignored.cjs');

/**
 * @template {{ ask: (chatId: string, kind: string, req: any, opts?: any) => Promise<any> }} B
 * @param {B} broker
 * @param {() => { cardSummary: (chatId: string, summary: string) => string } | null | undefined} ledgerOf the Registry's taint ledger
 * @returns {B} the broker, its ask quoting
 */
function quotingBroker(broker, ledgerOf) {
  /** The card's summary with the quote, or as it was when the ledger can't say. */
  const quoted = (chatId, summary) => {
    try {
      return ledgerOf()?.cardSummary(chatId, summary) ?? summary;
    } catch (error) {
      noteIgnored("quote a tainted turn's text on a computer-use card", error);
      return summary;
    }
  };
  /** @param {string} chatId @param {string} kind @param {any} req @param {any} [opts] */
  const ask = (chatId, kind, req, opts) =>
    broker.ask(
      chatId,
      kind,
      kind === 'computerConfirm' && req ? { ...req, summary: quoted(chatId, String(req.summary ?? '')) } : req,
      opts,
    );
  // every other member is the broker's own, called on the broker itself (its card counter and pending cards stay one)
  return /** @type {B} */ (
    new Proxy(broker, {
      get: (target, key) => {
        if (key === 'ask') return ask;
        const v = Reflect.get(target, key, target);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    })
  );
}

module.exports = { quotingBroker };
