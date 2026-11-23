// The app's startup timeline (docs/architecture/rust-core.md §2, Phase 0): each mark's time since the process started and
// the modules main had loaded by then, kept from launch whatever shared.perf.probe says, and written as `mark` samples
// once the probe runs (probe.cjs).
const path = require('node:path');
const { performance } = require('node:perf_hooks');

/** A launch records a few marks; past this, later ones are dropped. */
const MAX_MARKS = 64;

/** @typedef {{ name: string, ms: number, modules: number }} StartupMark */

/** @type {StartupMark[]} */
const marks = [];
/** @type {((mark: StartupMark) => void) | null} */
let listener = null;

/** Milliseconds with two decimals. */
const round = (/** @type {number} */ ms) => Math.round(ms * 100) / 100;

/** How many CommonJS modules main has loaded: a count a lazy require lowers whatever the machine's speed. */
const loadedModules = () => Object.keys(require.cache).length;

/**
 * Record `name` at `ms` since the process started (now, by default), with the modules loaded by then. A name is kept
 * once: the first time is the one a launch reaches it.
 * @param {string} name
 * @param {number} [ms]
 * @param {number} [modules]
 */
function markStartup(name, ms = performance.now(), modules = loadedModules()) {
  if (marks.length >= MAX_MARKS || marks.some((m) => m.name === name)) return;
  const mark = { name, ms: round(ms), modules };
  marks.push(mark);
  listener?.(mark);
}

/** The marks so far, in the order they came. */
const startupMarks = () => marks.map((m) => ({ ...m }));

/**
 * Hear each later mark (the probe, while it runs); returns the stop.
 * @param {(mark: StartupMark) => void} fn
 */
function onStartupMark(fn) {
  listener = fn;
  return () => {
    if (listener === fn) listener = null;
  };
}

/**
 * A window's mark, sent as wall-clock time (its timeOrigin plus its own clock): the time since this process started.
 * @param {number} epochMs
 * @param {number} [origin] when this process started, wall-clock
 */
const sinceStart = (epochMs, origin = performance.timeOrigin) => round(epochMs - origin);

/** @type {{ name: string, packages: Record<string, number> }[]} */
const breakdowns = [];

/** The repository (or packaged app) root the app's own files are counted under. */
const ROOT = path.join(__dirname, '..', '..');

/**
 * Where a loaded app file sits: its folder under `root`, two levels deep (`./electron/app`), or `other` outside it.
 * @param {string} root @param {string} file
 */
function folderOf(root, file) {
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'other';
  return `./${rel.split(/[\\/]/).slice(0, -1).slice(0, 2).join('/')}`;
}

/**
 * Where a loaded file comes from: its node_modules package (its scope included) by name, or the app's own folder
 * (`./electron/app`).
 * @param {string} file @param {string} [root]
 */
function packageOf(file, root = ROOT) {
  const parts = file.split(/[\\/]node_modules[\\/]/);
  const rest = /** @type {string} */ (parts.at(-1)).split(/[\\/]/);
  return parts.length === 1 ? folderOf(root, file) : rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
}

/**
 * The loaded modules counted by where they come from (packageOf). What a lazy require would move out of startup,
 * heaviest first.
 * @param {string[]} files @param {string} [root]
 */
function packagesOf(files, root = ROOT) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const file of files) {
    const name = packageOf(file, root);
    counts[name] = (counts[name] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

/**
 * Record the loaded modules by package at `name` (the probe writes them as `modules` samples), once per name.
 * @param {string} name @param {string[]} [files]
 */
function markModules(name, files = Object.keys(require.cache)) {
  if (breakdowns.some((b) => b.name === name)) return;
  breakdowns.push({ name, packages: packagesOf(files) });
}

/** The module breakdowns so far. */
const moduleBreakdowns = () => breakdowns.map((b) => ({ ...b, packages: { ...b.packages } }));

/** Forget every mark and breakdown (tests). */
function resetStartupMarks() {
  marks.length = 0;
  breakdowns.length = 0;
  listener = null;
}

module.exports = {
  MAX_MARKS,
  packageOf,
  markStartup,
  startupMarks,
  onStartupMark,
  sinceStart,
  resetStartupMarks,
  packagesOf,
  markModules,
  moduleBreakdowns,
};
