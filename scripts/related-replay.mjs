// Replays unit-test selection over the files the last merged pull requests changed, on today's dependency graph: how
// many related tests each changed file selects (p50 / p90) and how many invariant tests each change adds, so a change
// to the selection or to the module structure can quote its before and after (docs/architecture/modularization.md §6).
//
//   node scripts/related-replay.mjs [--limit=200] [--base=origin/main] [--json]
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { invariantTestsFor, isGraphFile, relatedTests, reverseGraph } from './related-tests.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

/** The `p` quantile of ascending `values` (nearest rank), or 0 for none. */
export const quantile = (/** @type {number[]} */ values, /** @type {number} */ p) =>
  values.length ? values[Math.max(0, Math.ceil(p * values.length) - 1)] : 0;

/** A change's domain: the first two segments of the path (an area and its folder), or the file itself at the top. */
export const domainOf = (/** @type {string} */ file) => file.split('/').slice(0, 2).join('/');

/** Whether a graph file is a test or test helper rather than a source: the per-file and domain numbers skip those. */
const isTestFile = (/** @type {string} */ file) => /^(?:web\/)?tests\//.test(file);

/**
 * Each merge on `base`'s first-parent line, newest first, with the paths it changed. A merge's first parent is main
 * before it, so its diff is the pull request's whole change.
 * @param {(args: string[]) => string} git
 */
export function mergedChanges(git, { base = 'origin/main', limit = 200 } = {}) {
  return git(['log', '--first-parent', '--merges', '--format=%H %s', `-n${limit}`, base])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ...subject] = line.split(' ');
      const files = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', `${sha}^1`, sha])
        .split('\n')
        .filter(Boolean);
      return { sha, subject: subject.join(' '), files };
    });
}

/**
 * The selection each change gets today. Per-file numbers are over changed sources (a changed test selects itself), and
 * a change is single-domain when its sources share one domain. `exists` says whether a changed graph file is still in
 * the tree: one deleted since selects nothing now, so it is left out rather than counted as zero.
 */
export function replay(
  changes,
  users,
  { invariantsFor = invariantTestsFor, exists = (/** @type {string} */ f) => existsSync(path.join(root, f)) } = {},
) {
  /** @type {Map<string, number>} */
  const perFile = new Map();
  const rows = changes.map((change) => {
    const graph = change.files.filter((f) => isGraphFile(f) && exists(f));
    const sources = graph.filter((f) => !isTestFile(f));
    for (const file of sources) if (!perFile.has(file)) perFile.set(file, relatedTests([file], users).length);
    const related = relatedTests(graph, users);
    const invariants = invariantsFor(change.files);
    const domains = new Set(sources.map(domainOf));
    return {
      ...change,
      graph,
      related: related.length,
      invariants: invariants.length,
      selected: new Set([...related, ...invariants]).size,
      singleDomain: domains.size === 1,
    };
  });
  return { rows, perFile };
}

/** The numbers modularization.md §6 tracks, from a replay. */
export function summarize({ rows, perFile }) {
  const sorted = (/** @type {number[]} */ v) => [...v].sort((a, b) => a - b);
  const files = sorted([...perFile.values()]);
  const invariants = sorted(rows.map((r) => r.invariants));
  const single = sorted(rows.filter((r) => r.singleDomain).map((r) => r.invariants));
  const selected = sorted(rows.map((r) => r.selected));
  return {
    changes: rows.length,
    files: files.length,
    relatedPerFile: { p50: quantile(files, 0.5), p90: quantile(files, 0.9), max: quantile(files, 1) },
    invariantsPerChange: { p50: quantile(invariants, 0.5), p90: quantile(invariants, 0.9) },
    invariantsPerSingleDomainChange: { changes: single.length, p50: quantile(single, 0.5), p90: quantile(single, 0.9) },
    selectedPerChange: { p50: quantile(selected, 0.5), p90: quantile(selected, 0.9) },
  };
}

/** The summary as the table a pull request description quotes. */
export function table(/** @type {ReturnType<typeof summarize>} */ s) {
  const row = (/** @type {string} */ name, /** @type {{ p50: number, p90: number }} */ v) => `| ${name} | ${v.p50} | ${v.p90} |`;
  return [
    `Replayed ${s.changes} merged pull requests (${s.files} changed source files still in the tree).`,
    '',
    '| Metric | p50 | p90 |',
    '| --- | --- | --- |',
    row('Related tests per changed file', s.relatedPerFile),
    row('Invariant tests per change', s.invariantsPerChange),
    row(`Invariant tests per single-domain change (${s.invariantsPerSingleDomainChange.changes})`, s.invariantsPerSingleDomainChange),
    row('Tests selected per change', s.selectedPerChange),
  ].join('\n');
}

export function main(
  /** @type {string[]} */ args,
  {
    git = (/** @type {string[]} */ a) => execFileSync('git', a, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 }),
    log = console.log,
    users = () => reverseGraph(root),
    exists = (/** @type {string} */ f) => existsSync(path.join(root, f)),
  } = {},
) {
  let limit = 200;
  let base = 'origin/main';
  let json = false;
  for (const arg of args) {
    if (arg === '--json') json = true;
    else if (arg.startsWith('--limit=')) limit = Number(arg.slice(8));
    else if (arg.startsWith('--base=')) base = arg.slice(7);
    else if (arg !== '--')
      throw new Error(`Unknown argument: ${arg}. Usage: node scripts/related-replay.mjs [--limit=200] [--base=origin/main] [--json]`);
  }
  if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit takes a positive whole number');
  const summary = summarize(replay(mergedChanges(git, { base, limit }), users(), { exists }));
  log(json ? JSON.stringify(summary, null, 2) : table(summary));
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
