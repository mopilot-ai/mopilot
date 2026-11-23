// Motion bench cursor moments' command lines and measuring (bench/lib/motion/cli.mjs): the recorder's surface, recorder and fps options, the report's arguments, the recording clock, the cursor analysis of a recording, and the cursor self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cursorSynthChecks, measureRecording, parseRecordArgs, parseReportArgs, videoClock } from '../bench/lib/motion/cli.mjs';
import { momentById, resolveRegions } from '../bench/lib/motion/moments.mjs';
import { stubPlanner } from '../bench/lib/motion/skyFit.mjs';
import { cursorSynthVideo, fixtureRun, WALL0 } from './support/motionCursor.ts';

const planner = { planner: stubPlanner, source: 'stub' };

test('parseRecordArgs: a cursor moment needs a surface; recorder and fps are checked', () => {
  const ok = parseRecordArgs(['--arm', 'desk-chatgpt', '--moment', 'cursor-move-d200', '--surface', 'cu']);
  assert.deepEqual([ok.surface, ok.recorder, ok.fps, ok.seconds], ['cu', 'sck', 120, 300]);
  const custom = parseRecordArgs([
    '--arm',
    'mp-claude',
    '--moment',
    'cursor-repeat',
    '--surface',
    'iab',
    '--recorder',
    'screencapture',
    '--fps',
    '60',
  ]);
  assert.deepEqual([custom.surface, custom.recorder, custom.fps], ['iab', 'screencapture', 60]);
  // the calibration has no agent: no surface needed
  assert.equal(parseRecordArgs(['--arm', 'mp-claude', '--moment', 'cursor-calibration']).surface, null);
  assert.equal(parseRecordArgs(['--arm', 'desk-claude', '--moment', 'turn-start']).surface, null);
  for (const [argv, why] of [
    [['--arm', 'desk-chatgpt', '--moment', 'cursor-move-d200'], /needs --surface cu\|iab\|bu/],
    [['--arm', 'desk-chatgpt', '--moment', 'cursor-move-d200', '--surface', 'x'], /--surface must be cu, iab, bu/],
    [['--arm', 'desk-chatgpt', '--moment', 'turn-start', '--recorder', 'x'], /--recorder must be sck or screencapture/],
    [['--arm', 'desk-chatgpt', '--moment', 'turn-start', '--fps', '1000'], /--fps must be 15–240/],
    [['--arm', 'desk-chatgpt', '--moment', 'turn-start', '--fps', 'x'], /--fps must be 15–240/],
  ] as const)
    assert.throws(() => parseRecordArgs([...argv]), why as RegExp);
});

test('parseReportArgs: both arm folders, moments, output and tolerance overrides', () => {
  const r = parseReportArgs([
    '--vendor',
    'ChatGPT=/r/desk-chatgpt',
    '--ours',
    'MoPilot=/r/mp-codex',
    '--moments',
    'cursor-repeat,,cursor-scroll',
    '--out',
    '/o',
    '--path-rms',
    '3',
    '--offset',
    '0',
  ]);
  assert.deepEqual(r, {
    vendor: { label: 'ChatGPT', dir: '/r/desk-chatgpt' },
    ours: { label: 'MoPilot', dir: '/r/mp-codex' },
    moments: ['cursor-repeat', 'cursor-scroll'],
    out: '/o',
    tolerance: { pathRmsPx: 3, offsetFrames: 0 },
  });
  const plain = parseReportArgs(['--vendor', 'A=/a', '--ours', 'B=/b']);
  assert.deepEqual([plain.moments, plain.out, plain.tolerance], [null, null, {}]);
  assert.equal(
    parseReportArgs(['--vendor', 'A=/a', '--ours', 'B=/b', '--duration', '0.1', '--frame-error', '5']).tolerance.durationShare,
    0.1,
  );
  assert.throws(() => parseReportArgs(['--ours', 'B=/b']), /--vendor needs <label>=<arm dir>/);
  assert.throws(() => parseReportArgs(['--vendor', 'A=/a', '--ours', 'nolabel']), /--ours needs <label>=<arm dir>/);
  assert.throws(
    () => parseReportArgs(['--vendor', 'A=/a', '--ours', 'B=/b', '--path-rms', '-1']),
    /--path-rms must be a number of at least 0/,
  );
  assert.throws(() => parseReportArgs(['--vendor', 'A=/a', '--ours', 'B=/b', '--duration', 'x']), /--duration must be/);
});

const moment = momentById('cursor-move-d100');
const recFor = (sync: object, marks = { send: WALL0 + 200, end: WALL0 + 21_000 }) => ({
  arm: 'desk-chatgpt',
  family: 'chatgpt',
  version: '1',
  moment: moment.id,
  surface: 'cu',
  window: [0, 0, 400, 300],
  regions: resolveRegions(moment, 'chatgpt', [0, 0, 400, 300]),
  sync,
  marks,
  recordedAt: new Date(WALL0 + 22_000).toISOString(),
});

test('videoClock: a wall-clock recording, a recording placed by the cursor move, and one where the move never showed', () => {
  const { video } = fixtureRun();
  const wall = videoClock(recFor({ clock: 'wall', originMs: WALL0 }), video, 1)!;
  assert.equal(wall(WALL0 + 500), 500);
  // the cursor leaves (40, 40) at 900 ms: the sync region around it sees the move
  const placed = videoClock(recFor({ syncAt: WALL0 + 880, region: [20, 20, 40, 40] }), video, 1)!;
  assert.ok(Math.abs(placed(WALL0 + 880) - 900) < 100, `${placed(WALL0 + 880)}`);
  assert.ok(Math.abs(placed(WALL0 + 1880) - placed(WALL0 + 880) - 1000) < 1e-9);
  assert.equal(videoClock(recFor({ syncAt: WALL0, region: [390, 290, 5, 5] }), video, 1), null);
});

test('measureRecording adds the cursor analysis to a cursor moment, with jank, tool times and cost when given', () => {
  const { video, events } = fixtureRun();
  const rec = recFor({ clock: 'wall', originMs: WALL0 });
  const plain = measureRecording(rec, video);
  assert.equal(plain.surface, 'cu');
  assert.equal('analysis' in plain, false, 'without a planner there is no cursor analysis');
  assert.equal(plain.results.length, 3);
  const full = measureRecording(rec, video, undefined, {
    planner,
    events,
    jank: [{ type: 'longtask', start: WALL0 + 1000, duration: 90 }],
    calls: [{ kind: 'click', name: 'x', startMs: 0, endMs: 40 }],
    records: [{ task: 'f4-week-plan', verdict: 'PASS', score: 1, efficiency: { steps: 30, tokens: 9, wallMs: 1 } }],
  }) as any;
  // a MoPilot arm's pointer carries a label chip: its episodes are analysed as labelled (the arm's name says so); a vendor's are not
  const mp = measureRecording({ ...rec, arm: 'mp-claude' }, video, undefined, { planner, events }) as any;
  assert.equal(mp.analysis.appear.found, full.analysis.appear.found);
  assert.equal(measureRecording({ ...rec, arm: undefined }, video, undefined, { planner, events }).analysis.moves.matched, 8);
  assert.equal(full.analysis.moves.matched, 8);
  assert.equal(full.analysis.origin.from, 'events');
  assert.equal(full.analysis.jank.longTasks, 1);
  assert.equal(full.analysis.jank.windowMs, 20_800);
  assert.equal(full.analysis.actions.click.p50, 40);
  assert.equal(full.analysis.cost.passRate, 1);
  assert.equal(full.analysis.gaps.count >= 0, true);
  // no events, no extras: the analysis is still there, with nothing to join
  const bare = measureRecording(
    { ...rec, surface: undefined, marks: { send: WALL0 + 200 }, recordedAt: new Date(WALL0 + 22_000).toISOString() },
    video,
    undefined,
    { planner },
  ) as any;
  assert.equal(bare.surface, null);
  assert.equal(bare.analysis.plan, null);
  assert.equal(bare.analysis.jank, null);
  assert.equal(bare.analysis.actions, null);
  assert.equal(bare.analysis.cost, null);
  assert.equal(bare.analysis.jank, null);
  // the cursor move never showed: the analysis says so and joins nothing
  const unsynced = measureRecording(recFor({ syncAt: WALL0, region: [390, 290, 5, 5] }), video, undefined, { planner, events }) as any;
  assert.equal(unsynced.synced, false);
  assert.ok(unsynced.analysis.notes.some((n: string) => /clock sync not seen/.test(n)));
  // no recorded end mark: the window runs to when it was recorded
  const noEnd = measureRecording({ ...rec, marks: { send: WALL0 + 200 } }, video, undefined, { planner, events, jank: [] }) as any;
  assert.equal(noEnd.analysis.jank.windowMs, 21_800);
  // no send mark: the window starts at the clock sync
  const noSend = measureRecording(
    recFor({ clock: 'wall', originMs: WALL0, syncAt: WALL0 + 1000 }, { end: WALL0 + 21_000 } as any),
    video,
    undefined,
    { planner, events, jank: [] },
  ) as any;
  assert.equal(noSend.analysis.jank.windowMs, 20_000);
});

test('cursorSynthChecks passes on the synthetic cursor recording and fails on a different one', () => {
  const checks = cursorSynthChecks(cursorSynthVideo(2));
  assert.deepEqual(
    checks.filter(([, ok]) => !ok).map(([what]) => what),
    [],
  );
  assert.equal(checks.length, 6);
  // a recording with no cursor in it fails them all but the vacuous ones
  const still = cursorSynthVideo(2);
  const empty = { ...still, frames: still.frames.map((f) => ({ ...f, px: new Uint8Array(f.px.length).fill(235) })) };
  const failed = cursorSynthChecks(empty).filter(([, ok]) => !ok);
  assert.ok(failed.length >= 4);
});
