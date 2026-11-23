// Claude transcript fork rule: where "Fork chat from here" ends a turn.

/** A user prompt in getSessionMessages' list (not a tool result or a goal check). */
const isPrompt = (m) => {
  if (m?.type !== 'user' || m.isMeta || m.isSynthetic) return false;
  const c = m.message?.content;
  return typeof c === 'string' || (Array.isArray(c) && c.some((b) => b?.type === 'text' || b?.type === 'image'));
};

/**
 * The last message of the turn a prompt starts: what "Fork chat from here" keeps, up to and including. A turn a
 * compaction followed ends before it: the fork is the chat as it was, not the boundary the SDK lists after it (which
 * it may list without saying it is one, so system messages are left off the end). A turn the compaction cut in two
 * (the messages it kept come back after the summary) goes on to the last of those.
 */
function forkPoint(messages, promptUuid) {
  const i = (messages ?? []).findIndex((m) => m.uuid === promptUuid);
  if (i < 0) return null;
  let last = messages[i].uuid;
  let spoken = last;
  let compacted = false;
  for (let j = i + 1; j < messages.length; j++) {
    const m = messages[j];
    // before the prompt test: a summary is a user message with text, which would end the turn one message too late
    if (m.isCompactSummary === true || m.subtype === 'compact_boundary') {
      compacted = true;
      continue;
    }
    if (isPrompt(m)) break;
    if (!m.uuid) continue;
    last = m.uuid;
    if (m.type !== 'system') spoken = m.uuid;
  }
  return compacted ? spoken : last;
}

module.exports = { forkPoint };
