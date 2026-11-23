// The Host's handler for host.momoNotice (shared/host/methods/momoNotice.mjs): what MoMo's notices keep, read for the two apps, and snooze and dismiss. Veiled like the rest of MoMo: to a client that is not paired, or while no live grant of an invited account is held, it is a request no Host knows.

import { isOwner } from '../momoOwner.mjs';

/** @param {{ momo?: ReturnType<typeof import('../momoHome.mjs').createMomoHome> }} deps */
export default ({ momo }) => {
  /** What the home's notice service offers, read when asked: the home may be wired after this file loads. @returns {any} */
  const notice = () => momo?.service('notice');
  return {
    veils: { 'host.momoNotice': (/** @type {unknown} */ principal) => !!momo && isOwner(principal) && momo.granted() && !!notice() },
    handlers: {
      'host.momoNotice': async (/** @type {{ op: string } & Record<string, any>} */ p) => {
        switch (p.op) {
          case 'decisions':
            return { decisions: notice().decisions(p) };
          case 'watching':
            return { tasks: await notice().watching() };
          case 'cards':
            return { cards: notice().cards() };
          case 'snooze':
            return { done: await notice().actions.snooze(p.matterKey, p.until) };
          case 'retry':
            return { done: await notice().actions.retry() };
          case 'moreReads':
            return { done: await notice().actions.moreReads() };
          case 'dismiss':
            return { done: await notice().actions.dismiss(p.matterKey) };
          default:
            return notice().state();
        }
      },
    },
  };
};
