// Checks authored file growth against Git snapshots, with staged-content checks and reviewed, path-specific exceptions.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCEPTIONS = 'lint/file-size-exceptions.json';
// One file per pull request's exceptions, so two pull requests never edit the same file: `lint/file-size-exceptions/<name>.json`
// holds the same shape as EXCEPTIONS and the check merges them all. EXCEPTIONS itself is legacy and no longer grows.
export const EXCEPTIONS_DIR = 'lint/file-size-exceptions/';

/** Whether a repository path holds exceptions: the legacy file, or a file directly in EXCEPTIONS_DIR. */
export const isExceptionsFile = (/** @type {string} */ file) =>
  file === EXCEPTIONS || (file.startsWith(EXCEPTIONS_DIR) && file.endsWith('.json') && !file.slice(EXCEPTIONS_DIR.length).includes('/'));
export const WARN_LINES = 400;
export const MAX_LINES = 500;

/** Authored code, including tests, styles and native helpers; generated code and build/dependency trees stay out. */
export function isSource(file) {
  return (
    /\.(?:[cm]?[jt]sx?|css|scss|swift|rs|py|sh|html|grit)$/.test(file) &&
    !/(?:^|\/)(?:node_modules|vendor|external|generated|build|dist|out|target|coverage|test-results|playwright-report|\.git|\.next|\.build)(?:\/|$)/.test(
      file,
    ) &&
    !file.startsWith('src/protocol/') &&
    !file.includes('.generated.')
  );
}

/** Physical lines: a final newline terminates the last line rather than adding another one; CRLF counts once. */
export function lineCount(text) {
  if (!text) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

/** @typedef {{ maxLines: number, reason: string }} Exception */
/** @typedef {Map<string, Exception>} Exceptions */
/** @typedef {{ oid: string, mode: string }} Entry */
/** @typedef {Map<string, Entry>} Snapshot */
/** @typedef {(args: string[]) => string} Git */
/** @typedef {(cmd: string, args: string[], options: { cwd: string, encoding: 'utf8', maxBuffer: number }) => { status: number | null, stdout?: string | null, stderr?: string | null, error?: Error }} Run */

/** No ignore patterns: every exception names one authored file, a finite cap, and a reviewable explanation. */
export function parseExceptions(/** @type {string | null} */ text, source = EXCEPTIONS) {
  /** @type {Exceptions} */
  const result = new Map();
  if (text === null) return result;
  const config = JSON.parse(text);
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!object(config) || Object.keys(config).length !== 1 || !object(config.exceptions)) {
    throw new Error(`${source}: expected an object containing only "exceptions".`);
  }
  for (const [file, value] of Object.entries(config.exceptions)) {
    if (!isSource(file) || /[\\*?\[\]]/.test(file) || file.split('/').some((part) => !part || part === '.' || part === '..')) {
      throw new Error(`${source}: ${file} must be one repository-relative authored file.`);
    }
    const entry = /** @type {Exception} */ (value);
    if (
      !object(entry) ||
      Object.keys(entry).length !== 2 ||
      !Number.isSafeInteger(entry.maxLines) ||
      entry.maxLines <= MAX_LINES ||
      typeof entry.reason !== 'string' ||
      !entry.reason.trim()
    ) {
      throw new Error(`${source}: ${file} needs maxLines (an integer above ${MAX_LINES}) and a nonempty reason.`);
    }
    result.set(file, entry);
  }
  return result;
}

/** A Git runner that fails closed, including spawn failures and missing refs, instead of silently skipping checks. */
export function createGit(cwd, /** @type {Run} */ run = spawnSync) {
  return (/** @type {string[]} */ args) => {
    const result = run('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
    }
    return result.stdout ?? '';
  };
}

/** Read immutable blob ids from a commit or the index; NUL records preserve spaces, tabs and newlines in paths. */
export function snapshot(/** @type {Git} */ git, /** @type {string | null} */ ref) {
  const staged = ref === null;
  const listed = git(staged ? ['ls-files', '--stage', '-z'] : ['ls-tree', '-r', '-z', ref]);
  /** @type {Snapshot} */
  const files = new Map();
  for (const record of listed.split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, middle, last] = record.slice(0, tab).split(' ');
    const file = record.slice(tab + 1);
    if (staged && last !== '0') throw new Error(`Resolve the index conflict in ${file} before checking file sizes.`);
    files.set(file, { mode, oid: staged ? middle : last });
  }
  return files;
}

/** Rename destinations keep the old file's ceiling; copies remain new files. */
export function renameSources(/** @type {string} */ diff) {
  const parts = diff.split('\0');
  parts.pop();
  const renames = new Map();
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    const source = parts[i++];
    if (/^[RC]/.test(status)) {
      const destination = parts[i++];
      if (status.startsWith('R')) renames.set(destination, source);
    }
  }
  return renames;
}

/** @param {Entry | undefined} entry @returns {entry is Entry} */
const regular = (entry) => entry?.mode === '100644' || entry?.mode === '100755';

/** @typedef {{ files: Snapshot, renames: Map<string, string> }} Parent */

/**
 * Check changed blobs only; Git itself records and lowers the grandfathered ceilings after each commit/merge.
 * `merged`: a merge's other parents (MERGE_HEAD). The commit answers only for growth beyond every parent, since
 * what a merged branch already has was that branch's change, checked where it was made.
 */
export function checkGrowth(
  /** @type {Snapshot} */ before,
  /** @type {Snapshot} */ after,
  /** @type {Git} */ git,
  /** @type {Map<string, string>} */ renames = new Map(),
  /** @type {Parent[]} */ merged = [],
) {
  const text = (entry) => git(['cat-file', 'blob', entry.oid]);
  /**
   * Every exception in a tree: the legacy file and each file in EXCEPTIONS_DIR, one exception per path overall (a path
   * twice is refused in the tree being checked, not in a parent that already holds it). `origins` records the file of each.
   */
  const exceptionsAt = (files, /** @type {Map<string, string>} */ origins = new Map(), strict = false) => {
    /** @type {Exceptions} */
    const all = new Map();
    for (const source of [...files.keys()].filter(isExceptionsFile).sort()) {
      const entry = files.get(source);
      if (!regular(entry)) throw new Error(`${source} must be a regular file.`);
      for (const [file, exception] of parseExceptions(text(entry), source)) {
        if (strict && all.has(file)) throw new Error(`${source}: ${file} already has an exception in ${origins.get(file)}; keep one.`);
        all.set(file, exception);
        origins.set(file, source);
      }
    }
    return all;
  };
  const parentOrigins = new Map();
  const parents = [{ files: before, renames }, ...merged].map((parent) => ({
    ...parent,
    exceptions: exceptionsAt(parent.files, parentOrigins),
  }));
  const origins = new Map();
  const exceptions = exceptionsAt(after, origins, true);
  for (const file of exceptions.keys()) {
    if (!regular(after.get(file))) throw new Error(`${origins.get(file)}: remove the exception for missing or nonregular file ${file}.`);
  }
  const warnings = [];
  const errors = [];
  // the legacy file only shrinks or changes an entry it has: a new exception goes in a file of its own
  for (const [file, source] of origins) {
    if (source === EXCEPTIONS && parentOrigins.get(file) !== EXCEPTIONS)
      errors.push(
        `${EXCEPTIONS}: ${file} is new there. Put its exception in a new ${EXCEPTIONS_DIR}<name>.json; the legacy file no longer grows.`,
      );
  }
  for (const [file, entry] of after) {
    if (!isSource(file) || !regular(entry)) continue;
    const olds = parents.map(({ files, renames }) => {
      const source = renames.get(file) ?? file;
      return isSource(source) ? files.get(source) : undefined;
    });
    if (olds.some((old) => regular(old) && old.oid === entry.oid)) continue;
    const lines = lineCount(text(entry));
    const ceiling = Math.max(MAX_LINES, ...olds.map((old) => (regular(old) ? lineCount(text(old)) : 0)));
    const exception = exceptions.get(file);
    // An old allowance cannot restore headroom after a file shrinks. Any increase must be justified in this diff,
    // which for a merge means one that differs from every parent's.
    const reviewed =
      exception &&
      parents.every(({ exceptions: previous }) => {
        const prior = previous.get(file);
        return exception.maxLines !== prior?.maxLines || exception.reason !== prior?.reason;
      });
    if (lines > ceiling && !(reviewed && lines <= exception.maxLines)) {
      errors.push(
        `${file}: ${lines} lines exceeds ${ceiling}. Split by responsibility, or document a scoped exception in a new ${EXCEPTIONS_DIR}<name>.json.`,
      );
    }
    if (lines > WARN_LINES)
      warnings.push(`${file}: ${lines} lines; review whether it still owns one responsibility (target <= ${MAX_LINES}).`);
  }
  return { warnings, errors };
}

/** The commits a merge in progress takes in (MERGE_HEAD, one per line for an octopus); none outside a merge. */
export function mergeHeads(/** @type {Git} */ git, /** @type {string} */ cwd) {
  const file = path.resolve(cwd, git(['rev-parse', '--git-path', 'MERGE_HEAD']).trim());
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((sha) => git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]).trim());
}

/** Staged content vs HEAD (and a merge's other parents) for hooks; a committed (possibly merged) HEAD vs the exact base for CI. */
export function cli(argv, { cwd = process.cwd(), log = console.log, run = spawnSync } = {}) {
  try {
    const staged = argv.length === 0 || (argv.length === 1 && argv[0] === '--staged');
    if (!staged && !(argv.length === 1 && argv[0].startsWith('--base=') && argv[0].length > 7)) {
      throw new Error('Usage: node scripts/file-size.mjs [--staged | --base=<commit>]');
    }
    const git = createGit(cwd, run);
    const base = git(['rev-parse', '--verify', '--end-of-options', `${staged ? 'HEAD' : argv[0].slice(7)}^{commit}`]).trim();
    const before = snapshot(git, base);
    const after = snapshot(git, staged ? null : 'HEAD');
    const diff = (/** @type {string} */ from) =>
      renameSources(git(['diff', '--name-status', '-z', '--find-renames', ...(staged ? ['--cached', from] : [from, 'HEAD']), '--']));
    // Concluding a merge stages the result against every parent, as the commit will record it.
    const merged = (staged ? mergeHeads(git, cwd) : []).map((head) => ({ files: snapshot(git, head), renames: diff(head) }));
    const { warnings, errors } = checkGrowth(before, after, git, diff(base), merged);
    for (const warning of warnings) log(`file-size warning: ${warning}`);
    for (const error of errors) log(`file-size error: ${error}`);
    log(`file-size: ${errors.length ? 'FAILED' : 'passed'} (${warnings.length} size advisories).`);
    return errors.length ? 1 : 0;
  } catch (error) {
    log(`file-size: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = cli(process.argv.slice(2));
}
