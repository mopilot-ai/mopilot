// Motion bench specs, moments and command lines (bench/lib/motion/measure.mjs, moments.mjs, cli.mjs): spec checks, marks, palettes, region resolving, clock sync and the synthetic self-check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  checkSynth,
  measureRecording,
  parseMetricsArgs,
  parseRecordArgs,
  syncSpot,
  SYNTH_PALETTE,
  SYNTH_SPEC,
  videoMarks,
  wallMarks,
} from '../bench/lib/motion/cli.mjs';
import { checkSpec, CSS_EASINGS, measure, paletteFrom, when } from '../bench/lib/motion/measure.mjs';
import { clickPoint, familyOf, MOMENTS, momentById, recordingSpec, resolveRegions } from '../bench/lib/motion/moments.mjs';
import { BENCH_DIR } from '../bench/lib/config.mjs';
import { drawVideo, synthVideo } from './support/motionFrames.ts';

const synth = synthVideo(4);

test('the synthetic recording passes the self-check, and a wrong measurement fails it', () => {
  const results = measure(synth, SYNTH_SPEC, { palette: SYNTH_PALETTE });
  const checks = checkSynth(results);
  assert.deepEqual(
    checks.filter(([, ok]) => !ok),
    [],
  );
  assert.equal(checks.length, 7);
  const broken: any[] = structuredClone(results);
  broken[1].result = null;
  broken[2].result = null;
  broken[5].dropped = 0;
  assert.deepEqual(
    checkSynth(broken)
      .filter(([, ok]) => !ok)
      .map(([w]) => w),
    ['fade ≈ 200 ms, closest to its curve', 'slide ≈ 300 ms, closest to its curve, no overshoot', 'slide drops 2 frames'],
  );
});

test('checkSpec refuses malformed specs, naming what is wrong', () => {
  const ok = { id: 'x', regions: { a: [0, 0, 1, 1] }, measure: [{ kind: 'dropped', region: 'a' }] };
  assert.equal(checkSpec(ok), ok);
  assert.equal(checkSpec({ ...ok, measure: [{ kind: 'feedback', trigger: 'a', response: 'a' }] }).id, 'x');
  for (const [bad, why] of [
    [null, /needs an id/],
    [{ id: '' }, /needs an id/],
    [{ id: 'x' }, /regions must be an object/],
    [{ id: 'x', regions: { a: [0, 0, 0, 1] } }, /region a must be/],
    [{ id: 'x', regions: { a: [0, 0, 1] } }, /region a must be/],
    [{ id: 'x', regions: {}, measure: [] }, /at least one metric/],
    [{ id: 'x', regions: {}, measure: [null] }, /unknown metric undefined/],
    [{ id: 'x', regions: {}, measure: [{ kind: 'bogus' }] }, /unknown metric bogus/],
    [{ ...ok, measure: [{ kind: 'dropped', region: 'b' }] }, /dropped names no region b/],
    [{ ...ok, measure: [{ kind: 'feedback', response: 'b' }] }, /feedback names no region b/],
  ] as const)
    assert.throws(() => checkSpec(bad), why as RegExp);
});

test('when reads numbers, marks and defaults; measure keeps going past a metric it cannot take', () => {
  assert.equal(when(undefined, {}, 7), 7);
  assert.equal(when(30, {}, 7), 30);
  assert.equal(when('send', { send: 900 }, 7), 900);
  assert.throws(() => when('send', {}, 7), /no mark send/);
  const out = measure(
    synth,
    {
      id: 'm',
      regions: { trigger: [0, 0, 640, 80], fade: [0, 100, 640, 80] },
      measure: [
        { kind: 'feedback', trigger: 'go', response: 'fade' },
        { kind: 'feedback', trigger: 520, response: 'fade', after: 'go' },
        { kind: 'cadence', region: 'fade', from: 'missing' },
        { kind: 'dropped', region: 'gone' },
        { kind: 'feedback', trigger: 'trigger', response: 'gone' },
      ],
    },
    { marks: { go: 550 } },
  );
  assert.deepEqual(out, [
    { kind: 'feedback', region: 'fade', trigger: 550, response: 617, ms: 67 },
    { kind: 'feedback', region: 'fade', trigger: 520, response: 617, ms: 97 },
    { kind: 'cadence', error: 'no mark missing in this recording' },
    { kind: 'dropped', error: 'dropped names no region gone in this recording' },
    { kind: 'feedback', error: 'feedback names no region gone in this recording' },
  ]);
  const empty = measure({ ...synth, frames: [] }, { id: 'e', regions: { a: [0, 0, 10, 10] }, measure: [{ kind: 'cadence', region: 'a' }] });
  assert.deepEqual(empty, [{ kind: 'cadence', region: 'a', updates: 0, medianMs: null, p90Ms: null, maxMs: null, perSecond: null }]);
  const shifted = measure(synth, { id: 's', regions: { c: [0, 330, 640, 70] }, measure: [{ kind: 'layoutShift', region: 'c', maxPx: 8 }] });
  assert.equal((shifted[0] as any).totalPx, 8);
  const step = measure(synth, { id: 'd', regions: { t: [0, 0, 640, 80] }, measure: [{ kind: 'transition', region: 't' }] })[0] as any;
  assert.ok(Object.hasOwn(CSS_EASINGS, step.result.nearest[0].name), 'the CSS keywords are the default palette');
});

test('paletteFrom takes a vendor inventory’s cubic-bezier tokens, alongside the CSS keywords', () => {
  const p = paletteFrom({
    vendor: 'claude',
    motion: {
      'var:--cds-ease-snap@.cds-root': { value: 'cubic-bezier(.32, .72, 0, 1)' },
      'var:--cds-dur-base@.cds-root': { value: '.2s' },
      'var:--two': { value: 'cubic-bezier(0,0,1,1) | cubic-bezier(1,1,1,1)' },
      'var:--bad': { value: 'cubic-bezier(a,0,1,1)' },
      'css:.x|transition': { value: 'cubic-bezier(0,0,1,1)' },
    },
  });
  assert.deepEqual(p['claude:--cds-ease-snap@.cds-root'], [0.32, 0.72, 0, 1]);
  assert.deepEqual(
    Object.keys(p).filter((k) => k.startsWith('claude:')),
    ['claude:--cds-ease-snap@.cds-root'],
  );
  assert.deepEqual(paletteFrom({ vendor: 'chatgpt' }), CSS_EASINGS);
});

test('moments: lookup, layout family, regions and click points per app', () => {
  assert.equal(momentById('turn-start').id, 'turn-start');
  assert.throws(() => momentById('nope'), /unknown moment nope; known: turn-start/);
  for (const m of MOMENTS)
    assert.equal(
      checkSpec({ id: m.id, regions: { ...Object.fromEntries(Object.keys(m.regions).map((k) => [k, [0, 0, 1, 1]])) }, measure: m.measure })
        .id,
      m.id,
    );
  assert.equal(familyOf({ kind: 'mopilot' }), 'mopilot');
  assert.equal(familyOf({ kind: 'desktop', app: 'Claude' }), 'claude');
  assert.equal(familyOf({ kind: 'desktop', app: 'ChatGPT' }), 'chatgpt');
  assert.throws(() => familyOf({ kind: 'desktop', app: 'Notes' }), /no motion layout for the Notes app/);
  assert.throws(() => familyOf({ kind: 'other' }), /no motion layout for the other app/);
  const moment = {
    ...momentById('turn-start'),
    regions: { whole: [0, 0, 1, 1], composer: { default: [0.5, 0.5, 0.5, 0.5], chatgpt: [0, 0, 0.5, 0.5] } },
  } as any;
  assert.deepEqual(resolveRegions(moment, 'claude', [100, 50, 800, 600]), { whole: [100, 50, 800, 600], composer: [500, 350, 400, 300] });
  assert.deepEqual(resolveRegions(moment, 'chatgpt', [100, 50, 800, 600]).composer, [100, 50, 400, 300]);
  assert.deepEqual(clickPoint({ do: 'click', at: [3, 4] }, 'claude'), [3, 4]);
  assert.deepEqual(clickPoint({ do: 'click', at: { chatgpt: [5, 6] } }, 'chatgpt'), [5, 6]);
  assert.equal(clickPoint({ do: 'click', at: { chatgpt: [5, 6] } }, 'mopilot'), null);
  assert.deepEqual(recordingSpec(moment, { whole: [100, 50, 800, 600] }, [100, 50, 800, 600], 2).regions, { whole: [0, 0, 1600, 1200] });
});

test('parseRecordArgs and parseMetricsArgs', () => {
  const r = parseRecordArgs(['--arm', 'desk-claude', '--moment', 'turn-start', '--run', 'r1']);
  assert.equal(r.arm, 'desk-claude');
  assert.equal(r.seconds, momentById('turn-start').seconds);
  assert.equal(r.dir, path.join(BENCH_DIR, 'results', 'motion', 'r1', 'desk-claude'));
  assert.equal(
    parseRecordArgs(['--arm', 'mp-claude', '--moment', 'turn-start', '--seconds', '5', '--results', '/x']).dir,
    path.join('/x', 'local', 'mp-claude'),
  );
  assert.deepEqual([r.cdp, r.cdpTarget], [null, '']);
  const withCdp = parseRecordArgs(['--arm', 'desk-chatgpt', '--moment', 'turn-start', '--cdp', '9398', '--cdp-target', 'app://']);
  assert.deepEqual([withCdp.cdp, withCdp.cdpTarget], [9398, 'app://']);
  assert.throws(() => parseRecordArgs(['--arm', 'desk-chatgpt', '--moment', 'turn-start', '--cdp', '99999']), /--cdp must be a port/);
  for (const [argv, why] of [
    [['--moment', 'turn-start'], /unknown or missing --arm/],
    [['--arm', 'nope', '--moment', 'turn-start'], /unknown or missing --arm/],
    [['--arm', 'desk-claude'], /unknown moment/],
    [['--arm', 'desk-claude', '--moment', 'turn-start', '--run', 'a/b'], /plain name/],
    [['--arm', 'desk-claude', '--moment', 'turn-start', '--seconds', '1'], /2–600/],
    [['--arm', 'desk-claude', '--moment', 'turn-start', '--seconds', 'x'], /2–600/],
    [['--arm'], /--arm needs a value/],
    [['--arm', '--moment'], /--arm needs a value/],
  ] as const)
    assert.throws(() => parseRecordArgs([...argv]), why as RegExp);
  assert.deepEqual(parseMetricsArgs(['a.json', 'b.json', '--palette', 'c.json,,d.json', '--scale', '4']), {
    recordings: ['a.json', 'b.json'],
    palettes: ['c.json', 'd.json'],
    scale: 4,
    scaleGiven: true,
    selfCheck: false,
    mgb: null,
    records: null,
  });
  assert.deepEqual(parseMetricsArgs(['--self-check']), {
    recordings: [],
    palettes: [],
    scale: 4,
    scaleGiven: false,
    selfCheck: true,
    mgb: null,
    records: null,
  });
  // a 12-Grid Bench run folder alone is enough (#1381)
  assert.deepEqual(parseMetricsArgs(['--mgb', 'results/mgb/r1', '--scale', '8']), {
    recordings: [],
    palettes: [],
    scale: 8,
    scaleGiven: true,
    selfCheck: false,
    mgb: 'results/mgb/r1',
    records: null,
  });
  assert.equal(parseMetricsArgs(['a.json', '--records', 'results/mgb/r1']).records, 'results/mgb/r1');
  assert.throws(() => parseMetricsArgs([]), /usage: node bench\/motion-metrics\.mjs/);
  assert.throws(() => parseMetricsArgs(['a.json', '--scale', '0']), /1–16/);
});

/** A recorded-looking video: the cursor lands in the window's corner at 300 ms, then a box appears at 800 ms. */
const recorded = drawVideo(400, 300, 2, 90, (t, fill) => {
  if (t >= 0.3) fill(16, 16, 16, 16, 255);
  if (t >= 0.8) fill(100, 100, 100, 50, 220);
});

test('the clock-sync spot is the middle of the title bar, away from the traffic lights', () => {
  assert.deepEqual(syncSpot([100, 50, 1200, 800]), { point: [600, 12], region: [576, 0, 48, 32] });
  assert.deepEqual(syncSpot([0, 0, 801, 600]).point, [401, 12]);
});

test('videoMarks places the recorder’s wall-clock marks by the cursor move it sees', () => {
  assert.deepEqual(videoMarks(recorded, [8, 8, 40, 40], { syncAt: 10_000, marks: { send: 10_450 } }), { send: 750 });
  assert.equal(videoMarks(recorded, [300, 200, 40, 40], { syncAt: 10_000, marks: {} }), null);
  // the box at 800 ms sits in this region too: with the recorder spawned 1.5 s before the move, only a change after
  // 500 ms can be it, and the cursor's at 300 ms is ignored
  assert.deepEqual(videoMarks(recorded, [8, 8, 300, 300], { syncAt: 10_000, spawnAt: 8_500, marks: { send: 10_100 } }), { send: 900 });
  assert.deepEqual(videoMarks(recorded, [8, 8, 300, 300], { syncAt: 10_000, marks: { send: 10_100 } }), { send: 400 });
});

test('measureRecording measures a recording with its moment’s current spec, synced or not', () => {
  const rec = {
    arm: 'desk-claude',
    family: 'claude',
    version: '1.2',
    moment: 'turn-start',
    window: [0, 0, 200, 150],
    regions: { composer: [0, 120, 200, 30], transcript: [40, 40, 120, 60] },
    sync: { syncAt: 10_000, region: [8, 8, 40, 40] },
    marks: { send: 10_450 },
  };
  const out = measureRecording(rec, recorded);
  assert.equal(out.synced, true);
  assert.deepEqual(out.marks, { send: 750 });
  assert.equal(out.frames, 90);
  assert.deepEqual(out.results[1], { kind: 'deadAir', region: 'transcript', longestMs: 683, gaps: [] });
  const unsynced = measureRecording({ ...rec, sync: { syncAt: 0, region: [180, 130, 10, 10] } }, recorded, { linear: [0, 0, 1, 1] });
  assert.equal(unsynced.synced, false);
  assert.equal(unsynced.marks, null);
  assert.deepEqual(unsynced.results[1], { kind: 'deadAir', error: 'no mark send in this recording' });
  // a CDP screencast: frames carry the wall clock, so marks need no cursor move
  const cast = measureRecording({ ...rec, sync: { clock: 'wall', originMs: 10_000 }, marks: { send: 10_450 } }, recorded);
  assert.deepEqual([cast.synced, cast.marks], [true, { send: 450 }]);
  assert.deepEqual(wallMarks({ a: 5, b: 1005 }, 1000), { a: -995, b: 5 });
});
