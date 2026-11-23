// Which files Biome's `files.includes` selects, decided by Biome itself in a scratch project (never the checkout), for the merge-gate
// matcher test (tests/mergeGateScopeLists.test.ts: the gate's over-approximating match must never say no where Biome says yes).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const biome = fileURLToPath(new URL('../node_modules/@biomejs/biome/bin/biome', import.meta.url));

/**
 * The repository-relative `names` (JS and TS files) that Biome formats under `files.includes`, from copies with unformatted contents.
 * @param {string[]} includes
 * @param {string[]} names
 */
export function biomeSelects(includes, names) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mopilot-biome-select-'));
  try {
    for (const name of names) {
      fs.mkdirSync(path.join(root, path.dirname(name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), 'a  =  1;\n');
    }
    fs.writeFileSync(
      path.join(root, 'biome.json'),
      JSON.stringify({ files: { includes }, formatter: { enabled: true }, linter: { enabled: false } }),
    );
    const run = spawnSync(process.execPath, [biome, 'format', '--reporter=json', '--max-diagnostics=none', '.'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    });
    const formatted = JSON.parse(run.stdout).diagnostics.map((/** @type {{ location: { path: string } }} */ d) => d.location.path);
    return new Set(formatted.filter((/** @type {string} */ file) => names.includes(file)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
