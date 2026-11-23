// Prints a run's arm x benchmark table, or compares two runs for a pull request. Reads result files only, so it runs
// anywhere. Usage: node bench/report.mjs <results/run> [--before <results/base-run>]
import { compareRuns, loadRun, summaryTable } from './lib/report.mjs';

const args = process.argv.slice(2);
const i = args.indexOf('--before');
const before = i >= 0 ? args.splice(i, 2)[1] : null;
if (args.length !== 1 || (i >= 0 && !before)) throw new Error('usage: node bench/report.mjs <results/run> [--before <results/base-run>]');
const run = loadRun(args[0]);
console.log(before ? compareRuns(loadRun(before), run) : summaryTable(run));
