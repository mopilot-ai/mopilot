// The one recursive file listing for scripts and tests that scan the repository's folders. It never enters hidden
// folders or node_modules: lint-rule tests write and delete fixture folders (src/.lint-fixture-*) during a full run,
// and a scan that read one as it was deleted failed with ENOENT (docs/bug-prevention/load-dependent-tests.md).
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

/**
 * Every file under `dir` whose name matches `include`, as `dir` joined with its path below it. A missing `dir` lists
 * nothing. `skip(p, isDirectory)` leaves out more folders (and everything in them) or files by their joined path.
 * @param {string} dir
 * @param {RegExp} include
 * @param {{ skip?: (p: string, isDirectory: boolean) => boolean }} [options]
 * @returns {string[]}
 */
export function treeFiles(dir, include, { skip = () => false } = {}) {
  const out = [];
  const walk = (/** @type {string} */ d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      const isDirectory = e.isDirectory();
      if (skip(p, isDirectory)) continue;
      if (isDirectory) {
        if (!e.name.startsWith('.') && e.name !== 'node_modules') walk(p);
      } else if (include.test(e.name)) out.push(p);
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Whether a repository-relative path ('/'-separated) lies in a hidden folder inside a top-level folder, which no scan
 * enters: an untracked file there is a running test's fixture (src/.lint-fixture-*), not a change. Top-level hidden
 * folders (.github, .agents) hold real files and are not matched.
 * @param {string} rel
 */
export const inHiddenFolder = (rel) =>
  rel
    .split('/')
    .slice(1, -1)
    .some((segment) => segment.startsWith('.'));
