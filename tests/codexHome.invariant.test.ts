// Invariant (#2326): a Codex thread's home is resolved from its chat (MoMo's own CODEX_HOME or the user's), never assumed
// to be ~/.codex. Only harness/codexRollout.cjs knows where a thread's sessions are kept, and it asks the thread's home;
// the only other code that builds a reader on a fixed home is the one that copies a thread into MoMo's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', 'electron');
function walk(dir: string, out: string[] = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'chrome-extension') continue;
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f, out);
    else if (/\.(cjs|mjs|js)$/.test(e.name)) out.push(f);
  }
  return out;
}
const files = walk(root).map((f) => [path.relative(root, f), fs.readFileSync(f, 'utf8')] as const);
const naming = (re: RegExp) => files.filter(([, text]) => re.test(text)).map(([f]) => f);

test('only the rollout reader looks inside a Codex home for a thread’s sessions', () => {
  assert.deepEqual(naming(/archived_sessions/), ['harness/codexRollout.cjs']);
  assert.deepEqual(naming(/path\.join\([^)]*['"]sessions['"]/), ['harness/codexRollout.cjs']);
});

test('a reader on a fixed home is built only to copy a thread into MoMo’s; every other reader asks the thread’s home', () => {
  assert.deepEqual(naming(/createCodexRollouts\(/).sort(), ['harness/codexMomoHome.cjs', 'harness/codexRollout.cjs']);
  for (const [f, text] of files) {
    if (f === 'harness/codexRollout.cjs') continue;
    assert.doesNotMatch(text, /codexHome:\s*\(\)\s*=>[^\n]*sessions/, f);
  }
});
