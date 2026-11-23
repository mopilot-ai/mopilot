// Action memory's replay (#3571, G4; electron/capabilities/routines/routineReplay.cjs): a replay only reads. It runs opens,
// reads, waits and (with lookOnly) scripts in order, hands the rest to the model as a plan at the first step that could act,
// hands off on a page mismatch, a missing value or a failed read; Stop and a harness switch stop it; and what the model reads
// after each outcome.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { replay, replayReport } = createRequire(import.meta.url)('../electron/capabilities/routines/routineReplay.cjs');

const ANCHOR = { steps: [{ k: 'role', role: 'button', name: { s: 'Add', exact: true } }] };
const PAGE = { origin: 'https://shop.test', path: '/item/*' };
const ROUTINE = {
  name: 'Buy',
  description: 'Adds the item to the cart.',
  params: [{ name: 'qty', example: '1' }],
  steps: [
    { tool: 'browser_navigate', args: { url: 'https://shop.test/item/123' }, page: { origin: 'https://other.test', path: '/' } },
    { tool: 'browser_get_page_text', args: { note: '{{qty}}' }, reads: true, page: PAGE },
    { tool: 'browser_form_input', args: { value: '{{qty}}' }, target: ANCHOR, page: PAGE },
    { tool: 'browser_computer', args: { action: 'left_click' }, target: ANCHOR, page: PAGE },
  ],
};

/** What a browser tool's result ends with: the tab state a replay reads where the result came from. */
const state = (url: string) => ({
  type: 'text',
  text: `<browser_state>\ncurrent tab: tab_1 · Page · ${url}\ntabs: tab_1*\n</browser_state>`,
});

/** The fake tools answer as the real ones do: their result ends with the state of the page named by `o.url` (none: no state). */
function harness(o: any = {}) {
  const calls: any[] = [];
  const opts: any[] = [];
  const ac = new AbortController();
  return {
    calls,
    opts,
    ac,
    run: (routine: any = ROUTINE, values: any = {}) =>
      replay({
        routine,
        values,
        invoke: async (tool: string, args: any, o2?: any) => {
          calls.push({ tool, args });
          opts.push(o2);
          const res = o.invoke ? o.invoke(tool, args, calls.length) : { ok: true, content: [{ type: 'text', text: `did ${tool}` }] };
          const at = o.url ? o.url() : 'https://shop.test/item/456';
          return res.ok && at ? { ...res, content: [...(res.content ?? []), state(at)] } : res;
        },
        signal: ac.signal,
        current: o.current ?? (() => true),
        tainted: o.tainted ?? (() => false),
      }),
  };
}

test('replay: opens and reads run with their values filled, then it hands off before the first step that could act, with no reason', async () => {
  const h = harness();
  const r = await h.run(ROUTINE, { qty: 3 });
  assert.equal(r.status, 'handoff');
  assert.equal(r.reason, null);
  assert.equal(r.at, 2);
  assert.equal(r.ran, 2);
  assert.deepEqual(h.calls, [
    { tool: 'browser_navigate', args: { url: 'https://shop.test/item/123' } },
    { tool: 'browser_get_page_text', args: { note: '3' } },
  ]);
  assert.deepEqual(h.opts, [{}, {}], 'only a script is run with lookOnly');
  assert.deepEqual(r.last.content, [{ type: 'text', text: 'did browser_get_page_text' }, state('https://shop.test/item/456')]);
  // a routine that only reads is done
  const plain = await replay({
    routine: { params: [], steps: [ROUTINE.steps[0]] },
    values: {},
    invoke: async () => ({ ok: true, content: [state('https://shop.test/item/123')] }),
    signal: new AbortController().signal,
    current: () => true,
    tainted: () => false,
  });
  assert.equal(plain.status, 'done');
});

test('replay never runs an acting step: a click, a fill, a password, an unsupported or an unrecorded one is left for the model', async () => {
  const acting: any[] = [
    { tool: 'browser_computer', args: { action: 'left_click' }, target: ANCHOR, page: PAGE },
    { tool: 'browser_form_input', args: {}, target: ANCHOR },
    { tool: 'browser_form_input', args: {}, secret: true, target: ANCHOR },
    { tool: 'browser_file_upload', args: {}, unsupported: true },
    { tool: 'browser_computer', args: { action: 'type', text: 'x' }, target: null },
    { tool: 'browser_computer', args: { action: 'key', text: 'Enter' } },
    { tool: 'chrome_computer', args: { action: 'left_click' } },
    { tool: 'browser_javascript_exec', args: { code: 'document.title' } },
    { tool: 'desktop_app_click', args: {} },
    { tool: 'desktop_app_script', args: { app: 'Notes', script: 'x' } },
    { tool: 'browser_computer', args: undefined },
  ];
  for (const step of acting) {
    const h = harness();
    const r = await h.run({ ...ROUTINE, steps: [ROUTINE.steps[0], step, ROUTINE.steps[1]] });
    assert.deepEqual([r.status, r.at, r.ran, r.reason], ['handoff', 1, 1, null], step.tool);
    assert.equal(h.calls.length, 1, 'the acting step and what follows it did not run');
  }
});

test('replay runs a wait step, a read after it, and nothing else; a script is tried with lookOnly and no other step is', async () => {
  const wait = { tool: 'browser_computer', args: { action: 'wait', duration: 2 } };
  const script = { tool: 'browser_script', args: { code: 'return 1' } };
  const h = harness();
  const r = await h.run({ ...ROUTINE, steps: [wait, script, ROUTINE.steps[1]] });
  assert.equal(r.status, 'done');
  assert.deepEqual(
    h.calls.map((c: any) => c.tool),
    ['browser_computer', 'browser_script', 'browser_get_page_text'],
  );
  assert.deepEqual(h.opts, [{}, { lookOnly: { origins: ['https://shop.test'] } }, {}]);
});

test('replay: a script refused with look_only is left out and named, and the reads after it still run', async () => {
  const script = { tool: 'browser_script', args: { code: 'await loc.act("click")' } };
  const routine = { ...ROUTINE, steps: [ROUTINE.steps[1], script, ROUTINE.steps[3]] };
  const h = harness({
    invoke: (t: string) =>
      t === 'browser_script'
        ? { ok: false, error: { code: 'look_only', message: 'A replay only reads' } }
        : { ok: true, content: [state('https://shop.test/')] },
  });
  const r = await h.run(routine);
  // ROUTINE.steps[3] is a click, which stops the run after the refused script went past
  assert.deepEqual([r.status, r.at, r.reason, r.left], ['handoff', 2, null, [1]]);
  assert.deepEqual(h.opts[1], { lookOnly: { origins: ['https://shop.test'] } });
  const text = replayReport(routine, r)[0].text;
  assert.match(text, /read 1 of 3 steps again and changed nothing\. A routine doesn't act/);
  assert.match(text, /It did not run these steps[^\n]*\n2\. script: await loc\.act\("click"\)/);
  assert.match(text, /3\. left_click "Add"$/);
});

test('replay hands off with a reason on another page, a missing value, a failed read or a script that failed', async () => {
  // the read is invoked, but what it found on another site is not handed back
  let looked = 0;
  const off = harness({
    url: () => (++looked > 1 ? 'https://evil.test/' : 'https://shop.test/item/456'),
    invoke: (t: string) => ({ ok: true, content: [{ type: 'text', text: t === 'browser_get_page_text' ? 'SECRET-OFF-SITE' : 'opened' }] }),
  });
  const moved = await off.run({
    ...ROUTINE,
    steps: [
      ROUTINE.steps[0],
      { tool: 'browser_get_page_text', args: {}, reads: true, page: { origin: 'https://shop.test', path: '/cart' } },
    ],
  });
  assert.equal(moved.status, 'handoff');
  assert.deepEqual([moved.at, moved.ran], [1, 1]);
  assert.match(moved.reason, /it reached a page that is not on a site it recorded \(https:\/\/evil\.test\)/);
  assert.equal(off.calls.length, 2, 'the read was invoked');
  assert.doesNotMatch(JSON.stringify([moved.last, moved.outputs]), /SECRET-OFF-SITE/);
  assert.deepEqual(moved.outputs, []);
  const missing = harness();
  const none = await missing.run({
    ...ROUTINE,
    steps: [ROUTINE.steps[0], { tool: 'browser_get_page_text', args: { q: '{{who}}' }, reads: true }],
  });
  assert.deepEqual([none.status, none.at, none.ran], ['handoff', 1, 1]);
  assert.match(none.reason, /no value for who/);
  assert.equal(missing.calls.length, 1, 'nothing past the first step ran');
  const noPage = await harness({ url: () => null }).run({ ...ROUTINE, steps: [ROUTINE.steps[1]] });
  assert.match(noPage.reason, /not on a site it recorded \(no address\)/);
  const h = harness({
    invoke: (_t: string, _a: any, n: number) =>
      n === 2 ? { ok: false, error: { code: 'denied', message: 'The user declined' } } : { ok: true, content: [] },
  });
  const failed = await h.run();
  assert.equal(failed.status, 'handoff');
  assert.equal(failed.at, 1);
  assert.match(failed.reason, /it failed: The user declined/);
  assert.equal(h.calls.length, 2, 'a refused read stops the run: nothing after it');
  const vague = await harness({ invoke: () => ({ ok: false }) }).run();
  assert.match(vague.reason, /unknown error/);
  // a plain script failure (any other code) is a hand-off with its reason, and is not kept as a failed step
  const sh = harness({ invoke: () => ({ ok: false, error: { code: 'script_failed', message: 'boom' } }) });
  const script = await sh.run({ ...ROUTINE, steps: [{ tool: 'browser_script', args: { code: 'x' } }] });
  assert.deepEqual([script.status, script.at, script.reason], ['handoff', 0, 'it failed: boom']);
  assert.deepEqual(sh.opts, [{ lookOnly: { origins: [] } }]);
});

test('replay stops on Stop (before a step, an aborted call) and on a harness switch', async () => {
  const before = harness();
  before.ac.abort();
  assert.deepEqual(await before.run(), { status: 'stopped', ran: 0, at: 0, reason: 'the turn was stopped' });
  assert.equal(before.calls.length, 0);
  const aborted = await harness({
    invoke: () => ({ ok: false, error: { code: 'aborted', message: 'The turn was stopped before this finished' } }),
  }).run();
  assert.deepEqual(aborted, { status: 'stopped', ran: 0, at: 0, reason: 'the turn was stopped' });
  let g: any;
  g = harness({
    invoke: () => {
      g.ac.abort();
      return { ok: false };
    },
  });
  assert.equal((await g.run()).reason, 'the turn was stopped');
  let switched = false;
  const s = harness({ current: () => !switched, invoke: () => ((switched = true), { ok: true, content: [] }) });
  const r = await s.run();
  assert.deepEqual(r, { status: 'stopped', ran: 1, at: 1, reason: 'the chat switched to another harness' });
});

test('replayReport: done says it read and changed nothing; a hand-off the goal and a numbered plan of the steps left; a stop says nothing else ran', () => {
  const last = { content: [{ type: 'text', text: 'Tab 1 is at https://shop.test/cart.' }] };
  const reads = { ...ROUTINE, steps: ROUTINE.steps.slice(0, 2) };
  const doneText = 'Routine "Buy" read all 2 steps again. They only open and read pages, so nothing changed.';
  assert.deepEqual(replayReport(reads, { status: 'done', ran: 2, last, outputs: [] }), [{ type: 'text', text: doneText }, last.content[0]]);
  assert.deepEqual(replayReport(reads, { status: 'done', ran: 2, last: null, outputs: [] }), [{ type: 'text', text: doneText }]);
  const hand = replayReport(ROUTINE, { status: 'handoff', ran: 2, at: 2, reason: null, last, outputs: [] });
  assert.equal(
    hand[0].text,
    'Routine "Buy" read 2 of 4 steps again and changed nothing. A routine doesn\'t act: the rest is yours to do.\n' +
      "The routine's goal: Adds the item to the cart.\n" +
      'The steps recorded for the rest, from an earlier run. Their values may be out of date, so check each one against this request and read the page before you act:\n' +
      '3. fill "Add"\n4. left_click "Add"',
  );
  assert.equal(hand[1], last.content[0]);
  const why = replayReport(ROUTINE, { status: 'handoff', ran: 1, at: 1, reason: 'it failed: boom', last: null, outputs: [] });
  assert.match(
    why[0].text,
    /again and changed nothing\. It stopped before step 2 of 4 \(get_page_text\): it failed: boom\. A routine doesn't act/,
  );
  const bare = replayReport({ ...ROUTINE, description: '' }, { status: 'handoff', ran: 0, at: 0, reason: null, last: null, outputs: [] });
  assert.equal(bare.length, 1);
  assert.doesNotMatch(bare[0].text, /goal/);
  assert.deepEqual(replayReport(ROUTINE, { status: 'stopped', ran: 2, at: 2, reason: 'the turn was stopped' }), [
    {
      type: 'text',
      text: 'Routine "Buy" stopped before step 3 of 4 (fill "Add"): the turn was stopped. 2 step(s) ran. Nothing else was done.',
    },
  ]);
});

test('the plan shows a script by its code, cut at 800; says what a failed step is; and is bounded with how many steps it leaves out', () => {
  const long = 'x'.repeat(900);
  const exact = 'y'.repeat(800);
  const steps: any[] = [
    { tool: 'browser_script', args: { code: long } },
    { tool: 'browser_script', args: { code: exact } },
    { tool: 'browser_javascript_exec', args: { text: 'document.title' } },
    { tool: 'browser_script', args: {} },
    { tool: 'browser_script', args: {}, unsupported: true, failed: true },
  ];
  const routine = { name: 'P', description: '', params: [], steps };
  const text = replayReport(routine, { status: 'handoff', ran: 0, at: 0, reason: null, last: null, outputs: [] })[0].text;
  assert.ok(text.includes(`1. script: ${'x'.repeat(800)} [cut short]\n`));
  assert.ok(!text.includes('x'.repeat(801)));
  assert.ok(text.includes(`2. script: ${exact}\n`), 'code of exactly 800 is not marked cut');
  assert.ok(text.includes('3. script: document.title\n'));
  assert.ok(text.includes('4. script: \n'));
  assert.match(text, /5\. script \(failed when it was recorded, and may have done part of its work\)$/);
  // many long scripts: the plan stops at 8,000 characters and counts what it left out
  const many = Array.from({ length: 12 }, () => ({ tool: 'browser_script', args: { code: long } }));
  const big = replayReport({ ...routine, steps: many }, { status: 'handoff', ran: 0, at: 0, reason: null, last: null, outputs: [] })[0]
    .text;
  const plan = big.split('before you act:\n')[1];
  assert.ok(plan.length <= 8_000 + 40, `${plan.length}`);
  assert.match(plan, /\n\[3 more steps\]$/);
  assert.equal(plan.split('\n').length, 10);
});

test('a run gives back what its reads found: own text only, once, bounded; a part still to run is named, not run', async () => {
  const steps = [
    { tool: 'browser_get_page_text', args: {}, reads: true },
    { tool: 'browser_get_page_text', args: {}, reads: true },
    { tool: 'browser_script', args: { code: 'x' } },
    { tool: 'browser_navigate', args: { url: 'https://a.test/' } },
    { tool: 'browser_get_page_text', args: {}, reads: true },
    { tool: 'browser_script', args: { code: 'y' } },
    { tool: 'browser_script', args: { code: 'z' } },
    { tool: 'browser_script', args: { code: 'w' } },
    { tool: 'browser_script', args: { code: 'v' } },
    { tool: 'browser_script', args: { code: 'u' } },
    { tool: 'browser_script', args: { code: 't' } },
  ];
  const big = (c: string) => c.repeat(25_000);
  const answers: any[] = [
    [
      { type: 'text', text: 'orders' },
      { type: 'text', text: '<browser_state>\ntab\n</browser_state>' },
    ],
    [
      { type: 'text', text: 'orders' },
      { type: 'image', data: 'x', mimeType: 'image/png' },
    ],
    [{ type: 'text', text: big('a') }],
    [{ type: 'text', text: 'navigated' }],
    [{ type: 'text', text: '<page_diff>x</page_diff>' }],
    [{ type: 'text', text: big('b') }],
    [{ type: 'text', text: big('c') }],
    [{ type: 'text', text: big('d') }],
    [{ type: 'text', text: big('e') }],
    [{ type: 'text', text: big('f') }],
    [{ type: 'text', text: 'last' }],
  ];
  const routine = { name: 'R', description: 'd', params: [], steps };
  const h = harness({ url: () => 'https://a.test/', invoke: (_t: string, _a: any, n: number) => ({ ok: true, content: answers[n - 1] }) });
  const r = await h.run(routine);
  const report = replayReport(routine, r, { part: 1, parts: 2, next: Array(7).fill({ tool: 'browser_form_input', args: {} }) });
  const texts = report.map((c: any) => c.text);
  assert.equal(
    texts[0],
    'Routine "R" read all 11 steps of part 1 of 2 again. They only open and read pages, so nothing changed. Their 5 results are below, as the pages are now: reading the same pages again would show the same.',
  );
  assert.equal(texts[1], 'Step 1 (get_page_text) found:\norders', 'the tab state is left out, and the repeat with the same text');
  assert.match(texts[2], /^Step 3 \(script\) found:\na+\n\[cut short\]$/);
  const later = texts.find((t: string) => t.startsWith('Part 2 of 2'));
  assert.match(later, /has not run \(7 steps\)/);
  assert.equal(later.split('\n- ').length - 1, 6, 'at most six of its steps are named');
  assert.match(later, /Run it only when the user asks for it: routine_run with part 2\.$/);
  const found = texts.filter((t: string) => / found:\n/.test(t));
  assert.equal(
    found.reduce((n: number, t: string) => n + t.split('found:\n')[1].replace('\n[cut short]', '').length, 0),
    80_000,
    'the run keeps to its bound',
  );
  assert.ok(!found.some((t: string) => t.includes('Step 11')), 'nothing after the bound');
  // a hand-off still gives back what was read before it, and says which part
  const click = { tool: 'browser_computer', args: { action: 'left_click' }, target: ANCHOR };
  const handRoutine = { ...routine, steps: [{ ...steps[0], page: { origin: 'https://a.test', path: '/' } }, click] };
  const stop = await harness({ url: () => 'https://a.test/', invoke: () => ({ ok: true, content: [{ type: 'text', text: 'seen' }] }) }).run(
    handRoutine,
  );
  assert.deepEqual([stop.status, stop.at], ['handoff', 1]);
  const told = replayReport(handRoutine, stop, { part: 2, parts: 2, next: [] });
  assert.match(told[0].text, /read 1 of 2 steps of part 2 of 2 again and changed nothing/);
  assert.match(told[0].text, /2\. left_click "Add"/);
  assert.equal(told[1].text, 'Step 1 (get_page_text) found:\nseen');
  // a result with no outputs at all reads as before
  assert.deepEqual(
    replayReport(routine, { status: 'done', ran: 11, last: null, outputs: [] }).map((c: any) => c.text),
    ['Routine "R" read all 11 steps again. They only open and read pages, so nothing changed.'],
  );
});

test('a plan fills in the values a run was given, else the recorded ones; a step with neither keeps its name, and a failed script is never called', async () => {
  const STEPS = [
    { tool: 'browser_navigate', args: { url: 'https://a.test/' } },
    { tool: 'browser_computer', args: { action: 'type', text: '{{search}}' } },
    { tool: 'browser_computer', args: { action: 'type', text: '{{other}}' } },
    { tool: 'browser_javascript_exec', args: { text: 'document.title' } },
    { tool: 'browser_script', args: {}, unsupported: true, failed: true },
  ];
  const routine = { name: 'R', description: '', steps: STEPS, params: [{ name: 'search', example: 'mug' }] };
  const report = (values?: any) => {
    const r = { status: 'handoff', ran: 1, at: 1, reason: null, last: null, outputs: [] } as any;
    return replayReport(routine, r, { part: 1, parts: 1, next: [], ...(values ? { values } : {}) })[0].text;
  };
  assert.match(report(), /2\. type "mug"/);
  assert.match(report({ search: 'cup' }), /2\. type "cup"/);
  assert.match(report(), /3\. type "\{\{other\}\}"/);
  assert.match(report(), /4\. script: document\.title/);
  assert.match(report(), /failed when it was recorded/);
  assert.match(
    replayReport({ name: 'R', description: '', steps: STEPS }, {
      status: 'handoff',
      ran: 0,
      at: 4,
      reason: null,
      last: null,
      outputs: [],
    } as any)[0].text,
    /5\. /,
  );
  const called: string[] = [];
  const r = await replay({
    routine: { steps: [STEPS[4]], params: [] },
    values: {},
    invoke: async (t: string) => (called.push(t), { ok: true, content: [] }),
    signal: new AbortController().signal,
    current: () => true,
    tainted: () => false,
  });
  assert.equal(r.status, 'done');
  assert.equal(r.ran, 0);
  assert.deepEqual(called, []);
});
