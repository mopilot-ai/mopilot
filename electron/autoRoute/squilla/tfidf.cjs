// SquillaRouter's frozen sklearn char_wb TF-IDF vectorizer, as a sparse map from vocabulary index to weight.
'use strict';

const { pySplit } = require('./text.cjs');

// sklearn's _white_spaces = re.compile(r"\s\s+") on str: runs of two or more Python whitespace characters
const WHITE_RUNS = /[\t\n\v\f\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]{2,}/gu;

/** sklearn _char_wb_ngrams over code points. */
function charWbNgrams(text, minN, maxN) {
  const grams = [];
  for (const word of pySplit(text.replace(WHITE_RUNS, ' '))) {
    const w = Array.from(` ${word} `);
    for (let size = minN; size <= maxN; size++) {
      let offset = 0;
      grams.push(w.slice(offset, offset + size).join(''));
      while (offset + size < w.length) {
        offset++;
        grams.push(w.slice(offset, offset + size).join(''));
      }
      if (offset === 0) break; // a short word is counted once
    }
  }
  return grams;
}

/**
 * @param {{ options: any, vocabulary: string[], idf: Float32Array | Float64Array }} spec
 */
function createTfidf({ options, vocabulary, idf }) {
  const supported =
    options.analyzer === 'char_wb' &&
    options.lowercase === true &&
    options.strip_accents === null &&
    options.preprocessor === null &&
    options.binary === false &&
    options.use_idf === true &&
    options.sublinear_tf === false &&
    options.norm === 'l2';
  if (!supported) throw new TypeError('unsupported TF-IDF configuration');
  if (vocabulary.length !== idf.length) throw new RangeError('TF-IDF vocabulary and idf sizes differ');
  const index = new Map(vocabulary.map((token, i) => [token, i]));
  const [minN, maxN] = options.ngram_range;

  /**
   * sklearn's float32 arithmetic in its sorted CSR order: counts times idf, then an l2 norm summed in double.
   * @returns {Array<[number, number]>} [column, weight] by ascending column
   */
  function transform(text) {
    /** @type {Map<number, number>} */
    const counts = new Map();
    for (const gram of charWbNgrams(text.toLowerCase(), minN, maxN)) {
      const i = index.get(gram);
      if (i !== undefined) counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    const row = [...counts].sort((a, b) => a[0] - b[0]).map(([i, c]) => /** @type {[number, number]} */ ([i, Math.fround(c * idf[i])]));
    let sum = 0;
    for (const [, v] of row) sum += Math.fround(v * v);
    if (sum === 0) return row;
    const norm = Math.sqrt(sum);
    return row.map(([i, v]) => [i, Math.fround(v / norm)]);
  }

  return { transform };
}

module.exports = { charWbNgrams, createTfidf };
