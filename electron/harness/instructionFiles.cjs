// The instructions files a harness would load for a folder (#2278): AGENTS.md, CLAUDE.md and the like in the folder
// itself, and in each folder above it up to the root of the git project it is in (as far as Codex looks; Claude Code's
// and opencode's own lookups are off in a chat kept apart, by their isolation switches). A chat kept apart from the
// coding side (MoMo's) runs in a folder from which none is reachable.
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');

/** The files the harnesses read as project instructions (Codex, Claude Code, opencode). */
const INSTRUCTIONS_FILES = Object.freeze(['AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'CLAUDE.local.md', 'CONTEXT.md']);

/**
 * Each instructions file a harness would load for `dir`, nearest first.
 * @param {string} dir an absolute folder
 * @param {{ existsSync: (p: string) => boolean }} [fsx]
 * @returns {string[]}
 */
function reachableInstructions(dir, fsx = fs) {
  const levels = [];
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    levels.push(d);
    if (path.dirname(d) === d) break;
  }
  // outside a git project only the folder itself is read
  const root = levels.findIndex((d) => fsx.existsSync(path.join(d, '.git')));
  const read = root < 0 ? levels.slice(0, 1) : levels.slice(0, root + 1);
  return read.flatMap((d) => INSTRUCTIONS_FILES.map((f) => path.join(d, f)).filter((p) => fsx.existsSync(p)));
}

/**
 * Throw when an instructions file is reachable from `dir`: a chat kept apart from the coding side doesn't start there.
 * @param {string} dir
 */
function assertNoInstructions(dir) {
  const found = reachableInstructions(dir);
  if (found.length) throw new Error(`MoMo's chats would load ${found.join(', ')}: remove it to keep coding instructions out of MoMo`);
}

module.exports = { reachableInstructions, assertNoInstructions, INSTRUCTIONS_FILES };
