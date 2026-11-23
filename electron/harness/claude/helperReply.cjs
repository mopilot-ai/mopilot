// What a one-shot Claude Code helper query (a chat's title, a handoff note) answers: its own words, never the CLI's error reply.
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { isSyntheticAssistant } = require('../../../shared/claudeItems/failures.mjs');
const { claudeResultErrors, claudeResultFailed } = require('../../../shared/claudeResult.mjs');

/**
 * The text of a helper query's reply, or a throw with the failure. A query that can't run (the account is at its limit,
 * the login lapsed) is answered by a synthetic assistant message holding the error as text ("You've hit your monthly
 * spend limit ..."): that is a failure to report, never a title or a note to keep.
 * @param {AsyncIterable<any>} q
 * @returns {Promise<string>}
 */
async function helperReply(q) {
  let text = '';
  let failure = '';
  for await (const m of q) {
    if (m.type === 'assistant') {
      const said = contentBlocks(m.message?.content)
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (isSyntheticAssistant(m)) failure ||= said.trim() || String(m.error ?? 'Claude Code could not answer');
      else text += said;
    }
    if (m.type === 'result') {
      // a result with no subtype is a plain end of the stream, as the SDK's own tests and fakes give it
      if (m.is_error === true || (m.subtype && claudeResultFailed(m)))
        failure ||= claudeResultErrors(m).join('; ') || String(m.result ?? m.subtype);
      break;
    }
  }
  if (failure) throw new Error(failure);
  return text.trim();
}

module.exports = { helperReply };
