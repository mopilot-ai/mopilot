// Browser-script worker-sessions unit cases with shared tab, clock and worker fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SESSION_INIT,
  ScriptSession,
  ScriptSessions,
  WORKER_SOURCE,
  LOG_MAX,
  ToolError,
  FakeWorker,
  tick,
  answers,
  fakeSession,
} from './fixture';

export function registerWorkerSessionsCases() {
  test('browser_script preserves the shared worker-session constructors and source', async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const sessionModule = require('../../../electron/capabilities/browser/scriptSessions.cjs');
    assert.equal(ScriptSession, sessionModule.ScriptSession);
    assert.equal(ScriptSessions, sessionModule.ScriptSessions);
    assert.equal(WORKER_SOURCE, sessionModule.WORKER_SOURCE);
    assert.equal(LOG_MAX, sessionModule.LOG_MAX);
  });

  test('ScriptSession: a worker for the chat, each call a run in it; calls dispatched and answered, logs kept, the outcome returned once', async () => {
    const seen: any[] = [];
    const s = fakeSession();
    const p = s.run({
      code: 'CODE',
      current: 't1',
      dispatch: async (op: string, args: any) => {
        seen.push([op, args]);
        if (op === 'bad') throw new ToolError('No.', 'denied');
        if (op === 'worse') throw 'plain';
        if (op === 'odd') throw Object.assign(new Error('odd'), { code: 'x' });
        return op === 'v' ? { a: 1 } : undefined;
      },
    });
    await tick();
    const worker = s.w();
    assert.equal(worker.src, WORKER_SOURCE);
    assert.deepEqual(worker.opts.workerData, { init: { platform: 'linux' } });
    assert.deepEqual([worker.opts.eval, worker.opts.env, worker.opts.resourceLimits.maxOldGenerationSizeMb], [true, {}, 128]);
    assert.deepEqual(worker.posted, [{ t: 'run', run: 1, code: 'CODE', current: 't1' }]);
    worker.send('not json');
    worker.send({ t: 'log', level: 'log', text: 'hello' });
    worker.send({ t: 'log', level: 'warn', text: 7 });
    worker.send({ t: 'call', id: 1, op: 'v', args: { x: 1 } });
    worker.send({ t: 'call', id: 2, op: 'u', args: 'nope' });
    worker.send({ t: 'call', id: 3, op: 'bad' });
    worker.send({ t: 'call', id: 4, op: 'worse' });
    worker.send({ t: 'call', id: 5, op: 'odd' });
    worker.send({ t: 'other' });
    await tick();
    await tick();
    assert.deepEqual(seen, [
      ['v', { x: 1 }],
      ['u', {}],
      ['bad', {}],
      ['worse', {}],
      ['odd', {}],
    ]);
    assert.deepEqual(answers(worker), [
      { id: 1, ok: true, value: { a: 1 } },
      { id: 2, ok: true, value: null },
      { id: 3, ok: false, error: { message: 'No.', code: 'denied' } },
      { id: 4, ok: false, error: { message: 'plain', code: 'failed' } },
      { id: 5, ok: false, error: { message: 'odd', code: 'failed' } },
    ]);
    worker.send({ t: 'done', run: 99, ok: true, value: 'another run' });
    worker.send({ t: 'done', ok: true, value: '42', undef: false });
    worker.send({ t: 'done', ok: false, error: { message: 'late' } });
    const r = await p;
    assert.deepEqual({ ...r, ms: 0 }, { ok: true, value: '42', undef: false, logs: ['hello', '[warn] 7'], dropped: 0, ms: 0, lost: null });
    assert.equal(worker.terminated, 0, 'the worker stays for the next call');
    // between calls: logs are dropped and a call an earlier script left running is refused
    worker.send({ t: 'log', level: 'log', text: 'stray' });
    worker.send({ t: 'call', id: 6, op: 'v' });
    assert.deepEqual(answers(worker).at(-1), {
      id: 6,
      ok: false,
      error: { message: 'The script that made this call already finished.', code: 'finished' },
    });
    assert.deepEqual(seen.length, 5);
    // the next call runs in the same worker
    const p2 = s.run({ code: 'NEXT' });
    await tick();
    assert.equal(s.workers.length, 1);
    assert.deepEqual(worker.posted.at(-1), { t: 'run', run: 2, code: 'NEXT', current: null });
    worker.send({ t: 'done', ok: true, value: '1' });
    assert.equal((await p2).ok, true);
  });

  test('ScriptSession: calls run one at a time; an answer for a call whose worker was let go is not sent', async () => {
    const s = fakeSession();
    const slow = s.run({ code: 'A', dispatch: () => new Promise((res) => setTimeout(res, 20)) });
    const next = s.run({ code: 'B' });
    await tick();
    assert.deepEqual(
      s.w().posted.map((m) => m.code),
      ['A'],
    );
    s.w().send({ t: 'call', id: 1, op: 'slow' });
    s.w().send({ t: 'done', ok: false, error: { message: 'e', code: 'strict' } });
    assert.deepEqual((await slow).error, { message: 'e', code: 'strict' });
    await tick();
    assert.deepEqual(
      s
        .w()
        .posted.filter((m) => m.t === 'run')
        .map((m) => m.code),
      ['A', 'B'],
    );
    s.session.end();
    await new Promise((res) => setTimeout(res, 30));
    assert.deepEqual(answers(s.w()), []);
    assert.deepEqual((await next).error, { message: 'The turn ended.', code: 'aborted' });
  });

  test("ScriptSession: console output is capped; crashes, exits, timeouts, stops and the turn's end end the session, and the next call says so", async () => {
    const cap = fakeSession();
    const capped = cap.run();
    await tick();
    const big = 'x'.repeat(LOG_MAX / 2);
    for (let i = 0; i < 3; i++) cap.w().send({ t: 'log', level: 'log', text: big });
    cap.w().send({ t: 'done', ok: true, value: null, undef: true });
    assert.deepEqual([(await capped).logs.length, (await capped).dropped, (await capped).undef], [1, 2, true]);

    const s = fakeSession();
    let p = s.run();
    await tick();
    s.w().emit('error', new Error('heap limit'));
    assert.deepEqual((await p).error, { message: 'The script stopped: heap limit', code: 'crashed' });
    p = s.run();
    await tick();
    assert.equal(s.workers.length, 2, 'a fresh worker');
    s.w().emit('error', 'odd');
    const odd = await p;
    assert.deepEqual([odd.error.message, odd.lost], ['The script stopped: odd', 'its worker stopped']);
    p = s.run();
    await tick();
    s.w().emit('exit', 0);
    assert.deepEqual((await p).error, { message: 'The script stopped before it finished.', code: 'crashed' });
    // a worker that goes between calls
    p = s.run();
    await tick();
    const w4 = s.w();
    w4.send({ t: 'done', ok: true, value: '1' });
    await p;
    w4.emit('exit', 1);
    w4.emit('exit', 1);
    p = s.run();
    await tick();
    s.w().send({ t: 'done', ok: true, value: '1' });
    assert.equal((await p).lost, 'its worker stopped');
    // a timeout lets the worker go; what it says afterwards is not answered
    p = s.run({ timeoutMs: 20 });
    await tick();
    const timedOut = s.w();
    assert.deepEqual((await p).error, { message: "The script didn't finish within 20 ms.", code: 'script_timeout' });
    assert.equal(timedOut.terminated, 1);
    timedOut.send({ t: 'call', id: 1, op: 'x' });
    assert.deepEqual(answers(timedOut), []);
    p = s.run();
    await tick();
    s.w().send({ t: 'done', ok: true, value: '1' });
    assert.equal((await p).lost, 'a script timed out');
    // stopped during the call, or before it
    const ac = new AbortController();
    p = s.run({ signal: ac.signal });
    await tick();
    ac.abort();
    assert.deepEqual((await p).error, { message: 'The turn was stopped.', code: 'aborted' });
    const pre = new AbortController();
    pre.abort();
    const before = await s.run({ signal: pre.signal });
    assert.deepEqual([before.error.code, before.lost], ['aborted', 'the turn was stopped']);
    // the turn's end lets go without a note for the next turn
    p = s.run();
    await tick();
    s.w().send({ t: 'done', ok: true, value: '1' });
    await p;
    s.session.end();
    s.session.end();
    p = s.run();
    await tick();
    s.w().send({ t: 'done', ok: true, value: '1' });
    assert.equal((await p).lost, null);
  });

  test('ScriptSessions: one per chat, ended per chat or all at once', async () => {
    const made: string[] = [];
    const sessions = new ScriptSessions({ init: {}, makeWorker: (src: string, opts: any) => (made.push('w'), new FakeWorker(src, opts)) });
    assert.equal(sessions.get('a'), sessions.get('a'));
    assert.notEqual(sessions.get('a'), sessions.get('b'));
    const a = sessions.get('a');
    sessions.end('a');
    sessions.end('zz');
    assert.notEqual(sessions.get('a'), a);
    sessions.endAll();
    assert.equal(sessions.byChat.size, 0);
    assert.equal(new ScriptSessions().byChat.size, 0);
  });

  test('ScriptSession with a real worker: the sandbox has no Node, no code from strings; declarations stay until a timeout', async () => {
    const session = new ScriptSession({ init: SESSION_INIT });
    const dispatch = async (op: string) => (op === 'tab.resolve' ? { id: 't1' } : op === 'tab.title' ? 'Real' : null);
    const run = (c: string, timeoutMs = 5000) => session.run({ code: c, timeoutMs, dispatch });
    try {
      const ok = await run(
        'console.log(typeof require, typeof process, typeof fetch, typeof setTimeout)\nconst title = await tab.title()\nlet n = 1\ntitle',
      );
      assert.deepEqual([ok.ok, ok.value, ok.logs], [true, '"Real"', ['undefined undefined undefined undefined']]);
      const kept = await run('n += 1\n[title, n]');
      assert.equal(kept.value, '[\n  "Real",\n  2\n]');
      const gen = await run('try { return (() => {}).constructor("return process")() } catch (e) { return e.message }');
      assert.match(gen.value, /Code generation from strings disallowed/);
      const loop = await run('while (true) {}', 300);
      assert.equal(loop.error.code, 'script_timeout');
      const after = await run('typeof n');
      assert.deepEqual([after.value, after.lost], ['"undefined"', 'a script timed out']);
      const bad = await run('await tab.title()\nawait nope()');
      assert.deepEqual([bad.ok, bad.error.name, bad.error.message], [false, 'ReferenceError', 'nope is not defined']);
      assert.match(bad.error.stack, /browser_script:3:/);
    } finally {
      session.end();
    }
  });

  // ---------------------------------------------------------------- the tool
}
