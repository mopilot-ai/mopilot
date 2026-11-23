// Test evidence sources reachable from runnable entrypoints, excluding unrelated helpers and production modules.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { referencesOf } from '../../scripts/related-tests.mjs';

export function testCaseSources(entries: string[], root: string) {
  const found: { file: string; entry: string; source: string }[] = [];
  const visited = new Set<string>();
  const read = (file: string, entry: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const source = readFileSync(path.join(root, file), 'utf8');
    found.push({ file, entry, source });
    for (const target of referencesOf(file, source, root))
      if (target.startsWith('tests/support/') || target.startsWith('tests/helpers/')) read(target, entry);
  };
  for (const entry of entries) read(entry, entry);
  return found;
}
