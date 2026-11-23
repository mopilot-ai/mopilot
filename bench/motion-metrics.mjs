// Measures motion recordings (the recorder's output; for the agent-cursor moments also the fixture page's events, renderer jank and the 12-Grid Bench records) and checks the measuring itself on a synthetic recording: decodes each with bench/motion/decode.swift and writes <moment>.metrics.json next to it. Reads files only; runs anywhere with Swift. Usage: bench/README.md.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BENCH_DIR } from './lib/config.mjs';
import { checkSynth, cursorSynthChecks, measureRecording, parseMetricsArgs, SYNTH_PALETTE, SYNTH_SPEC } from './lib/motion/cli.mjs';
import { parseFrames } from './lib/motion/frames.mjs';
import { measure, paletteFrom } from './lib/motion/measure.mjs';
import { manifestMotion } from './lib/motion/mgb.mjs';
import { momentById } from './lib/motion/moments.mjs';
import { loadPlanner } from './lib/motion/skyFit.mjs';
import { toolCallTimes } from './lib/motion/toolTimes.mjs';

const cfg = parseMetricsArgs(process.argv.slice(2));
const BIN = path.join(BENCH_DIR, 'results', '.bin');

/** Compiles bench/motion/<name>.swift once per source version; returns the binary. */
function tool(/** @type {string} */ name) {
  const src = path.join(BENCH_DIR, 'motion', `${name}.swift`);
  const hash = crypto.createHash('sha256').update(readFileSync(src)).digest('hex').slice(0, 12);
  const bin = path.join(BIN, `${name}-${hash}`);
  if (!existsSync(bin)) {
    mkdirSync(BIN, { recursive: true });
    // -suppress-warnings: the macOS 26 AVFoundation calls read as deprecated on macOS 27
    execFileSync('swiftc', ['-O', '-suppress-warnings', '-o', bin, src], { stdio: ['ignore', 'ignore', 'inherit'] });
  }
  return bin;
}

/** Decodes a recording (.mov or screencast folder) at the chosen scale, cached next to it until the recording is newer, and parses it. */
function decode(/** @type {string} */ mov, scale = cfg.scale, crop = '') {
  const frames = `${mov}.${scale}${crop}.frames`;
  // a folder's frames.json is rewritten with every capture into it
  const source = statSync(mov).isDirectory() ? path.join(mov, 'frames.json') : mov;
  const fresh = existsSync(frames) && statSync(frames).mtimeMs >= statSync(source).mtimeMs;
  if (!fresh)
    execFileSync(tool('decode'), [mov, frames, String(scale), ...(crop ? [crop] : [])], { stdio: ['ignore', 'ignore', 'inherit'] });
  return parseFrames(readFileSync(frames));
}

/** @type {(dir: string) => string[]} */
const filesUnder = (dir) =>
  readdirSync(dir).flatMap((n) => (statSync(path.join(dir, n)).isDirectory() ? filesUnder(path.join(dir, n)) : [path.join(dir, n)]));

if (cfg.selfCheck) {
  mkdirSync(BIN, { recursive: true });
  const mov = path.join(BIN, 'synth.mov');
  execFileSync(tool('synth'), [mov], { stdio: 'inherit' });
  const cursorMov = path.join(BIN, 'synth-cursor.mov');
  execFileSync(tool('synth'), [cursorMov, 'cursor'], { stdio: 'inherit' });
  const checks = [...checkSynth(measure(decode(mov), SYNTH_SPEC, { palette: SYNTH_PALETTE })), ...cursorSynthChecks(decode(cursorMov, 2))];
  for (const [what, ok] of checks) console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
}

if (cfg.mgb) {
  // a 12-Grid Bench run (#1381): each task run's recording parts scored, as <task>.motion.json beside its record
  let failed = 0;
  for (const file of filesUnder(cfg.mgb).filter((f) => f.endsWith('.rec.json'))) {
    try {
      const summary = manifestMotion(JSON.parse(readFileSync(file, 'utf8')), (part) => decode(path.join(path.dirname(file), part)));
      const out = file.replace(/\.rec\.json$/, '.motion.json');
      writeFileSync(out, `${JSON.stringify(summary, null, 1)}\n`);
      console.log(
        `${out}: longest still ${summary.longestStillMs} ms, ${summary.stillsOver3s} over 3 s, ${summary.droppedPerMin} drops/min`,
      );
    } catch (e) {
      // a broken manifest or a missing part leaves that run unscored; the rest of the run is still measured
      failed += 1;
      console.error(`${file}: not measured (${e instanceof Error ? e.message : e})`);
    }
  }
  process.exit(failed ? 1 : 0);
}

const palette = Object.assign({}, ...cfg.palettes.map((f) => paletteFrom(JSON.parse(readFileSync(f, 'utf8')))));
// the 12-Grid Bench run records (f4-week-plan, f2-onboarding) for the cost and pass-rate columns of cursor moments
const records = cfg.records
  ? filesUnder(cfg.records)
      .filter((f) => f.endsWith('.json') && !/\.(rec|motion|finish)\.json$/.test(f))
      .flatMap((f) => {
        try {
          const r = JSON.parse(readFileSync(f, 'utf8'));
          return typeof r?.task === 'string' && typeof r?.verdict === 'string' ? [r] : [];
        } catch {
          // a file that is not a run record is not one
          return [];
        }
      })
  : undefined;
const planner = await loadPlanner();
/** A sibling file of a recording named in its `files`, parsed; undefined when not recorded. */
const sibling = (/** @type {string} */ file, /** @type {string | null | undefined} */ name, /** @type {(text: string) => any} */ parse) =>
  name && existsSync(path.join(path.dirname(file), name)) ? parse(readFileSync(path.join(path.dirname(file), name), 'utf8')) : undefined;
for (const file of cfg.recordings) {
  const rec = JSON.parse(readFileSync(file, 'utf8'));
  const cursor = !!momentById(rec.moment).cursor;
  // a screen recording's .mov, or a screencast's frames folder; a cursor moment is decoded at scale 2 unless asked otherwise (positions need finer cells)
  // a cursor moment's frames are cropped to `rec.crop` ("WxH" from the top-left, in pixels) when the recording names one
  const video = decode(path.join(path.dirname(file), rec.media ?? rec.mov), cursor && !cfg.scaleGiven ? 2 : cfg.scale, rec.crop ?? '');
  const result = measureRecording(rec, video, Object.keys(palette).length ? palette : undefined, {
    planner,
    events: sibling(file, rec.files?.events, JSON.parse),
    jank: sibling(file, rec.files?.jank, JSON.parse),
    calls: rec.files?.transcriptKind
      ? sibling(file, rec.files?.transcript, (text) => toolCallTimes(rec.files.transcriptKind, text))
      : undefined,
    records,
  });
  const out = file.replace(/\.json$/, '.metrics.json');
  writeFileSync(out, `${JSON.stringify(result, null, 1)}\n`);
  console.log(`${out}${result.synced ? '' : ' (clock sync not seen: marks unused)'}`);
}
