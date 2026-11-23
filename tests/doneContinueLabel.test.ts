// One "Done, continue" label (#1834): the button and every model-facing string that names it read shared/doneContinue.mjs, so
// the agent is never told to click a button that no longer exists ("Done signing in" outlived its button by a release, #1721).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { treeFiles } from '../scripts/source-tree.mjs';
import { stripComments } from './support/source-strings.ts';
import { DONE_CONTINUE, HANDOFF_CONTINUES, doneOn } from '../shared/doneContinue.mjs';
import { browserToolSpecs } from './support/tool-specs.ts';

export const GUARDS = ['bench/', 'electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const ROOTS = ['src', 'electron', 'shared', 'bench'];
const EXT = /\.(ts|tsx|js|cjs|mjs)$/;
const OWNER = 'shared/doneContinue.mjs';
/** Labels the button had before: no code may name them again. */
const RETIRED = /Done signing in/i;

/** Code lines (comments left out) that spell the label out instead of reading the constant, or name a retired label. */
function spelled(file: string, text: string): string[] {
  return stripComments(text)
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => RETIRED.test(line) || (file !== OWNER && line.includes(DONE_CONTINUE)))
    .map(({ line, n }) => `${file}:${n}: ${line.trim().slice(0, 100)}`);
}

test('the label is spelled once, in shared/doneContinue.mjs; no code names a retired one', () => {
  const hits = ROOTS.flatMap((r) => treeFiles(r, EXT)).flatMap((f) => spelled(f, fs.readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
  // the scanner itself: a spelled-out label or a retired one is caught, a comment is not
  assert.equal(spelled('electron/x.cjs', `const a = 'click "${DONE_CONTINUE}"';`).length, 1);
  assert.equal(spelled('electron/x.cjs', "const a = 'Done signing in';").length, 1);
  assert.equal(spelled('electron/x.cjs', `// "${DONE_CONTINUE}" in a comment`).length, 0);
  assert.equal(spelled(OWNER, `export const DONE_CONTINUE = '${DONE_CONTINUE}';`).length, 0);
});

test('what the model is told names the button the user sees, and that its turn ends', () => {
  assert.ok(HANDOFF_CONTINUES.includes(`"${DONE_CONTINUE}"`));
  assert.match(HANDOFF_CONTINUES, /^End your turn now\./);
  assert.equal(doneOn('github.com'), 'Done on github.com');
  const spec = browserToolSpecs().find((s: any) => s.name === 'browser_request_signin');
  assert.ok(spec.description.includes(HANDOFF_CONTINUES));
  // a bot check in the pane hands the tab over the same way
  const { HANDOFF } = require('../electron/capabilities/browser/botCheck.cjs');
  assert.ok(HANDOFF.pane.endsWith(HANDOFF_CONTINUES));
});
