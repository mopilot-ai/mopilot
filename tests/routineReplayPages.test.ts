// Action memory's replay says what it holds (#3571, G4; electron/capabilities/routines/routineReplay.cjs): when its results already
// hold the other pages of a paged list, the "page 1 of 2, open the rest" note says where they are instead of sending the model
// back to open them (both Codex pass B runs of the G4 pair re-read page 2), and the report's first line says the findings are
// the pages as they are now.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pagePositions, noteFor } from '../shared/pagingNote.mjs';

const { replay, replayReport } = createRequire(import.meta.url)('../electron/capabilities/routines/routineReplay.cjs');

const page = (text: string, url: string) => ({
  ok: true,
  content: [
    { type: 'text', text },
    {
      type: 'text',
      text: `<browser_state>\ncurrent tab: tab_1 · Page · ${url}\ntabs: tab_1*\n</browser_state>`,
    },
  ],
});
const READ = (code: string) => ({ tool: 'browser_script', args: { code } });
const OPEN = {
  tool: 'browser_navigate',
  args: { url: 'https://mail.test/f/inbox' },
};

/** Replays `steps`, each read answering with the next of `answers` (text, url). */
async function reportOf(steps: any[], answers: [string, string][]) {
  let n = 0;
  const routine = { name: 'R', description: '', steps, params: [] };
  const r = await replay({
    routine,
    values: {},
    invoke: async () => page(...answers[n++]),
    signal: new AbortController().signal,
    current: () => true,
    tainted: () => false,
  });
  return replayReport(routine, r).map((c: any) => c.text);
}

const ONE = 'Inbox\n12 conversations\nPage 1 of 2: 1';
const TWO = 'Inbox\nPage 2 of 2: 12';
const MAIL = 'https://mail.test/f/inbox';

test('pagePositions names every "Page X of Y" a text shows, in order, and nothing else', () => {
  assert.deepEqual(pagePositions('Page 1 of 2: 1 … page 2 of 2'), [
    { here: 1, of: 2 },
    { here: 2, of: 2 },
  ]);
  assert.deepEqual(
    pagePositions('Page 3 of 2, page 0 of 4, no position here'),
    [],
    'a position past the end or before the first is no position',
  );
});

test('a page-1 note whose other page this replay also returned says where it is, and the first line says the findings are current', async () => {
  const note = noteFor(1, 2);
  const texts = await reportOf(
    [OPEN, READ('a'), READ('b')],
    [
      ['opened', MAIL],
      [ONE + note, MAIL],
      [TWO, MAIL],
    ],
  );
  assert.match(
    texts[0],
    /read all 3 steps again\. They only open and read pages, so nothing changed\. Their 2 results are below, as the pages are now, with pages 1 and 2 of 2 of a paged list: reading the same pages again would show the same\.$/,
  );
  assert.match(
    texts[1],
    /Page 1 of 2: 1\n\[This is page 1 of 2 of a list\. Page 2 came back in step 3 below, from the same site: there is nothing more to open\.\]$/,
  );
  assert.equal(texts[1].includes('Open it before counting'), false, 'the old instruction is gone where its pages are here');
  assert.equal(texts[2], 'Step 3 (script) found:\n' + TWO, 'the other page itself is untouched');
});

test('a page-1 note keeps its instruction when the other page is not here, is from another site, or a list of three has a page missing', async () => {
  const note = noteFor(1, 2);
  // the other page was not read
  let texts = await reportOf(
    [OPEN, READ('a')],
    [
      ['opened', MAIL],
      [ONE + note, MAIL],
    ],
  );
  assert.match(texts[1], /Open it before counting or totalling\.\]$/);
  assert.doesNotMatch(texts[0], /with pages/);
  // a "Page 2 of 2" read on another site is not this list's
  texts = await reportOf(
    [OPEN, READ('a'), READ('b')],
    [
      ['opened', MAIL],
      [ONE + note, MAIL],
      [TWO, 'https://shop.test/orders'],
    ],
  );
  assert.match(texts[1], /Open it before counting or totalling\.\]$/);
  // a list of three with only page 2 read still has page 3 to open
  texts = await reportOf(
    [OPEN, READ('a'), READ('b')],
    [
      ['opened', MAIL],
      ['Orders\nPage 1 of 3' + noteFor(1, 3), MAIL],
      ['Orders\nPage 2 of 3' + noteFor(2, 3), MAIL],
    ],
  );
  assert.match(texts[1], /Open them before counting or totalling\.\]$/);
  assert.match(texts[2], /Open it before counting or totalling\.\]$/, 'page 2 of 3 still has page 3 to open');
});

test('a list of three read whole says so, with the steps the other pages came back in', async () => {
  const texts = await reportOf(
    [OPEN, READ('a'), READ('b'), READ('c')],
    [
      ['opened', MAIL],
      ['Orders\nPage 1 of 3' + noteFor(1, 3), MAIL],
      ['Orders\nPage 2 of 3' + noteFor(2, 3), MAIL],
      ['Orders\nPage 3 of 3', MAIL],
    ],
  );
  assert.match(texts[0], /with pages 1 and 2 and 3 of 3 of a paged list/);
  assert.match(texts[1], /Pages 2 and 3 came back in step 3 and step 4 below/);
});

test('a one-result run says "Its result is", and a run with no findings adds nothing', async () => {
  const one = await reportOf(
    [OPEN, READ('a')],
    [
      ['opened', MAIL],
      ['just text', MAIL],
    ],
  );
  assert.match(one[0], /nothing changed\. Its result is below, as the pages are now: reading the same pages again would show the same\.$/);
  const none = await reportOf([OPEN], [['opened', MAIL]]);
  assert.equal(none[0], 'Routine "R" read all 1 steps again. They only open and read pages, so nothing changed.');
});
