// A field's label from every text that labels it, each line once: pages often tie one field to several labels that repeat a word.

/**
 * Joins the texts that label one field (its <label>s, or its aria-labelledby targets) into one name. Each
 * text is split into lines, so a label holding a heading and a floating label ("Password\nPassword") counts
 * as two pieces, and a piece already taken (ignoring case and spacing) is dropped. Page scripts receive this
 * by its source text (pageAgent.cjs, agentCursor.cjs, annotateOverlay.ts), so it must not close over anything.
 * @param {readonly (string | null | undefined)[]} texts
 * @returns {string}
 */
export function labelText(texts) {
  const seen = new Set();
  const out = [];
  for (const text of texts) {
    for (const line of String(text == null ? '' : text).split(/[\r\n]+/)) {
      const piece = line.replace(/\s+/g, ' ').trim();
      const key = piece.toLowerCase();
      if (!piece || seen.has(key)) continue;
      seen.add(key);
      out.push(piece);
    }
  }
  return out.join(' ');
}
