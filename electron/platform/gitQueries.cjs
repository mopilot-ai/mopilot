// Main-process Git queries for a folder: repository info, branches and `git status` with per-file line counts.

const nodeFs = require('node:fs');
const { parseStatusZ, parseNumstatZ, parseGitPathLine, isNestedRepo } = require('./gitParse.cjs');
const { readHeadDiff } = require('./gitDiff.cjs');
const { GIT_DIFF_FLAGS } = require('../../shared/gitDiffFlags.mjs');
const { isUnmerged } = require('../../shared/gitBranchOps.mjs');

/** @param {{ run: (cmd: string, args: string[], options: { cwd: string }) => Promise<{ok: boolean, stdout: string, code?: number|string}>, fs?: Pick<typeof nodeFs, 'existsSync'> }} options */
function createGitQueries({ run, fs = nodeFs }) {
  const statusReads = new Map();
  async function gitInfo(cwd) {
    if (!cwd || !fs.existsSync(cwd)) return null;
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = parseGitPathLine(top.stdout);
    if (!top.ok || !root) return null;
    const branch = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd });
    if (branch.ok && !branch.stdout.trim()) return null;
    if (!branch.ok) {
      if (branch.code !== 1) return null;
      const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
      if (!head.ok) return null;
    }
    const remote = await run('git', ['config', '--get', 'remote.origin.url'], { cwd });
    const branches = await run('git', ['branch', '--format=%(refname:short)'], { cwd });
    return {
      root,
      branch: branch.ok ? branch.stdout.trim() : 'HEAD',
      remote: remote.stdout.trim(),
      branches: branches.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }
  /** What `git status` shows for a folder, with the lines each file added and removed, or null. */
  async function readGitStatus(cwd) {
    if (!cwd || !fs.existsSync(cwd)) return null;
    // -z: paths verbatim, not C-quoted ("my file.txt", "\303\274ber.txt")
    const st = await run('git', ['status', '--porcelain=v1', '-uall', '-z'], { cwd });
    if (!st.ok) return null;
    let numstat;
    try {
      numstat = await readHeadDiff(run, cwd, [...GIT_DIFF_FLAGS, '--numstat', '-z']);
    } catch {
      return null;
    }
    const stats = parseNumstatZ(numstat.stdout);
    const entries = parseStatusZ(st.stdout);
    let root = cwd;
    if (entries.some(({ code }) => code === '??')) {
      const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
      const repositoryRoot = parseGitPathLine(top.stdout);
      if (!top.ok || !repositoryRoot) return null;
      root = repositoryRoot;
    }
    const files = [];
    for (const { code, path: file } of entries) {
      let added = stats[file]?.added ?? 0;
      let removed = stats[file]?.removed ?? 0;
      if (code === '??' && !isNestedRepo(file)) {
        const diff = await run('git', ['diff', '--no-index', ...GIT_DIFF_FLAGS, '--numstat', '-z', '--', '/dev/null', file], { cwd: root });
        if (!diff.ok && diff.code !== 1) return null;
        const untracked = parseNumstatZ(diff.stdout);
        if (!Object.hasOwn(untracked, file)) return null;
        added = untracked[file].added;
        removed = untracked[file].removed;
      }
      files.push({ code, path: file, added, removed, ...(isUnmerged(code) && { conflicted: true }) });
    }
    return { files };
  }
  /** Overlapping refreshes share a read; completed results are never cached. */
  function gitStatus(cwd, fresh = false) {
    const pending = statusReads.get(cwd);
    if (pending && !fresh) return pending;
    const request = Promise.resolve()
      .then(() => readGitStatus(cwd))
      .finally(() => {
        if (statusReads.get(cwd) === request) statusReads.delete(cwd);
      });
    statusReads.set(cwd, request);
    return request;
  }
  return { gitInfo, gitStatus };
}

module.exports = { createGitQueries };
