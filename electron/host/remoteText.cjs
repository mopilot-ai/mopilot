// The text of a Host's unfinished messages as the windows draw it, and the row of an item this app cannot read: split from remoteChats.cjs, which keeps what a chat follows.
const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The row an item of a known family that this app cannot read draws (short, so a chat never silently misses something). */
const DEGRADED = 'This part of the reply can’t be shown by this version of MoPilot.';

/** The update that draws the degraded row for `item`'s turn, or null when the item names none. @param {any} item */
function degradedEvent(item) {
  const turnId = item?.event?.turnId;
  if (typeof turnId !== 'string') return null;
  return { kind: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: DEGRADED } } };
}

/** @param {(event: object) => void} emit */
function createLiveText(emit) {
  /** The update event that draws `text` of a message; `replaces` is the text drawn of it that this text takes the place of. A command's live output is the call's whole output so far (`key` names what is drawn of it). @param {{ shown: Map<string, string>, chatId: string }} f @param {any} head @param {string} text @param {string} [replaces] @param {string} [key] */
  function textEvent(f, head, text, replaces, key) {
    if (head.sessionUpdate === 'tool_output_delta') {
      const output = /** @type {string} */ (f.shown.get(/** @type {string} */ (key)));
      return {
        kind: 'update',
        key: f.chatId,
        turnId: head.turnId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: head.toolCallId,
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: output } }],
          rawOutput: { output },
        },
      };
    }
    return {
      kind: 'update',
      key: f.chatId,
      turnId: head.turnId,
      update: {
        sessionUpdate: head.sessionUpdate,
        ...(head.messageId === undefined ? {} : { messageId: head.messageId }),
        // a sub-agent's words keep the call they belong to
        ...(isObject(head._meta) ? { _meta: head._meta } : {}),
        content: { type: 'text', text },
      },
      ...(replaces === undefined ? {} : { replaces }),
    };
  }

  /** Draws `text` of an unfinished message that goes on from what is drawn already (nothing when it is no longer than that, or does not start with it). @param {{ shown: Map<string, string>, chatId: string }} f @param {string} key @param {any} head @param {string} text */
  function showText(f, key, head, text) {
    const drawn = f.shown.get(key) ?? '';
    if (text.length <= drawn.length || !text.startsWith(drawn)) return;
    f.shown.set(key, text);
    emit(textEvent(f, head, text.slice(drawn.length), undefined, key));
  }

  /** @param {{ shown: Map<string, string>, chatId: string }} f @param {{ key: string, deltas: any[] }[]} inflight */
  function applyInflight(f, inflight) {
    for (const { key, deltas } of inflight) {
      const parts = deltas.filter((d) => isObject(d) && typeof d.text === 'string');
      if (parts.length) showText(f, key, parts[0], parts.map((d) => d.text).join(''));
    }
  }

  return { textEvent, showText, applyInflight };
}

module.exports = { createLiveText, degradedEvent };
