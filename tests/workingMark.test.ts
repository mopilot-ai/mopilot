// The working mark (src/components/thread/workingMark): its sprite sheets, the stage machine and the playhead
// that hands one activity to the next. The strips it steps on the compositor: workingMarkView.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { readAppCssPart } from './support/app-css.ts';
import { MARK_SHEETS } from '../src/components/thread/workingMark/markSheets.ts';
import {
  CROSSFADE_MS,
  SEAM_LEAD_MS,
  TAIL_FRAMES,
  TAIL_THRESHOLD_MS,
  earlyExit,
  nextStage,
  restFrame,
  sheetKey,
  stageDuration,
  stageRange,
} from '../src/components/thread/workingMark/markStages.ts';
import { GHOST_MS, MarkPlayer, RESUME_MS, forgetLeftMark, type MarkFrame } from '../src/components/thread/workingMark/markPlayer.ts';

const ACTIVITIES = ['think', 'search', 'read', 'code', 'write', 'default', 'blocked'] as const;
const INTRO_MS = stageDuration({ kind: 'grow' });

const sheetSvg = (key: string) => Buffer.from(MARK_SHEETS[key].url.split(',')[1], 'base64').toString('utf8');

/** The sheet and frame a player shows at `now`. */
function at(p: MarkPlayer, now: number): string {
  const f: MarkFrame = p.frame(now);
  return `${f.sheet}:${f.index}`;
}

test('a fresh mark grows from a dot before entering the requested activity', () => {
  forgetLeftMark();
  const player = new MarkPlayer('think', 0);
  assert.equal(at(player, 0), 'grow:0');
  assert.equal(at(player, stageDuration({ kind: 'grow' })), 'think.in:0');
});

test('an activity changed during the entrance starts the latest requested motion', () => {
  forgetLeftMark();
  const player = new MarkPlayer('read', 0);
  player.want('code', 0);
  assert.equal(at(player, INTRO_MS), 'code.in:0');
});

test('the half-second handoff window includes its boundary and expires immediately after it', () => {
  forgetLeftMark();
  const first = new MarkPlayer('think', 0);
  first.frame(1_000);
  first.leave(1_000);
  assert.equal(RESUME_MS, 500);
  assert.equal(new MarkPlayer('think', 1_500, { standalone: true }).start, first.start);
  assert.deepEqual(new MarkPlayer('think', 1_501).stage, { kind: 'grow' });
});

test('every activity has its in, loop and out sheets, each an SVG strip of its frames', () => {
  for (const a of ACTIVITIES)
    for (const kind of ['in', 'loop', 'out']) {
      const key = `${a}.${kind}`;
      const sheet = MARK_SHEETS[key];
      assert.ok(sheet.frames > 0, key);
      assert.equal(sheet.speed, 33.3333);
      assert.ok(sheet.url.startsWith('data:image/svg+xml;base64,'), key);
      assert.match(sheetSvg(key), new RegExp(`^<svg [^>]*height="${48 * sheet.frames}"`), key);
    }
  assert.equal(MARK_SHEETS.grow.frames, 10);
  assert.equal(MARK_SHEETS['think.loop'].frames, 110);
});

test('each working-mark frame draws a core and four rounded rays', () => {
  for (const [key, sheet] of Object.entries(MARK_SHEETS)) {
    const svg = sheetSvg(key);
    const cores = svg.match(/<circle [^>]*fill="#[\da-f]{6}"[^>]*\/>/g);
    assert.equal(cores?.length, sheet.frames, key);
    const rayPaths = [...svg.matchAll(/<path d="([^"]+)"[^>]*stroke-linecap="round"[^>]*\/>/g)];
    assert.equal(rayPaths.length, sheet.frames, key);
    for (const [, rays] of rayPaths) assert.equal(rays.match(/M/g)?.length, 4, key);
  }
});

test('working-mark sprites match the startup dot in every activity, with amber reserved for blocked work', () => {
  const clay = /--brand-claude:\s*(#[\da-f]{6});/.exec(readAppCssPart('tokens.css'))?.[1];
  assert.ok(clay);
  assert.match(readAppCssPart('app/motion.css'), /\.working-mark\s*\{[^}]*\bcolor:\s*var\(--brand-claude\);/);

  const colors = (key: string) => [...sheetSvg(key).matchAll(/(?:fill|stroke)="(#[\da-f]{6})"/g)].map(([, color]) => color);
  for (const key of Object.keys(MARK_SHEETS).filter((key) => !key.startsWith('blocked.'))) {
    assert.deepEqual([...new Set(colors(key))], [clay], key);
  }

  const amber = '#e2b341';
  const entering = colors('blocked.in');
  const leaving = colors('blocked.out');
  assert.deepEqual([entering[0], entering.at(-1)], [clay, amber]);
  assert.deepEqual([...new Set(colors('blocked.loop'))], [amber]);
  assert.deepEqual([leaving[0], leaving.at(-1)], [amber, clay]);
});

test('stages name their sheet, frames and length; a tail is the last frames of the loop', () => {
  assert.equal(sheetKey({ kind: 'grow' }), 'grow');
  assert.equal(sheetKey({ kind: 'in', body: 'read' }), 'read.in');
  assert.equal(sheetKey({ kind: 'tail', body: 'read' }), 'read.loop');
  assert.deepEqual(stageRange({ kind: 'loop', body: 'think' }), [0, 110]);
  assert.deepEqual(stageRange({ kind: 'tail', body: 'think' }), [110 - TAIL_FRAMES, 110]);
  // a loop shorter than a tail plays whole
  MARK_SHEETS['tiny.loop'] = { frames: 5, speed: 10, url: '' };
  try {
    assert.deepEqual(stageRange({ kind: 'tail', body: 'tiny' as any }), [0, 5]);
    // no rest frame: a third of the way in
    assert.equal(restFrame('tiny' as any), 1);
  } finally {
    delete MARK_SHEETS['tiny.loop'];
  }
  assert.equal(stageDuration({ kind: 'in', body: 'think' }), 16 * 33.3333);
  assert.equal(restFrame('think'), 95);
});

test('each stage hands on to the next', () => {
  assert.deepEqual(nextStage({ kind: 'grow' }, 'read'), { kind: 'in', body: 'read' });
  assert.deepEqual(nextStage({ kind: 'in', body: 'think' }, 'read'), { kind: 'loop', body: 'think' });
  const loop = { kind: 'loop', body: 'think' } as const;
  assert.equal(nextStage(loop, 'think'), loop, 'a loop that is still wanted keeps going');
  assert.deepEqual(nextStage(loop, 'read'), { kind: 'out', body: 'think' });
  assert.deepEqual(nextStage({ kind: 'out', body: 'think' }, 'read'), { kind: 'in', body: 'read' });
  assert.deepEqual(nextStage({ kind: 'tail', body: 'code' }, 'code'), { kind: 'loop', body: 'code' });
  assert.deepEqual(nextStage({ kind: 'tail', body: 'code' }, 'read'), { kind: 'out', body: 'code' });
});

test('a loop leaves early at its next seam, or winds down with a tail around default and blocked', () => {
  const think = { kind: 'loop', body: 'think' } as const; // seam at frame 54
  const seam = 54 * 33.3333;
  assert.equal(earlyExit({ kind: 'in', body: 'think' }, 'read', 0), null, 'only loops leave early');
  assert.equal(earlyExit(think, 'think', 0), null, 'still wanted');
  assert.deepEqual(earlyExit(think, 'read', 0), { atMs: seam, to: { kind: 'out', body: 'think' } });
  assert.equal(earlyExit(think, 'read', seam - SEAM_LEAD_MS), null, 'too close to the seam: play out');
  assert.equal(earlyExit({ kind: 'loop', body: 'read' }, 'code', 0), null, 'a loop without seams plays out');
  // default and blocked cut short with a tail, unless little is left
  assert.deepEqual(earlyExit(think, 'blocked', 100), { atMs: 100, to: { kind: 'tail', body: 'think' } });
  assert.equal(earlyExit(think, 'blocked', 110 * 33.3333 - TAIL_THRESHOLD_MS), null, 'little left: play out');
  // the default loop is shorter than that: it always plays out
  assert.equal(earlyExit({ kind: 'loop', body: 'default' }, 'read', 0), null);
});

test('the playhead enters, loops and skips whole laps; a new activity takes over at a seam', () => {
  forgetLeftMark();
  const p = new MarkPlayer('think', 1000);
  assert.deepEqual(p.stage, { kind: 'grow' });
  assert.equal(at(p, 1000), 'grow:0');
  assert.equal(at(p, 1000 + INTRO_MS), 'think.in:0');
  assert.equal(at(p, 1000 + INTRO_MS + 5 * 33.3334), 'think.in:5');
  const inEnd = 1000 + INTRO_MS + 16 * 33.3333;
  assert.equal(at(p, inEnd), 'think.loop:0');
  // an hour hidden: the loop is still where its lap says
  const lap = 110 * 33.3333;
  assert.equal(at(p, inEnd + 100 * lap + 10 * 33.3334), 'think.loop:10');
  // switching to read waits for the seam at frame 54, then plays out and enters read
  const lapStart = p.start;
  p.want('read', lapStart);
  assert.equal(at(p, lapStart + 20 * 33.3334), 'think.loop:20');
  assert.equal(at(p, lapStart + 53 * 33.3334), 'think.loop:53');
  assert.equal(at(p, lapStart + 54 * 33.3334), 'think.out:0');
  assert.equal(at(p, lapStart + 54 * 33.3334 + 15 * 33.3334), 'read.in:0');
});

test('a switch to blocked cuts to a tail, keeping the frame it left under it for a while', () => {
  forgetLeftMark();
  const p = new MarkPlayer('code', 0, { resume: false });
  const loopStart = INTRO_MS + 16 * 33.3333;
  const t = loopStart + 10 * 33.3334;
  assert.equal(at(p, t), 'code.loop:10');
  assert.equal(p.frame(t).looping, true);
  assert.equal(p.nextChangeMs(t), Infinity, 'a loop still wanted changes only when something else is');
  p.want('blocked', t);
  const cut = p.frame(t);
  assert.equal(`${cut.sheet}:${cut.index}`, `code.loop:${75 - TAIL_FRAMES}`);
  assert.deepEqual(cut.stage, { kind: 'tail', body: 'code' });
  assert.equal(cut.start, t);
  assert.equal(cut.looping, false);
  assert.deepEqual(cut.ghost, { sheet: 'code.loop', index: 10, start: t }, 'the frame it cut from stays under the new one');
  assert.equal(p.nextChangeMs(t), GHOST_MS, 'it looks again when the old frame goes');
  assert.equal(p.frame(t + GHOST_MS - 1).ghost, cut.ghost);
  assert.equal(p.frame(t + GHOST_MS).ghost, null, 'the old frame goes after 360ms');
  assert.ok(Math.abs(p.nextChangeMs(t + GHOST_MS) - (TAIL_FRAMES * 33.3333 - GHOST_MS)) < 1e-6, 'then at the end of the tail');
  // the tail plays out, then the code mark leaves and blocked enters
  assert.equal(at(p, t + TAIL_FRAMES * 33.3334), 'code.out:0');
  assert.equal(CROSSFADE_MS, 300);
});

test('the playhead looks again at the end of a stage, or at the seam it plans to leave at', () => {
  forgetLeftMark();
  const p = new MarkPlayer('think', 0, { resume: false });
  p.frame(10);
  assert.ok(Math.abs(p.nextChangeMs(10) - (INTRO_MS - 10)) < 1e-6);
  const loopStart = INTRO_MS + 16 * 33.3333;
  p.frame(loopStart + 5);
  p.want('read', loopStart + 5);
  p.frame(loopStart + 5);
  assert.ok(Math.abs(p.nextChangeMs(loopStart + 5) - (54 * 33.3333 - 5)) < 1e-6, 'the seam at frame 54');
  assert.equal(p.nextChangeMs(loopStart + 60 * 33.3333), 0, 'never less than nothing');
  // a loop that is no longer wanted and has no seam plays to the end of its lap
  const r = new MarkPlayer('read', 0, { resume: false });
  const readLoop = INTRO_MS + 21 * 33.3333;
  r.frame(readLoop + 100);
  r.want('code', readLoop + 100);
  r.frame(readLoop + 100);
  assert.ok(Math.abs(r.nextChangeMs(readLoop + 100) - (60 * 33.3333 - 100)) < 1e-6);
});

test('a line that mounts right after another left picks up its mark; later, or when told not to, it starts over', () => {
  forgetLeftMark();
  const first = new MarkPlayer('think', 0);
  first.frame(600);
  first.leave(700);
  const resumed = new MarkPlayer('read', 700 + RESUME_MS - 1);
  assert.deepEqual(resumed.stage, first.stage);
  assert.equal(resumed.start, first.start);
  assert.equal(resumed.fresh, false);
  resumed.leave(700);
  assert.deepEqual(new MarkPlayer('read', 700 + RESUME_MS, { standalone: true }).stage, first.stage);
  const late = new MarkPlayer('read', 700 + RESUME_MS + 1, { standalone: true });
  assert.deepEqual(late.stage, { kind: 'grow' });
  assert.equal(late.fresh, true);
  assert.deepEqual(new MarkPlayer('read', 701, { resume: false, standalone: true }).stage, { kind: 'grow' });
  forgetLeftMark();
  assert.deepEqual(new MarkPlayer('code', 701, { standalone: true }).stage, { kind: 'grow' });
});

test('a mark that mounts while others show picks up the latest; a standalone one is never picked up', () => {
  forgetLeftMark();
  const a = new MarkPlayer('think', 0);
  a.frame(INTRO_MS + 1);
  const b = new MarkPlayer('read', 5_000);
  assert.equal(b.stage, a.stage, 'long after any mark left, it joins the one on screen');
  assert.equal(b.start, a.start);
  b.frame(5_000);
  const button = new MarkPlayer('default', 5_000, { standalone: true });
  assert.equal(button.stage, b.stage, 'the latest mark on screen');
  button.frame(9_000);
  button.leave(9_000);
  b.leave(9_000);
  a.leave(9_000);
  const next = new MarkPlayer('think', 9_100);
  assert.equal(next.start, a.start, 'the standalone mark left nothing behind: the last line did');
});

test('a loop that lapped on its own waits from the lap it is in when another activity is wanted', () => {
  forgetLeftMark();
  const p = new MarkPlayer('read', 0, { resume: false });
  const loopStart = INTRO_MS + 21 * 33.3333;
  const lap = 60 * 33.3333;
  // the loop laps on the compositor: nobody asks the playhead until the activity changes, laps later
  assert.equal(at(p, loopStart + 1), 'read.loop:0');
  const now = loopStart + 7 * lap + 10 * 33.3334;
  p.want('code', now);
  assert.equal(at(p, now), 'read.loop:10', 'not fast-forwarded as if code had been wanted since the first lap');
  assert.ok(Math.abs(p.nextChangeMs(now) - (loopStart + 8 * lap - now)) < 1e-6, 'it plays out the lap it is in');
  assert.equal(at(p, loopStart + 8 * lap + 1), 'read.out:0');
  // wanting what is already wanted changes nothing
  const before = p.start;
  p.want('code', loopStart + 99 * lap);
  assert.equal(p.start, before);
});

test('a mark that picks up a loop lapping on its own starts from the lap it is in, not one long gone', () => {
  forgetLeftMark();
  const status = new MarkPlayer('think', 0);
  const loopStart = INTRO_MS + 16 * 33.3333;
  const lap = 110 * 33.3333;
  assert.equal(at(status, loopStart + 1), 'think.loop:0');
  // the loop laps on the compositor for a while; nobody asks the status line's player
  const now = loopStart + 5 * lap + 10 * 33.3334;
  const row = new MarkPlayer('read', now);
  assert.equal(at(row, now), 'think.loop:10', 'the step row joins mid-lap instead of skipping into read');
  assert.ok(row.nextChangeMs(now) > 0, 'it waits for the seam');
  assert.equal(at(row, loopStart + 5 * lap + 54 * 33.3334), 'think.out:0', 'and leaves at the seam of the lap it is in');
  // the same through the mark a line leaves behind
  const later = now + 7 * lap;
  status.leave(later);
  row.leave(later);
  const next = new MarkPlayer('code', later + 1);
  assert.deepEqual(next.stage, { kind: 'loop', body: 'read' }, 'the row had gone on to lap read');
  assert.ok(later - next.start < 60 * 33.3333, 'it left the start of the lap it was in');
  assert.match(at(next, later + 1), /^read\.loop:/, 'so the new mark plays that lap out instead of skipping to code');
  forgetLeftMark();
  const alone = new MarkPlayer('think', 0);
  alone.frame(loopStart + 1);
  alone.leave(loopStart + 3 * lap + 5 * 33.3334);
  const after = new MarkPlayer('read', loopStart + 3 * lap + 5 * 33.3334);
  assert.equal(at(after, loopStart + 3 * lap + 5 * 33.3334), 'think.loop:5');
});

test('a loop without seams plays out before the next activity enters', () => {
  forgetLeftMark();
  const p = new MarkPlayer('read', 0, { resume: false });
  const loopStart = INTRO_MS + 21 * 33.3334;
  assert.equal(at(p, loopStart), 'read.loop:0');
  p.want('code', loopStart);
  assert.equal(at(p, loopStart + 30 * 33.3334), 'read.loop:30');
  assert.equal(at(p, loopStart + 60 * 33.3334), 'read.out:0');
});

test('the committed sheets are what scripts/gen-working-mark.mjs generates', async (t) => {
  const { OUTPUT, source, generate } = await import('../scripts/gen-working-mark.mjs');
  const { readFileSync } = await import('node:fs');
  const artifact = new URL('../src/components/thread/workingMark/markSheets.ts', import.meta.url);
  assert.equal(OUTPUT, 'src/components/thread/workingMark/markSheets.ts');
  const committed = readFileSync(artifact, 'utf8');
  assert.equal(committed, source());
  const { mkdtempSync, mkdirSync, cpSync, rmSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const dir = mkdtempSync(`${(await import('node:os')).tmpdir()}/mark-`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = `${dir}/sheets.ts`;
  const script = fileURLToPath(new URL('../scripts/gen-working-mark.mjs', import.meta.url));
  assert.equal(spawnSync(process.execPath, [script, out]).status, 0);
  assert.equal(readFileSync(out, 'utf8'), committed);
  generate(out);
  assert.equal(readFileSync(out, 'utf8'), committed);
  generate('', (destination, text) => {
    assert.equal(destination, fileURLToPath(artifact));
    assert.equal(text, committed);
  });
  const failure = new Error('The output cannot be written');
  assert.throws(
    () =>
      generate(undefined, () => {
        throw failure;
      }),
    (error) => error === failure,
  );
  assert.throws(() => generate(`${dir}/missing/sheets.ts`), { code: 'ENOENT' });
  assert.equal(readFileSync(artifact, 'utf8'), committed);
  // The CLI default is relative to its own repository, even when invoked from another working directory.
  const { dirname } = await import('node:path');
  for (const file of ['scripts/gen-working-mark.mjs', OUTPUT]) mkdirSync(dirname(`${dir}/${file}`), { recursive: true });
  cpSync(script, `${dir}/scripts/gen-working-mark.mjs`);
  assert.equal(spawnSync(process.execPath, [`${dir}/scripts/gen-working-mark.mjs`], { cwd: dir }).status, 0);
  assert.equal(readFileSync(`${dir}/${OUTPUT}`, 'utf8'), committed);
});
