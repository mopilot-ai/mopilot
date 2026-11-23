// Browser-script tool-results unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCRIPT_SPEC, SCRIPT_REFERENCE, LOG_MAX, RESULT_MAX, MAX_MS, browserToolSpecs, code, tick, answers, tool } from './fixture';

export function registerToolResultsCases() {
  test('reserved worker error codes do not become a diagnostic hint', async () => {
    const t = tool((w) => {
      setTimeout(() => w.send({ t: 'done', ok: false, error: { name: 'Error', message: 'failed', code: '__proto__' } }), 5);
    });
    await assert.rejects(t.call({ code: 'x' }), (e: any) => {
      assert.equal(e.code, 'script_failed');
      assert.doesNotMatch(e.message, /Hint:|object Object/);
      return true;
    });
  });

  test('browser_script: the spec, and its place among the browser tools', () => {
    const spec = browserToolSpecs().find((s: any) => s.name === 'browser_script');
    assert.deepEqual([spec.policy, spec.inputSchema.required, spec.inputSchema.properties.timeoutMs.maximum], ['act', ['code'], MAX_MS]);
    assert.equal(spec.description, SCRIPT_SPEC.description);
    for (const word of [
      'getByRole',
      'frameLocator',
      'getJsDialog',
      'domSnapshot',
      'markDeliverable',
      'browser_navigate',
      'browser_computer',
      'browser_read_page',
    ])
      assert.match(spec.description, new RegExp(word));
    // #1381 stab1: checks across many records are computed in the script, not read back as page dumps
    assert.match(spec.description, /compute counts, sums, date differences and record-by-record comparisons in the script/);
  });

  test('browser_script: a result that shows "Page 1 of 2" ends with the note, (#3571)', async () => {
    const answers = (value: string) =>
      tool((w) => setTimeout(() => w.send({ t: 'done', ok: true, value, undef: false }), 5)).call({ code: 'return 1' });
    const one = await answers('"17 orders\\nPage 1 of 2: 1 2"');
    assert.equal(
      one[0].text.split('\n').slice(-2).join('\n'),
      'Result: "17 orders\\nPage 1 of 2: 1 2"\n[This is page 1 of 2 of a list: the rest is on the other page. Open it before counting or totalling.]',
    );
    // a script that also printed page 2 is still told: that page may be another list's (a filtered one)
    const both = await answers('["Page 1 of 2", "Page 2 of 2"]');
    assert.match(both[0].text, /\[This is page 1 of 2 of a list: the rest is on the other page\./);
    const partial = await answers('["Page 1 of 3", "Page 2 of 3"]');
    assert.match(partial[0].text, /\[This is page 1 of 3 of a list: the rest is on the other pages\./);
    const none = await answers('"no pager here"');
    assert.equal(none[0].text.includes('[This is page'), false);
  });

  test('browser_script: the result has the time, console, value and screenshots, then browser_state', async () => {
    const { call, worker } = tool((w) => {
      w.send({ t: 'log', level: 'log', text: 'step 1' });
      w.send({ t: 'call', id: 1, op: 'tab.screenshot', args: { tab: 't1' } });
      w.send({ t: 'call', id: 2, op: 'tab.screenshot', args: { tab: 't1', fullPage: true } });
      setTimeout(() => w.send({ t: 'done', ok: true, value: '{"a": 1}', undef: false }), 5);
    });
    const out = await call({ code: 'return 1', timeoutMs: 99 });
    assert.match(out[0].text, /^Script finished in \d+\.\d s\.\nConsole:\nstep 1\nResult: \{"a": 1\}$/);
    // each screenshot is followed by its id, which browser_file_upload's screenshots attaches (#1530)
    const ids = out.map((c: any) => c.text?.match(/^Screenshot ID: (ss_[0-9a-f]{8})\. To attach it to a file input/)?.[1]).filter(Boolean);
    assert.equal(ids.length, 2);
    const tagged = (id: string) => ({
      type: 'text',
      text: `Screenshot ID: ${id}. To attach it to a file input, give it in browser_file_upload's screenshots.`,
    });
    assert.deepEqual(out.slice(1), [
      { type: 'text', text: 'Screenshot 1 (t1, viewport): image 400x300; coordinate frame 800x600 CSS pixels.' },
      { type: 'image', data: 'IMG', mimeType: 'image/jpeg' },
      tagged(ids[0]),
      {
        type: 'text',
        text: 'Screenshot 2 (t1, full page): image 1280x4000; coordinate frame 1280x4000 CSS pixels; the page is taller and was cut at 8000 pixels.',
      },
      { type: 'image', data: 'FULL', mimeType: 'image/jpeg' },
      tagged(ids[1]),
      { type: 'text', text: 'STATE c1' },
    ]);
    const w = worker();
    assert.deepEqual(w.opts.workerData.init, { platform: process.platform, doc: SCRIPT_REFERENCE });
    // the model sees the outline; a script reads the whole API (G2)
    assert.ok(SCRIPT_REFERENCE.length > SCRIPT_SPEC.description.length && SCRIPT_REFERENCE.includes('allInnerTexts()'));
    assert.deepEqual(w.posted[0], { t: 'run', run: 1, code: 'return 1', current: 't1' });
  });

  test('browser_script: a step still waiting for the user when the script ends does nothing once the card is answered', async () => {
    for (const signal of [undefined, new AbortController().signal]) {
      let answer!: (v: any) => void;
      const t = tool(
        (w) => {
          w.send({ t: 'call', id: 1, op: 'tab.goto', args: { tab: 't1', url: 'https://b.test/' } });
          // the script gives up (its time ran out) while the card is still open
          setTimeout(() => w.send({ t: 'done', ok: false, error: { message: 'out of time', code: 'script_timeout' } }), 5);
        },
        { signal, ask: () => new Promise((r) => (answer = r)) },
      );
      await assert.rejects(t.call({ code: 'await tab.goto("https://b.test/")' }), code('timeout'));
      answer({ decision: 'allow', scope: 'once', level: 'write' });
      await tick();
      await tick();
      assert.deepEqual(
        t.tabs.calls.filter((c: any[]) => c[0] === 'navigate'),
        [],
        'no navigation after the script ended',
      );
      assert.deepEqual(answers(t.worker()).at(-1)?.error?.code, 'aborted');
    }
  });

  test('browser_script: undefined, long values, dropped console lines, no current tab, clamped timeouts and bad code', async () => {
    const a = tool((w) => w.send({ t: 'done', ok: true, value: null, undef: true }));
    a.tabs.list_ = [];
    assert.match((await a.call({ code: 'x' }))[0].text, /\nResult: undefined$/);
    assert.equal(a.worker().posted[0].current, null);
    const b = tool((w) => {
      for (let i = 0; i < 3; i++) w.send({ t: 'log', level: 'log', text: 'y'.repeat(LOG_MAX / 2) });
      w.send({ t: 'done', ok: true, value: 'z'.repeat(RESULT_MAX + 5), undef: false });
    });
    const text = (await b.call({ code: 'x', timeoutMs: 1 }))[0].text;
    assert.match(text, /\[2 more console lines dropped at the 20,000-character limit\.\]/);
    assert.match(text, /z\n\[Truncated at 20,000 characters\.\]$/);
    const c = tool((w) => {
      for (let i = 0; i < 2; i++) w.send({ t: 'log', level: 'log', text: 'y'.repeat(LOG_MAX / 2) });
      w.send({ t: 'done', ok: true, value: '1', undef: false });
    });
    assert.match((await c.call({ code: 'x' }))[0].text, /\[1 more console line dropped/);
    await assert.rejects(a.call({ code: '   ' }), code('bad_args', /^Give the script in code\.$/));
    await assert.rejects(a.call({}), code('bad_args', /^Give the script in code\.$/));
    await assert.rejects(a.call({ code: 'x'.repeat(100_001) }), code('bad_args', /too long/));
  });

  test('browser_script: failures name the line, the error, a hint, the console so far and the state', async () => {
    const fail = async (error: any, codeText = 'const a = 1\nawait tab.getByRole("button").click()\nreturn a', o: any = {}) => {
      const t = tool((w) => {
        if (o.log) w.send({ t: 'log', level: 'log', text: 'before' });
        if (o.shot) w.send({ t: 'call', id: 1, op: 'tab.screenshot', args: { tab: 't1' } });
        setTimeout(() => w.send({ t: 'done', ok: false, error }), 5);
      });
      return t.call({ code: codeText }).then(
        () => assert.fail('should fail'),
        (e: any) => e,
      );
    };
    let e = await fail(
      {
        name: 'BrowserError',
        message: 'matched 2 elements',
        code: 'strict',
        stack: 'Error\n    at Tab._call (mopilot-browser-runtime:1:1)\n    at browser_script:3:44',
      },
      undefined,
      { log: true, shot: true },
    );
    assert.equal(e.code, 'script_failed');
    assert.equal(
      e.message,
      'browser_script failed at line 2: await tab.getByRole("button").click()\nmatched 2 elements\nHint: Make the locator match one element: first(), nth(i), filter({ hasText }) or a more specific role and name.\nConsole:\nbefore\n(1 screenshot taken before the failure is not returned.)\nSTATE c1',
    );
    e = await fail({ name: 'TimeoutError', message: 'Timed out', code: 'timeout', stack: 'at browser_script:2:1' }, undefined, {
      shot: true,
    });
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /^browser_script failed at line 1: const a = 1\nTimeoutError: Timed out\nHint: Look at what the page shows/);
    e = await fail({ message: "The script didn't finish within 5 ms.", code: 'script_timeout' });
    assert.equal(e.code, 'timeout');
    assert.match(e.message, /^browser_script failed\nThe script didn't finish within 5 ms\.\nHint: Split the work/);
    e = await fail({ name: 'SyntaxError', message: 'Unexpected token', code: 'syntax', line: 3, stack: '' });
    assert.match(
      e.message,
      /^browser_script failed at line 3: return a\nSyntaxError: Unexpected token\nHint: The code is the body of an async function/,
    );
    e = await fail({ name: 'ReferenceError', message: 'require is not defined', code: null, stack: 'at browser_script:2:3' });
    assert.match(e.message, /Hint: Only tab, browser, tabs, console, sleep and agent are defined/);
    e = await fail({ name: 'TypeError', message: 'tab.clickIt is not a function', code: null, stack: '' });
    assert.match(e.message, /^browser_script failed\nTypeError: tab\.clickIt is not a function\nHint: Check the method/);
    e = await fail({ name: 'TypeError', message: 'other', code: null, stack: 'browser_script:99:1' });
    assert.equal(e.message, 'browser_script failed\nTypeError: other\nSTATE c1');
    e = await fail({ name: 'Error', message: 'denied', code: 'denied', stack: 'at browser_script:2:1' });
    assert.equal(e.message, 'browser_script failed at line 1: const a = 1\ndenied\nSTATE c1');
    e = await fail({ message: 'The turn was stopped.', code: 'aborted' });
    assert.equal(e.code, 'aborted');
    e = await fail(undefined);
    assert.equal(e.message, 'browser_script failed\nThe script failed.\nSTATE c1');
    // two screenshots lost
    const t = tool((w) => {
      w.send({ t: 'call', id: 1, op: 'tab.screenshot', args: { tab: 't1' } });
      w.send({ t: 'call', id: 2, op: 'tab.screenshot', args: { tab: 't1' } });
      setTimeout(() => w.send({ t: 'done', ok: false, error: { message: 'x' } }), 5);
    });
    await assert.rejects(t.call({ code: 'x' }), code('script_failed', /\(2 screenshots taken before the failure are not returned\.\)/));
  });

  test('browser_script: sleep waits for real, and a stopped turn ends the wait', async () => {
    const quick = tool((w) => {
      w.send({ t: 'call', id: 1, op: 'sleep', args: { ms: 5 } });
      setTimeout(() => w.send({ t: 'done', ok: true, value: '1', undef: false }), 20);
    });
    await quick.call({ code: 'x' });
    assert.deepEqual(answers(quick.worker()), [{ id: 1, ok: true, value: null }]);
    const ac = new AbortController();
    const stopped = tool(
      (w) => {
        w.send({ t: 'call', id: 1, op: 'sleep', args: { ms: 20_000 } });
        setTimeout(() => ac.abort(), 5);
      },
      { signal: ac.signal },
    );
    await assert.rejects(stopped.call({ code: 'x' }), code('aborted', /The turn was stopped\./));
    // already stopped: the script ends at once and a sleep it still asks for doesn't wait
    const pre = new AbortController();
    pre.abort();
    let answered = false;
    const gone = tool(
      (w) => {
        w.send({ t: 'call', id: 1, op: 'sleep', args: { ms: 20_000 } });
        answered = true;
      },
      { signal: pre.signal },
    );
    await assert.rejects(gone.call({ code: 'x' }), code('aborted'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(answered, true);
  });
}
