// How the gate's cards become rows of MoMo's chat (host/src/momoServices/gate.mjs): one write at a time per card, each reading the card in its turn, and a look that puts right the rows that are missing or older than their card.
import { approvalView } from '../../shared/momoCore/view.ts';
import { ROWS_KEEP } from './momoRows.mjs';

/** The statuses of a card that still waits for something: its row is always kept right. */
const WAITING = ['open', 'deciding', 'allowed', 'using'];

/**
 * @param {object} o
 * @param {any} o.home
 * @param {() => Promise<{ store: import('../../shared/momoCore/approvalGate.ts').CardStore }>} o.ensure the gate's stores
 * @param {(cardId: string) => boolean} o.editable whether Edit is offered on a card
 * @param {(message: string) => void} o.report
 */
export function createGateRows({ home, ensure, editable, report }) {
  /** @type {Map<string, Promise<unknown>>} the last row write of each card still running */
  const chains = new Map();
  /**
   * The card as a row of MoMo's chat, one per card id, updated in place at every change (answered, used, expired, void). The row is the same for every client, so it names no viewing device: who answered is `decidedName` of host.momoCards, per device. A card raised while MoMo has no main chat has no row yet; `syncRows` writes it once there is one.
   * The writes of one card run one after the other, and each reads the card when its turn comes: a row built from an older read can never land after a newer one.
   * @param {string} id the card @param {boolean} [heal] a look at the rows: a row already kept as the card shows it is left alone, and so is a settled card with no row when the store has no room for it
   */
  const writeRow = (id, heal = false) => {
    const run = (chains.get(id) ?? Promise.resolve()).then(async () => {
      // off the home nothing is read, built or written: the stores are not even opened
      if (!home.stamp()) return;
      const card = await (await ensure()).store.get(id);
      if (!card) return;
      const row = {
        kind: 'approval',
        id: `approval:${card.id}`,
        at: card.createdAt,
        approval: approvalView(card, { device: card.decidedBy ?? '', editable: editable(card.id) }),
      };
      if (heal && !(await missing(card, row))) return;
      await home.rows?.put(row);
    });
    const tail = run.catch(() => undefined);
    chains.set(id, tail);
    void tail.then(() => chains.get(id) === tail && chains.delete(id));
    return run;
  };
  /** Whether a look has a row to write for a card: its row is not kept, or is kept as an older view of the card. A settled card with no row comes back only if the store has room, or the card changed after the oldest settled row was written (else it would push a newer row out on every look). @param {import('../../shared/momoCore/approvalGate.ts').Card} card @param {any} row */
  const missing = async (card, row) => {
    const kept = home.rows?.kept?.(row.id);
    if (kept) return JSON.stringify(kept.approval) !== JSON.stringify(row.approval);
    if (WAITING.includes(card.status)) return true;
    const stat = home.rows?.stat?.();
    if (!stat || stat.settled < ROWS_KEEP) return true;
    // the last time the card changed: when it was made, answered, used, or (unattended) ended
    const times = [card.createdAt, card.decidedAt, card.usedAt, card.status === 'expired' ? card.expiresAt : null];
    return Math.max(...times.filter((/** @type {unknown} */ t) => typeof t === 'number')) > stat.oldest;
  };
  /** The row of a card, written where a failure of the row must not stop what the card is for: it is reported. @param {import('../../shared/momoCore/approvalGate.ts').Card | string} card the card, or its id @param {boolean} [heal] */
  const rowed = (card, heal = false) =>
    writeRow(typeof card === 'string' ? card : card.id, heal).catch((/** @type {Error} */ error) =>
      report(`MoMo could not write a card's row: ${error.message}`),
    );
  /** Writes the row of every card that has one to write (a card from before MoMo had a chat, a failed write, a row from an older view of the card), whatever its age; a row already kept as the card shows it is not written again. */
  const syncRows = async () => {
    if (!home.stamp() || !home.rows || !home.chats?.main()) return;
    const { store } = await ensure();
    for (const card of await store.list()) await rowed(card.id, true);
    await home.service('questions')?.syncRows?.();
  };

  return { rowed, syncRows };
}
