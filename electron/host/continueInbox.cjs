// The handoffs of chats that came back to this Mac from another Host (docs: design/host/index.html, package 3.1): prepared when the user continues the chat here, bound when the chat becomes this Mac's again, and handed to the chat's next message once. Made at startup so a handoff that waits across a restart is still found.
const path = require('node:path');
const { parseKind } = require('../../shared/harnessKind.mjs');
const { createContinueTarget } = require('../../host/src/continueTarget.mjs');
const { createHostFs } = require('../../host/src/hostFs.mjs');

/**
 * @param {{ dir: string }} o where the handoffs live (under userData)
 */
function createContinueInbox({ dir }) {
  const target = createContinueTarget({
    dir,
    hostFs: createHostFs({}),
    // this Mac starts every family a chat can run on; a basic harness it has not admitted fails when its session starts
    accepts: (harness) => parseKind(harness) !== null,
  });
  /** The chats whose handoff waits for their next message. */
  const waiting = new Set(target.pending().flatMap((p) => (p.chatId ? [p.chatId] : [])));
  return {
    /** The Host calls of the target half (check the folder and agent, keep the handoff, bind it when the chat is this Mac's). */
    target: {
      check: target.check,
      open: target.open,
      discard: target.discard,
      /** @param {{ chatId: string, nativeId: string }} rec */
      serve(rec) {
        target.serve(rec);
        // only a handoff that was kept is waited for
        if (target.take(rec.chatId)) waiting.add(rec.chatId);
      },
    },
    /** What the chat's next message carries, or null. Cheap for the chats that wait for nothing (every message asks). @param {string} chatId */
    pending(chatId) {
      if (!waiting.has(chatId)) return null;
      const p = target.take(chatId);
      return p?.harness && p.cwd ? { harness: p.harness, cwd: p.cwd, text: p.text } : null;
    },
    /** The message went out. @param {string} chatId */
    done(chatId) {
      waiting.delete(chatId);
      target.done(chatId);
    },
  };
}

/**
 * The inbox of an app whose data folder is not known yet: made on its first use, in `name` under userData.
 * @param {{ getPath: (n: any) => string }} app @param {string} name
 */
function createLazyContinueInbox(app, name) {
  /** @type {ReturnType<typeof createContinueInbox> | null} */
  let made = null;
  const inbox = () => (made ??= createContinueInbox({ dir: path.join(app.getPath('userData'), name) }));
  return {
    get target() {
      return inbox().target;
    },
    pending: (/** @type {string} */ chatId) => inbox().pending(chatId),
    done: (/** @type {string} */ chatId) => inbox().done(chatId),
  };
}

module.exports = { createContinueInbox, createLazyContinueInbox };
