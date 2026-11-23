// The sidebar rows the shared minute timer refreshes together read their folder's branch once between them (a git spawn
// each, src/lib/threadPullRequest.ts): a read is shared only while it is in flight, so a later one sees a switch at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPullRequestReader } from '../src/lib/threadPullRequest.ts';

const url = 'https://github.com/org/repo/pull/42';

test('rows reading the same folder at once share one branch read; a read after it settles asks git again', async () => {
  const heads: string[] = [];
  let head = 'feature';
  const read = createPullRequestReader({
    head: async (cwd) => (heads.push(cwd), head),
    attachments: async () => ({ data: [], nextCursor: null }),
    legacy: async () => null,
    gh: async () => ({ ok: true, stdout: JSON.stringify({ url, state: 'OPEN' }) }),
  });
  // a dozen rows on one folder, and one on another, refreshed in the same tick
  const rows = await Promise.all([...Array.from({ length: 12 }, (_, i) => read(`c${i}`, '/repo', true)), read('d', '/other', true)]);
  assert.ok(rows.every((pr) => pr?.url === url));
  // one read per folder, and the check after GitHub answered that the branch did not change meanwhile (once per branch)
  assert.deepEqual(heads.sort(), ['/other', '/other', '/repo', '/repo']);
  // the next refresh reads the branch again, and a switch shows
  head = 'main';
  heads.length = 0;
  await read('c0', '/repo', true);
  // the new branch's read, and its own check after GitHub answered
  assert.deepEqual(heads, ['/repo', '/repo']);
});
