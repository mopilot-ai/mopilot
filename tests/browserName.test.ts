// One name for the built-in browser (#1523 §9): no UI copy, tool result or refusal in src, electron or shared calls it "MoPilot Browser" or MoPilot's "in-app browser" again; Claude Desktop and ChatGPT both say "built-in browser".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const ROOTS = ['src', 'electron', 'shared'];
const EXT = /\.(ts|tsx|js|cjs|mjs|json)$/;
// generated release notes quote what an older build said
const ALLOW = new Set(['src/harness/matrix.generated.json']);
const OLD = /MoPilot Browser|MoPilot(?:'s)? in-app browser|\bin-app browser\b/i;
// "in-app browser" still names other products' browsers (the Codex app's own, the Codex Browser plugin's "iab"
// backend), is a phrase the user may say, which the routing notes map to the built-in browser, and is in the name the
// plugin shows for the pane ("MoPilot In-app Browser", protocol.cjs), which notes already in Codex threads match
const OTHER = /Codex (?:desktop )?app|plugin|\(the in-app browser\)|createBrowserTab|'MoPilot In-app Browser'/;

function oldNames(file: string, text: string): string[] {
  return stripComments(text)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => OLD.test(line) && !(/in-app browser/i.test(line) && !/MoPilot Browser/i.test(line) && OTHER.test(line)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 100)}`);
}

test('the built-in browser has one name in every user- and model-visible string', () => {
  const hits = ROOTS.flatMap((r) => treeFiles(r, EXT))
    .filter((f) => !ALLOW.has(f))
    .flatMap((f) => oldNames(f, fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});

test("the scanner flags the old names in strings and JSX text, not in comments, and leaves other products' browsers alone", () => {
  assert.equal(oldNames('a.ts', "const a = 'MoPilot Browser · x';").length, 1);
  assert.equal(oldNames('a.ts', "const a = 'MoPilot browser routing: use the built-in browser (the in-app browser)';").length, 1);
  assert.equal(oldNames('a.ts', "const a = 'MoPilot Browser routing: use the built-in browser (the in-app browser)';").length, 1);
  assert.equal(oldNames('a.ts', 'const a = `Use the in-app browser`;').length, 1);
  assert.equal(oldNames('a.tsx', '<p>In-app browser</p>').length, 1);
  assert.equal(oldNames('a.ts', '// the in-app browser pane').length, 0);
  assert.equal(oldNames('a.ts', 'const a = "The Codex app\'s in-app browser (Owl)";').length, 0);
  assert.equal(oldNames('a.ts', "const a = 'the Browser plugin\\'s in-app browser (\"iab\")';").length, 0);
  assert.equal(oldNames('a.ts', "const a = 'the built-in browser (the in-app browser)';").length, 0);
  assert.equal(oldNames('a.ts', "const a = 'Browser routing in MoPilot: use the built-in browser (the in-app browser)';").length, 0);
  assert.equal(oldNames('a.ts', "const a = 'the built-in browser';").length, 0);
  assert.equal(oldNames('a.cjs', "const NAME = 'MoPilot In-app Browser';").length, 0);
  assert.equal(oldNames('a.cjs', "const a = 'Unsupported in MoPilot\\'s in-app browser';").length, 1);
});
