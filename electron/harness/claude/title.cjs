// A new Claude Code chat's title: written at send by the warm title CLI of the chat's login (#3413), else by the chat's own
// CLI once it took the message, else by the cheapest model once the chat's turn shows output (#1651, #2150).

const { generatedTitle, provisionalTitle } = require('../../../shared/title.mjs');
const { parseUserText } = require('../../../shared/userText.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { landTitle, within } = require('../autoTitle.cjs');

/** The CLI's own title request: a side query on its small model, so a few seconds at most. */
const LIVE_TITLE_MS = 15_000;
/** The fallback waits for the turn's first output (at most 20 s) and then starts a CLI of its own. */
const FALLBACK_TITLE_MS = 60_000;

/**
 * Name a chat's first message with a short title, as the chat's own login, unless it already has a name (the user's,
 * or one from an earlier turn). It is written beside the CLI's start, by the login's warm title CLI, so it never waits
 * for the chat's CLI, and saved once that CLI took the message (`sending`). Without the helper the running CLI writes it,
 * and without that request the helper query does, once `ready` settles.
 * @param {any} adapter the ClaudeAdapter
 * @param {Promise<void> | null} ready
 * @param {Promise<unknown>} [sending] the send of the message (resolves once the CLI took it)
 */
async function autoTitle(adapter, chatId, ref, text, cwd, st, ready, sending = Promise.resolve()) {
  text = parseUserText(text).text;
  if (adapter.titling.has(chatId) || !text.trim()) return;
  adapter.titling.add(chatId);
  const accepted = sending.then(
    () => true,
    () => false,
  );
  const provisional = provisionalTitle(text);
  /** the helper's title, shown before the CLI took the message @type {string | null} */
  let shown = null;
  try {
    // If reading the name fails, leave it alone: a title must never erase an unknown user name. The CLI titles the chat
    // itself within seconds, and that title is not a name the user gave (harness/claude/userTitle.cjs).
    const named = () => adapter.api.userTitle(ref.id);
    if (await named()) return;
    const name = await landTitle({
      prompt: text,
      generate: async () => {
        const quick = await adapter.api.title(text, cwd, st.prefs.claudeBin, st.account, chatId, { helper: true });
        if (quick) {
          // shown the moment it is written; saved below once the CLI took the message
          shown = generatedTitle(quick, text);
          adapter.emit({ kind: 'threadName', key: ref.key, chatId, name: shown, provisional });
          return quick;
        }
        // the chat's own CLI is asked only once it has the message
        if (!(await accepted)) return null;
        const live = await liveTitle(adapter, ref.key, text);
        if (live) return live;
        await ready;
        return adapter.api.title(text, cwd, st.prefs.claudeBin, st.account, chatId);
      },
      unnamed: async () => !(await named()),
      apply: (n) => adapter.api.rename(ref.id, n),
      what: 'write a title for a Claude Code chat',
      ms: FALLBACK_TITLE_MS,
      accepted,
    });
    if (name) adapter.emit({ kind: 'threadName', key: ref.key, chatId, name, provisional });
    // the message didn't go: the chat is named after its first words again (unless it was renamed meanwhile)
    else if (shown && !(await accepted)) adapter.emit({ kind: 'threadName', key: ref.key, chatId, name: provisional, provisional: shown });
  } finally {
    adapter.titling.delete(chatId);
  }
}

/** The running CLI's title for `text`, or null (no live CLI, an older CLI, a failure or no answer in time). */
async function liveTitle(adapter, key, text) {
  if (!adapter.api.isLive(key)) return null;
  try {
    const title = await within(Promise.resolve(adapter.api.control(key, 'generateTitle', text)), LIVE_TITLE_MS);
    return typeof title === 'string' && title.trim() ? title : null;
  } catch (error) {
    noteIgnored('ask a Claude Code session for its title', error);
    return null;
  }
}

const OUTPUT_TYPES = new Set(['stream_event', 'assistant', 'result']);

/** A claude:event showing that the session's turn has started answering, or that its CLI is gone. */
function isFirstOutput(e) {
  return e.kind === 'closed' || e.kind === 'error' || (e.kind === 'message' && OUTPUT_TYPES.has(e.msg?.type));
}

module.exports = { autoTitle, isFirstOutput, LIVE_TITLE_MS };
