#!/usr/bin/env node
// Reports how much of the interface each language covers; --missing <tag> lists what still needs translating (docs/i18n.md).
import { fileURLToPath } from 'node:url';
import { catalogReport, reportLines, sourceMessages } from './catalog.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const report = catalogReport(root);
if (args[0] === '--missing') {
  const language = report.find(({ tag }) => tag === args[1]);
  if (!language) throw new Error(`No language ${args[1]}`);
  console.log(JSON.stringify(language.missing, null, 1));
} else {
  const { lines, ok } = reportLines(report, sourceMessages(root).length);
  console.log(lines.join('\n'));
  process.exitCode = Number(!ok);
}
