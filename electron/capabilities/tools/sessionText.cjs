// A chat's turns as plain text for the session tools (list_events, search_session_transcripts, export_transcript): one
// line per user message, agent message or tool call, the same for every harness because the turns are the shared peer
// transcript's (session/peerTranscript.cjs).
const { clip: clipMarked } = require('../../../shared/clippedText.mjs');

const LINE_CAP = 2000;
const SNIPPET = 80;

/** A line held to `n` characters, its cut marked with how much it left out. */
const clip = (s, n = LINE_CAP) => clipMarked(s, n);
const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();

/** What a tool-call item is, in a few words: its command, tool, query or kind. */
function toolWords(item) {
  const name = [item.server, item.tool].filter((x) => typeof x === 'string' && x).join('.');
  const words = typeof item.command === 'string' && item.command ? item.command : name || item.query || item.type;
  return typeof words === 'string' ? words.replace(/\s+/g, ' ').trim() : String(item.type);
}

/**
 * The events of `turns`, oldest first: {id, role: 'user' | 'assistant' | 'tool', text}. An event's id is its turn's id
 * and position, so a page can end exactly where the last one began.
 * @param {any[]} turns
 */
function eventsOf(turns) {
  const out = [];
  for (const [t, turn] of (Array.isArray(turns) ? turns : []).entries()) {
    for (const [i, item] of (Array.isArray(turn?.items) ? turn.items : []).entries()) {
      const id = `${turn?.id ?? `t${t}`}#${i}`;
      if (item?.type === 'userMessage') {
        const text = textOf(item.content);
        if (text) out.push({ id, role: 'user', text: clip(text) });
      } else if (item?.type === 'agentMessage') {
        if (typeof item.text === 'string' && item.text.trim()) out.push({ id, role: 'assistant', text: clip(item.text.trim()) });
      } else if (item && typeof item.type === 'string' && item.type !== 'reasoning' && item.type !== 'statusNote')
        out.push({ id, role: 'tool', text: clip(toolWords(item), 300) });
    }
  }
  return out;
}

/** An event as one block of text. */
const eventText = (e) => `${e.role === 'user' ? 'User' : e.role === 'assistant' ? 'Assistant' : 'Tool'}: ${e.text}`;

/**
 * Where `query` (any case) first occurs in the events, with the text around it; null when it does not occur.
 * @param {{ text: string }[]} events
 * @param {string} query
 */
function snippetOf(events, query) {
  const q = query.toLowerCase();
  for (const e of events) {
    const at = e.text.toLowerCase().indexOf(q);
    if (at < 0) continue;
    const from = Math.max(0, at - SNIPPET);
    const to = Math.min(e.text.length, at + q.length + SNIPPET);
    return `${from > 0 ? '…' : ''}${e.text.slice(from, to).replace(/\s+/g, ' ')}${to < e.text.length ? '…' : ''}`;
  }
  return null;
}

module.exports = { eventsOf, eventText, snippetOf, textOf };
