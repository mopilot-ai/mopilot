// MoMo "Gets it done" (shared/momoTasks/manager.ts, runs.ts, watching.ts): start on a chosen machine and agent, one result card, the read-only check, failures with fixes, retry caps, restart recovery, and watch rows in the groups.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupTasks, HARD_ATTEMPTS, MAX_WORKING, TaskRefusal } from '../shared/momoTasks/manager.ts';
import { ask, gate, HOME, machine, REPORT, tick, world } from './support/momoTaskItems/world.ts';

const refusal = (code: string) => (e: unknown) => e instanceof TaskRefusal && e.code === code;

const WATCH = {
  title: 'AWS invoice due today',
  doneMeans: 'Tell me when it changes',
  origin: 'matter' as const,
  watch: { kind: 'tool', tool: 'gmail.search', track: ['id', 'status'], everyMinutes: 30 },
};

test("a request starts a session on MoMo's home with a brief, and the item says where it runs", async () => {
  const { w, mgr } = world();
  const { item, error } = await mgr.create(ask);
  assert.equal(error, null);
  assert.deepEqual(
    [item.state, item.attempts, item.where, item.origin],
    ['working', 1, { machineId: 'home', harness: 'claude', sessionId: 'sess1', machineName: 'Studio' }, 'asked'],
  );
  assert.equal(item.startedAt, item.createdAt);
  const req = w.started[0];
  assert.deepEqual([req.machineId, req.harness, req.readOnly, req.gateOrigin, req.key], ['home', 'claude', false, 'task', `${item.id}:1`]);
  assert.ok(req.forbidTools.includes('create_task'));
  assert.match(req.brief, /Done means: Sheet has 200 seats/);
  assert.equal(w.cards.length, 0);
});

test('one task per request: the same stable key returns the first item and starts nothing', async () => {
  const { w, mgr } = world();
  const a = await mgr.create(ask);
  const b = await mgr.create({ ...ask, title: ` ${ask.title.toUpperCase()} ` });
  assert.equal(b.item.id, a.item.id);
  assert.equal(w.started.length, 1);
  const c = await mgr.create({ ...ask, stableKey: 'other' });
  assert.notEqual(c.item.id, a.item.id);
});

test('the rules: nothing inside a task makes more work, only the user begins a task, unprompted work only reads', async () => {
  const { w, mgr } = world();
  await assert.rejects(mgr.create({ ...ask, callerItemId: 'task1' }), refusal('nested'));
  await assert.rejects(mgr.create({ ...ask, userStarted: false }), refusal('not_user_started'));
  await assert.rejects(mgr.create({ ...ask, origin: 'suggestion', userStarted: undefined }), refusal('not_user_started'));
  await assert.rejects(mgr.create({ ...ask, title: '  ' }), refusal('bad_input'));
  await assert.rejects(mgr.create({ ...ask, doneMeans: '' }), refusal('bad_input'));
  assert.equal(w.started.length, 0);
  for (const origin of ['matter', 'routine'] as const) {
    await mgr.create({ title: `Look at ${origin}`, doneMeans: 'summary', origin });
    const req = w.started.at(-1)!;
    assert.deepEqual([req.readOnly, req.gateOrigin], [true, 'unprompted']);
    assert.match(req.brief, /read and report only/);
  }
  await mgr.create({ title: 'Suggested', doneMeans: 'd', origin: 'suggestion', userStarted: true });
  assert.deepEqual([w.started.at(-1)!.readOnly, w.started.at(-1)!.gateOrigin], [false, 'task']);
});

test('at most five tasks work at once; the sixth is told why and is not stored', async () => {
  const { w, mgr } = world();
  for (let i = 0; i < MAX_WORKING; i++) await mgr.create({ ...ask, title: `Job ${i}` });
  const sixth = await mgr.create({ ...ask, title: 'Job 6' });
  assert.equal(sixth.error?.code, 'too_many_active');
  assert.equal(w.started.length, MAX_WORKING);
  assert.equal((await mgr.list()).length, MAX_WORKING);
});

// every pairing of the home's agent with the agent the task runs on: the brief, limits and result handling do not depend on either
const AGENTS = ['claude', 'codex', 'acp:gemini'];
for (const homeAgent of AGENTS) {
  for (const target of AGENTS) {
    test(`mixed pair: MoMo's home runs ${homeAgent}, the task runs on ${target} on another machine`, async () => {
      const { w, mgr } = world({ home: { machineId: 'home', harness: homeAgent } });
      const { item } = await mgr.create({ ...ask, where: { machineId: 'mini', harness: target } });
      assert.deepEqual([w.started[0].machineId, w.started[0].harness], ['mini', target]);
      assert.equal(item.where.harness, target);
      const done = await mgr.onEvent('mini', item.where.sessionId as string, { kind: 'finished', report: REPORT });
      assert.equal(done?.state, 'done');
      assert.deepEqual([w.cards.length, w.cards[0].machineId, w.cards[0].files], [1, 'mini', ['Acme-quote.xlsx']]);
      assert.match(w.started[0].brief, /^Task: Build the Acme quote sheet\nDone means:/);
    });
  }
}

test('events from every harness adapter end the same way: usage limit, sign-out and an ordinary failure', async () => {
  const signals: [string, unknown, string | undefined, string][] = [
    ['claude', 'rate_limit', undefined, 'usage_limit'],
    ['codex', { usageLimitExceeded: {} }, undefined, 'usage_limit'],
    ['acp:gemini', undefined, 'Usage limit reached for today', 'usage_limit'],
    ['claude', 'authentication_failed', undefined, 'agent_signed_out'],
    ['codex', { unauthorized: {} }, undefined, 'agent_signed_out'],
    ['acp:gemini', undefined, undefined, 'session_failed'],
  ];
  for (const [harness, signal, message, code] of signals) {
    const { w, mgr } = world();
    const { item } = await mgr.create({ ...ask, where: { machineId: 'mini', harness } });
    const failed = await mgr.onEvent('mini', item.where.sessionId as string, { kind: 'failed', signal, message });
    assert.deepEqual([failed?.state, failed?.lastError?.code], ['failed', code], `${harness} ${code}`);
    assert.equal(failed?.progress, null);
    assert.equal(w.cards.length, 1);
    assert.equal(w.cards[0].state, 'failed');
    assert.equal(w.cards[0].summary, failed?.lastError?.message);
    assert.ok(w.cards[0].actions.includes('runElsewhere'));
  }
});

test('a finished task is checked read-only against done_means: a clear yes is done, with one card and the evidence', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const sid = item.where.sessionId as string;
  const done = await mgr.onEvent('home', sid, { kind: 'finished', report: REPORT });
  assert.deepEqual(
    [done?.state, done?.result?.met, done?.result?.checked, done?.lastError],
    ['done', true, 'opened the file, totals match', null],
  );
  assert.equal(done?.result?.summary, 'Built Acme-quote.xlsx for 200 seats.');
  assert.match(w.asked[0], /Done means: Sheet has 200 seats at \$48k/);
  assert.match(String(w.askedData[0]), /^Result: Built Acme-quote\.xlsx/);
  assert.deepEqual(
    [w.cards.length, w.cards[0].state, w.cards[0].untrusted, w.cards[0].actions, w.cards[0].evidence],
    [1, 'done', true, ['openSession'], 'opened it, totals match $48k.'],
  );
  assert.deepEqual([done?.settled, done?.posted], [1, 1]);
  // a replayed event never posts a second card or reopens the task
  assert.equal(await mgr.onEvent('home', sid, { kind: 'finished', report: REPORT }), null);
  assert.equal(w.cards.length, 1);
});

test('finished but not done, an unreadable check, or a check that fails: the user decides, never a default of done', async () => {
  const { w, mgr } = world();
  const a = await mgr.create(ask);
  w.answer = () => '{"met": false, "reason": "The total is $40k.", "checked": "read the totals"}';
  const unmet = await mgr.onEvent('home', a.item.where.sessionId as string, { kind: 'finished', report: REPORT });
  assert.deepEqual([unmet?.state, unmet?.result?.met, unmet?.progress], ['needs_you', false, 'Finished, but not done: The total is $40k.']);
  assert.match(unmet?.result?.summary as string, /^Finished, but not done: The total is \$40k\. Built Acme/);
  assert.deepEqual([w.cards[0].state, w.cards[0].actions], ['needs_you', ['review', 'openSession']]);

  const b = await mgr.create({ ...ask, title: 'B' });
  w.answer = () => 'I think it is fine';
  const garbled = await mgr.onEvent('home', b.item.where.sessionId as string, { kind: 'finished', report: 'just text' });
  assert.deepEqual([garbled?.state, garbled?.lastError?.code, garbled?.result?.summary], ['needs_you', 'check_failed', 'just text']);

  const c = await mgr.create({ ...ask, title: 'C' });
  w.answer = () => {
    throw new Error('model down');
  };
  const broke = await mgr.onEvent('home', c.item.where.sessionId as string, { kind: 'finished', report: REPORT });
  assert.deepEqual([broke?.state, broke?.progress], ['needs_you', "I couldn't check this result."]);
  assert.equal(w.cards.length, 3);
});

test('a result card the chat could not take stays owed and goes out on the next flush, once', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.postFails = 1;
  const done = await mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  assert.deepEqual([done?.state, done?.settled, done?.posted, w.cards.length], ['done', 1, 0, 0]);
  assert.equal(await mgr.flushCards(), 1);
  assert.equal(await mgr.flushCards(), 0);
  assert.deepEqual([w.cards.length, (await mgr.get(item.id))?.posted], [1, 1]);
});

test("the session's own steps: progress, a gate card that needs the user, and resuming when it is settled", async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const sid = item.where.sessionId as string;
  assert.equal(
    (await mgr.onEvent('home', sid, { kind: 'progress', line: 'Filling the pricing table' }))?.progress,
    'Filling the pricing table',
  );
  const waiting = await mgr.onEvent('home', sid, { kind: 'needs_you', line: 'Draft ready, waiting', cardId: 'card9' });
  assert.deepEqual([waiting?.state, waiting?.cardId, waiting?.progress], ['needs_you', 'card9', 'Draft ready, waiting']);
  assert.equal(w.cards.length, 0);
  // progress while waiting changes nothing
  assert.equal((await mgr.onEvent('home', sid, { kind: 'progress', line: 'x' }))?.progress, 'Draft ready, waiting');
  assert.equal((await mgr.onEvent('home', sid, { kind: 'resumed' }))?.state, 'working');
  // resumed with nothing to resume, and a wait with no card, change nothing
  assert.equal((await mgr.onEvent('home', sid, { kind: 'resumed' }))?.state, 'working');
  const bare = await mgr.onEvent('home', sid, { kind: 'needs_you', line: 'Waiting' });
  // a wait with no card id still holds a marker, so it cannot be started again and its report can still settle it
  assert.deepEqual([bare?.state, bare?.cardId], ['needs_you', `waiting:${sid}`]);
  assert.equal((await mgr.onEvent('home', sid, { kind: 'resumed' }))?.state, 'working');
  assert.equal(await mgr.onEvent('home', 'nobody', { kind: 'progress', line: 'x' }), null);
});

test('the start is blocked with the real cause and a fix, and the run is not counted', async () => {
  const cases: [string, Parameters<typeof machine>[2], string, string, string[]][] = [
    ['offline', { online: false }, 'machine_offline', 'Mac mini is offline.', ['retry', 'runElsewhere']],
    ['outdated', { outdated: true }, 'host_outdated', 'MoPilot on Mac mini is out of date.', ['update', 'runElsewhere']],
    ['agent missing', { agents: { claude: 'ready' } }, 'agent_missing', "Codex isn't installed on Mac mini.", ['install', 'runElsewhere']],
    ['signed out', { agents: { codex: 'signin' } }, 'agent_signed_out', 'Sign in to Codex on Mac mini.', ['signIn', 'runElsewhere']],
  ];
  for (const [name, over, code, message, actions] of cases) {
    const { w, mgr } = world({ machines: [machine('home', 'Studio'), machine('mini', 'Mac mini', over), machine('mac', 'This Mac')] });
    const { item, error } = await mgr.create({ ...ask, where: { machineId: 'mini', harness: 'codex' } });
    assert.deepEqual([item.state, item.attempts, error?.code, error?.message], ['failed', 0, code, message], name);
    assert.deepEqual([...new Set(error?.fixes.map((x) => x.action))], actions, name);
    assert.equal(w.started.length, 0);
    assert.deepEqual([w.cards.length, w.cards[0].state, w.cards[0].actions], [1, 'failed', actions], name);
  }
  // the fix for a missing agent names the machine; running elsewhere names a machine where Codex is ready
  const { mgr } = world({ machines: [machine('home', 'Studio'), machine('mini', 'Mac mini', { agents: { claude: 'ready' } })] });
  const { error } = await mgr.create({ ...ask, where: { machineId: 'mini', harness: 'codex' } });
  assert.deepEqual(
    error?.fixes.map((x) => [x.label, x.machineId]),
    [
      ['Install Codex on Mac mini', 'mini'],
      ['Run on Studio', 'home'],
    ],
  );
});

test('the Host refuses the start, or cannot be reached: the failure carries the refusal words', async () => {
  const { w, mgr } = world();
  w.startOutcome = () => ({ ok: false, code: 'login_limited' });
  const limited = await mgr.create(ask);
  assert.deepEqual([limited.error?.code, limited.error?.retry, limited.item.state], ['usage_limit', true, 'failed']);
  w.startOutcome = () => ({ ok: false, code: 'something_new', message: 'Disk is full' });
  assert.equal((await mgr.create({ ...ask, title: 'B' })).error?.message, 'Disk is full');
  w.startOutcome = () => {
    throw new Error('socket closed');
  };
  const dropped = await mgr.create({ ...ask, title: 'C' });
  assert.deepEqual([dropped.error?.code, dropped.item.attempts], ['machine_offline', 0]);
  w.startOutcome = () => {
    throw 'plain';
  };
  assert.equal((await mgr.create({ ...ask, title: 'D' })).error?.code, 'machine_offline');
});

test("a retry is the user's and counts: one run plus two retries, then the cap says so and offers another machine", async () => {
  const { w, mgr } = world();
  let { item } = await mgr.create(ask);
  for (let run = 1; run <= 3; run++) {
    assert.equal(item.attempts, run);
    const failed = await mgr.onEvent('home', item.where.sessionId as string, { kind: 'failed', message: `different problem ${run}` });
    assert.equal(failed?.state, 'failed');
    if (run < 3) item = (await mgr.retry(item.id)).item;
  }
  assert.equal(w.started.length, 3);
  assert.deepEqual(
    w.started.map((r) => r.key),
    [1, 2, 3].map((n) => `${item.id}:${n}`),
  );
  const capped = await mgr.retry(item.id);
  assert.deepEqual([capped.error?.code, capped.item.state, capped.item.attempts, w.started.length], ['retry_cap', 'failed', 3, 3]);
  assert.match(capped.error?.message as string, /already run 3 times/);
  // running it on another machine earns one more round, once, and never beyond the hard ceiling
  const moved = await mgr.retry(item.id, { machineId: 'mini', harness: 'codex' });
  assert.deepEqual([moved.item.state, moved.item.where.machineId, moved.item.attempts, moved.item.attemptCap], ['working', 'mini', 4, 6]);
  for (let run = 5; run <= HARD_ATTEMPTS; run++) {
    await mgr.onEvent('mini', (await mgr.get(item.id))?.where.sessionId as string, { kind: 'failed', message: `p${run}` });
    await mgr.retry(item.id);
  }
  await mgr.onEvent('mini', (await mgr.get(item.id))?.where.sessionId as string, { kind: 'failed', message: 'last' });
  const again = await mgr.retry(item.id, { machineId: 'mac', harness: 'claude' });
  assert.deepEqual([again.item.attemptCap, again.error?.code], [HARD_ATTEMPTS, 'retry_cap']);
});

test('the same failure twice stops offering Retry on that machine; another machine is allowed', async () => {
  const { w, mgr } = world();
  const first = await mgr.create(ask);
  await mgr.onEvent('home', first.item.where.sessionId as string, { kind: 'failed', message: 'cannot write the file' });
  const second = await mgr.retry(first.item.id);
  const twice = await mgr.onEvent('home', second.item.where.sessionId as string, { kind: 'failed', message: 'cannot write the file' });
  assert.equal(twice?.lastError?.code, 'same_failure');
  assert.deepEqual([...new Set(twice?.lastError?.fixes.map((x) => x.action))], ['runElsewhere']);
  await assert.rejects(mgr.retry(first.item.id), refusal('same_failure'));
  const moved = await mgr.retry(first.item.id, { machineId: 'mini', harness: 'claude' });
  assert.deepEqual([moved.item.state, moved.item.lastError, moved.item.where.machineId], ['working', null, 'mini']);
  assert.equal(w.started.length, 3);
  // choosing the machine it is already on is not a move
  await mgr.onEvent('mini', moved.item.where.sessionId as string, { kind: 'failed', message: 'other' });
  assert.equal((await mgr.retry(first.item.id, { machineId: 'mini', harness: 'claude' })).item.attemptCap, 3 + 3);
});

test('misuse of start is refused and changes nothing', async () => {
  const { mgr } = world();
  await assert.rejects(mgr.start('nope'), refusal('unknown_item'));
  const { item } = await mgr.create(ask);
  await assert.rejects(mgr.start(item.id), refusal('bad_state'));
  await mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  await assert.rejects(mgr.retry(item.id), refusal('bad_state'));
  await assert.rejects(mgr.stop(item.id), refusal('bad_state'));
  await assert.rejects(mgr.stop('nope'), refusal('unknown_item'));
});

test('a task that finished "not done" can be retried by the user', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.answer = () => '{"met": false, "reason": "short", "checked": "c"}';
  await mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  w.answer = () => '{"met": true, "reason": "ok", "checked": "c"}';
  const again = await mgr.retry(item.id);
  assert.deepEqual([again.item.state, again.item.attempts, again.item.result], ['working', 2, null]);
});

test('Stop: the item is stopped first, its session stopped, and late events never revive it', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const sid = item.where.sessionId as string;
  const stopped = await mgr.stop(item.id);
  assert.deepEqual(
    [stopped.state, stopped.lastError?.code, stopped.lastError?.message],
    ['stopped', 'stopped_by_user', 'You stopped this task. Files already made are kept.'],
  );
  assert.deepEqual(w.stopped, [['home', sid]]);
  assert.equal(await mgr.onEvent('home', sid, { kind: 'finished', report: REPORT }), null);
  assert.equal((await mgr.get(item.id))?.state, 'stopped');
  assert.equal(w.cards.length, 0);
  // the machine cannot be reached to stop the session: the item is still stopped, and says so
  const b = await mgr.create({ ...ask, title: 'B' });
  w.stopThrows = true;
  assert.match((await mgr.stop(b.item.id)).lastError?.message as string, /couldn't reach Studio to stop its session/);
  // a stopped task may be started again by the user
  w.stopThrows = false;
  assert.equal((await mgr.retry(item.id)).item.state, 'working');
});

test('a start that finishes after Stop leaves the item stopped', async () => {
  const { w, mgr, store } = world();
  let release!: () => void;
  const hold = new Promise<void>((r) => (release = r));
  w.startOutcome = async () => (await hold, { ok: true, sessionId: 'slow' });
  const pending = mgr.create(ask);
  await new Promise((r) => setImmediate(r));
  const [item] = await store.list();
  await mgr.stop(item.id);
  release();
  assert.equal((await pending).item.state, 'stopped');
  assert.equal((await store.get(item.id))?.where.sessionId, null);
});

test('the Tasks groups: needs you (waiting and failed today), working, watching and done today', async () => {
  const { w, mgr, advance } = world();
  const wait = await mgr.create({ ...ask, title: 'wait' });
  await mgr.onEvent('home', wait.item.where.sessionId as string, { kind: 'needs_you', line: 'Review', cardId: 'c' });
  const work = await mgr.create({ ...ask, title: 'work' });
  const failed = await mgr.create({ ...ask, title: 'failed' });
  await mgr.onEvent('home', failed.item.where.sessionId as string, { kind: 'failed', message: 'x' });
  const done = await mgr.create({ ...ask, title: 'done' });
  await mgr.onEvent('home', done.item.where.sessionId as string, { kind: 'finished', report: REPORT });
  const stopped = await mgr.create({ ...ask, title: 'stopped' });
  await mgr.stop(stopped.item.id);
  const watch = await mgr.createWatch(WATCH);
  const dayStart = Date.parse('2026-11-23T00:00:00Z');
  const groups = groupTasks(await mgr.list(), dayStart);
  assert.deepEqual(groups.needsYou.map((i) => i.title).sort(), ['failed', 'wait']);
  assert.deepEqual([groups.working[0].id, groups.watching[0].id, groups.doneToday[0].id], [work.item.id, watch.id, done.item.id]);
  assert.equal(w.cards.length, 2);
  advance(24 * 3_600_000);
  const tomorrow = groupTasks(await mgr.list(), dayStart + 24 * 3_600_000);
  assert.deepEqual([tomorrow.doneToday.length, tomorrow.needsYou.map((i) => i.title)], [0, ['wait']]);
  // newest first
  const sorted = groupTasks(
    [
      { ...done.item, state: 'done', updatedAt: dayStart + 5 },
      { ...done.item, id: 'z', state: 'done', updatedAt: dayStart + 9 },
    ],
    dayStart,
  );
  assert.deepEqual(
    sorted.doneToday.map((i) => i.id),
    ['z', done.item.id],
  );
});

test('Reset MoMo through the manager deletes every task', async () => {
  const { mgr } = world();
  await mgr.create(ask);
  await mgr.reset();
  assert.deepEqual(await mgr.list(), []);
});

test("a home with no agent chosen yet and the default pairing: MoMo's home is the default and the picker may name any machine", async () => {
  const { w, mgr } = world({ home: HOME });
  const a = await mgr.create(ask);
  const b = await mgr.create({ ...ask, title: 'other', where: { machineId: 'mac', harness: 'codex' } });
  assert.deepEqual([a.item.where.machineId, b.item.where.machineId, w.started.map((r) => r.machineId)], ['home', 'mac', ['home', 'mac']]);
});

test('a machine that is no longer in the list is named by its id, and the task says it is gone', async () => {
  const { w, mgr } = world();
  const { item, error } = await mgr.create({ ...ask, where: { machineId: 'removed', harness: 'claude' } });
  assert.deepEqual(
    [item.state, error?.code, error?.message],
    ['failed', 'machine_offline', "removed isn't one of your machines any more."],
  );
  const running = await mgr.create({ ...ask, title: 'on a machine that then goes away' });
  w.machines = [];
  assert.match((await mgr.stop(running.item.id)).lastError?.message as string, /^You stopped this task/);
});

test('the same card is never delivered twice by two flushes at once', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  w.postFails = 1;
  await mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  const [a, b] = await Promise.all([mgr.flushCards(), mgr.flushCards()]);
  assert.deepEqual([a + b, w.cards.length], [1, 1]);
});

test('the Host refuses a start the user already stopped: the task stays stopped, with no card', async () => {
  const { w, mgr, store } = world();
  const g = gate();
  w.startOutcome = async () => (await g.hold, { ok: false, code: 'login_limited' });
  const pending = mgr.create(ask);
  await tick();
  const [item] = await store.list();
  await mgr.stop(item.id);
  g.release();
  const { item: after } = await pending;
  assert.deepEqual([after.state, w.cards.length], ['stopped', 0]);
});

test('the check finishes after the user stopped the task: nothing is recorded and no card goes out', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const g = gate();
  w.answer = async () => (await g.hold, '{"met": true, "reason": "ok", "checked": "c"}');
  const finishing = mgr.onEvent('home', item.where.sessionId as string, { kind: 'finished', report: REPORT });
  await tick();
  await mgr.stop(item.id);
  g.release();
  assert.equal((await finishing)?.state, 'stopped');
  assert.equal(w.cards.length, 0);
});

test('a replayed "finished" after a not-done check, and one for a task waiting on a card, are not checked twice', async () => {
  const { w, mgr } = world();
  const { item } = await mgr.create(ask);
  const sid = item.where.sessionId as string;
  w.answer = () => '{"met": false, "reason": "short", "checked": "c"}';
  await mgr.onEvent('home', sid, { kind: 'finished', report: REPORT });
  const replay = await mgr.onEvent('home', sid, { kind: 'finished', report: REPORT });
  assert.deepEqual([replay?.settled, w.cards.length], [1, 1]);
  // a task waiting on a gate card whose session finished while MoMo was away is checked after the restart
  const b = await mgr.create({ ...ask, title: 'B' });
  await mgr.onEvent('home', b.item.where.sessionId as string, { kind: 'needs_you', line: 'Draft', cardId: 'c' });
  w.answer = () => '{"met": true, "reason": "ok", "checked": "c"}';
  w.probes.set(`home/${b.item.where.sessionId}`, { state: 'finished', report: REPORT });
  assert.equal((await mgr.recover()).finished, 1);
  assert.equal((await mgr.get(b.item.id))?.state, 'done');
});
