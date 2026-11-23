// Real-volume push counts under the rules that align the phone push with Claude's (#3986): a linked child's finish is silent,
// a finished chat pushes only where its switch was turned on, nothing is pushed at the Mac, and a need left unanswered still is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { useFakeClock } from './support/ports/clock.ts';

const require = createRequire(import.meta.url);
const { Notifier } = require('../electron/platform/notify.cjs');
const { createPushRequests, AWAY_AFTER_MS, RECHECK_MS } = require('../electron/platform/notifyPush.cjs');

type Opts = { child?: boolean; kinds?: Record<string, boolean>; idle?: () => number | null };

function rig(o: Opts, clock: { now(): number }) {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r), getKinds: () => o.kinds ?? {}, idleMs: o.idle });
  const n = new Notifier({
    getMode: () => 'always',
    isFocused: () => false,
    now: clock.now,
    show: () => ({ close() {} }),
    onBanner: push.onBanner,
    isLinkedChild: (id: string) => !!o.child && id.includes('-c'),
  });
  n.onSettled = push.cancel;
  return { n, reqs };
}

/** 2 parents with 4 children each; every child finishes twice (a retry); child pa-c1 needs approval twice (the first is answered); each parent finishes once; a lone chat finishes. */
function scenario(o: Opts, clock: { now(): number; advance(ms: number): void }) {
  const { n, reqs } = rig(o, clock);
  const tick = () => clock.advance(5 * 60_000);
  for (const p of ['pa', 'pb'])
    for (const i of [1, 2, 3, 4])
      for (let retry = 0; retry < 2; retry++) {
        n.notify('turn', `${p}-c${i}`, { title: 'child' });
        tick();
      }
  n.notify('approval', 'pa-c1', { title: 'needs approval' });
  n.retract('pa-c1');
  tick();
  n.notify('approval', 'pa-c1', { title: 'needs approval again' });
  tick();
  for (const p of ['pa', 'pb']) {
    n.notify('turn', p, { title: p });
    tick();
  }
  n.notify('turn', 'solo', { title: 'solo' });
  return { n, reqs };
}

const kinds = (r: any[]) => ({ done: r.filter((x) => x.kind === 'done').length, needsYou: r.filter((x) => x.kind === 'needsYou').length });

test('pushes for 8 children finishing twice, 2 needs, 2 parents and a lone chat, rule by rule', (t) => {
  const old = scenario({ kinds: { turn: true } }, useFakeClock(t, 1_000_000)).reqs;
  const child = scenario({ child: true, kinds: { turn: true } }, useFakeClock(t, 1_000_000)).reqs;
  const dflt = scenario({ child: true }, useFakeClock(t, 1_000_000)).reqs;
  console.log(
    `pushes: before ${old.length} ${JSON.stringify(kinds(old))}; child silent ${child.length} ${JSON.stringify(kinds(child))}; finished off by default ${dflt.length} ${JSON.stringify(kinds(dflt))}`,
  );
  assert.deepEqual(kinds(old), { done: 19, needsYou: 2 });
  assert.deepEqual(kinds(child), { done: 3, needsYou: 2 });
  assert.deepEqual(kinds(dflt), { done: 0, needsYou: 2 });
});

test('at the Mac nothing is pushed; a need still standing is pushed once the person has left, a finished chat is not', (t) => {
  const clock = useFakeClock(t, 1_000_000);
  let idle: number | null = 5_000;
  const { n, reqs } = rig({ kinds: { turn: true }, idle: () => idle }, clock);
  n.notify('turn', 'c1', {});
  n.notify('approval', 'c2', {});
  assert.equal(reqs.length, 0, 'at the Mac: the banner is enough');
  clock.advance(RECHECK_MS);
  assert.equal(reqs.length, 0, 'still at the Mac');
  idle = AWAY_AFTER_MS + 1;
  clock.advance(RECHECK_MS);
  assert.deepEqual(kinds(reqs), { done: 0, needsYou: 1 });
  clock.advance(10 * RECHECK_MS);
  assert.equal(reqs.length, 1, 'said once');
});

test('a need answered while the person is at the Mac is never pushed', (t) => {
  const clock = useFakeClock(t, 1_000_000);
  const { n, reqs } = rig({ idle: () => 1_000 }, clock);
  n.notify('approval', 'c1', {});
  n.retract('c1');
  clock.advance(10 * 60_000);
  n.notify('approval', 'c2', {});
  n.clear('c2');
  clock.advance(10 * 60_000);
  assert.equal(reqs.length, 0);
  assert.equal(clock.pending, 0);
});

test('a newer need for the chat replaces the waiting one; an unknown idle time counts as away', (t) => {
  const clock = useFakeClock(t, 1_000_000);
  let idle: number | null = 1_000;
  const { n, reqs } = rig({ idle: () => idle }, clock);
  n.notify('approval', 'c1', {});
  clock.advance(5 * 60_000);
  n.notify('approval', 'c1', { title: 'again' });
  assert.equal(clock.pending, 1);
  idle = null;
  clock.advance(RECHECK_MS);
  assert.equal(reqs.length, 1);
  idle = 1_000;
  n.notify('approval', 'c3', {});
  idle = null;
  n.notify('approval', 'c3', {});
  assert.equal(clock.pending, 0, 'away now: pushed, nothing waits');
  assert.equal(reqs.length, 2);
});

test('a throwing child lookup or settle hook lets the notice through', () => {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r), getKinds: () => ({ turn: true }) });
  const n = new Notifier({
    getMode: () => 'always',
    show: () => ({ close() {} }),
    onBanner: push.onBanner,
    isLinkedChild: () => {
      throw new Error('journal unavailable');
    },
  });
  n.onSettled = () => {
    throw new Error('x');
  };
  n.notify('turn', 'c1', { title: 't' });
  n.retract('c1');
  assert.equal(reqs.length, 1);
});

test('a child goal that stopped short still needs the person; a completed one is the parent’s news', () => {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r), getKinds: () => ({ goal: true }) });
  const n = new Notifier({ getMode: () => 'always', show: () => ({ close() {} }), onBanner: push.onBanner, isLinkedChild: () => true });
  n.notify('goal', 'c1', { title: 't', status: 'complete' });
  n.notify('goal', 'c2', { title: 't', status: 'paused' });
  assert.deepEqual(
    reqs.map((r) => r.kind),
    ['needsYou'],
  );
});

test('linkedChildOf: an attached child is one, a detached one, a stranger and a missing orchestrator are not', () => {
  const { linkedChildOf } = require('../electron/session/orchestration/family.cjs');
  const journal = { child: (id: string) => ({ a: { parentId: 'p' }, d: { parentId: 'p', detached: true } })[id] ?? null };
  const of = linkedChildOf({ orchestrator: { journal } });
  assert.deepEqual([of('a'), of('d'), of('x')], [true, false, false]);
  assert.equal(linkedChildOf({})('a'), false);
});

test('without switches or idle time given, a finished chat is not pushed and a need is', () => {
  const reqs: any[] = [];
  const push = createPushRequests({ pairs: () => ['p1'], sink: (r: any) => reqs.push(r) });
  push.onBanner({ kind: 'turn', chatId: 'c', needs: false });
  push.onBanner({ kind: 'approval', chatId: 'c', needs: true });
  assert.deepEqual(
    reqs.map((r) => r.kind),
    ['needsYou'],
  );
});

test('pushesToPhone: opt-in kinds need their switch true, the others only not false', async () => {
  const { pushesToPhone, PUSH_OPT_IN_KINDS } = await import('../shared/remote/pushSettings.mjs');
  assert.deepEqual([...PUSH_OPT_IN_KINDS], ['turn', 'goal']);
  assert.deepEqual(
    [undefined, {}, { turn: false }, { turn: true }].map((k) => pushesToPhone(k, 'turn')),
    [false, false, false, true],
  );
  assert.deepEqual(
    [undefined, {}, { approval: false }, { approval: true }].map((k) => pushesToPhone(k, 'approval')),
    [true, true, false, true],
  );
});
