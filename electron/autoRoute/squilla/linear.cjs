// SquillaRouter's frozen linear transformers: TruncatedSVD, PCA and the intent StandardScaler with its clip.
'use strict';

const f32 = Math.fround;

/**
 * TruncatedSVD.transform of one CSR row, X · Cᵀ, accumulated in float32 over ascending columns as scipy does.
 * @param {{ components: Float32Array | Float64Array, rows: number, cols: number }} spec
 */
function createSvd({ components, rows, cols }) {
  if (components.length !== rows * cols) throw new RangeError('SVD components have the wrong size');
  /** @param {Array<[number, number]>} sparse */
  return function transform(sparse) {
    const out = new Float32Array(rows);
    for (const [c, v] of sparse) for (let r = 0; r < rows; r++) out[r] = f32(out[r] + f32(v * components[r * cols + c]));
    return out;
  };
}

/**
 * PCA.transform of one row as sklearn orders it: x · Cᵀ − mean · Cᵀ, divided by √explained_variance when whitened.
 * @param {{ mean: Float32Array | Float64Array, components: Float32Array | Float64Array, explainedVariance: Float32Array | Float64Array, rows: number, whiten: boolean }} spec
 */
function createPca({ mean, components, explainedVariance, rows, whiten }) {
  const cols = mean.length;
  if (components.length !== rows * cols || explainedVariance.length !== rows) throw new RangeError('PCA parameters have the wrong size');
  const offset = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = 0; c < cols; c++) sum += mean[c] * components[r * cols + c];
    offset[r] = sum;
  }
  /** @param {ArrayLike<number>} x */
  return function transform(x) {
    if (x.length !== cols) throw new RangeError(`PCA input has ${x.length} columns, expected ${cols}`);
    const out = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let c = 0; c < cols; c++) sum += x[c] * components[r * cols + c];
      const v = f32(f32(sum) - offset[r]);
      out[r] = whiten ? v / Math.sqrt(explainedVariance[r]) : v;
    }
    return out;
  };
}

/**
 * StandardScaler.transform as the reference runtime computes it on float32 input: every operand and step in float32
 * (the hashes of OpenSquilla's prepared intent inputs pin this), then the intent head's clip.
 * @param {{ mean: Float32Array | Float64Array, scale: Float32Array | Float64Array, withMean: boolean, withStd: boolean, limit: number }} spec
 */
function createScaler({ mean, scale, withMean, withStd, limit }) {
  if (mean.length !== scale.length) throw new RangeError('scaler mean and scale sizes differ');
  /** @param {ArrayLike<number>} x */
  return function transform(x) {
    if (x.length !== mean.length) throw new RangeError(`scaler input has ${x.length} columns, expected ${mean.length}`);
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      let v = f32(x[i]);
      if (withMean) v = f32(v - f32(mean[i]));
      if (withStd) v = f32(v / f32(scale[i]));
      out[i] = Math.min(Math.max(v, -limit), limit);
    }
    return out;
  };
}

module.exports = { createPca, createScaler, createSvd };
