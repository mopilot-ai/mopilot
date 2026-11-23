// Whole-repository invariant: the task core (shared/momoTasks) reaches nothing but itself, `shared/textPrefix.mjs` and node:crypto, so the Host bundle ships it with no table, catalog or package behind it; the Host hands it the Remote Run words (host/src/momoServices/tasks.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '..', 'shared', 'momoTasks');
const ALLOWED = new Set(['node:crypto', '../textPrefix.mjs']);

test('the task core imports only itself, the text-prefix leaf and node:crypto', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.ts'));
  assert.ok(files.length > 8);
  for (const file of files) {
    const text = fs.readFileSync(path.join(DIR, file), 'utf8');
    // a type-only import is erased when the Host ships the file, so it reaches nothing
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)(?!\s+type\b)\s[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(spec.startsWith('./') || ALLOWED.has(spec), `${file} imports ${spec}`);
    }
  }
});
