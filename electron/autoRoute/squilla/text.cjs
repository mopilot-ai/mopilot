// SquillaRouter text contract ported from OpenSquilla features/text.py: canonical text, three segments and token truncation.
'use strict';

const HISTORY_MAX_TURNS = 4;
const HISTORY_SEPARATOR = '\n[TURN]\n';
const SEGMENT_KINDS = /** @type {const} */ (['current_request', 'recent_history', 'previous_answer']);

/** Python's str.strip() whitespace: Unicode White_Space plus the separators str.isspace() also counts. */
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const STRIP = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');
const SPLIT = new RegExp(`[${PY_SPACE}]+`, 'u');

/** Python `str.strip()`. */
function pyStrip(text) {
  return text.replace(STRIP, '');
}

/** Python `str.split()` with no separator: whitespace runs, no empty items. */
function pySplit(text) {
  const stripped = pyStrip(text);
  return stripped ? stripped.split(SPLIT) : [];
}

/** Length in code points, as Python's len(str). */
function pyLen(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** canonicalize_text: CRLF/CR to LF, NFC, strip. */
function canonicalizeText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string') throw new TypeError(`text value must be str or None, got ${typeof value}`);
  return pyStrip(value.replaceAll('\r\n', '\n').replaceAll('\r', '\n').normalize('NFC'));
}

/**
 * truncate_content_tokens: current requests keep about 3:1 head/tail, previous answers 1:1, history its tail.
 * @template T
 * @param {string} kind
 * @param {T[]} tokens
 * @param {number} [max]
 * @returns {T[]}
 */
function truncateContentTokens(kind, tokens, max = 510) {
  if (max <= 0) throw new RangeError('max_content_tokens must be positive');
  if (tokens.length <= max) return [...tokens];
  if (kind === 'recent_history') return tokens.slice(-max);
  let head;
  if (kind === 'current_request') head = Math.floor((max * 3 + 3) / 4);
  else if (kind === 'previous_answer') head = Math.floor((max + 1) / 2);
  else throw new RangeError(`unsupported segment kind: ${kind}`);
  const tail = max - head;
  return [...tokens.slice(0, head), ...(tail ? tokens.slice(-tail) : [])];
}

/**
 * extract_text_segments over a RouterInput-shaped payload.
 * @param {{ current_request?: string, history_user?: string[], previous_answer?: string }} input
 */
function extractTextSegments(input) {
  const current = canonicalizeText(input.current_request);
  if (!current) throw new RangeError('input.current_request must be non-empty');
  const raw = input.history_user ?? [];
  if (!Array.isArray(raw)) throw new TypeError('input.history_user must be a sequence of strings');
  const turns = raw.map(canonicalizeText).filter(Boolean).slice(-HISTORY_MAX_TURNS);
  return {
    current_request: current,
    recent_history: turns.join(HISTORY_SEPARATOR),
    previous_answer: canonicalizeText(input.previous_answer),
  };
}

/** The segments in SEGMENT_KINDS order. */
function segmentTexts(segments) {
  return [segments.current_request, segments.recent_history, segments.previous_answer];
}

module.exports = {
  HISTORY_MAX_TURNS,
  SEGMENT_KINDS,
  canonicalizeText,
  extractTextSegments,
  pyLen,
  pySplit,
  pyStrip,
  segmentTexts,
  truncateContentTokens,
};
