// Global Auto's harness scores from HM-Router's published results (hmTable.json): how close a request is to each benchmark's
// queries, and how often each harness, with the models it offers here, solved that benchmark's tasks, less a price weight.
const { termsOf } = require('./hmTerms.cjs');
const { sizeClass, versionOf, compareVersions } = require('../../shared/autoRoute.mjs');

/** How sharply a request's closeness to a benchmark turns into that benchmark's weight. */
const TEMPERATURE = 0.05;
/** How many observations a cell's own result outweighs the harness's average on that benchmark by. */
const PRIOR_WEIGHT = 2;

/** HM-Router and MoPilot spell model versions differently ("gpt-5.5", "gpt-5-5"). @param {string} id */
const normalize = (id) =>
  String(id ?? '')
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[._\s]+/g, '-');

/** A model's family without its version ("claude-opus-5-5" → "claude-opus", "gpt-5.4-mini" → "gpt-mini"). @param {string} id */
const stem = (id) =>
  normalize(id)
    .split('-')
    .filter((part) => part && !/^\d+$/.test(part))
    .join('-');

/**
 * @param {{ benchmarks: string[], idf: Record<string, number>, centroids: Record<string, [string, number][]>,
 *   results: Record<string, Record<string, Record<string, [number, number]>>> }} table
 */
function createHarnessScorer(table) {
  const centroids = table.benchmarks.map((b) => new Map(table.centroids[b] ?? []));
  const norms = centroids.map((c) => Math.hypot(...c.values()) || 1);
  /** kind → normalized model → benchmark → [sum, n] */
  const cells = new Map();
  /** benchmark → [sum, n] over every pair, the prior where a harness never ran it */
  const overall = new Map();
  for (const [kind, models] of Object.entries(table.results)) {
    const byModel = new Map();
    for (const [model, benches] of Object.entries(models)) {
      const key = normalize(model);
      const into = byModel.get(key) ?? new Map();
      for (const [b, [acc, n]] of Object.entries(benches)) {
        const held = into.get(b) ?? [0, 0];
        into.set(b, [held[0] + acc * n, held[1] + n]);
        const all = overall.get(b) ?? [0, 0];
        overall.set(b, [all[0] + acc * n, all[1] + n]);
      }
      byModel.set(key, into);
    }
    cells.set(kind, byModel);
  }
  /** Every pair's average on a benchmark: a harness is judged by how far above or below it it scored. */
  const baseline = new Map([...overall].map(([b, [sum, n]]) => [b, sum / n]));

  /** How much each benchmark looks like the request, summing to 1. @param {string} text */
  function benchmarkWeights(text) {
    const tf = new Map();
    for (const t of termsOf(text)) if (Object.hasOwn(table.idf, t)) tf.set(t, (tf.get(t) ?? 0) + table.idf[t]);
    const qNorm = Math.hypot(...tf.values());
    const sims = centroids.map((c, i) => {
      if (!qNorm) return 0;
      let dot = 0;
      for (const [t, w] of tf) dot += w * (c.get(t) ?? 0);
      return dot / (qNorm * norms[i]);
    });
    const top = Math.max(...sims);
    const exps = sims.map((s) => Math.exp((s - top) / TEMPERATURE));
    const total = exps.reduce((a, b) => a + b, 0);
    return Object.fromEntries(table.benchmarks.map((b, i) => [b, exps[i] / total]));
  }

  /** One model's cells, or a harness's models pooled when none of them is offered here. */
  const pooled = (/** @type {Map<string, Map<string, [number, number]>>} */ byModel) => {
    /** @type {Map<string, [number, number]>} */
    const into = new Map();
    for (const benches of byModel.values())
      for (const [b, [sum, n]] of benches) {
        const held = into.get(b) ?? [0, 0];
        into.set(b, [held[0] + sum, held[1] + n]);
      }
    return into;
  };

  /**
   * Each harness's best expected result for the request, highest first. A harness HM-Router never measured is left out.
   * The score is how far above each benchmark's average the harness's model did, weighted by how much the request looks
   * like that benchmark, so a benchmark it never ran neither helps nor hurts it; less the price weight.
   * @param {string} text
   * @param {{ kind: string, models: string[] }[]} candidates each harness with the model ids it offers now
   * @param {number} weight how much a model's size class (its price) counts against it
   * @returns {{ kind: string, score: number, success: number, model: string, estimated: boolean }[]}
   */
  function score(text, candidates, weight) {
    const weights = benchmarkWeights(text);
    const out = [];
    for (const { kind, models } of candidates) {
      const byModel = cells.get(kind);
      if (!byModel) continue;
      // a model HM-Router measured, else the newest measured version of its family (a newer release than the paper's)
      const measured = (/** @type {string} */ m) => {
        if (byModel.has(normalize(m))) return normalize(m);
        const kin = [...byModel.keys()].filter((k) => stem(k) === stem(m));
        return kin.sort((a, b) => compareVersions(versionOf(b), versionOf(a)))[0] ?? null;
      };
      const offered = [...new Set((models ?? []).map(measured).filter((m) => m !== null))];
      // a harness whose models here are not among the measured ones is judged by all its measured ones together
      const estimated = !offered.length;
      const options = estimated
        ? [{ name: '', benches: pooled(byModel) }]
        : offered.map((name) => ({ name, benches: /** @type {Map<string, [number, number]>} */ (byModel.get(name)) }));
      /** @type {{ kind: string, score: number, success: number, model: string, estimated: boolean } | null} */
      let best = null;
      for (const { name, benches } of options) {
        let success = 0;
        let advantage = 0;
        for (const b of table.benchmarks) {
          const base = baseline.get(b) ?? 0;
          const c = benches.get(b);
          const value = c ? (c[0] + base * PRIOR_WEIGHT) / (c[1] + PRIOR_WEIGHT) : base;
          success += weights[b] * value;
          advantage += weights[b] * (value - base);
        }
        const s = advantage - weight * (sizeClass(name) / 5);
        if (!best || s > best.score) best = { kind, score: s, success, model: name, estimated };
      }
      out.push(/** @type {NonNullable<typeof best>} */ (best));
    }
    return out.sort((a, b) => b.score - a.score || a.kind.localeCompare(b.kind));
  }

  return { benchmarkWeights, score, measured: (/** @type {string} */ kind) => cells.has(kind) };
}

module.exports = { createHarnessScorer, normalize };
