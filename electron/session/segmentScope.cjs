// The segment scope (docs/control-plane/design.md, class 4): per-chat controller state a native session reports
// belongs to the chat's current segment. A Claude CLI a switch left behind stays up (idle until reaped), but
// its Claude in Chrome link no longer reaches the chat, and the switch's segment end shows the new segment's.
const { matchesSource } = require('./contract/route.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * Whether Claude in Chrome state applies to a chat whose current segment `refOf()` reads: only a Claude
 * segment runs it, and with `key` only that segment's own session (CM-B02, CM-B03). The segment is read
 * here, so a chat whose segment can't be read (a kind this build doesn't know) has no link instead of
 * throwing into a CLI's exit cleanup or a tool call.
 */
function chromeLinkApplies(refOf, key = null) {
  try {
    const ref = refOf();
    return !!ref && matchesSource(ref, { kind: 'claude', key });
  } catch (error) {
    noteIgnored("read a chat's segment for its Claude in Chrome link", error);
    return false;
  }
}

/**
 * Claude in Chrome's link in each chat's session state, kept to the chat's current segment.
 * @param {object} o
 * @param o.sessions SessionStore
 * @param o.ref (chatId) => the chat's NativeRef
 * @param o.linkOf (key) => the link the live Claude session on `key` last read, or null
 */
function chromeLinkScope(o) {
  return {
    /** A Claude session read its link (null: it ended): the chat takes it only from its current segment's session. */
    report(chatId, link, key) {
      if (chatId && chromeLinkApplies(() => o.ref(chatId), key)) o.sessions.patch(chatId, { chromeLink: link });
    },
    /** Segment end: a switch settled on `to`; the chat shows that segment's link, if its session runs one. */
    segmentEnded({ chatId, to }) {
      o.sessions.patch(chatId, { chromeLink: chromeLinkApplies(() => to) ? o.linkOf(to.key) : null });
    },
  };
}

module.exports = { chromeLinkApplies, chromeLinkScope };
