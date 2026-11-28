// Finds and loads SquillaRouter's assets: the fetched upstream weights and the checked-in converted sklearn parameters.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const UPSTREAM = require('./upstream.json');

const PARAMS_DIR = path.join(__dirname, 'params');
const ASSET_SUBDIR = path.join('auto-route', 'squilla');

/**
 * Where the weights may be, in order: an explicit directory; the packaged app's Resources; a checkout's
 * build/vendor (scripts/fetch-auto-route-assets.mjs); the user's data folder.
 * @param {{ assetsDir?: string, resourcesPath?: string, appRoot?: string, userData?: string }} o
 */
function candidateDirs({ assetsDir, resourcesPath, appRoot, userData }) {
  if (assetsDir) return [assetsDir];
  return [
    resourcesPath && path.join(resourcesPath, ASSET_SUBDIR),
    appRoot && path.join(appRoot, 'build', 'vendor', ASSET_SUBDIR),
    userData && path.join(userData, ASSET_SUBDIR),
  ].filter(/** @returns {d is string} */ (d) => !!d);
}

/**
 * The first directory holding every pinned upstream file at its pinned size, or null.
 * @param {string[]} dirs
 * @param {{ statSync: (p: string) => { size: number } }} [fsx]
 */
function findAssetsDir(dirs, fsx = fs) {
  for (const dir of dirs) {
    const complete = UPSTREAM.files.every((f) => {
      try {
        return fsx.statSync(path.join(dir, f.name)).size === f.size;
      } catch {
        return false;
      }
    });
    if (complete) return dir;
  }
  return null;
}

/** Loads one checked-in little-endian float array. */
function readArray(entry, dir = PARAMS_DIR, fsx = fs) {
  const bytes = fsx.readFileSync(path.join(dir, entry.file));
  const Type = entry.dtype === '<f4' ? Float32Array : entry.dtype === '<f8' ? Float64Array : null;
  if (!Type) throw new TypeError(`unsupported parameter dtype ${entry.dtype}`);
  const expected = entry.shape.reduce((a, b) => a * b, 1);
  if (bytes.length !== expected * Type.BYTES_PER_ELEMENT) throw new RangeError(`${entry.file} has ${bytes.length} bytes`);
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Type(copy.buffer);
}

/** The converted TF-IDF, SVD, PCA and scaler parameters (scripts/auto-route/convert-squilla-transformers.py). */
function loadParams(dir = PARAMS_DIR, fsx = fs) {
  const meta = JSON.parse(fsx.readFileSync(path.join(dir, 'transformers.json'), 'utf8'));
  const vocabulary = JSON.parse(fsx.readFileSync(path.join(dir, meta.tfidf.vocabulary.file), 'utf8'));
  return {
    tfidf: { options: meta.tfidf.options, vocabulary, idf: readArray(meta.tfidf.idf, dir, fsx) },
    svd: {
      components: readArray(meta.svd100.components, dir, fsx),
      rows: meta.svd100.components.shape[0],
      cols: meta.svd100.components.shape[1],
    },
    pca: {
      mean: readArray(meta.pca64.mean, dir, fsx),
      components: readArray(meta.pca64.components, dir, fsx),
      explainedVariance: readArray(meta.pca64.explained_variance, dir, fsx),
      rows: meta.pca64.components.shape[0],
      whiten: meta.pca64.whiten,
    },
    scaler: {
      mean: readArray(meta.scaler88.mean, dir, fsx),
      scale: readArray(meta.scaler88.scale, dir, fsx),
      withMean: meta.scaler88.with_mean,
      withStd: meta.scaler88.with_std,
      limit: 5,
    },
  };
}

/** Paths of the upstream files in a verified directory, with the tokenizer and tier model read. */
function loadUpstream(dir, fsx = fs) {
  const tier = UPSTREAM.files.find((f) => f.name === 'tier/model.txt.gz');
  const text = zlib.gunzipSync(fsx.readFileSync(path.join(dir, 'tier/model.txt.gz')));
  if (text.length !== tier?.gunzippedSize) throw new RangeError('the tier model does not have its pinned size');
  return {
    bgeModel: path.join(dir, 'bge/model.onnx'),
    intentModel: path.join(dir, 'intent/model.int8.onnx'),
    tokenizer: JSON.parse(fsx.readFileSync(path.join(dir, 'bge/tokenizer.json'), 'utf8')),
    tierModel: text.toString('utf8'),
  };
}

module.exports = { ASSET_SUBDIR, PARAMS_DIR, UPSTREAM, candidateDirs, findAssetsDir, loadParams, loadUpstream, readArray };
