// Conditional human Retry must still own the observed idle session before any send or peer-intent side effect.
const { busy } = require('./controllerEvents.cjs');

function assertRetryAdmission(state, chatId, item, nativeWriter = false) {
  const revision = item?.retryAtRevision;
  if (revision === undefined) return;
  const session = state.get(chatId);
  if (
    nativeWriter ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    revision !== session.rev ||
    busy(session) ||
    session.activeTurn ||
    session.queue.length
  )
    throw new Error('The chat changed before Retry reached it. Your message was not sent again.');
}

module.exports = { assertRetryAdmission };
