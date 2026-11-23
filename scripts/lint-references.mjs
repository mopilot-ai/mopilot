// The lint configuration a test reads or runs (biome.json and files under lint/), as references for the related-tests
// graph (scripts/related-tests.mjs): nothing imports a rule, so these edges are the only way a rule's tests are selected.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

// biome.json or a lint/ path a test names, quoted, joined to a root or in a comment: `lint/rules/x.grit`,
// `${ROOT}/lint/rules/${rule}.grit`; path.join(ROOT, 'lint', 'rules') names the same folder
const LINT_PATH = /(?<![\w.-])(?:\.{1,2}\/)*(biome\.json|lint\/[\w.*${}/-]*)/g;
const JOINED_LINT_PATH = /['"`]lint['"`]((?:\s*,\s*['"`][\w.-]+['"`])+)/g;
// a test that runs Biome lints with the repository's biome.json; a rule's findings carry its `[name]` tag
export const BIOME_RUN = /node_modules\/(?:\.bin|@biomejs\/biome\/bin)\/biome\b/;
const RULE_TAG = /['"`]\[([a-z\d]+(?:-[a-z\d]+)*)\]/g;
const LINT_FILE = /^(?:biome\.json|lint\/.+)$/;
/** Whether a repository path is lint configuration: biome.json or a file under lint/. */
export const isLintFile = (/** @type {string} */ f) => LINT_FILE.test(f);

/**
 * The lint configuration a test reads or runs (#1604): nothing imports a rule, so per-rule tests were never selected
 * for it. A test running Biome reaches biome.json, and a test reaches each rule whose `[name]` tag it quotes (also when
 * a shared helper runs Biome for it). A named file is linked whether or not it exists, and a folder it lists or
 * templates by its folder key (`lint/rules/`), so a rule deleted since still reaches the test (lintKeys).
 */
export function lintReferences(text, repoRoot) {
  const out = new Set(BIOME_RUN.test(text) ? ['biome.json'] : []);
  for (const m of text.matchAll(RULE_TAG)) out.add(`lint/rules/${m[1]}.grit`);
  const joined = [...text.matchAll(JOINED_LINT_PATH)].map((m) =>
    ['lint', ...[...m[1].matchAll(/['"`]([\w.-]+)['"`]/g)].map((s) => s[1])].join('/'),
  );
  for (const raw of [...[...text.matchAll(LINT_PATH)].map((m) => m[1]), ...joined]) {
    const name = raw.replace(/\.+$/, '');
    const wild = name.search(/\*|\$\{/);
    if (wild >= 0) out.add(name.slice(0, name.lastIndexOf('/', wild) + 1));
    else if (!name.endsWith('/') && existsSync(path.join(repoRoot, name)) && statSync(path.join(repoRoot, name)).isDirectory())
      out.add(`${name}/`);
    else out.add(name);
  }
  return out;
}

/** A changed path and, for a lint file, the lint folders holding it, which tests that list or template a folder name. */
export const lintKeys = (/** @type {string} */ file) =>
  isLintFile(file)
    ? [
        file,
        ...file
          .split('/')
          .slice(0, -1)
          .map((_, i, parts) => `${parts.slice(0, i + 1).join('/')}/`),
      ]
    : [file];
