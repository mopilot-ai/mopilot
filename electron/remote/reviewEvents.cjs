// Tells the phones that follow a chat when its diff changes (review.changed: which turn, live or final, or taken back; never the diff itself, the phone asks diff.list), and makes the running turn's diff worth reading while a phone follows the chat even if no window shows it.
const { noteIgnored } = require('../ignored.cjs');

/** The event a phone gets. */
const REVIEW_CHANGED = 'review.changed';

/**
 * @param {object} o
 * @param {{ controller?: { turnSnapshots?: any }, chromePanel?: { service?: any } }} o.live the app's live objects: main's TurnSnapshots
 *   (session/turnSnapshots.cjs) and, once the panel has made it, the remote service
 * @returns {() => void} how to stop
 */
function attachReviewEvents({ live }) {
  const snapshots = live.controller?.turnSnapshots;
  if (!snapshots) return () => undefined;
  const service = () => live.chromePanel?.service;
  /** The devices that follow the chat and may review it. */
  const devices = (/** @type {string} */ chatId) => {
    const svc = service();
    return svc ? svc.followers(chatId).filter((/** @type {any} */ p) => svc.permitted(p.client, 'diff.list')) : [];
  };
  snapshots.followed = (/** @type {string} */ chatId) => devices(chatId).length > 0;
  return snapshots.onChange((/** @type {{ chatId: string, turnId: string, live: boolean, removed: boolean }} */ change) => {
    const svc = service();
    // after the chat's earlier events, so a phone hears the diff change in the order things happened
    void svc?.enqueue(change.chatId, async () => {
      for (const p of devices(change.chatId)) {
        try {
          await svc.emit(p.client.pairId, { ev: REVIEW_CHANGED, ...change });
        } catch (error) {
          // one device's failure leaves the others their event
          noteIgnored('tell a phone its chat’s diff changed', error);
        }
      }
    });
  });
}

module.exports = { attachReviewEvents, REVIEW_CHANGED };
