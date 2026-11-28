// SquillaRouter's model pieces with small fixtures: WordPiece tokenizer, LightGBM text model, ONNX encoder sessions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import tierGolden from './fixtures/autoRoute/tier_golden_vectors.json' with { type: 'json' };

const require = createRequire(import.meta.url);
const { createBertTokenizer } = require('../electron/autoRoute/squilla/tokenizer.cjs');
const lgb = require('../electron/autoRoute/squilla/lightgbm.cjs');
const { createEncoders, sessionOptions, BGE_WIDTH, INTENT_WIDTH } = require('../electron/autoRoute/squilla/encoders.cjs');

const VOCAB = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '[MASK]',
  'un',
  '##aff',
  '##able',
  'hello',
  '中',
  '文',
  ',',
  '!',
  '[',
  ']',
  'E',
  '##MP',
  '##TY',
];
function spec(over: Record<string, any> = {}, normalizer: Record<string, any> = {}) {
  return {
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: false,
      ...normalizer,
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 10,
      vocab: Object.fromEntries(VOCAB.map((t, i) => [t, i])),
    },
    added_tokens: [
      { id: 0, content: '[PAD]', normalized: false, single_word: false, lstrip: false, rstrip: false },
      { id: 2, content: '[CLS]', normalized: false, single_word: false, lstrip: false, rstrip: false },
      { id: 99, content: '[CLS]X', normalized: false, single_word: false, lstrip: false, rstrip: false },
      { id: 4, content: '[MASK]', normalized: true, single_word: false, lstrip: false, rstrip: false },
    ],
    ...over,
  };
}

test('tokenizer: BERT normalization, punctuation, CJK splitting, WordPiece and literal special tokens', () => {
  const t = createBertTokenizer(spec());
  assert.deepEqual([t.clsId, t.sepId, t.padId], [2, 3, 0]);
  assert.deepEqual(t.encode('unaffable hello'), [5, 6, 7, 8]);
  assert.deepEqual(t.encode('hello,中文!'), [8, 11, 9, 10, 12]);
  assert.deepEqual(
    t.encode('\u0000he\u00adllo\u3000�un'),
    [8, 5],
    'control, format and replacement chars dropped; an ideographic space splits',
  );
  assert.deepEqual(t.encode('unknown xxxxxxxxxxxxx'), [1, 1], 'an unmatched word and an over-long word are unknown');
  assert.deepEqual(t.encode('a[CLS]hello[CLS]Xhello[PAD]'), [1, 2, 8, 99, 8, 0], 'the earliest, then longest, added token wins');
  assert.deepEqual(t.encode('[EMPTY]'), [13, 15, 16, 17, 14]);
  assert.deepEqual(t.encode('[MASK]'), [13, 1, 14], 'a normalized added token is ordinary text');
  assert.deepEqual(t.encode(''), []);
  const raw = createBertTokenizer(spec({ added_tokens: undefined }, { clean_text: false, handle_chinese_chars: false }));
  assert.deepEqual(raw.encode('中文'), [1], 'without CJK splitting the pair is one unknown word');
  assert.deepEqual(raw.encode('\u0000'), [1]);
});

test('tokenizer: refuses configurations it does not implement', () => {
  assert.throws(() => createBertTokenizer(null), /not a BERT WordPiece/);
  assert.throws(() => createBertTokenizer(spec({ pre_tokenizer: { type: 'Whitespace' } })), /not a BERT WordPiece/);
  assert.throws(() => createBertTokenizer(spec({ model: { type: 'BPE' } })), /not a BERT WordPiece/);
  assert.throws(() => createBertTokenizer(spec({ model: { type: 'WordPiece' } })), /not a BERT WordPiece/);
  assert.throws(() => createBertTokenizer(spec({}, { lowercase: true })), /lowercasing/);
  assert.throws(() => createBertTokenizer(spec({}, { strip_accents: true })), /lowercasing/);
  const vocab = Object.fromEntries(VOCAB.map((t, i) => [t, i]));
  assert.throws(() => createBertTokenizer(spec({ model: { type: 'WordPiece', unk_token: 'nope', vocab } })), /unknown token/);
  const { '[SEP]': _sep, ...noSep } = vocab;
  assert.throws(
    () => createBertTokenizer(spec({ model: { type: 'WordPiece', unk_token: '[UNK]', vocab: noSep } })),
    /does not define \[SEP\]/,
  );
  const defaults = createBertTokenizer(spec({ model: { type: 'WordPiece', unk_token: '[UNK]', vocab } }));
  assert.deepEqual(defaults.encode('unaffable'), [5, 6, 7], 'prefix and word length default to BERT values');
});

const TREE = (decision: string, threshold = '0.5', extra = '') =>
  `Tree=0\nnum_leaves=3\nnum_cat=0\nsplit_feature=0 1\nthreshold=${threshold} 1.5\ndecision_type=${decision}\nleft_child=-1 -2\nright_child=1 -3\nleaf_value=1 2 3\n${extra}\n`;
const MODEL = (trees: string[], header = 'num_class=2\nnum_tree_per_iteration=2\nmax_feature_idx=1\nobjective=multiclass num_class:2') =>
  `tree\nversion=v4\n${header}\n\n${trees.join('\n')}\nend of trees\n\nparameters:\n`;
const STUMP = 'Tree=1\nnum_leaves=1\nnum_cat=0\nsplit_feature=\nthreshold=\ndecision_type=\nleft_child=\nright_child=\nleaf_value=0.25\n';

test('LightGBM: numerical decisions, missing-value types, multiclass sums and calibration', () => {
  const model = lgb.parseLightGBM(MODEL([TREE('2 2'), STUMP]));
  assert.equal(model.trees.length, 2);
  const raw = (features: number[]) => {
    const p = lgb.predictProbabilities(model, features);
    return Math.log(p[0] / p[1]) + 0.25;
  };
  assert.ok(Math.abs(raw([0.5, 0]) - 1) < 1e-12, 'a value equal to the threshold goes left');
  assert.ok(Math.abs(raw([0.6, 1]) - 2) < 1e-12);
  assert.ok(Math.abs(raw([0.6, 2]) - 3) < 1e-12);
  assert.ok(Math.abs(raw([Number.NaN, 0]) - 1) < 1e-12, 'NaN counts as zero without NaN handling');
  const zero = lgb.parseLightGBM(MODEL([TREE(`${lgb.MISSING_ZERO << 2} 2`, '-1'), STUMP]));
  const zeroRight = (f: number[]) => lgb.predictProbabilities(zero, f);
  assert.deepEqual(zeroRight([0, 2]), zeroRight([5, 2]), 'zero is missing and defaults right when default_left is unset');
  const nanLeft = lgb.parseLightGBM(MODEL([TREE(String((lgb.MISSING_NAN << 2) | 2) + ' 2', '-1'), STUMP]));
  assert.deepEqual(
    lgb.predictProbabilities(nanLeft, [Number.NaN, 2]),
    lgb.predictProbabilities(nanLeft, [-5, 2]),
    'NaN takes the default-left branch',
  );
  assert.notDeepEqual(lgb.predictProbabilities(nanLeft, [0, 2]), lgb.predictProbabilities(nanLeft, [-5, 2]));
  assert.throws(() => lgb.predictProbabilities(model, [1]), /expects 2 features/);
  const single = lgb.parseLightGBM(MODEL([STUMP], 'num_class=1\nnum_tree_per_iteration=1\nmax_feature_idx=0\nobjective=binary'));
  assert.deepEqual(lgb.predictProbabilities(single, [0]), [1]);
  const calibrated = lgb.calibrate([0.2, 0.6, 0.2], 2);
  assert.ok(Math.abs(calibrated.reduce((a: number, b: number) => a + b, 0) - 1) < 1e-12);
  assert.ok(calibrated[1] < 0.6, 'a temperature above one flattens');
  assert.deepEqual(
    lgb.calibrate([0, 1], 1).map((v: number) => Number(v.toFixed(9))),
    [0, 1],
  );
  assert.throws(() => lgb.calibrate([0.5, 0.5], 0), /temperature/);
  assert.throws(() => lgb.calibrate([-1, 2], 1), /non-negative/);
  assert.throws(() => lgb.calibrate([0, 0], 1), /positive mass/);
  assert.deepEqual(lgb.softmax([0, 0]), [0.5, 0.5]);
});

test('LightGBM: refuses models it cannot evaluate exactly', () => {
  assert.throws(() => lgb.parseLightGBM('tree\nnum_class=x\n'), /multiclass text model/);
  assert.throws(
    () => lgb.parseLightGBM(MODEL([TREE('2 2')], 'num_class=2\nnum_tree_per_iteration=2\nmax_feature_idx=1\nobjective=regression')),
    /unsupported objective/,
  );
  assert.throws(() => lgb.parseLightGBM(MODEL([TREE('2 2', '0.5', 'is_linear=1'), STUMP])), /linear trees/);
  assert.throws(() => lgb.parseLightGBM(MODEL([TREE('2 2').replace('num_cat=0', 'num_cat=1'), STUMP])), /categorical/);
  assert.throws(() => lgb.parseLightGBM(MODEL([TREE('3 2'), STUMP])), /categorical/);
  assert.throws(() => lgb.parseLightGBM(MODEL([TREE('2'), STUMP])), /malformed/);
  assert.throws(() => lgb.parseLightGBM(MODEL([TREE('2 2')])), /incomplete iteration/);
  assert.throws(() => lgb.parseLightGBM(MODEL([])), /incomplete iteration/);
  assert.throws(
    () => lgb.parseLightGBM(MODEL([TREE('2 2'), STUMP], 'num_class=2\nnum_tree_per_iteration=2\nmax_feature_idx=1')),
    /unsupported objective: undefined/,
  );
  const noCatCount = lgb.parseLightGBM(MODEL([TREE('2 2').replace('num_cat=0\n', ''), STUMP]));
  assert.equal(noCatCount.trees.length, 2, 'a tree without num_cat has no categorical splits');
  const noObjective = lgb.parseLightGBM(MODEL([STUMP], 'num_class=1\nnum_tree_per_iteration=1\nmax_feature_idx=0'));
  assert.equal(noObjective.numClass, 1);
});

test('LightGBM calibration reproduces the tier head goldens from their logged uncalibrated probabilities', () => {
  for (const c of tierGolden.cases) {
    const got = lgb.calibrate(c.expected.uncalibrated_probabilities, tierGolden.calibration.temperature);
    got.forEach((v: number, i: number) => assert.ok(Math.abs(v - c.expected.calibrated_probabilities[i]) < 1e-12, c.sample_id));
  }
});

function fakeOrt({
  failIntent = false,
  hidden = (n: number) => new Float32Array(n).fill(0.5),
  logits = [1, 2, 3],
  inputNames = ['input_ids', 'attention_mask', 'token_type_ids'],
} = {}) {
  const created: any[] = [];
  const runs: any[] = [];
  const released: string[] = [];
  class Tensor {
    type: string;
    data: any;
    dims: number[];
    constructor(type: string, data: any, dims: number[]) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  }
  const session = (name: string) => ({
    inputNames: name === 'bge' ? inputNames : ['input_ids', 'attention_mask', 'numeric88'],
    outputNames: [name === 'bge' ? 'last_hidden_state' : 'logits'],
    async run(feed: any) {
      runs.push({ name, feed });
      if (name === 'bge') return { last_hidden_state: { dims: [1, BGE_WIDTH, 4], data: hidden(BGE_WIDTH * 4) } };
      return { logits: { dims: [1, 3], data: Float32Array.from(logits) } };
    },
    release: async () => void released.push(name),
  });
  return {
    created,
    runs,
    released,
    ort: {
      Tensor,
      InferenceSession: {
        async create(path: string, options: any) {
          created.push({ path, options });
          if (path === 'intent' && failIntent) throw new Error('bad intent model');
          return session(path);
        },
      },
    },
  };
}
const tokenizer = { encode: (t: string) => Array.from(t, (c) => c.codePointAt(0)! % 100), clsId: 101, sepId: 102, padId: 0 };

test('encoders: OpenSquilla session options, fixed-width BGE CLS pooling with L2 norm, and intent inputs', async () => {
  assert.deepEqual(sessionOptions('x64').extra, { 'session.x64quantprecision': '1' });
  assert.equal(sessionOptions('arm64').extra['optimization.disable_specified_optimizers'], 'MatMulIntegerToFloatFusion;GeluFusionL2');
  const f = fakeOrt({ inputNames: ['input_ids', 'attention_mask'] });
  const enc = await createEncoders({ ort: f.ort, tokenizer, bgeModel: 'bge', intentModel: 'intent', arch: 'arm64' });
  assert.deepEqual(
    f.created.map((c) => c.options.intraOpNumThreads),
    [1, 1],
  );
  const v = await enc.embed('ab', 'current_request');
  assert.deepEqual(Array.from(v), [0.5, 0.5, 0.5, 0.5]);
  const feed = f.runs[0].feed;
  assert.deepEqual(Object.keys(feed), ['input_ids', 'attention_mask'], 'only inputs the model declares are fed');
  assert.deepEqual(feed.input_ids.dims, [1, BGE_WIDTH]);
  assert.deepEqual(Array.from(feed.input_ids.data.slice(0, 5), Number), [101, 97, 98, 102, 0]);
  assert.deepEqual(Array.from(feed.attention_mask.data.slice(0, 5), Number), [1, 1, 1, 1, 0]);
  const prepared = enc.intentInputs(['a', '', 'b'.repeat(60)], ['current_request', 'recent_history', 'previous_answer']);
  const ids = Array.from(prepared.ids, Number);
  assert.equal(ids.length, 3 * INTENT_WIDTH);
  assert.deepEqual(ids.slice(0, 4), [101, 97, 102, 0]);
  assert.deepEqual(ids.slice(INTENT_WIDTH, INTENT_WIDTH + 9), [101, ...Array.from('[EMPTY]', (c) => c.codePointAt(0)! % 100), 102]);
  assert.equal(
    Array.from(prepared.mask, Number)
      .slice(2 * INTENT_WIDTH)
      .filter(Boolean).length,
    48,
    'the answer segment keeps 46 tokens plus CLS/SEP',
  );
  assert.deepEqual(await enc.intentLogits(prepared, new Float32Array(88)), [1, 2, 3]);
  assert.deepEqual(f.runs[1].feed.numeric88.dims, [1, 88]);
  await enc.close();
  assert.deepEqual(f.released.sort(), ['bge', 'intent']);
});

test('encoders: zero and non-finite embeddings, invalid logits and a failed second session', async () => {
  const zero = await createEncoders({
    ort: fakeOrt({ hidden: (n) => new Float32Array(n) }).ort,
    tokenizer,
    bgeModel: 'bge',
    intentModel: 'intent',
  });
  assert.deepEqual(Array.from(await zero.embed('a', 'current_request')), [0, 0, 0, 0]);
  const nan = await createEncoders({
    ort: fakeOrt({ hidden: (n) => new Float32Array(n).fill(Number.NaN) }).ort,
    tokenizer,
    bgeModel: 'bge',
    intentModel: 'intent',
  });
  await assert.rejects(nan.embed('a', 'current_request'), /non-finite/);
  const short = await createEncoders({ ort: fakeOrt({ logits: [1, 2] }).ort, tokenizer, bgeModel: 'bge', intentModel: 'intent' });
  await assert.rejects(
    short.intentLogits({ ids: new BigInt64Array(384), mask: new BigInt64Array(384) }, new Float32Array(88)),
    /invalid logits/,
  );
  const inf = await createEncoders({
    ort: fakeOrt({ logits: [1, Number.POSITIVE_INFINITY, 0] }).ort,
    tokenizer,
    bgeModel: 'bge',
    intentModel: 'intent',
  });
  await assert.rejects(
    inf.intentLogits({ ids: new BigInt64Array(384), mask: new BigInt64Array(384) }, new Float32Array(88)),
    /invalid logits/,
  );
  const failing = fakeOrt({ failIntent: true });
  await assert.rejects(createEncoders({ ort: failing.ort, tokenizer, bgeModel: 'bge', intentModel: 'intent' }), /bad intent model/);
  assert.deepEqual(failing.released, ['bge'], 'the first session is released');
});
