// Bounded text prefixes (and suffixes) that keep UTF-16 surrogate pairs intact, counted in code points or in UTF-16 units.
export function prefixCodePoints(text, max) {
  const limit = Math.max(0, Math.trunc(max)) || 0;
  let end = 0;
  let count = 0;
  for (const point of text) {
    if (count >= limit) break;
    end += point.length;
    count++;
  }
  return text.slice(0, end);
}

/**
 * At most the first `n` UTF-16 units of `s`, one fewer when the last would be half of a surrogate pair: for a limit
 * that is a size budget (bytes, a model's context), where a prefix of `n` code points could be twice as long.
 */
export function prefixUnits(s, n) {
  const p = s.slice(0, Math.max(0, n));
  return /[\uD800-\uDBFF]$/.test(p) ? p.slice(0, -1) : p;
}

/** At most the last `n` UTF-16 units of `s`, one fewer when the first would be half of a surrogate pair. */
export function suffixUnits(s, n) {
  const p = n > 0 ? s.slice(-n) : '';
  return /^[\uDC00-\uDFFF]/.test(p) ? p.slice(1) : p;
}

/**
 * The text with each unpaired surrogate (half of an emoji left by a cut elsewhere) replaced by U+FFFD: what a
 * harness's JSON parser accepts. Pairs are kept.
 */
export function wellFormedText(s) {
  return s.replace(/[\uD800-\uDFFF]/gu, '\uFFFD');
}
