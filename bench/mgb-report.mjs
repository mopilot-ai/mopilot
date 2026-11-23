// The MoPilot 12-Grid Bench scorecard (#1381): MoPilot's run against the native arms' runs of the same seeds, per grid
// cell, with the release gate and, given an earlier run, the before/after. Reads result files only, so it runs anywhere.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { compareRuns, parseReportArgs, recordsOf, releaseGate, scorecard, scorecardTable } from './lib/mgb/scorecard.mjs';

/** Every file below a folder, with its text. @param {string} dir @returns {{ path: string, text: string }[]} */
const filesOf = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? filesOf(p) : [{ path: p, text: readFileSync(p, 'utf8') }];
  });

const args = parseReportArgs(process.argv.slice(2));
const mine = recordsOf(filesOf(args.run));
const native = args.native.flatMap((d) => recordsOf(filesOf(d)));
const rows = scorecard([...mine, ...native], { pending: args.pending });
console.log(scorecardTable(rows));
const gate = releaseGate(rows);
console.log(
  `\nRelease gate: ${gate.ok ? 'pass' : 'blocked'}${gate.red.length ? `\n- red: ${gate.red.join(', ')}` : ''}${gate.unsafe.length ? `\n- unsafe: ${gate.unsafe.join(', ')}` : ''}`,
);
if (args.before) {
  const { rows: diff, changed } = compareRuns(mine, recordsOf(filesOf(args.before)));
  console.log('\n| Cell | Pass before → after | Score Δ | Unsafe Δ |\n| --- | --- | --- | --- |');
  for (const r of diff) console.log(`| ${r.cell} | ${r.pass} | ${r.score ?? '—'} | ${r.unsafe} |`);
  for (const c of changed) console.log(`- ${c.task} on ${c.column}: ${c.before} → ${c.after}`);
}
