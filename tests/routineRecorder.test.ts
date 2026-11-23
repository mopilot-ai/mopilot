// Action memory's recorder (#3571, G4; electron/capabilities/routines/routineRecorder.cjs): only acting browser tools
// are wrapped, each call's target is anchored before it runs and kept once it succeeded, a completed turn becomes the
// chat's last turn while a stopped or failed one keeps nothing, and a run of a routine never changes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { routineKit, recordSearchTurn, SEARCH, GO, ADD, memorySealed } from './support/routine-kit.ts';

const require = createRequire(import.meta.url);
const { RoutineRecorder, RECORDED } = require('../electron/capabilities/routines/routineRecorder.cjs');
const { RoutineStore, MAX_STEPS } = require('../electron/capabilities/routines/routineStore.cjs');
const S = require('../electron/capabilities/routines/routineSteps.cjs');

const controls = [SEARCH, GO, ADD];

test('wrap: only the browser tools a recording reads; the rest pass through as they are', () => {
  const r = new RoutineRecorder({ store: null });
  const read = { name: 'browser_find', handler: () => 'x' };
  assert.equal(r.wrap(read), read);
  assert.ok(RECORDED.has('browser_computer'));
  const act = { name: 'browser_computer', handler: () => 'x', policy: 'act' };
  const wrapped = r.wrap(act);
  assert.notEqual(wrapped, act);
  assert.equal(wrapped.policy, 'act');
});

test('a completed turn: its acting steps with anchors and the page each ran on, never refs; reads left out', async () => {
  const k = routineKit({ controls });
  const out = await recordSearchTurn(k);
  assert.deepEqual(out, { offer: true });
  const steps = k.recorder.lastTurn('chat1').steps;
  assert.deepEqual(
    steps.map((s: any) => [s.tool, s.args.action ?? s.args.url, s.target?.steps.at(-1).name.s]),
    [
      ['browser_navigate', 'https://shop.test/', undefined],
      ['browser_computer', 'left_click', 'Search'],
      ['browser_computer', 'type', undefined],
      ['browser_computer', 'left_click', 'Go'],
      ['browser_computer', 'left_click', 'Add to cart'],
    ],
  );
  assert.ok(!JSON.stringify(steps).includes('ref_'), 'no ref is kept');
  assert.deepEqual(steps[1].page, { origin: 'https://shop.test', path: '/' });
});

test('a stopped, crashed or failed turn keeps nothing, and drops an earlier last turn; a turn with no browser steps keeps it', async () => {
  const k = routineKit({ controls });
  await recordSearchTurn(k);
  assert.deepEqual(k.end('chat1', true), { offer: false }, 'a turn with no browser call');
  assert.ok(k.recorder.lastTurn('chat1'), 'an empty turn leaves the last one');
  await k.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  assert.deepEqual(k.end('chat1', false), { offer: false });
  assert.equal(k.recorder.lastTurn('chat1'), null);
  // a call that failed last: the turn is not verified
  const f = routineKit({ controls, fail: (_t, a) => (a.ref === GO.ref ? 'The site is blocked' : null) });
  await f.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  const res = await f.call('browser_computer', { action: 'left_click', ref: GO.ref });
  assert.equal(res.ok, false);
  assert.deepEqual(f.end('chat1', true), { offer: false });
  // a failure the model recovered from (a later success) does not count against the turn
  await f.call('browser_computer', { action: 'left_click', ref: GO.ref });
  await f.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  await f.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  await f.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  assert.equal(f.end('chat1', true).offer, true);
});

test('recording never keeps a call from running: no tabs yet, no chat, an anchor that throws', async () => {
  const store = new RoutineStore({ sealed: memorySealed() });
  const r = new RoutineRecorder({ store });
  const calls: string[] = [];
  const tool = r.wrap({ name: 'browser_computer', handler: async () => (calls.push('ran'), 'ok') });
  assert.equal(await tool.handler({ action: 'left_click', ref: 'ref_1' }, { chatId: 'c' }), 'ok', 'no browser tabs yet');
  assert.equal(await tool.handler({}, {}), 'ok', 'no chat');
  r.recording(
    { register: (t: any) => t },
    {
      current: () => {
        throw new Error('tabs broke');
      },
    },
  );
  assert.equal(await tool.handler({ action: 'left_click', ref: 'ref_1' }, { chatId: 'c' }), 'ok', 'an anchor that throws');
  assert.equal(r.turns.get('c').steps[0].target, null);
  assert.equal(await tool.handler({ action: 'key', text: 'a' }, { chatId: 'c' }), 'ok', 'a url read that throws');
  assert.equal(calls.length, 4);
});

test('recording(): the registry proxy wraps what registers and passes everything else through, bound', () => {
  const r = new RoutineRecorder({ store: null });
  const seen: any[] = [];
  const registry = {
    tag: 'reg',
    register(t: any) {
      seen.push(t);
      return () => {};
    },
    has(this: any, n: string) {
      return `${this.tag}:${n}`;
    },
  };
  const tabs = {};
  const p = r.recording(registry, tabs);
  assert.equal(r.adapter('browser_').up(), true);
  p.register({ name: 'browser_navigate', handler: () => 1 });
  assert.notEqual(seen[0].handler, undefined);
  assert.equal(p.has('x'), 'reg:x');
  assert.equal(p.tag, 'reg');
});

test('a turn longer than a routine may be is not offered', async () => {
  const k = routineKit({ controls });
  for (let i = 0; i <= MAX_STEPS; i++) await k.call('browser_computer', { action: 'key', text: 'a' });
  assert.deepEqual(k.end(), { offer: false });
});

test('a run of a routine never changes it: after a hand-off and a completed turn its steps, params and rev are as they were', async () => {
  const k = routineKit({ controls });
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy' });
  k.end();
  const rec = k.recorder;
  const shape = () => {
    const { steps, params, rev } = k.store.get('Buy');
    return JSON.stringify({ steps, params, rev });
  };
  const before = shape();
  const doNothing = () => {};
  const unrelated = () => k.call('browser_navigate', { url: 'https://elsewhere.test/' });
  const acts = () => k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  for (const during of [doNothing, unrelated, acts]) {
    rec.replayStarted('chat1');
    rec.replayEnded('chat1', { failed: false });
    await during();
    const out = k.end();
    assert.equal(Object.hasOwn(out, 'updated'), false);
    assert.equal(out.offer, false, 'a turn in which a routine ran offers nothing');
    assert.equal(rec.lastTurn('chat1'), null, 'and keeps nothing');
    assert.equal(shape(), before);
  }
  assert.equal(k.store.get('Buy').steps.length, 5, 'including its acting steps');
});

test('a run that did not finish leaves the turn unverified; a stopped turn after a run changes nothing', async () => {
  const k = routineKit({ controls });
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy' });
  k.end();
  const shape = () => {
    const { steps, params, rev } = k.store.get('Buy');
    return JSON.stringify({ steps, params, rev });
  };
  const before = shape();
  const rec = k.recorder;
  rec.replayStarted('chat1');
  rec.replayEnded('chat1', { failed: true });
  assert.equal(rec.replaying.has('chat1'), false);
  assert.deepEqual(k.end(), { offer: false });
  rec.replayStarted('chat1');
  rec.replayEnded('chat1', { failed: false });
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  assert.deepEqual(k.end('chat1', false), { offer: false });
  assert.equal(shape(), before);
});

test('forget: a deleted chat keeps nothing', async () => {
  const k = routineKit({ controls });
  await recordSearchTurn(k);
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  k.recorder.replaying.add('chat1');
  k.recorder.forget('chat1');
  assert.equal(k.recorder.lastTurn('chat1'), null);
  assert.equal(k.recorder.turns.has('chat1'), false);
  assert.equal(k.recorder.replaying.has('chat1'), false);
});

test('a read that fails leaves the turn and earlier parts as they are; a read that works does not undo a failed action', async () => {
  let readFails = false;
  const k = routineKit({
    controls,
    fail: (t, a) => (t === 'browser_read_page' && readFails ? 'the tab is blank' : a.ref === GO.ref ? 'refused' : null),
  });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  k.end();
  readFails = true;
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  assert.equal((await k.call('browser_read_page', { filter: 'all' })).ok, false);
  k.end();
  assert.equal(k.recorder.lastTurn('chat1').steps.length, 2, 'both turns kept');
  readFails = false;
  await k.call('browser_computer', { action: 'left_click', ref: GO.ref });
  await k.call('browser_read_page', { filter: 'all' });
  k.end();
  assert.equal(k.recorder.lastTurn('chat1'), null, 'the failed action still fails the turn');
});

test('a script that failed may have done part of its work: the routine keeps a step that hands off there, however the turn went on', async () => {
  const k = routineKit({ controls, fail: (t, a) => (t === 'browser_script' && a.code === 'fill' ? 'Timed out' : null) });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  // the form was filled before it timed out; the next call submits it
  assert.equal((await k.call('browser_script', { code: 'fill' })).ok, false);
  await k.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  k.end();
  const steps = k.recorder.lastTurn('chat1')?.steps ?? [];
  assert.deepEqual(
    steps.map((s: any) => [s.tool, !!s.failed]),
    [
      ['browser_navigate', false],
      ['browser_script', true],
      ['browser_computer', false],
    ],
  );
  assert.deepEqual(steps[1].args, {}, 'nothing of the failed call is kept');
  assert.equal(steps[1].unsupported, true);
  // a replay stops at the submit, and its plan says the step right before it failed
  await k.call('routine_save', { name: 'Fill', description: 'Fills a form.' });
  k.did.length = 0;
  const out = JSON.stringify(await k.call('routine_run', { routine: 'Fill' }, 'chat2', 'claude:s2'));
  assert.deepEqual(
    k.did.map(([t]: any[]) => t),
    ['browser_navigate'],
  );
  assert.match(out, /failed when it was recorded/);
  assert.match(out, /2\. script \(failed when it was recorded, and may have done part of its work\)/);
  assert.match(out, /3\. left_click/);
});

test('a desktop script that says it failed, without throwing, keeps the same step; one that worked is kept as it ran', async () => {
  const r = new RoutineRecorder({ store: { list: () => [] } as any });
  const said = (effect: string) => [{ type: 'text', text: `${JSON.stringify({ action: 'script', effect })}\nThe script said so` }];
  r.adapters.set('desktop_', { up: () => true, url: () => null, anchorsBefore: async () => ({ anchors: new Map(), url: null }) } as any);
  let effect = 'failed';
  const tool = r.wrap({ name: 'desktop_app_script', handler: async () => said(effect) });
  assert.deepEqual(
    await tool.handler({ app: 'Notes', script: 'x' }, { chatId: 'c' }),
    said('failed'),
    'its result still reaches the model',
  );
  effect = 'confirmed';
  await tool.handler({ app: 'Notes', script: 'y' }, { chatId: 'c' });
  r.turnFinished('c', true);
  assert.deepEqual(
    r.lastTurn('c')?.steps.map((s: any) => [s.args.script ?? null, !!s.failed]),
    [
      [null, true],
      ['y', false],
    ],
  );
});

test('reportedFailure: only an action record that says so', () => {
  const { reportedFailure } = S;
  assert.equal(reportedFailure([{ type: 'text', text: '{"effect":"failed"}\nwhy' }]), true);
  for (const out of [
    [{ type: 'text', text: '{"effect":"confirmed"}' }],
    [{ type: 'text', text: 'Script finished' }],
    [{ type: 'image' }],
    [],
    'text',
    null,
  ])
    assert.equal(reportedFailure(out), false);
});

test('a replayed script that fails: the hand-off says so, and the routine is not changed by what the model does next', async () => {
  let failing = false;
  const k = routineKit({ controls, fail: (t, a) => (failing && t === 'browser_script' && a.code === 'fill' ? 'Timed out' : null) });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_script', { code: 'fill' });
  await k.call('browser_computer', { action: 'left_click', ref: SEARCH.ref });
  k.end();
  await k.call('routine_save', { name: 'Fill', description: 'Fills a form.' });
  const shape = () => {
    const { steps, params, rev } = k.store.list()[0];
    return JSON.stringify({ steps, params, rev });
  };
  const before = shape();
  failing = true;
  const out = JSON.stringify(await k.call('routine_run', { routine: 'Fill' }, 'chat2', 'claude:s2'));
  assert.match(out, /it failed: /);
  // the model finishes the task, and the turn completes
  await k.call('browser_computer', { action: 'left_click', ref: SEARCH.ref }, 'chat2', 'claude:s2');
  k.end('chat2');
  assert.equal(shape(), before);
});
