// SquillaRouter's 380-feature tier vector and intent inputs, ported from OpenSquilla's lightgbm380.py and model.py.
'use strict';

const { extractNumeric88, extractContext5, extractPreviousSignals19, extractRouteHistory16 } = require('./numeric.cjs');
const { SEGMENT_KINDS, extractTextSegments, segmentTexts } = require('./text.cjs');

const SEMANTIC_DIM = 64;
const CHARACTER_DIM = 100;
const FEATURE_DIM = 380;

/**
 * @param {{
 *   embed: (text: string, kind: string) => Promise<Float32Array>,
 *   pca: (x: Float32Array) => Float32Array,
 *   tfidf: { transform: (text: string) => Array<[number, number]> },
 *   svd: (row: Array<[number, number]>) => Float32Array,
 *   scaler: (x: Float32Array) => Float32Array,
 * }} parts
 */
function createFeaturizer({ embed, pca, tfidf, svd, scaler }) {
  /** @param {string} text @param {number} s */
  async function semantic(text, s) {
    if (!text) return new Float32Array(SEMANTIC_DIM);
    const projected = pca(await embed(text, SEGMENT_KINDS[s]));
    if (projected.length !== SEMANTIC_DIM) throw new RangeError('PCA output has the wrong width');
    return projected;
  }

  /**
   * transform_row: the frozen 380-vector for a RouterInput-shaped payload.
   * @param {any} input
   */
  async function tierFeatures(input) {
    const segments = extractTextSegments(input);
    const texts = segmentTexts(segments);
    const semantics = [];
    for (let s = 0; s < 3; s++) semantics.push(await semantic(texts[s], s));
    const character = svd(tfidf.transform(segments.current_request));
    if (character.length !== CHARACTER_DIM) throw new RangeError('SVD output has the wrong width');
    const numeric = extractNumeric88(input);
    const out = new Float32Array(FEATURE_DIM);
    let at = 0;
    for (const block of [
      semantics[0],
      character,
      numeric.subarray(0, 48),
      semantics[1],
      numeric.subarray(48, 64),
      semantics[2],
      numeric.subarray(64, 88),
    ]) {
      out.set(block, at);
      at += block.length;
    }
    if (!out.every(Number.isFinite)) throw new RangeError('feature vector contains non-finite values');
    return out;
  }

  /**
   * The intent head's numeric88: the tier vector's rules48 plus the full input's history, previous-answer and context
   * signals, scaled and clipped.
   * @param {any} input
   * @param {Float32Array} features the current-request tier vector
   */
  function intentNumeric(input, features) {
    const segments = extractTextSegments(input);
    const numeric = new Float32Array(88);
    numeric.set(features.subarray(164, 212), 0);
    numeric.set(extractRouteHistory16(input.route_history), 48);
    numeric.set(extractPreviousSignals19(segments.current_request, input.previous_answer, input.previous_usage), 64);
    numeric.set(extractContext5(input), 83);
    return scaler(numeric);
  }

  return { tierFeatures, intentNumeric };
}

module.exports = { FEATURE_DIM, createFeaturizer };
