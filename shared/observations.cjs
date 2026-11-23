// Optional observation boundary for product operations; @host-portable: only observes neutral facts with no default effects.
const { identityKey } = require('./identityKey.mjs');
const { noteIgnored } = require('../electron/ignored.cjs');
/** @type {{ publish: (fact: import('./observations.cjs').UsageFact) => void } | null} */
let observer = null;

/** Install one process-owned observer; disposing an older owner cannot remove its replacement. */
function observeWith(next) {
  const registration = { publish: next };
  observer = registration;
  return () => {
    if (observer === registration) observer = null;
  };
}

/** Best effort only. Observers receive no content, arguments, paths, native messages or credentials. */
function observe(fact) {
  try {
    Promise.resolve(observer?.publish(fact)).catch((error) => {
      noteIgnored('observe an optional product operation', error);
    });
  } catch (error) {
    noteIgnored('observe an optional product operation', error);
  }
}

/** Project the shared session owner inside the failure boundary, including chats with no segment yet. */
function observeSession(chatId, read, ref) {
  if (!observer) return;
  try {
    const state = read();
    const owner = ref();
    observe({
      kind: 'session',
      chatId,
      segment: identityKey(owner.kind, owner.id, owner.instance ?? null),
      harness: owner.kind,
      running: state.turn === 'running' || state.turn === 'awaitingUser',
      human: !!state.activeTurn?.human,
      crashed: state.turn === 'crashed',
      plan: !!state.plan,
      goal: !!state.goal,
      scheduled: !!state.scheduled,
      queued: state.queue.length > 0,
      remote: !!state.runningElsewhere,
    });
  } catch (error) {
    noteIgnored('observe a chat with no current session owner', error);
  }
}

module.exports = { observe, observeWith, observeSession };
