// Action memory's replay passes over what it can't do (#3571, G4; electron/capabilities/routines/routineReplay.cjs): a step that
// failed when recorded, a script left out for what it reaches for, and one the run refused for acting (a click to the next page)
// don't stop the reads after them. What they left may have moved the tab, so a read straight after one waits for a step that opens a page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { replay, replayReport } = createRequire(import.meta.url)('../electron/capabilities/routines/routineReplay.cjs');

/** What a browser tool's result ends with: the tab state a replay reads where the result came from. */
const state = (url: string) => ({
  type: 'text',
  text: `<browser_state>\ncurrent tab: tab_1 · Page · ${url}\ntabs: tab_1*\n</browser_state>`,
});

const seen = (url = 'https://a.test/') => ({
  ok: true,
  content: [
    { type: 'text', text: 'page text' },
    { type: 'text', text: `<browser_state>\ncurrent tab: tab_1 · Page · ${url}\ntabs: tab_1*\n</browser_state>` },
  ],
});
const runOf = async (steps: any[]) => {
  const called: string[] = [];
  const r = await replay({
    routine: { steps, params: [] },
    values: {},
    invoke: async (_t: string, a: any) => (called.push(a.code ?? a.url ?? 'read'), seen()),
    signal: new AbortController().signal,
    current: () => true,
    tainted: () => false,
  });
  return { r, called };
};
const OPEN = { tool: 'browser_navigate', args: { url: 'https://a.test/' } };
const FAILED = { tool: 'browser_script', args: {}, unsupported: true, failed: true };
const READ = { tool: 'browser_script', args: { code: 'return await tab.title()' } };
const NOSY = { tool: 'browser_script', args: { code: 'return document.querySelector("form").outerHTML' } };
const CLICK = { tool: 'browser_computer', args: { action: 'left_click' }, target: null };

test('a step that failed when recorded does not stop the reads after it: a model often starts with one', async () => {
  const { r, called } = await runOf([FAILED, FAILED, OPEN, READ]);
  assert.equal(r.status, 'done');
  assert.equal(r.ran, 2);
  assert.deepEqual(called, ['https://a.test/', READ.args.code]);
});

test('a script that reaches for secrets is left out and named; the reads after it wait for a step that says where they read', async () => {
  // what it left out may be what moved the tab, so a read straight after it could be of another page
  const { r, called } = await runOf([OPEN, NOSY, READ]);
  assert.equal(r.status, 'done');
  assert.deepEqual(called, ['https://a.test/'], 'the nosy script did not run, and the script after it did not either');
  assert.deepEqual(r.left, [1, 2]);
  const text = replayReport({ name: 'R', description: '', steps: [OPEN, NOSY, READ], params: [] }, r)[0].text;
  assert.match(text, /read 1 of 3 steps again and changed nothing/);
  assert.match(
    text,
    /It did not run these steps[^\n]*\n2\. script: return document\.querySelector[\s\S]*3\. script: return await tab\.title/,
  );
  // an open after it says where the next read is: that one runs
  const after = await runOf([OPEN, NOSY, OPEN, READ]);
  assert.deepEqual(after.r.left, [1]);
  assert.deepEqual(after.called, ['https://a.test/', 'https://a.test/', READ.args.code]);
});

test('a plan keeps a failure right before the step it stopped at, which may rest on it, and drops one the reads went past', async () => {
  const steps = [FAILED, OPEN, READ, NOSY, FAILED, CLICK, READ];
  const { r } = await runOf(steps);
  assert.equal(r.status, 'handoff');
  assert.equal(r.at, 5);
  const text = replayReport({ name: 'R', description: '', steps, params: [] }, r)[0].text;
  assert.match(text, /read 2 of 7 steps/);
  assert.match(text, /It did not run these steps[^\n]*\n4\. script: return document/, 'what it left out, on its own');
  assert.match(text, /read the page before you act:\n5\. script \(failed/, 'and the steps still to do, without it');
  assert.match(text, /5\. script \(failed when it was recorded/, 'the failure right before the stop');
  assert.match(text, /6\. left_click/);
  assert.match(text, /7\. script: return await tab\.title/);
  assert.doesNotMatch(text, /\n1\. /, 'the failure the reads went past');
});

const THEN_READ = { tool: 'browser_get_page_text', args: {}, reads: true };
const MOVES = { tool: 'browser_script', args: { code: 'await tab.goto("https://a.test/item/5"); return await tab.title()' } };
const MOVES_NOSY = {
  tool: 'browser_script',
  args: { code: 'await tab.goto("https://a.test/item/5"); return (await tab.locator("form").innerHTML())' },
};

test('a read right after a step it passed over may be of the wrong page: it is left out too, until a step opens a page', async () => {
  // the left-out script is what opened /item/5: the plain read would have read /list and passed it off as the answer
  const steps = [OPEN, MOVES_NOSY, THEN_READ, OPEN, THEN_READ];
  const { r, called } = await runOf(steps);
  assert.equal(r.status, 'done');
  assert.deepEqual(r.left, [1, 2]);
  assert.deepEqual(called, ['https://a.test/', 'https://a.test/', 'read'], 'only the read after the next open ran');
  // a failure when recorded is different: the recording read what follows without it, so this replay left nothing out
  const after = await runOf([FAILED, THEN_READ, MOVES, THEN_READ]);
  assert.deepEqual(after.r.left ?? [], []);
  assert.deepEqual(after.called, ['read', MOVES.args.code, 'read']);
  const text = replayReport({ name: 'R', description: '', steps, params: [] }, r)[0].text;
  assert.match(text, /read 3 of 5 steps again and changed nothing/);
  assert.match(text, /2\. script: await tab\.goto/);
  assert.match(text, /3\. get_page_text/);
});

test('whatever a refused script was after leaves what follows unsure: a fill, a selection, a navigation written around the goto check', async () => {
  // the code is what the refusal says nothing about: only that it wanted to act, so the page isn't the recording's any more
  const refuse = (code: string) => ({ tool: 'browser_script', args: { code } });
  for (const code of [
    'await tab.getByRole("searchbox").fill("mug"); return "filtered"',
    'await tab.getByRole("combobox").selectOption("blue"); return 1',
    'await tab.getByRole("checkbox").check(); return 1',
    'await tab["goto"]("https://a.test/item/2"); await tab.getByRole("button").dblclick()',
    'const g = tab.goto; await g("https://a.test/item/2"); return 1',
  ]) {
    const refusing = await replay({
      routine: { steps: [OPEN, refuse(code), THEN_READ], params: [] },
      values: {},
      invoke: async (t: string) =>
        t === 'browser_script' ? { ok: false, error: { code: 'look_only', message: 'A replay only reads' } } : seen(),
      signal: new AbortController().signal,
      current: () => true,
      tainted: () => false,
    });
    assert.deepEqual(refusing.left, [1, 2], code);
    assert.equal(refusing.ran, 1, `${code}: the read after it did not run`);
  }
});

test('counts say what ran: a part of failures only reads none, and a stop counts what ran, not what it passed', async () => {
  const none = await runOf([FAILED]);
  assert.equal(none.r.status, 'done');
  assert.match(
    replayReport({ name: 'R', description: '', steps: [FAILED], params: [] }, none.r)[0].text,
    /read 0 of 1 steps again and changed nothing/,
  );
  const ac = new AbortController();
  const r = await replay({
    routine: { steps: [FAILED, OPEN, READ], params: [] },
    values: {},
    invoke: async () => (ac.abort(), seen()),
    signal: ac.signal,
    current: () => true,
    tainted: () => false,
  });
  assert.equal(r.status, 'stopped');
  assert.equal(r.ran, 1);
});

test("a script with no code is left out, not run; a report with left-out steps fills in a run's values, with or without parameters", async () => {
  for (const blank of [{ tool: 'browser_script', args: {} }, { tool: 'browser_script' }]) {
    const { r, called } = await runOf([OPEN, blank, OPEN, READ]);
    assert.deepEqual(r.left, [1]);
    assert.deepEqual(called, ['https://a.test/', 'https://a.test/', READ.args.code]);
  }
  const typed = { tool: 'browser_script', args: { code: 'return document.cookie // {{who}}' } };
  const done = { status: 'done', ran: 1, left: [1], last: null, outputs: [] } as any;
  const withParams = { name: 'R', description: '', steps: [OPEN, typed], params: [{ name: 'who', example: 'Ann' }] };
  assert.match(replayReport(withParams, done, { part: 1, parts: 1, next: [], values: { who: 'Bo' } })[0].text, /document\.cookie \/\/ Bo/);
  assert.match(replayReport(withParams, done, { part: 1, parts: 1, next: [] })[0].text, /document\.cookie \/\/ Ann/);
  assert.match(replayReport({ name: 'R', description: '', steps: [OPEN, typed] }, done)[0].text, /document\.cookie \/\/ \{\{who\}\}/);
});

test('replay: a click to the next page is passed over, and the reads after the next open run, as in G4 Codex escalations r1', async () => {
  // read, page through the inbox by clicking, then open and read the messages: the click is the model's, and each open says
  // where the reads after it are, so they run (this run read 1 of 8 steps when a refusal ended it)
  const INBOX = { tool: 'browser_navigate', args: { url: 'https://shop.test/' } };
  const PAGE_2 = { tool: 'browser_script', args: { code: "await tab.playwright.getByRole('link', { name: '2' }).click(); return 1" } };
  const MESSAGE = { tool: 'browser_navigate', args: { url: 'https://shop.test/m/1' } };
  const TEXT = { tool: 'browser_get_page_text', args: {}, reads: true, page: { origin: 'https://shop.test', path: '/m/*' } };
  const called: string[] = [];
  const run = (steps: any[]) =>
    replay({
      routine: { steps, params: [] },
      values: {},
      invoke: async (t: string, a: any) => {
        called.push(a.code ?? a.url ?? t);
        return t === 'browser_script'
          ? { ok: false, error: { code: 'look_only', message: 'A replay only reads' } }
          : { ok: true, content: [state('https://shop.test/')] };
      },
      signal: new AbortController().signal,
      current: () => true,
      tainted: () => false,
    });
  const r = await run([INBOX, PAGE_2, MESSAGE, TEXT, MESSAGE, TEXT]);
  assert.equal(r.status, 'done');
  assert.equal(r.ran, 5, 'the opens and the reads after them ran; only the click did not');
  assert.deepEqual(r.left, [1], 'the click, named for the model');
  assert.deepEqual(called, [
    'https://shop.test/',
    "await tab.playwright.getByRole('link', { name: '2' }).click(); return 1",
    'https://shop.test/m/1',
    'browser_get_page_text',
    'https://shop.test/m/1',
    'browser_get_page_text',
  ]);
  // a read straight after the click, with no open between, may be of the wrong page and waits
  const bare = await run([INBOX, PAGE_2, TEXT]);
  assert.equal(bare.ran, 1);
  assert.deepEqual(bare.left, [1, 2]);
  // the click is in the plan, not run as a read, and the plan says its values may be out of date
  const text = replayReport({ name: 'R', description: '', steps: [INBOX, PAGE_2, MESSAGE, TEXT, MESSAGE, TEXT], params: [] }, r)[0].text;
  assert.match(text, /read 5 of 6 steps again and changed nothing/);
  assert.match(text, /It did not run these steps\. Some act on a page \(a click, a form\)[^\n]*\n2\. script: await tab\.playwright/);
  assert.match(text, /read the page before you do any of them/);
});

test('the common recording keeps replaying: failed calls up front, then scripts that open their own pages (G4: 7 of 18 recordings)', async () => {
  // a model's first calls often fail ("tab.innerText is not a function"), and then it reads page after page with scripts that goto
  const goto = (u: string) => ({ tool: 'browser_script', args: { code: `await tab.goto("${u}"); return await tab.title()` } });
  const { r, called } = await runOf([
    FAILED,
    FAILED,
    goto('https://a.test/1'),
    goto('https://a.test/2'),
    goto('https://a.test/3'),
    goto('https://a.test/4'),
  ]);
  assert.equal(r.status, 'done');
  assert.equal(r.ran, 4, 'all four reads ran, not "read 0 of 6"');
  assert.deepEqual(r.left ?? [], []);
  assert.equal(called.length, 4);
  // but one of those scripts this replay skips (it reaches for a secret) makes what follows wait, as the recording ran it
  const nosy = { tool: 'browser_script', args: { code: 'await tab.goto("https://a.test/2"); return document.cookie' } };
  const skipped = await runOf([FAILED, goto('https://a.test/1'), nosy, goto('https://a.test/3'), OPEN, goto('https://a.test/4')]);
  assert.deepEqual(skipped.r.left, [2, 3], 'the skipped script and the read straight after it');
  assert.equal(skipped.r.ran, 3);
});
