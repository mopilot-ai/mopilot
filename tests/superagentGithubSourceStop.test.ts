// Superagent GitHub source: stop() retires the pending timer and every in-flight await; a backoff outlives stop()/start().
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitFor } from './support/waitFor.ts';
import src from '../electron/superagent/sources/github.cjs';
import { API, NOTES, SINCE0, commentsUrl, note, issueBody, commentBody, rig } from './support/superagentGithubRig.ts';
import type { Res } from './support/superagentGithubRig.ts';

test('start twice is one poll; stop then start resumes', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [] });
  r.source.start();
  r.source.start();
  assert.equal(r.timers.length, 1);
  r.source.stop();
  r.source.stop();
  assert.equal(r.timers.length, 0);
  r.source.start();
  assert.equal(r.timers.length, 1);
  await r.fire();
  assert.equal(r.timers.length, 1);
});

test('stop() clears the pending timer, and a timer that fires late does nothing', async () => {
  const r = rig();
  r.routes.set(NOTES, { body: [] });
  r.source.start();
  const late = r.timers[0];
  r.source.stop();
  assert.deepEqual(r.cleared, [late.id]);
  await late.fn();
  assert.equal(r.calls.length, 0);
});

test('stop() during each await publishes nothing and schedules nothing', async () => {
  const gates: Record<string, () => void> = {};
  const gate = (name: string) => () => new Promise<Res>((res) => (gates[name] = () => res({ body: [] })));
  for (const stage of ['notes', 'issue', 'comment', 'review', 'second']) {
    const r = rig();
    const pr = `${API}/repos/o/r/pulls/7`;
    const noteBody = (n: number) => note(n, {}, { type: 'PullRequest', url: n === 7 ? pr : `${API}/repos/o/r/pulls/${n}` });
    r.routes.set(NOTES, stage === 'notes' ? gate('notes') : { body: [noteBody(7), noteBody(8)] });
    r.routes.set(pr, stage === 'issue' ? gate('issue') : { body: { ...issueBody(7), node_id: 'PR_7' } });
    r.routes.set(commentsUrl(7), stage === 'comment' ? gate('comment') : { body: [commentBody('IC_1')] });
    r.routes.set(
      `${pr}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`,
      stage === 'review' ? gate('review') : { body: [commentBody('RC_1')] },
    );
    r.routes.set(`${API}/repos/o/r/pulls/8`, stage === 'second' ? gate('second') : { body: { ...issueBody(8), node_id: 'PR_8' } });
    r.routes.set(`${API}/repos/o/r/pulls/8/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`, { body: [] });
    r.source.start();
    const done = r.fire();
    await waitFor(() => gates[stage], `the ${stage} request to be pending`);
    const before = r.events.length;
    r.source.stop();
    gates[stage]?.();
    await done;
    assert.equal(r.events.length, before, stage);
    assert.equal(r.timers.length, 0, stage);
    assert.equal(r.stored.has('github-notifications:o/r'), false, stage);
    assert.deepEqual(r.statuses, [], stage);
  }
});

test('stop() while the token is read, or while a fetch fails, starts and reports nothing', async () => {
  let release!: () => void;
  const timers: any[] = [];
  const calls: string[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async () => {
      calls.push('f');
      throw new Error('late');
    },
    now: () => 10_000,
    setTimer: (fn: any) => timers.push(fn),
    clearTimer: () => {},
    getToken: () => new Promise((res) => (release = () => res('t'))),
    store: { get: () => undefined, set: () => {} },
    emit: () => {},
    onStatus: () => assert.fail('no status after stop'),
  });
  s.start();
  const run = timers.pop()();
  await waitFor(() => release, 'the token read to be pending');
  s.stop();
  release();
  await run;
  assert.deepEqual(calls, []);
  // stop while fetch rejects
  let fail!: () => void;
  const t2: any[] = [];
  const s2 = src.createGithubSource({
    repo: 'o/r',
    fetch: () => new Promise((_, rej) => (fail = () => rej(new Error('x')))),
    now: () => 10_000,
    setTimer: (fn: any) => t2.push(fn),
    clearTimer: () => {},
    getToken: async () => 't',
    store: { get: () => undefined, set: () => {} },
    emit: () => {},
    onStatus: () => assert.fail('no status after stop'),
  });
  s2.start();
  const run2 = t2.pop()();
  await waitFor(() => fail, 'the fetch to be pending');
  s2.stop();
  fail();
  await run2;
  assert.equal(t2.length, 0);
});

test('stop() while the cursor is read ends quietly', async () => {
  let release!: () => void;
  const t: any[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async () => assert.fail('no fetch'),
    now: () => 10_000,
    setTimer: (fn: any) => t.push(fn),
    clearTimer: () => {},
    getToken: async () => 't',
    store: { get: () => new Promise((res) => (release = () => res(undefined))), set: () => {} },
    emit: () => {},
  });
  s.start();
  const run = t.pop()();
  await waitFor(() => release, 'the cursor read to be pending');
  s.stop();
  release();
  await run;
  assert.equal(t.length, 0);
});

test('a 304 stopped before its cursor write schedules and reports nothing', async () => {
  const t: any[] = [];
  let finish!: () => void;
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async () => ({ status: 304, ok: false, headers: { get: (k: string) => (k === 'x-poll-interval' ? '300' : null) } }),
    now: () => 10_000,
    setTimer: (fn: any) => t.push(fn),
    clearTimer: () => {},
    getToken: async () => 't',
    store: { get: () => ({ pollMs: 60_000 }), set: () => new Promise<void>((res) => (finish = res)) },
    emit: () => {},
    onStatus: () => assert.fail('no status after stop'),
  });
  s.start();
  const run = t.pop()();
  await waitFor(() => finish, 'the cursor write to be pending');
  s.stop();
  finish();
  await run;
  assert.equal(t.length, 0);
});

test('a backoff survives stop and start', async () => {
  let now = 10_000;
  const t: { fn: () => any; ms: number }[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: async () => ({ status: 429, ok: false, headers: { get: (k: string) => (k === 'retry-after' ? '900' : null) } }),
    now: () => now,
    setTimer: (fn: any, ms: number) => t.push({ fn, ms }),
    clearTimer: () => {},
    getToken: async () => 't',
    store: { get: () => undefined, set: () => {} },
    emit: () => {},
  });
  s.start();
  await t.pop()!.fn();
  assert.equal(t[0].ms, 900_000);
  t.length = 0;
  now += 100_000;
  s.stop();
  s.start();
  assert.equal(t[0].ms, 800_000);
});

/** Every async boundary of a full poll (token, request, body, cursor read/write, emit), blocked one at a time. */
async function stoppedAt(k: number, mode: 'ok' | 'fail') {
  const pr = `${API}/repos/o/r/pulls/7`;
  const page2 = `${API}/repos/o/r/notifications?page=2`;
  const reviews = `${pr}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`;
  const bodies = new Map<string, { headers?: Record<string, string>; body: any }>([
    [
      NOTES,
      {
        headers: { link: `<${page2}>; rel="next"`, etag: 'e' },
        body: [note(7, {}, { type: 'PullRequest', url: pr })],
      },
    ],
    [page2, { body: [note(9)] }],
    [pr, { body: { ...issueBody(7), node_id: 'PR_7' } }],
    [commentsUrl(7), { body: [commentBody('IC_1')] }],
    [reviews, { headers: { link: `<${pr}/comments?page=2>; rel="next"` }, body: [commentBody('RC_1')] }],
    [`${pr}/comments?page=2`, { body: [commentBody('RC_2')] }],
    [`${API}/repos/o/r/issues/9`, { body: issueBody(9) }],
  ]);
  let boundary = 0;
  let release: () => void = () => {};
  let afterStop = 0;
  let stopped = false;
  let reached = false;
  const hit = <T>(value: () => T): Promise<T> => {
    if (stopped) afterStop++;
    if (boundary++ !== k) return Promise.resolve(value());
    reached = true;
    return new Promise<T>((res, rej) => {
      release = () => (mode === 'ok' ? res(value()) : rej(new Error('late failure')));
    });
  };
  const timers: any[] = [];
  const statuses: any[] = [];
  const s = src.createGithubSource({
    repo: 'o/r',
    fetch: (url: string) =>
      hit(() => {
        const r = bodies.get(url);
        const headers = r?.headers ?? {};
        return { status: r ? 200 : 404, ok: !!r, headers: { get: (h: string) => headers[h] ?? null }, json: () => hit(() => r?.body) };
      }),
    now: () => 10_000,
    setTimer: (fn: any) => timers.push(fn),
    clearTimer: () => {},
    getToken: () => hit(() => 't'),
    store: { get: () => hit(() => undefined), set: () => hit(() => undefined) },
    emit: () => hit(() => undefined),
    onStatus: (st: any) => statuses.push(st),
    log: () => {},
  });
  s.start();
  const done = timers.pop()();
  await waitFor(() => reached || undefined, 'the gate', { timeoutMs: 50 }).catch(() => {});
  if (!reached) {
    await done;
    return { reached: false, afterStop: 0, statuses, timers };
  }
  s.stop();
  stopped = true;
  release();
  await done;
  return { reached: true, afterStop, statuses, timers };
}

test('stopping at any await of a full poll leaves no request, write, emit, status or timer behind', async () => {
  for (const mode of ['ok', 'fail'] as const) {
    let k = 0;
    for (; ; k++) {
      const r = await stoppedAt(k, mode);
      if (!r.reached) break;
      assert.equal(r.afterStop, 0, `${mode} ${k}: nothing after stop()`);
      assert.deepEqual(r.statuses, [], `${mode} ${k}`);
      assert.equal(r.timers.length, 0, `${mode} ${k}`);
    }
    assert.ok(k > 20, 'the sweep covered the whole poll');
  }
});
