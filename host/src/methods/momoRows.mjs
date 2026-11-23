// The Host's handler for `host.momoRows` (shared/host/methods/momoRows.mjs): the rows of MoMo's chat, read by a client that may see MoMo, never by the local command line (a card's text is the owner's to read).
import { isOwner } from '../momoOwner.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  /** The handler runs only for a client the veil let through, so there is a home and it has its rows. */
  const rows = () => /** @type {NonNullable<NonNullable<typeof momo>['rows']>} */ (/** @type {NonNullable<typeof momo>} */ (momo).rows);
  return {
    veils: { 'host.momoRows': (/** @type {unknown} */ principal) => !!momo && isOwner(principal) && !!momo.granted() },
    handlers: { 'host.momoRows': (/** @type {{ after?: number, limit?: number }} */ p) => rows().list(p.after, p.limit) },
  };
};
