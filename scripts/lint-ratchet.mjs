// The lint ratchet: the bug-class warnings (lint/rules/*.grit and the warning-level rules in biome.json) may only
// go down. lint/baseline.json holds each file's warning count per rule; a file may not go above its count, a rule's
// total may not rise, and the pre-commit hook lowers the counts as warnings are fixed. docs/bug-prevention/README.md.
//
//   npm run lint:ratchet                          check every file
//   npm run lint:ratchet -- --staged              the pre-commit step: staged files; lowers and stages the baseline
//   npm run lint:ratchet -- --update [files]      record current counts (moving warnings between files; no total rises)
//   npm run lint:ratchet -- --base=origin/main    the pull request check: the files it changes, and no total above the base's
import { spawnSync } from 'node:child_process';
import { decodeBiomeReport } from './biome-report.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const BASELINE = 'lint/baseline.json';
/** Files the ratchet counts (biome.json applies the warning rules to these, not to tests); the stylesheets carry the CSS rules. */
/**
 * The files the pre-commit step lints: every source Biome is configured to lint (biome.json `files.includes`), the
 * same set the pull request check counts, so a warning it would refuse is refused before the commit too.
 */
export const LINTED =
  /^(?:(?:src|electron|shared|relay|host|scripts|bench|tests)\/.*\.(?:[cm]?[jt]s|tsx|css)|mobile\/(?:src\/.*\.(?:[cm]?[jt]s|tsx)|App\.tsx|index\.js|metro\.config\.js))$/;
/** Changing one of these can change any file's counts. */
const CONFIG = /^(?:biome\.json|lint\/rules\/[^/]+\.grit)$/;

/** @typedef {Map<string, Map<string, number>>} Counts rule → file → warnings */
/** @typedef {{ severity?: string, category?: string, message?: string, location?: { path?: string, start?: { line?: number } | null } | null }} Diagnostic */
/** @typedef {(cmd: string, args: string[]) => import('./biome-report.mjs').BiomeResult} Run */

/** The rule a warning counts under: `plugin/<tag>` for lint/rules/*.grit (its message starts with `[tag]`), else Biome's category. */
export function ruleOf(/** @type {Diagnostic} */ d) {
  if (d.category !== 'plugin') return String(d.category);
  const tag = /^\[([\w-]+)\]/.exec(d.message ?? '');
  return tag ? `plugin/${tag[1]}` : 'plugin';
}

/** Warning counts from Biome's JSON report, and the warnings themselves (to show the ones that rose). */
export function countWarnings(/** @type {{ diagnostics?: Diagnostic[] }} */ report) {
  /** @type {Counts} */
  const counts = new Map();
  /** @type {Diagnostic[]} */
  const warnings = [];
  for (const d of report.diagnostics ?? []) {
    const file = d.location?.path;
    if (d.severity !== 'warning' || !file) continue;
    warnings.push(d);
    const rule = ruleOf(d);
    const files = counts.get(rule) ?? new Map();
    counts.set(rule, files.set(file, (files.get(file) ?? 0) + 1));
  }
  return { counts, warnings };
}

/** lint/baseline.json's text as counts; an empty baseline when there is none. */
export function parseBaseline(/** @type {string | null} */ text) {
  /** @type {Counts} */
  const counts = new Map();
  if (text === null) return counts;
  const rules = JSON.parse(text).rules ?? {};
  for (const rule of Object.keys(rules)) counts.set(rule, new Map(Object.entries(rules[rule])));
  return counts;
}

/**
 * Counts as lint/baseline.json's text: sorted, zero entries left out, so diffs stay small. A rule whose warnings are
 * all fixed stays, as `{}`: a rule the baseline lacks is new and starts free, so dropping it would let it rise again.
 */
export function formatBaseline(/** @type {Counts} */ counts) {
  /** @type {Record<string, Record<string, number>>} */
  const rules = {};
  // keys are unique, so no two compare equal
  const byKey = (/** @type {[string, unknown]} */ [a], /** @type {[string, unknown]} */ [b]) => (a < b ? -1 : 1);
  for (const [rule, byFile] of [...counts].sort(byKey)) rules[rule] = Object.fromEntries([...byFile].filter(([, n]) => n > 0).sort(byKey));
  const header = 'Warning counts per rule per file. They may only go down; see docs/bug-prevention/README.md#the-lint-ratchet.';
  return `${JSON.stringify({ about: header, rules }, null, 2)}\n`;
}

/**
 * The rules the ratchet counts: biome.json's warning-level rules (`lint/<group>/<rule>`) and the GritQL rules in
 * lint/rules (`plugin/<file name>`, the tag their messages start with). Each needs an entry in the baseline, `{}` when
 * it has no warnings, or its total could rise as a new rule's.
 * @typedef {{ linter?: { rules?: Record<string, unknown> } }} LinterConfig
 * @param {LinterConfig & { overrides?: LinterConfig[] }} biome biome.json
 * @param {string[]} gritFiles the file names in lint/rules
 */
export function configuredRules(biome, gritFiles) {
  const rules = new Set();
  // the top level and every override can turn a rule to a warning
  for (const config of [biome, ...(biome.overrides ?? [])])
    for (const [group, byName] of Object.entries(config.linter?.rules ?? {})) {
      if (!byName || typeof byName !== 'object') continue;
      for (const [name, setting] of Object.entries(byName)) {
        const level = typeof setting === 'object' && setting ? /** @type {{ level?: string }} */ (setting).level : setting;
        if (level === 'warn') rules.add(`lint/${group}/${name}`);
      }
    }
  for (const f of gritFiles) if (f.endsWith('.grit')) rules.add(`plugin/${f.slice(0, -'.grit'.length)}`);
  return [...rules].sort();
}

const total = (/** @type {Map<string, number> | undefined} */ files) => [...(files ?? new Map()).values()].reduce((a, b) => a + b, 0);

/** @typedef {(file: string) => boolean} Scope which files a comparison or an update covers */
/** Every file. */
export const ALL = () => true;

/**
 * Where `current` differs from `baseline` for the files in `scope`: the entries that rose, and the ones that fell
 * (fixed warnings, deleted files).
 * @param {Counts} baseline
 * @param {Counts} current
 * @param {Scope} scope
 */
export function compare(baseline, current, scope) {
  /** @type {{ rule: string, file: string, was: number, now: number }[]} */
  const raised = [];
  /** @type {{ rule: string, file: string, was: number, now: number }[]} */
  const lowered = [];
  for (const rule of new Set([...baseline.keys(), ...current.keys()])) {
    const was = baseline.get(rule) ?? new Map();
    const now = current.get(rule) ?? new Map();
    for (const file of new Set([...was.keys(), ...now.keys()])) {
      if (!scope(file)) continue;
      const entry = { rule, file, was: was.get(file) ?? 0, now: now.get(file) ?? 0 };
      if (entry.now > entry.was) raised.push(entry);
      else if (entry.now < entry.was) lowered.push(entry);
    }
  }
  return { raised, lowered };
}

/** `baseline` with the entries for the files in `scope` replaced by `current`'s. */
export function merge(/** @type {Counts} */ baseline, /** @type {Counts} */ current, /** @type {Scope} */ scope) {
  /** @type {Counts} */
  const out = new Map();
  for (const rule of new Set([...baseline.keys(), ...current.keys()])) {
    const files = new Map([...(baseline.get(rule) ?? [])].filter(([file]) => !scope(file)));
    for (const [file, n] of current.get(rule) ?? []) if (scope(file)) files.set(file, n);
    out.set(rule, files);
  }
  return out;
}

/** The rules whose total in `next` is above their total in `previous`. Rules `previous` lacks are new and start free. */
export function risenTotals(/** @type {Counts} */ previous, /** @type {Counts} */ next) {
  return [...previous.keys()]
    .map((rule) => ({ rule, was: total(previous.get(rule)), now: total(next.get(rule)) }))
    .filter(({ was, now }) => now > was);
}

/** One line per warning of each rule that rose in a file, so the committer sees what to fix. */
export function describeRaised(
  /** @type {{ rule: string, file: string, was: number, now: number }[]} */ raised,
  /** @type {Diagnostic[]} */ warnings,
) {
  const lines = [];
  for (const { rule, file, was, now } of raised) {
    lines.push(`${file}: ${rule} rose from ${was} to ${now}. Fix the new one (the list includes the existing ones):`);
    for (const d of warnings) {
      if (d.location?.path === file && ruleOf(d) === rule) lines.push(`  ${file}:${d.location?.start?.line ?? '?'} ${d.message}`);
    }
  }
  return lines;
}

/**
 * Biome's warnings for `files` (every file in biome.json's scope when empty).
 * @param {string[]} files
 * @param {Run} run
 */
export function lint(files, run) {
  const biome = createRequire(import.meta.url).resolve('@biomejs/biome/bin/biome');
  const args = [biome, 'lint', '--reporter=json', '--max-diagnostics=none', '--no-errors-on-unmatched', '--files-ignore-unknown=true'];
  const result = run(process.execPath, [...args, ...files]);
  const report = decodeBiomeReport(result, { file: files.length ? files.join(', ') : 'all configured files' });
  return countWarnings(report);
}

/** @type {Run} */
export function defaultRun(cmd, args) {
  return spawnSync(cmd, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
}

/**
 * @param {string[]} argv
 * @param {{ run?: Run, log?: (line: string) => void, repoRoot?: string }} [deps]
 * @returns {number} the exit status
 */
export function main(argv, { run = defaultRun, log = console.error, repoRoot = root } = {}) {
  const file = path.join(repoRoot, BASELINE);
  const baseline = parseBaseline(existsSync(file) ? readFileSync(file, 'utf8') : null);
  const git = (/** @type {string[]} */ args) => {
    const r = run('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr ?? ''}`);
    return r.stdout ?? '';
  };
  const write = (/** @type {Counts} */ counts) => writeFileSync(file, formatBaseline(counts));
  const named = argv.filter((a) => !a.startsWith('--')).map((a) => path.relative(repoRoot, path.resolve(repoRoot, a)));
  const base = argv.find((a) => a.startsWith('--base='))?.slice('--base='.length);

  if (argv.includes('--update')) {
    const next = merge(baseline, lint(named, run).counts, named.length ? (f) => named.includes(f) : ALL);
    const risen = risenTotals(baseline, next);
    if (risen.length) {
      for (const { rule, was, now } of risen)
        log(`lint ratchet: ${rule} would rise from ${was} to ${now} in total. Fix the new warnings instead.`);
      return 1;
    }
    write(next);
    log(`lint ratchet: recorded the counts${named.length ? ` for ${named.join(', ')}` : ''} in ${BASELINE}.`);
    return 0;
  }

  if (argv.includes('--staged')) {
    const lines = (/** @type {string[]} */ args) =>
      git(args)
        .split('\n')
        .filter((f) => LINTED.test(f));
    // a merge commit answers for what differs from the branch merged in, not for that branch's own changes
    const merging = run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).status === 0;
    const ours = merging ? new Set(git(['diff', '--cached', '--name-only', 'MERGE_HEAD']).split('\n')) : null;
    const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMRD'])
      .split('\n')
      .filter((f) => !ours || ours.has(f));
    const whole = staged.some((f) => CONFIG.test(f));
    const files = staged.filter((f) => LINTED.test(f));
    if (!whole && !files.length) return 0;
    // Biome reads the working tree: an untracked file is in no commit, and a file with unstaged edits may hold
    // fixes this commit lacks, so neither lowers the baseline (the pull request check judges the committed files)
    const untracked = new Set(lines(['ls-files', '--others', '--exclude-standard']));
    const unsettled = new Set([...untracked, ...lines(['diff', '--name-only'])]);
    /** @type {Scope} */
    const scope = whole ? (f) => !untracked.has(f) : (f) => files.includes(f);
    const present = files.filter((f) => existsSync(path.join(repoRoot, f)));
    // a deleted file lints as nothing, so its entries drop
    const { counts, warnings } = whole || present.length ? lint(whole ? [] : present, run) : { counts: new Map(), warnings: [] };
    const { raised } = compare(baseline, counts, scope);
    if (raised.length) {
      for (const line of describeRaised(raised, warnings)) log(line);
      if (raised.some(({ file }) => unsettled.has(file))) log('lint ratchet: the counts include unstaged edits in those files.');
      log(
        'lint ratchet: a rule may only go down in each file (docs/bug-prevention/README.md). If you only moved code, run `npm run lint:ratchet -- --update <files>`.',
      );
      return 1;
    }
    const next = merge(baseline, counts, (f) => scope(f) && !unsettled.has(f));
    if (formatBaseline(next) === formatBaseline(baseline)) return 0;
    write(next);
    git(['add', BASELINE]);
    log(`lint ratchet: warnings went down; ${BASELINE} is updated and staged.`);
    return 0;
  }

  const mergeBase = base ? git(['merge-base', base, 'HEAD']).trim() : '';
  // a pull request answers for the files it changes; main can hold warnings a change merged before the ratchet added
  const changed = new Set(base ? git(['diff', '--name-only', mergeBase]).split('\n') : []);
  const { counts, warnings } = lint([], run);
  const { raised, lowered } = compare(baseline, counts, base ? (f) => changed.has(f) : ALL);
  let status = 0;
  if (raised.length) {
    for (const line of describeRaised(raised, warnings)) log(line);
    status = 1;
  }
  if (base) {
    const shown = run('git', ['show', `${mergeBase}:${BASELINE}`]);
    // before the ratchet existed there is nothing to compare against
    const risen = shown.status === 0 ? risenTotals(parseBaseline(String(shown.stdout)), baseline) : [];
    for (const { rule, was, now } of risen) log(`lint ratchet: ${BASELINE} raises ${rule} from ${was} to ${now} in total over ${base}.`);
    if (risen.length) status = 1;
  }
  if (lowered.length) log(`lint ratchet: ${lowered.length} counts went down; run \`npm run lint:ratchet -- --update\` to record them.`);
  if (status) log('lint ratchet: a rule may only go down (docs/bug-prevention/README.md#the-lint-ratchet).');
  return status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
