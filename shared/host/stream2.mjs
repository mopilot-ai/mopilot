// The stream's second vocabulary: what a Host tells that an app built before it would misread (a sub-agent's words, a command's live output, chat state), the feature that names it and how a Host holds it back from an end without the feature.
export const STREAM2_FEATURE = 'stream2';

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The sub-agent call an update's words belong to (claude-agent-acp's `parentToolUseId`), or null for the chat's own. @param {any} update */
export const subAgentOf = (update) => {
  const id = update?._meta?.claudeCode?.parentToolUseId;
  return typeof id === 'string' && id ? id : null;
};

/** Whether an event (or a delta head) is one only a `stream2` end can draw: a sub-agent's words read as the chat's reply to an end that ignores their call, and a command's live output is no update it knows. @param {any} e */
export function needsStream2(e) {
  if (!isObject(e)) return false;
  // a form card (a question the agent asks) is drawn from its own event, which an older end does not know
  if (e.kind === 'question') return true;
  const update = e.kind === 'update' ? e.update : e;
  if (!isObject(update)) return false;
  // a command's live output has no place in an end that draws a call from its updates alone
  if (update.sessionUpdate === 'tool_output_delta') return true;
  return /^agent_(message|thought)_chunk$/.test(String(update.sessionUpdate)) && subAgentOf(update) !== null;
}

/**
 * A frame as an end without `stream2` may be told it: the parts it would misread are left out (it never had them), the rest is as it was. Null when nothing is left of it.
 * @param {any} frame
 */
export function withoutStream2(frame) {
  if (!isObject(frame)) return frame;
  const old = (/** @type {any} */ item) => !(item?.t === 'event' && needsStream2(item.event));
  if (frame.t === 'durable') return old(frame.item) ? frame : null;
  if (frame.t === 'delta') return needsStream2(frame.delta) ? null : frame;
  // the chat's state is a frame of its own, which an older end cannot parse (it would drop the stream and ask again)
  if (frame.t === 'state') return null;
  if (frame.t !== 'hello') return frame;
  const { chatState: _state, ...hello } = frame;
  return {
    ...hello,
    snapshot: frame.snapshot ? { ...frame.snapshot, items: frame.snapshot.items.filter(old) } : frame.snapshot,
    // (a run with nothing left is left out whole)
    inFlightEphemeral: frame.inFlightEphemeral
      .map((/** @type {any} */ run) => ({ ...run, deltas: run.deltas.filter((/** @type {any} */ d) => !needsStream2(d)) }))
      .filter((/** @type {any} */ run, /** @type {number} */ i) => run.deltas.length > 0 || frame.inFlightEphemeral[i].deltas.length === 0),
  };
}
