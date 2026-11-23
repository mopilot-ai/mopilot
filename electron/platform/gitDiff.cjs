// Checked working-tree diffs, unborn HEAD fallback, literal file selection and pending read coalescing.
const { isUnbornHead } = require('../../shared/gitHead.mjs');
const { parseLsFilesZ, parseGitPathLine, isNestedRepo } = require('./gitParse.cjs');
const { GIT_DIFF_FLAGS } = require('../../shared/gitDiffFlags.mjs');

/** Compare the working tree with HEAD, or the empty tree before the first commit. */
async function readHeadDiff(run, cwd, args) {
  const read = (base) => run('git', ['diff', base, ...args], { cwd });
  let result = await read('HEAD');
  if (!result.ok) {
    const head = await run('git', ['rev-parse', '--verify', 'HEAD'], { cwd });
    if (!head.ok) {
      if (await isUnbornHead((args) => run('git', args, { cwd }))) {
        const empty = await run('git', ['hash-object', '-w', '-t', 'tree', '--', '/dev/null'], { cwd });
        if (!empty.ok || !empty.stdout.trim()) throw new Error(empty.stderr || 'Could not read empty repository tree');
        result = await read(empty.stdout.trim());
      }
    }
  }
  if (!result.ok) throw new Error(result.stderr || 'Could not read working changes');
  return result;
}

/** Read working changes without changing the user's index, including an unborn HEAD. */
function createGitDiff(run) {
  const requests = new Map();
  async function readDiff(cwd, file) {
    const top = await run('git', ['rev-parse', '--show-toplevel'], { cwd });
    const root = parseGitPathLine(top.stdout);
    if (!top.ok || !root) throw new Error(top.stderr || 'Could not read repository root');
    cwd = root;
    const result = await readHeadDiff(run, cwd, [...GIT_DIFF_FLAGS, ...(file ? ['--', `:(literal)${file}`] : [])]);
    let out = result.stdout;
    const untracked = await run('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd });
    if (!untracked.ok) throw new Error(untracked.stderr || 'Could not read untracked files');
    for (const name of parseLsFilesZ(untracked.stdout)) {
      // a nested repository is listed, but has no content of its own to show here
      if ((file && name !== file) || isNestedRepo(name)) continue;
      const diff = await run('git', ['diff', '--no-index', ...GIT_DIFF_FLAGS, '--', '/dev/null', name], { cwd });
      // no-index exits with 1 when the new file differs from /dev/null.
      if (!diff.ok && (diff.code !== 1 || !diff.stdout)) throw new Error(diff.stderr || 'Could not read untracked file changes');
      out += diff.stdout;
    }
    return out;
  }
  return (cwd, file, fresh = false) => {
    const key = JSON.stringify([cwd, file || null]);
    const pending = requests.get(key);
    if (pending && !fresh) return pending;
    const request = Promise.resolve()
      .then(() => readDiff(cwd, file))
      .finally(() => {
        if (requests.get(key) === request) requests.delete(key);
      });
    requests.set(key, request);
    return request;
  };
}

module.exports = { createGitDiff, readHeadDiff };
