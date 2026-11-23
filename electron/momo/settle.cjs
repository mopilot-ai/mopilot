// How long a message to a MoMo chat waits for the brain change a window made just before it (#3907): the change's settling, held at most a bound, never a failure.

/** The longest a message waits: a change still checking that the harness can run or reading its models. */
const SETTLE_MS = 5000;

/**
 * `settling` (a promise that never rejects) or `ms` passing, whichever comes first. Never rejects.
 * @param {Promise<unknown>} settling
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
async function settleWithin(settling, ms = SETTLE_MS) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  await Promise.race([settling, bound]);
  clearTimeout(timer);
}

/**
 * A message is going to `chatId`: once the brain changes the main chat service has queued settled, for a MoMo chat; at once for any other.
 * @param {{ isMomoChat: (chatId: string) => boolean, tail: Promise<unknown> }} service MomoMainChat
 * @param {string} chatId
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
const settledFor = (service, chatId, ms) => (service.isMomoChat(chatId) ? settleWithin(service.tail, ms) : Promise.resolve());

module.exports = { settleWithin, settledFor, SETTLE_MS };
