// The scripts a workflow runs on their own: copied out of a commit (`git show "$BASE_SHA:scripts/x.mjs" > "$RUNNER_TEMP/x.mjs"`)
// and run from that temporary folder, with nothing of the repository beside them, so they may import only Node.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const COPY = /git show "\$[A-Z_]+:(scripts\/[\w.-]+\.mjs)" > "\$RUNNER_TEMP\//g;

/** Every script a workflow under .github/ copies out and runs alone, repository-relative and sorted. */
export function standaloneScripts(root: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) for (const m of readFileSync(p, 'utf8').matchAll(COPY)) found.add(m[1]);
    }
  };
  walk(path.join(root, '.github'));
  return [...found].sort();
}
