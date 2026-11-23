// A linked-session E2E spec starts the parent's long turn with runSlow, which first waits for the turn that started the child to end (#3308).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { treeFiles } from '../scripts/source-tree.mjs';

export const GUARDS = ['tests/e2e/'];

/** A SLOW message the spec sends itself with the family fixture's send(), on one line or wrapped. */
const OWN_SLOW = /\bsend\(\s*page\s*,\s*[`'"][^`'"]*SLOW[^`'"]*[`'"]/g;

/**
 * The lines of a spec using tests/e2e/fixtures/linkedFamily.ts that send a SLOW turn themselves. Sent while the turn that
 * started a child still runs, the message is steered into that turn and ends with it: the parent is idle again, so the
 * child's message starts a turn there instead of waiting in its queue or steering in, and the spec checks the wrong path.
 */
export function ownSlowSends(source: string): number[] {
  if (!source.includes('./fixtures/linkedFamily')) return [];
  return [...source.matchAll(OWN_SLOW)].map((m) => source.slice(0, m.index).split('\n').length);
}

test('the check finds a SLOW send in a linked-session spec, and passes runSlow and other specs', () => {
  const linked = "import { send } from './fixtures/linkedFamily';";
  assert.deepEqual(ownSlowSends([linked, "await send(page, 'keep working SLOW');"].join('\n')), [2]);
  assert.deepEqual(ownSlowSends([linked, 'await send(', '  page,', '  `go SLOW now`,', ');'].join('\n')), [2]);
  assert.deepEqual(ownSlowSends([linked, 'await runSlow(page);', "await send(page, 'Steer this in');"].join('\n')), []);
  // a spec without the family fixture has no child turn to race
  assert.deepEqual(ownSlowSends("await send(page, 'keep working SLOW');"), []);
});

test('no linked-session E2E spec sends its SLOW turn without runSlow', () => {
  const hits = treeFiles('tests/e2e', /\.spec\.ts$/).flatMap((f: string) =>
    ownSlowSends(fs.readFileSync(f, 'utf8')).map((line) => `${f}:${line}`),
  );
  assert.deepEqual(hits, []);
});
