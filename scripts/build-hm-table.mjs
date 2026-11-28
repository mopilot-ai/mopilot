// Builds Global Auto's harness table (electron/autoRoute/hmTable.json) from HM-Router's published results: per benchmark,
// how often each (harness, model) pair MoPilot can run solved its tasks, and a word centroid of each benchmark's queries.
// Usage: node scripts/build-hm-table.mjs <dir with hm_router_bench.csv and queries.csv> [--commit <sha>] [--out <file>]
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { termsOf } from '../electron/autoRoute/hmTerms.cjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUTPUT = 'electron/autoRoute/hmTable.json';

/** HM-Router's harness names for the harnesses MoPilot runs, by MoPilot kind. */
export const HARNESSES = {
  claude: ['Claude Code'],
  codex: ['Codex'],
  'acp:gemini': ['Gemini CLI'],
  'acp:opencode': ['OpenCode'],
  'acp:hermes': ['hermes', 'Hermes'],
};
/** How many of a benchmark's most distinctive words its centroid keeps. */
const CENTROID_TERMS = 160;

/** RFC 4180 CSV: quoted fields may hold commas, doubled quotes and newlines. @param {string} text */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') row.push(field), (field = '');
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field), rows.push(row), (row = []), (field = '');
    } else field += c;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.length > 1 || r[0]);
  return body.map((r) => Object.fromEntries(head.map((k, i) => [k, r[i] ?? ''])));
}

/** The table from the two CSVs' text. @param {string} benchCsv @param {string} queriesCsv */
export function buildTable(benchCsv, queriesCsv) {
  const kindOf = new Map(Object.entries(HARNESSES).flatMap(([kind, names]) => names.map((n) => [n, kind])));
  /** @type {Record<string, Record<string, Record<string, [number, number]>>>} kind → model → benchmark → [acc sum, n] */
  const cells = {};
  for (const r of parseCsv(benchCsv)) {
    const kind = kindOf.get(r.harness);
    const acc = Number(r.acc);
    if (!kind || !r.model || !r.benchmark || !Number.isFinite(acc)) continue;
    const cell = ((cells[kind] ??= {})[r.model] ??= {})[r.benchmark] ?? [0, 0];
    cell[0] += acc;
    cell[1] += 1;
    cells[kind][r.model][r.benchmark] = cell;
  }
  const benchmarks = [...new Set(Object.values(cells).flatMap((ms) => Object.values(ms).flatMap((bs) => Object.keys(bs))))].sort();
  // inverse document frequency over every query, then each benchmark's mean normalized term vector
  const queries = parseCsv(queriesCsv).filter((q) => benchmarks.includes(q.benchmark));
  const docs = queries.map((q) => ({ benchmark: q.benchmark, terms: termsOf(q.query) }));
  /** @type {Map<string, number>} */
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  // every term asked about is one a query has
  const idf = (/** @type {string} */ t) => Math.log((1 + docs.length) / (1 + /** @type {number} */ (df.get(t)))) + 1;
  /** @type {Record<string, Map<string, number>>} */
  const sums = {};
  const counts = {};
  for (const d of docs) {
    const tf = new Map();
    for (const t of d.terms) tf.set(t, (tf.get(t) ?? 0) + 1);
    const weights = [...tf].map(([t, n]) => [t, n * idf(t)]);
    const norm = Math.hypot(...weights.map(([, w]) => /** @type {number} */ (w))) || 1;
    const sum = (sums[d.benchmark] ??= new Map());
    for (const [t, w] of weights) sum.set(t, (sum.get(t) ?? 0) + /** @type {number} */ (w) / norm);
    counts[d.benchmark] = (counts[d.benchmark] ?? 0) + 1;
  }
  const round = (/** @type {number} */ x) => Math.round(x * 1e4) / 1e4;
  const centroids = Object.fromEntries(
    benchmarks.map((b) => [
      b,
      [...(sums[b] ?? new Map())]
        .map(([t, w]) => [t, w / counts[b]])
        .sort((x, y) => /** @type {number} */ (y[1]) - /** @type {number} */ (x[1]) || String(x[0]).localeCompare(String(y[0])))
        .slice(0, CENTROID_TERMS)
        .map(([t, w]) => [t, round(/** @type {number} */ (w))]),
    ]),
  );
  const kept = new Set(Object.values(centroids).flatMap((c) => c.map(([t]) => t)));
  const idfTable = Object.fromEntries([...kept].sort().map((t) => [t, round(idf(/** @type {string} */ (t)))]));
  const results = Object.fromEntries(
    Object.keys(cells)
      .sort()
      .map((kind) => [
        kind,
        Object.fromEntries(
          Object.keys(cells[kind])
            .sort()
            .map((m) => [
              m,
              Object.fromEntries(
                Object.keys(cells[kind][m])
                  .sort()
                  .map((b) => [b, [round(cells[kind][m][b][0] / cells[kind][m][b][1]), cells[kind][m][b][1]]]),
              ),
            ]),
        ),
      ]),
  );
  return { benchmarks, idf: idfTable, centroids, results };
}

/**
 * Reads the two CSVs from `dir` and writes the table with their hashes (to `--out`, else the shipped table).
 * @param {string[]} argv <data dir> [--commit <sha>] [--out <file>]
 * @param {string} [root] the checkout the shipped table is in
 */
export function main(argv, root = ROOT) {
  const dir = argv[0];
  if (!dir || dir.startsWith('--')) throw new Error('Usage: node scripts/build-hm-table.mjs <data dir> [--commit <sha>] [--out <file>]');
  const flag = (/** @type {string} */ name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const bench = readFileSync(path.join(dir, 'hm_router_bench.csv'), 'utf8');
  const queries = readFileSync(path.join(dir, 'queries.csv'), 'utf8');
  const sha = (/** @type {string} */ s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;
  const table = {
    source: {
      repository: 'https://github.com/hmarkc/HM-Router',
      commit: flag('--commit') ?? null,
      paper: 'https://arxiv.org/abs/2609.32213',
      files: { 'data/hm_router_bench.csv': sha(bench), 'data/queries.csv': sha(queries) },
    },
    ...buildTable(bench, queries),
  };
  const out = flag('--out') ?? path.join(root, OUTPUT);
  writeFileSync(out, `${JSON.stringify(table)}\n`);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
