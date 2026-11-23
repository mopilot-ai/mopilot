// Every CLI ranking call names its harness so compatibility takes priority over version order (#3518).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? e.name === 'node_modules'
          ? []
          : files(path.join(dir, e.name))
        : /\.(c|m)?[jt]s$/.test(e.name)
          ? [path.join(dir, e.name)]
          : [],
    );

test('I: every install ranking call names the harness kind whose versions policy applies', () => {
  const calls = { preferredInstalls: 0, highestInstalls: 0 };
  for (const file of [...files(path.join(ROOT, 'electron')), ...files(path.join(ROOT, 'tests/conformance'))]) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?<!function )\b(preferredInstalls|highestInstalls)\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)) {
      calls[m[1] as keyof typeof calls]++;
      assert.match(m[2], /,\s*\S/, `${path.relative(ROOT, file)}: ${m[1]}(${m[2]}) picks without the kind`);
    }
  }
  assert.ok(calls.preferredInstalls >= 3, 'Codex, Claude Code and conformance default selection');
  assert.ok(calls.highestInstalls >= 3, 'Codex, Claude Code and ACP highest-version selection');
});
