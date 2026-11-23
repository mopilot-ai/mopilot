// Compares two arms' cursor-moment recordings (bench/motion-metrics.mjs output): prints the vendor / MoPilot / delta table per moment and the per-move alignment against the tolerance, and writes the overlay page. Reads files only; runs anywhere. Usage: bench/README.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseReportArgs } from './lib/motion/cli.mjs';
import { CURSOR_MOMENTS } from './lib/motion/moments.mjs';
import { formatReport, momentReport, overlayHtml } from './lib/motion/report.mjs';

const cfg = parseReportArgs(process.argv.slice(2));
const analysisOf = (/** @type {string} */ dir, /** @type {string} */ moment) => {
  const file = path.join(dir, `${moment}.metrics.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')).analysis ?? null) : null;
};

const reports = [];
for (const moment of cfg.moments ?? CURSOR_MOMENTS.map((m) => m.id)) {
  const vendor = analysisOf(cfg.vendor.dir, moment);
  const ours = analysisOf(cfg.ours.dir, moment);
  // a moment only one side recorded is listed, not compared
  if (!vendor || !ours) console.error(`${moment}: ${vendor ? cfg.ours.label : cfg.vendor.label} has no measured recording; skipped`);
  else reports.push(momentReport(moment, vendor, ours, cfg.tolerance));
}
if (!reports.length) {
  console.error('no moment was measured on both sides: run bench/motion-metrics.mjs on the recordings first');
  process.exit(1);
}
console.log(formatReport(reports, { vendor: cfg.vendor.label, ours: cfg.ours.label, tolerance: cfg.tolerance }));
if (cfg.out) {
  mkdirSync(cfg.out, { recursive: true });
  writeFileSync(path.join(cfg.out, 'overlay.html'), overlayHtml(reports, { vendor: cfg.vendor.label, ours: cfg.ours.label }));
  writeFileSync(path.join(cfg.out, 'report.json'), `${JSON.stringify(reports, null, 1)}\n`);
  console.log(`wrote ${path.join(cfg.out, 'overlay.html')}`);
}
