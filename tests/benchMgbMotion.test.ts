// The 12-Grid Bench motion score (#1381, #1511): bench/lib/motion/mgb.mjs's taskMotion over a task run's recording
// parts, and bench/lib/mgb/scorecard.mjs's motion side (motionStats, motionWorse, the amber downgrade, the Motion
// column, and a run's <task>.motion.json joining its record).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawVideo } from './support/motionFrames.ts';

const { manifestMotion, taskMotion, STILL_LIMIT_MS } = await import('../bench/lib/motion/mgb.mjs');
const sc = await import('../bench/lib/mgb/scorecard.mjs');

/**
 * A 10 s part at 20 fps: a box moves for 2 s (frames 12 and 13 dropped), the screen is still 4.5 s, the box moves
 * again from 6.5 s to 8 s, then nothing.
 */
const part = () =>
  drawVideo(
    160,
    100,
    4,
    200,
    (t, fill) => {
      const x = t < 2 ? t * 40 : t < 6.5 ? 80 : t < 8 ? 80 - (t - 6.5) * 40 : 20;
      fill(Math.round(x), 20, 40, 40, 230);
    },
    { fps: 20, skip: [12, 13] },
  );

test('taskMotion: the longest still stretch and the ones over 3 s within the turn, and drops per minute of motion', () => {
  assert.equal(STILL_LIMIT_MS, 3000);
  // the part started at epoch 1000; the turn ran from 500 ms into it to 9 s into it
  const one = taskMotion([{ load: () => part(), startedAt: 1000 }], { turnStartedAt: 1500, turnEndedAt: 10000 });
  assert.equal(one.schema, 1);
  assert.equal(one.parts, 1);
  assert.ok(Math.abs((one.longestStillMs as number) - 4500) <= 50, `the 4.5 s still stretch, got ${one.longestStillMs}`);
  assert.equal(one.stillsOver3s, 1, 'the 1 s still after the second move is under the limit');
  // two refreshes skipped while the box moved, over 3.5 s of motion
  assert.ok(one.droppedPerMin > 30 && one.droppedPerMin < 40, `drops per minute, got ${one.droppedPerMin}`);
  assert.ok(Math.abs(one.motionSeconds - 3.5) <= 0.2, `motion seconds, got ${one.motionSeconds}`);

  // the still stretch after the turn ended is not counted: a turn that ends at 7 s has its 4.5 s stretch only
  const early = taskMotion([{ load: () => part(), startedAt: 0 }], { turnStartedAt: 0, turnEndedAt: 7000 });
  assert.equal(early.stillsOver3s, 1);
  // nor the one before the prompt was sent
  const late = taskMotion([{ load: () => part(), startedAt: 0 }], { turnStartedAt: 6000, turnEndedAt: 9500 });
  assert.ok((late.longestStillMs as number) < STILL_LIMIT_MS, `only the 1.5 s after the second move, got ${late.longestStillMs}`);
  assert.equal(late.stillsOver3s, 0);
});

test('taskMotion: parts are measured on their own, and a run with nothing of its turn recorded has no score', () => {
  const two = taskMotion(
    [
      { load: () => part(), startedAt: 0 },
      { load: () => part(), startedAt: 10500 },
    ],
    { turnStartedAt: 0, turnEndedAt: 20500 },
  );
  assert.equal(two.parts, 2);
  // each part's 4.5 s stretch and its 2 s tail; the 0.5 s between the parts is not a still stretch
  assert.equal(two.stillsOver3s, 2);
  assert.ok(two.longestStillMs < 5000);

  const still = drawVideo(160, 100, 4, 100, (_t, fill) => fill(20, 20, 40, 40, 230), { fps: 20 });
  const none = taskMotion([{ load: () => still, startedAt: 0 }], { turnStartedAt: 0, turnEndedAt: 5000 });
  assert.deepEqual([none.parts, none.stillsOver3s, none.droppedPerMin, none.motionSeconds], [1, 1, 0, 0], 'no motion, no drops');

  const unscored = { schema: 1, parts: 0, longestStillMs: null, stillsOver3s: null, droppedPerMin: null, motionSeconds: 0 };
  // the turn's times unknown, a part of one frame, a part wholly after the turn
  assert.deepEqual(taskMotion([{ load: () => part(), startedAt: 0 }], { turnStartedAt: null, turnEndedAt: 5000 }), unscored);
  assert.deepEqual(taskMotion([{ load: () => part(), startedAt: 0 }], { turnStartedAt: 0, turnEndedAt: null }), unscored);
  const single = drawVideo(160, 100, 4, 1, () => {}, { fps: 20 });
  assert.deepEqual(taskMotion([{ load: () => single, startedAt: 0 }], { turnStartedAt: 0, turnEndedAt: 5000 }), unscored);
  // a part started after the turn ended is never decoded
  const never = () => {
    throw new Error('decoded a part outside the turn');
  };
  assert.deepEqual(taskMotion([{ load: never, startedAt: 60000 }], { turnStartedAt: 0, turnEndedAt: 5000 }), unscored);
  assert.deepEqual(taskMotion([{ load: never, startedAt: 0 }], { turnStartedAt: null, turnEndedAt: 5000 }), unscored);
  // a part that ended before the turn started
  assert.deepEqual(taskMotion([{ load: () => part(), startedAt: 0 }], { turnStartedAt: 20000, turnEndedAt: 25000 }), unscored);
  assert.deepEqual(taskMotion([], { turnStartedAt: 0, turnEndedAt: 5000 }), unscored);
});

test('manifestMotion loads each part of a <task>.rec.json by its file, one at a time', () => {
  const loaded: string[] = [];
  const load = (file: string) => {
    loaded.push(file);
    return part();
  };
  const rec = {
    parts: [
      { file: 'f1-a.rec-0.mov', startedAt: 0 },
      { file: 'f1-a.rec-1.mov', startedAt: 10500 },
    ],
    startedAt: 0,
    endedAt: 21000,
    turnStartedAt: 0,
    turnEndedAt: 9000,
  };
  const one = manifestMotion(rec, load);
  assert.deepEqual(loaded, ['f1-a.rec-0.mov'], 'the part after the turn is not decoded');
  assert.equal(one.parts, 1);
  assert.equal(manifestMotion({ turnStartedAt: 0, turnEndedAt: 9000 }, load).parts, 0, 'a manifest without parts');
  assert.equal(manifestMotion({ parts: rec.parts }, load).longestStillMs, null, 'a manifest without turn times');
});

/** A passing MoPilot or native record with a measured recording. */
const run = (column: string, task: string, motion: any) => ({
  task,
  column,
  surfaces: ['iab'],
  repeat: 0,
  verdict: 'PASS',
  score: 1,
  control: { cards: { over: 0, under: 0 }, deadEnds: [], escOk: null, leaks: [] },
  offSurface: [],
  efficiency: { wallMs: 60000, tokens: 1000, costUsd: 0.1 },
  motion,
});
const m = (longestStillMs: number, droppedPerMin: number | null, stillsOver3s = 0) => ({ longestStillMs, stillsOver3s, droppedPerMin });

test('motionStats: medians of the measured runs, nothing for a cell without recordings', () => {
  assert.deepEqual(
    sc.motionStats([run('claude', 'a', m(1000, 2, 0)), run('claude', 'b', m(5000, null, 2)), run('claude', 'c', m(3000, 4, 1))]),
    {
      motionRuns: 3,
      stillP50Ms: 3000,
      stillsOver3s: 3,
      droppedPerMin: 3,
    },
  );
  // a run not recorded, or with an unscored measurement, does not count
  assert.deepEqual(sc.motionStats([run('claude', 'a', undefined), run('claude', 'b', { longestStillMs: null })]), {
    motionRuns: 0,
    stillP50Ms: null,
    stillsOver3s: null,
    droppedPerMin: null,
  });
  assert.equal(sc.cellStats([run('claude', 'a', m(1200, 1))]).stillP50Ms, 1200, 'cellStats carries the motion side');
  // an UNGRADABLE run (an outage or a rate-limited turn is all still time) never feeds the comparison, nor an N/A one
  const outage = sc.cellStats([
    run('claude', 'a', m(1200, 1)),
    { ...run('claude', 'b', m(60000, 0, 20)), verdict: 'UNGRADABLE' },
    { ...run('claude', 'c', m(60000, 0, 20)), verdict: 'N/A' },
  ]);
  assert.deepEqual([outage.motionRuns, outage.stillP50Ms, outage.stillsOver3s], [1, 1200, 0]);
});

test('motionWorse: a longer still stretch or more drops beyond noise, never without both sides', () => {
  const stats = (still: number, drops: number | null) => sc.motionStats([run('x', 'a', m(still, drops))]);
  assert.equal(sc.motionWorse(stats(3600, 0), stats(2000, 0)), true, 'over 2000 × 1.25 + 1000');
  assert.equal(sc.motionWorse(stats(3400, 0), stats(2000, 0)), false, 'within noise');
  assert.equal(sc.motionWorse(stats(1000, 9), stats(1000, 4)), true, 'over 4 × 1.5 + 2 drops a minute');
  assert.equal(sc.motionWorse(stats(1000, 7), stats(1000, 4)), false);
  assert.equal(sc.motionWorse(stats(1000, null), stats(1000, 4)), false, 'drops unknown on one side');
  assert.equal(sc.motionWorse(stats(1000, 9), stats(1000, null)), false);
  assert.equal(sc.motionWorse(stats(9000, 0), null), false, 'no native arm');
  assert.equal(sc.motionWorse(sc.motionStats([]), stats(1000, 0)), false, 'MoPilot not recorded');
  assert.equal(sc.motionWorse(stats(9000, 0), sc.motionStats([])), false, 'native not recorded');
});

test('the scorecard: a cell green on success but worse on motion is amber, and the Motion column shows both sides', () => {
  const mine = Array.from({ length: 10 }, (_, i) => run('codex', `f1-t${i}`, m(6000, 1)));
  const native = Array.from({ length: 10 }, (_, i) => ({
    ...run('desk-chatgpt', `f1-t${i}`, m(2000, 1)),
    verdict: i < 2 ? 'PASS' : 'FAIL',
  }));
  const rows = sc.scorecard([...mine, ...native, ...Array.from({ length: 3 }, (_, i) => run('claude', `f1-t${i}`, undefined))]);
  const at = (cell: string): any => rows.find((r: any) => r.cell === cell);
  assert.deepEqual([at('iab×codex').band, at('iab×codex').motionWorse], ['amber', true]);
  const table = sc.scorecardTable(rows);
  assert.match(table, /\| IAB × codex \| .* \| 🟡 amber \| still 6 s · 1 drops\/min \(native still 2 s · 1 drops\/min\) ⚠ \|/);
  // MoPilot recorded without a native recording; a cell with no recording
  assert.match(table, /\| IAB × claude \| .* \| — \| 100% \|/);
  const solo = sc.scorecardTable(sc.scorecard([run('acp', 'f1-a', m(1500, null))]));
  assert.match(solo, /\| IAB × acp \| .* \| still 2 s · — drops\/min \|/);
  // the same codex cell with motion as good as native stays green
  const good = sc.scorecard([...mine.map((r) => ({ ...r, motion: m(2000, 1) })), ...native]);
  assert.deepEqual(
    [good.find((r: any) => r.cell === 'iab×codex')?.band, good.find((r: any) => r.cell === 'iab×codex')?.motionWorse],
    ['green', false],
  );
});

test("recordsOf: a run folder's <task>.motion.json joins its record; recording manifests are not records", () => {
  const plain = run('claude', 'f1-a', undefined);
  delete (plain as any).motion;
  const recs = sc.recordsOf([
    { path: 'r/claude/f1-a.json', text: JSON.stringify(plain) },
    { path: 'r/claude/f1-a.motion.json', text: JSON.stringify(m(1800, 2)) },
    { path: 'r/claude/f1-a.rec.json', text: JSON.stringify({ parts: [] }) },
    { path: 'r/claude/f1-b.json', text: JSON.stringify({ ...plain, task: 'f1-b' }) },
    { path: 'r/claude/f1-b.motion.json', text: '{half' },
    // a measurement next to a record that is not an object leaves it as it is
    { path: 'r/claude/f1-c.json', text: 'null' },
    { path: 'r/claude/f1-c.motion.json', text: JSON.stringify(m(1000, 0)) },
  ]);
  assert.deepEqual(
    recs.map((r: any) => [r.task, r.motion ?? null]),
    [
      ['f1-a', m(1800, 2)],
      ['f1-b', null],
    ],
  );
});
