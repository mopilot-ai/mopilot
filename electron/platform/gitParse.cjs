// Parsers for git's NUL-separated (-z) output: paths come through verbatim (no C-quoting of spaces or non-ASCII).

/** `git status --porcelain=v1 -z`: [{ code, path }], path being the new one for a rename or copy. */
function parseStatusZ(out) {
  const files = [];
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    files.push({ code, path: e.slice(3) });
    // a rename or copy is followed by its original path
    if (/[RC]/.test(code)) i++;
  }
  return files;
}

/** `git diff --numstat -z`: path -> { added, removed } (binary files count 0); a rename is keyed by its new path. */
function parseNumstatZ(out) {
  const stats = {};
  const parts = String(out || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].split('\t');
    if (m.length < 3) continue;
    let file = m.slice(2).join('\t');
    // a rename: "added\tremoved\t", then the old path and the new one
    if (!file) {
      file = parts[i + 2];
      i += 2;
    }
    if (file)
      Object.defineProperty(stats, file, {
        value: { added: Number(m[0]) || 0, removed: Number(m[1]) || 0 },
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return stats;
}

/** `git ls-files -z`: the paths. */
const parseLsFilesZ = (out) =>
  String(out || '')
    .split('\0')
    .filter(Boolean);

/** Path-valued Git output ends in LF; preceding whitespace belongs to the path. */
const { parseGitPathLine } = require('../../shared/gitPathLine.mjs');

/**
 * An untracked path git lists with a trailing slash: a nested repository (a clone inside the project), which git
 * shows as one entry. It has no file content to count or diff: `git diff --no-index /dev/null nested/` fails.
 */
const isNestedRepo = (file) => file.endsWith('/');

module.exports = { parseStatusZ, parseNumstatZ, parseLsFilesZ, parseGitPathLine, isNestedRepo };
