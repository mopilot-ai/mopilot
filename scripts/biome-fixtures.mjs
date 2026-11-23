// Run lint-rule fixtures in an invocation-owned project, preserving production config and paths without mutating the checkout.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeBiomeReport } from './biome-report.mjs';

const repo = new URL('../', import.meta.url);
const biome = fileURLToPath(new URL('node_modules/@biomejs/biome/bin/biome', repo));

/**
 * Each invocation owns the entire project Biome scans, even when other tests finish during its scan.
 * Keep relative paths unchanged: the production overrides (including excluded helper paths) still apply.
 * @param {Record<string, string>} files Repository-relative fixture paths and contents.
 * @param {(command: string, args: string[], options: { cwd: string, encoding: 'utf8' }) => import('./biome-report.mjs').BiomeResult} [run]
 */
export function lintFixtures(files, run = spawnSync) {
  const names = Object.keys(files);
  if (!names.length) throw new Error('A Biome fixture needs at least one file');
  for (const name of names) {
    if (!/^(src|electron|shared|scripts|tests|web)\//.test(name) || name.split(/[\\/]/).includes('..'))
      throw new Error(`Expected a repository-relative source fixture path: ${name}`);
  }
  // TMPDIR can point into this checkout, including through a symlink. That would recreate the shared-tree race.
  const temp = fs.realpathSync(os.tmpdir());
  const checkout = fs.realpathSync(repo);
  if (temp === checkout || temp.startsWith(path.join(checkout, path.sep)))
    throw new Error('Biome fixtures need a temporary directory outside the checkout');
  const root = fs.mkdtempSync(path.join(temp, 'mopilot-biome-'));
  try {
    // Copy unchanged inputs, not a hand-maintained test configuration or modified rule selection.
    for (const name of ['biome.json', '.gitignore']) fs.copyFileSync(new URL(name, repo), path.join(root, name));
    fs.cpSync(new URL('lint/rules', repo), path.join(root, 'lint/rules'), { recursive: true });
    for (const [name, input] of Object.entries(files)) {
      const file = path.join(root, name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, input);
    }
    const result = run(process.execPath, [biome, 'lint', ...names, '--reporter=json'], { cwd: root, encoding: 'utf8' });
    return decodeBiomeReport(result, { file: names.join(', '), input: JSON.stringify(files) });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
