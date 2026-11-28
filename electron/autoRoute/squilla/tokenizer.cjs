// SquillaRouter's BGE tokenizer: the Hugging Face BertNormalizer, BertPreTokenizer and WordPiece from tokenizer.json.
'use strict';

// Hugging Face's BERT chinese-character ranges (tokenizers/src/normalizers/bert.rs).
const CJK = [
  [0x4e00, 0x9fff],
  [0x3400, 0x4dbf],
  [0x20000, 0x2a6df],
  [0x2a700, 0x2b73f],
  [0x2b740, 0x2b81f],
  [0x2b920, 0x2ceaf],
  [0xf900, 0xfaff],
  [0x2f800, 0x2fa1f],
];
const isChinese = (cp) => CJK.some(([lo, hi]) => cp >= lo && cp <= hi);
// Rust char::is_whitespace is the Unicode White_Space property.
const WHITE_SPACE = /^[\t\n\v\f\r \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]$/u;
const OTHER = /^\p{C}$/u;
const PUNCT = /^\p{P}$/u;
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;

const isWhitespace = (ch) => ch === '\t' || ch === '\n' || ch === '\r' || WHITE_SPACE.test(ch);
const isControl = (ch) => ch !== '\t' && ch !== '\n' && ch !== '\r' && OTHER.test(ch);
const isPunctuation = (ch) => ASCII_PUNCT.test(ch) || PUNCT.test(ch);

/**
 * Builds an encoder from a parsed tokenizer.json, accepting only the configuration SquillaRouter's model ships.
 * @param {any} spec
 */
function createBertTokenizer(spec) {
  const n = spec?.normalizer;
  const m = spec?.model;
  if (
    n?.type !== 'BertNormalizer' ||
    spec.pre_tokenizer?.type !== 'BertPreTokenizer' ||
    m?.type !== 'WordPiece' ||
    !m.vocab ||
    typeof m.vocab !== 'object'
  )
    throw new TypeError('tokenizer.json is not a BERT WordPiece tokenizer');
  if (n.lowercase || n.strip_accents) throw new TypeError('lowercasing and accent stripping are not supported');
  const vocab = new Map(Object.entries(m.vocab).map(([token, id]) => [token, Number(id)]));
  const prefix = m.continuing_subword_prefix ?? '##';
  const maxChars = m.max_input_chars_per_word ?? 100;
  const unk = vocab.get(m.unk_token);
  if (unk === undefined) throw new TypeError('tokenizer.json has no unknown token');
  const added = (spec.added_tokens ?? [])
    .filter((t) => !t.normalized && !t.single_word && !t.lstrip && !t.rstrip)
    .map((t) => ({ content: String(t.content), id: Number(t.id) }))
    .sort((a, b) => b.content.length - a.content.length);
  const tokenId = (name) => {
    const id = vocab.get(name);
    if (id === undefined) throw new TypeError(`tokenizer does not define ${name}`);
    return id;
  };

  function normalize(text) {
    let out = '';
    for (const ch of text) {
      const cp = /** @type {number} */ (ch.codePointAt(0));
      if (n.clean_text && (cp === 0 || cp === 0xfffd || isControl(ch))) continue;
      const c = n.clean_text && isWhitespace(ch) ? ' ' : ch;
      out += n.handle_chinese_chars && isChinese(cp) ? ` ${c} ` : c;
    }
    return out;
  }

  function preTokenize(text) {
    const words = [];
    let word = '';
    for (const ch of text) {
      if (isWhitespace(ch)) {
        if (word) words.push(word);
        word = '';
      } else if (isPunctuation(ch)) {
        if (word) words.push(word);
        words.push(ch);
        word = '';
      } else word += ch;
    }
    if (word) words.push(word);
    return words;
  }

  function wordPiece(word, ids) {
    const chars = Array.from(word);
    if (chars.length > maxChars) return void ids.push(unk);
    const pieces = [];
    let start = 0;
    while (start < chars.length) {
      let end = chars.length;
      let found;
      while (start < end) {
        const sub = (start > 0 ? prefix : '') + chars.slice(start, end).join('');
        found = vocab.get(sub);
        if (found !== undefined) break;
        end--;
      }
      if (found === undefined) return void ids.push(unk);
      pieces.push(found);
      start = end;
    }
    ids.push(...pieces);
  }

  function encodeText(text, ids) {
    for (const word of preTokenize(normalize(text))) wordPiece(word, ids);
  }

  /** Token ids without special tokens (encode(text, add_special_tokens=False)). */
  function encode(text) {
    /** @type {number[]} */
    const ids = [];
    let rest = text;
    while (rest) {
      let at = -1;
      /** @type {{ content: string, id: number } | null} */
      let hit = null;
      for (const t of added) {
        const i = rest.indexOf(t.content);
        if (i >= 0 && (at < 0 || i < at)) {
          at = i;
          hit = t;
        }
      }
      if (!hit) {
        encodeText(rest, ids);
        break;
      }
      encodeText(rest.slice(0, at), ids);
      ids.push(hit.id);
      rest = rest.slice(at + hit.content.length);
    }
    return ids;
  }

  return { encode, clsId: tokenId('[CLS]'), sepId: tokenId('[SEP]'), padId: tokenId('[PAD]') };
}

module.exports = { createBertTokenizer };
