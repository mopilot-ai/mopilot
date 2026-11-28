// SquillaRouter's LightGBM tier head: parses a LightGBM text model and predicts calibrated multiclass probabilities.
'use strict';

const K_ZERO_THRESHOLD = 1e-35;
const MISSING_NONE = 0;
const MISSING_ZERO = 1;
const MISSING_NAN = 2;

const numbers = (line) => (line ? line.split(' ').map(Number) : []);

/**
 * Parses LightGBM's text format (numerical splits only; linear trees and categorical splits are refused).
 * @param {string} text
 */
function parseLightGBM(text) {
  const lines = text.split('\n');
  /** @type {Record<string, string>} */
  const header = {};
  let i = 0;
  for (; i < lines.length && !lines[i].startsWith('Tree='); i++) {
    const eq = lines[i].indexOf('=');
    if (eq > 0) header[lines[i].slice(0, eq)] = lines[i].slice(eq + 1);
  }
  const numClass = Number(header.num_class);
  const perIteration = Number(header.num_tree_per_iteration);
  const numFeatures = Number(header.max_feature_idx) + 1;
  if (!(numClass >= 1) || perIteration !== numClass || !(numFeatures > 0)) throw new TypeError('not a LightGBM multiclass text model');
  if (numClass > 1 && !/^multiclass\b/.test(header.objective ?? '')) throw new TypeError(`unsupported objective: ${header.objective}`);
  const trees = [];
  /** @type {Record<string, string> | null} */
  let tree = null;
  const finish = () => {
    if (!tree) return;
    if (tree.is_linear === '1') throw new TypeError('linear trees are not supported');
    if (Number(tree.num_cat ?? 0) !== 0) throw new TypeError('categorical splits are not supported');
    const leaves = numbers(tree.leaf_value);
    const internal = Number(tree.num_leaves) - 1;
    const split = Int32Array.from(numbers(tree.split_feature));
    const threshold = Float64Array.from(numbers(tree.threshold));
    const decision = Uint8Array.from(numbers(tree.decision_type));
    const left = Int32Array.from(numbers(tree.left_child));
    const right = Int32Array.from(numbers(tree.right_child));
    if (leaves.length !== internal + 1 || [split, threshold, decision, left, right].some((a) => a.length !== internal))
      throw new TypeError('malformed LightGBM tree');
    for (const d of decision) if (d & 1) throw new TypeError('categorical splits are not supported');
    trees.push({ leaves: Float64Array.from(leaves), split, threshold, decision, left, right });
    tree = null;
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('Tree=')) {
      finish();
      tree = {};
    } else if (line.startsWith('end of trees')) break;
    else if (tree) {
      const eq = line.indexOf('=');
      if (eq > 0) tree[line.slice(0, eq)] = line.slice(eq + 1);
    }
  }
  finish();
  if (!trees.length || trees.length % numClass) throw new TypeError('LightGBM model has an incomplete iteration');
  return { numClass, numFeatures, trees };
}

/** LightGBM Tree::NumericalDecision followed to a leaf. */
function leafValue(tree, features) {
  if (!tree.split.length) return tree.leaves[0];
  let node = 0;
  for (;;) {
    let fval = features[tree.split[node]];
    const type = tree.decision[node];
    const missing = (type >> 2) & 3;
    if (Number.isNaN(fval) && missing !== MISSING_NAN) fval = 0;
    let goLeft;
    if ((missing === MISSING_ZERO && Math.abs(fval) <= K_ZERO_THRESHOLD) || (missing === MISSING_NAN && Number.isNaN(fval)))
      goLeft = (type & 2) !== 0;
    else goLeft = fval <= tree.threshold[node];
    const next = goLeft ? tree.left[node] : tree.right[node];
    if (next < 0) return tree.leaves[~next];
    node = next;
  }
}

function softmax(values) {
  const max = Math.max(...values);
  const exps = values.map((v) => Math.exp(v - max));
  const total = exps.reduce((a, b) => a + b, 0);
  return exps.map((e) => e / total);
}

/**
 * Raw multiclass probabilities for one row (LightGBM predict with the multiclass softmax).
 * @param {ReturnType<typeof parseLightGBM>} model
 * @param {ArrayLike<number>} features float32 values; LightGBM compares them as doubles
 */
function predictProbabilities(model, features) {
  if (features.length !== model.numFeatures) throw new RangeError(`LightGBM expects ${model.numFeatures} features, got ${features.length}`);
  const raw = new Array(model.numClass).fill(0);
  model.trees.forEach((tree, t) => {
    raw[t % model.numClass] += leafValue(tree, features);
  });
  return softmax(raw);
}

/** probabilities_to_logits then apply_temperature from OpenSquilla's calibration.py. */
function calibrate(probabilities, temperature) {
  if (!Number.isFinite(temperature) || temperature <= 0) throw new RangeError('temperature must be finite and positive');
  if (!probabilities.every((p) => Number.isFinite(p) && p >= 0)) throw new RangeError('probabilities must be finite and non-negative');
  const total = probabilities.reduce((a, b) => a + b, 0);
  if (!(total > 0)) throw new RangeError('probability row must have positive mass');
  const logits = probabilities.map((p) => Math.log(Math.min(Math.max(p / total, 1e-12), 1)) / temperature);
  return softmax(logits);
}

module.exports = { MISSING_NAN, MISSING_NONE, MISSING_ZERO, calibrate, parseLightGBM, predictProbabilities, softmax };
