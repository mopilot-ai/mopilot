// Main's slowest files to load (Phase 0, docs/architecture/rust-core.md §2): each CommonJS file's own compile and top-level
// run with its nested requires' time left out, kept from boot while MOPILOT_REQUIRE_TIMES=1 (electron/boot.cjs) and
// written by the probe as a `requires` sample (probe.cjs). What a lazy require would save, file by file.
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { packageOf } = require('./startup.cjs');

/** The repository (or packaged app) root the files are named from. */
const ROOT = path.join(__dirname, '..', '..');

/** @type {Map<string, number>} each file's own milliseconds */
const own = new Map();

/**
 * Time every CommonJS file main compiles from now on: its `_compile` (compiling and running its top level), less the
 * time of the files it requires meanwhile. A required ES module or JSON file is not compiled there, so it counts in the
 * file that required it. Returns the undo.
 * @param {{ prototype: { _compile: Function } }} [Module] @param {() => number} [now]
 */
function timeRequires(Module = /** @type {any} */ (require('node:module')), now = () => performance.now()) {
  const compile = Module.prototype._compile;
  /** @type {{ start: number, nested: number }[]} */
  const stack = [];
  Module.prototype._compile = function (/** @type {string} */ content, /** @type {string} */ filename) {
    const frame = { start: now(), nested: 0 };
    stack.push(frame);
    try {
      return compile.call(this, content, filename);
    } finally {
      stack.pop();
      const total = now() - frame.start;
      own.set(filename, (own.get(filename) ?? 0) + total - frame.nested);
      const parent = stack.at(-1);
      if (parent) parent.nested += total;
    }
  };
  return () => {
    Module.prototype._compile = compile;
  };
}

/**
 * The slowest files so far, named from the root, with their own milliseconds (to 0.1 ms), the total over all files,
 * and the slowest packages and app folders (startup.cjs packageOf) by the sum of their files' own times.
 * @param {number} [count] @param {string} [root]
 */
function slowestRequires(count = 30, root = ROOT) {
  const all = [...own].sort((a, b) => b[1] - a[1]);
  const round = (/** @type {number} */ ms) => Math.round(ms * 10) / 10;
  /** @type {Map<string, number>} */
  const sums = new Map();
  for (const [file, ms] of all) {
    const name = packageOf(file, root);
    sums.set(name, (sums.get(name) ?? 0) + ms);
  }
  return {
    files: all.length,
    ms: round(all.reduce((n, [, ms]) => n + ms, 0)),
    slowest: all.slice(0, count).map(([file, ms]) => ({ file: path.relative(root, file), ms: round(ms) })),
    packages: [...sums]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name, ms]) => ({ name, ms: round(ms) })),
  };
}

/** Forget the times (tests). */
const resetRequireTimes = () => own.clear();

module.exports = { timeRequires, slowestRequires, resetRequireTimes };
