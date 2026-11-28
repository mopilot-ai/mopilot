// SquillaRouter's ONNX encoders: the BGE sentence embedding and the BERT-60M intent head, with OpenSquilla's session options.
'use strict';

const { truncateContentTokens } = require('./text.cjs');

const BGE_MAX_CONTENT_TOKENS = 510;
const BGE_WIDTH = BGE_MAX_CONTENT_TOKENS + 2;
const INTENT_LENGTHS = [128, 80, 48];
const INTENT_WIDTH = 128;

/**
 * OpenSquilla's CPU session settings: one thread, sequential, every optimization, x64 quantization precision, and on
 * ARM64 the two fusions that amplify dynamic-quantization rounding left off.
 * @param {string} arch
 */
function sessionOptions(arch) {
  /** @type {Record<string, string>} */
  const extra = { 'session.x64quantprecision': '1' };
  if (arch === 'arm64') extra['optimization.disable_specified_optimizers'] = 'MatMulIntegerToFloatFusion;GeluFusionL2';
  return {
    executionProviders: ['cpu'],
    intraOpNumThreads: 1,
    interOpNumThreads: 1,
    executionMode: /** @type {'sequential'} */ ('sequential'),
    graphOptimizationLevel: /** @type {'all'} */ ('all'),
    extra,
  };
}

const int64 = (values) => BigInt64Array.from(values, (v) => BigInt(v));

/**
 * @param {{ ort: any, tokenizer: ReturnType<typeof import('./tokenizer.cjs').createBertTokenizer>, bgeModel: string, intentModel: string, arch?: string }} o
 */
async function createEncoders({ ort, tokenizer, bgeModel, intentModel, arch = process.arch }) {
  const options = sessionOptions(arch);
  const bge = await ort.InferenceSession.create(bgeModel, options);
  let intent;
  try {
    intent = await ort.InferenceSession.create(intentModel, options);
  } catch (error) {
    await bge.release?.();
    throw error;
  }
  const bgeInputs = new Set(bge.inputNames);

  /**
   * One segment's CLS embedding, L2-normalized in float32, from a fixed 512-token input.
   * @param {string} text non-empty
   * @param {string} kind segment kind for truncation
   */
  async function embed(text, kind) {
    const content = truncateContentTokens(kind, tokenizer.encode(text), BGE_MAX_CONTENT_TOKENS);
    const sequence = [tokenizer.clsId, ...content, tokenizer.sepId];
    const ids = new Array(BGE_WIDTH).fill(tokenizer.padId);
    const mask = new Array(BGE_WIDTH).fill(0);
    sequence.forEach((id, i) => {
      ids[i] = id;
      mask[i] = 1;
    });
    /** @type {Record<string, any>} */
    const available = {
      input_ids: new ort.Tensor('int64', int64(ids), [1, BGE_WIDTH]),
      attention_mask: new ort.Tensor('int64', int64(mask), [1, BGE_WIDTH]),
      token_type_ids: new ort.Tensor('int64', new BigInt64Array(BGE_WIDTH), [1, BGE_WIDTH]),
    };
    const feed = Object.fromEntries(Object.entries(available).filter(([name]) => bgeInputs.has(name)));
    const outputs = await bge.run(feed);
    const hidden = outputs[bge.outputNames[0]];
    const width = hidden.dims[hidden.dims.length - 1];
    const pooled = Float32Array.from(/** @type {Float32Array} */ (hidden.data).subarray(0, width));
    if (!pooled.every(Number.isFinite)) throw new RangeError('the BGE model returned a non-finite row');
    let sum = 0;
    for (const v of pooled) sum += Math.fround(v * v);
    const norm = Math.fround(Math.sqrt(sum));
    return norm > 0 ? pooled.map((v) => v / norm) : new Float32Array(width);
  }

  /**
   * The intent head's prepared inputs for three segments (empty ones read "[EMPTY]").
   * @param {string[]} texts current request, recent history, previous answer
   * @param {readonly string[]} kinds
   */
  function intentInputs(texts, kinds) {
    const ids = new Array(3 * INTENT_WIDTH).fill(tokenizer.padId);
    const mask = new Array(3 * INTENT_WIDTH).fill(0);
    texts.forEach((text, s) => {
      const content = truncateContentTokens(kinds[s], tokenizer.encode(text || '[EMPTY]'), INTENT_LENGTHS[s] - 2);
      [tokenizer.clsId, ...content, tokenizer.sepId].forEach((id, i) => {
        ids[s * INTENT_WIDTH + i] = id;
        mask[s * INTENT_WIDTH + i] = 1;
      });
    });
    return { ids: int64(ids), mask: int64(mask) };
  }

  /**
   * Raw intent logits.
   * @param {{ ids: BigInt64Array, mask: BigInt64Array }} prepared
   * @param {Float32Array} numeric88 scaled and clipped
   */
  async function intentLogits(prepared, numeric88) {
    const outputs = await intent.run({
      input_ids: new ort.Tensor('int64', prepared.ids, [1, 3, INTENT_WIDTH]),
      attention_mask: new ort.Tensor('int64', prepared.mask, [1, 3, INTENT_WIDTH]),
      numeric88: new ort.Tensor('float32', numeric88, [1, 88]),
    });
    const logits = Array.from(/** @type {Float32Array} */ (outputs[intent.outputNames[0]].data));
    if (logits.length !== 3 || !logits.every(Number.isFinite)) throw new RangeError('the intent model returned invalid logits');
    return logits;
  }

  async function close() {
    await Promise.allSettled([bge.release?.(), intent.release?.()]);
  }

  return { embed, intentInputs, intentLogits, close };
}

module.exports = { BGE_WIDTH, INTENT_WIDTH, createEncoders, sessionOptions };
