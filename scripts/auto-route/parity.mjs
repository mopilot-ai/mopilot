// Checks the JS SquillaRouter against OpenSquilla's own oracles on the real weights (fetched first when missing).
//   npm run auto-route:parity [-- --dir <assets dir>] [--offline]
// Tokenizer ids must equal Hugging Face tokenizers'; fixed-feature tier goldens must match within 1e-6; text-to-feature cases, prepared intent inputs and intent
// probabilities are compared with OpenSquilla's measured ONNX Runtime bounds, and every classifier label must match.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OUT, complete, fetchAssets } from '../fetch-auto-route-assets.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { loadRuntime } = require('../../electron/autoRoute/squilla/router.cjs');
const { calibrate, predictProbabilities } = require('../../electron/autoRoute/squilla/lightgbm.cjs');
const { UPSTREAM } = require('../../electron/autoRoute/squilla/assets.cjs');
const { thresholdIntent } = require('../../electron/autoRoute/squilla/policy.cjs');

const TIERS = ['C0', 'C1', 'C2', 'C3'];
const INTENTS = ['new_task', 'continue', 'redo'];
// The three BGE/PCA blocks of the 380-vector: current request, history, previous answer.
const SEMANTIC = new Set([...Array(64).keys()].flatMap((i) => [i, 212 + i, 292 + i]));
// OpenSquilla's widest measured ONNX Runtime bounds (lightgbm_model/PROVENANCE.md)
export const BOUNDS = { tierGolden: 1e-6, otherFeatures: 1e-4, semanticFeatures: 0.0065, tierProbabilities: 0.007, intentProfile: 0.081 };

const maxDiff = (a, b) => a.reduce((m, v, i) => Math.max(m, Math.abs(v - b[i])), 0);
const argmax = (v) => v.indexOf(Math.max(...v));
const sha = (typed) =>
  createHash('sha256')
    .update(Buffer.from(typed.buffer, typed.byteOffset, typed.byteLength))
    .digest('hex');

/** The upstream oracles copied into tests/fixtures/autoRoute. */
export function readFixtures(dir = path.join(root, 'tests/fixtures/autoRoute')) {
  const read = (name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
  return {
    tier: read('tier_golden_vectors.json'),
    source: read('source_parity_cases.json'),
    intent: read('intent_golden_vectors.json'),
    tokens: read('tokenizer_reference.json'),
  };
}

/**
 * Compares a loaded runtime with the oracles. Returns the measured differences and every failure.
 * @typedef {{ tierModel: any, tokenizer: { encode: (text: string) => number[] }, featurizer: { tierFeatures: (input: any) => Promise<Float32Array> }, predict: (input: any, withIntent: boolean) => Promise<any>, close: () => Promise<void> }} ParityRuntime
 * @param {{ runtime: ParityRuntime, fixtures: ReturnType<typeof readFixtures> }} o
 */
export async function checkParity({ runtime, fixtures }) {
  const failures = [];
  const tokenMismatches = fixtures.tokens.cases.filter((c) => JSON.stringify(runtime.tokenizer.encode(c.text)) !== JSON.stringify(c.ids));
  for (const c of tokenMismatches) failures.push(`tokenizer differs on ${JSON.stringify(c.text.slice(0, 40))}`);
  const T = UPSTREAM.calibration.tierTemperature;
  const tierProbs = (features) => calibrate(predictProbabilities(runtime.tierModel, features), T);

  let tierMax = 0;
  for (const c of fixtures.tier.cases) {
    const probs = tierProbs(Float32Array.from(c.features));
    tierMax = Math.max(tierMax, maxDiff(probs, c.expected.calibrated_probabilities));
    if (TIERS[argmax(probs)] !== c.expected.calibrated_class) failures.push(`tier golden ${c.sample_id}: class`);
  }
  if (tierMax > BOUNDS.tierGolden) failures.push(`tier goldens differ by ${tierMax}`);

  const source = [];
  for (const c of fixtures.source.cases) {
    const features = await runtime.featurizer.tierFeatures(c.input);
    let semantic = 0;
    let other = 0;
    features.forEach((v, i) => {
      const d = Math.abs(v - c.features[i]);
      if (SEMANTIC.has(i)) semantic = Math.max(semantic, d);
      else other = Math.max(other, d);
    });
    const probs = tierProbs(features);
    const expected = TIERS.map((t) => c.tier_probabilities[t]);
    const tier = maxDiff(probs, expected);
    source.push({ name: c.name, semanticMaxAbs: semantic, otherMaxAbs: other, tierMaxAbs: tier });
    if (other > BOUNDS.otherFeatures) failures.push(`${c.name}: non-BGE features differ by ${other}`);
    if (semantic > BOUNDS.semanticFeatures) failures.push(`${c.name}: BGE/PCA features differ by ${semantic}`);
    if (tier > BOUNDS.tierProbabilities) failures.push(`${c.name}: tier probabilities differ by ${tier}`);
    if (argmax(probs) !== argmax(expected)) failures.push(`${c.name}: tier label`);
  }

  const inputs = new Map(fixtures.source.cases.map((c) => [c.name, c.input]));
  const profiles = Object.keys(fixtures.intent.runtime_profiles);
  const profileMax = Object.fromEntries(['source', ...profiles].map((p) => [p, 0]));
  const intent = [];
  for (const c of fixtures.intent.cases) {
    const out = await runtime.predict(inputs.get(c.name), true);
    const hashes = { input_ids: sha(out.prepared.ids), attention_mask: sha(out.prepared.mask), numeric88: sha(out.numeric) };
    const sameInputs = Object.entries(hashes).every(([k, v]) => v === c.prepared_sha256[k]);
    if (!sameInputs) failures.push(`${c.name}: prepared intent inputs differ`);
    const probs = INTENTS.map((k) => out.intentProbs[k]);
    const label = INTENTS[argmax(probs)];
    profileMax.source = Math.max(
      profileMax.source,
      maxDiff(
        probs,
        INTENTS.map((k) => c.probabilities[k]),
      ),
    );
    for (const p of profiles)
      profileMax[p] = Math.max(
        profileMax[p],
        maxDiff(
          probs,
          INTENTS.map((k) => c.runtime_probabilities[p][k]),
        ),
      );
    if (label !== c.decision) failures.push(`${c.name}: intent label ${label}, expected ${c.decision}`);
    intent.push({ name: c.name, label, threshold: thresholdIntent(out.intentProbs), sameInputs });
  }
  if (Math.min(...Object.values(profileMax)) > BOUNDS.intentProfile) failures.push(`intent probabilities match no measured profile`);
  return {
    report: {
      tokenizer: { cases: fixtures.tokens.cases.length, mismatches: tokenMismatches.length },
      tierGolden: { cases: fixtures.tier.cases.length, maxAbs: tierMax },
      source,
      intent,
      intentProfileMaxAbs: profileMax,
    },
    failures,
  };
}

/**
 * The command line; returns the exit code.
 * @param {string[]} argv
 * @param {Record<string, any>} [deps]
 */
export async function main(
  argv,
  {
    load = loadRuntime,
    fetch = fetchAssets,
    isComplete = complete,
    loadOrt = () => require('onnxruntime-node'),
    fixtures = readFixtures,
    log = console.log,
    error = console.error,
  } = {},
) {
  const at = argv.indexOf('--dir');
  const dir = at >= 0 ? path.resolve(argv[at + 1]) : DEFAULT_OUT;
  if (!isComplete(dir)) {
    if (argv.includes('--offline')) {
      error(`The auto-route assets are not in ${dir}; run without --offline to fetch them.`);
      return 1;
    }
    await fetch({ out: dir });
  }
  const runtime = await load({ dir, ort: loadOrt() });
  try {
    const { report, failures } = await checkParity({ runtime, fixtures: fixtures() });
    log(JSON.stringify({ arch: process.arch, ...report }, null, 1));
    if (failures.length) {
      error(`auto-route parity FAILED:\n- ${failures.join('\n- ')}`);
      return 1;
    }
    log('auto-route parity passed');
    return 0;
  } finally {
    await runtime.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
