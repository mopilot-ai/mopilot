// Repairs, or else warns about, a checkout whose git hooks would not run: core.hooksPath must lead to its own .githooks.
// A broken hook cannot report itself, so `npm install`, `npm run lint`, `npm run test:coverage` and the PR skills run
// this first. It only changes git's hooks setting, always exits 0, and stays quiet in CI, where the pull request
// check runs the same checks.
import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// the hooks this repository relies on: the pre-commit checks, and the refusal to push to main
export const HOOKS = ['pre-commit', 'pre-push'];

const executable = (/** @type {string} */ file) => {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    // missing, or not executable
    return false;
  }
};

/**
 * Why the hooks would not run in `repoRoot`, and the git command that fixes it (null when only the files can be
 * restored), or null when they run.
 * @param {{ git: (args: string[]) => string, repoRoot?: string }} deps
 * @returns {{ problem: string, fix: string[] | null } | null}
 */
export function hookDiagnosis({ git, repoRoot = root }) {
  const expected = path.join(repoRoot, '.githooks');
  // git resolves core.hooksPath (whichever scope sets it, relative to the checkout) or the default hooks folder
  const dir = path.resolve(repoRoot, git(['rev-parse', '--git-path', 'hooks']).trim());
  const real = (/** @type {string} */ p) => (existsSync(p) ? realpathSync(p) : p);
  if (real(dir) === real(expected)) {
    // git skips a hook file that is not executable
    const broken = HOOKS.filter((hook) => !executable(path.join(dir, hook)));
    if (!broken.length) return null;
    const many = broken.length > 1;
    return {
      problem: `The ${broken.join(' and ')} hook${many ? 's' : ''} in ${dir} ${many ? 'are' : 'is'} missing or not executable. Restore with \`git checkout -- .githooks\` (docs/code-quality.md).`,
      fix: null,
    };
  }
  let scopes = '';
  try {
    scopes = git(['config', '--show-scope', '--get-all', 'core.hooksPath']);
  } catch {
    // git config exits 1 when no scope sets core.hooksPath
    scopes = '';
  }
  const where = `The git hooks do not run here: git uses hooks from ${dir}, not ${expected}.`;
  /** @param {string[]} fix */
  const repairable = (fix) => ({ problem: `${where} Fix with \`git ${fix.join(' ')}\` (docs/code-quality.md).`, fix });
  // a worktree's own setting outranks the repository's .githooks, so drop it rather than override it
  if (/^worktree\s/m.test(scopes)) return repairable(['config', '--worktree', '--unset', 'core.hooksPath']);
  // nothing sets it, so git uses .git/hooks: set the repository's, as npm install does
  if (!scopes.trim()) return repairable(['config', 'core.hooksPath', '.githooks']);
  // a repository or global setting someone chose (a wrapper folder, say): report it, change nothing
  return {
    problem: `${where} If that folder does not run .githooks, use \`git config core.hooksPath .githooks\` (docs/code-quality.md).`,
    fix: null,
  };
}

/**
 * Applies the fix for each repairable problem found (a worktree setting, then an unset repository one), then reports
 * what is still wrong, or null when the hooks run.
 * @param {{ git?: (args: string[]) => string, env?: Record<string, string | undefined>, log?: (line: string) => void, repoRoot?: string }} [deps]
 */
export function main({ git, env = process.env, log = console.error, repoRoot = root } = {}) {
  if (env.CI) return null;
  const run = git ?? ((/** @type {string[]} */ args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 1 << 28 }));
  /** @type {string | null} */
  let problem = null;
  let failed = '';
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const found = hookDiagnosis({ git: run, repoRoot });
      problem = found ? found.problem : null;
      if (!found?.fix || attempt === 2) break;
      try {
        run(found.fix);
        log(`hook-check: the git hooks did not run here; ran \`git ${found.fix.join(' ')}\`.`);
      } catch (error) {
        // another run may have repaired it first (its unset leaves this one no key): diagnose again before reporting
        failed = ` The repair failed: ${error.message}`;
      }
    }
  } catch (error) {
    problem = `Could not check the git hooks: ${error.message}`;
  }
  if (problem) log(`warning: ${problem}${failed}`);
  return problem;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
