#!/usr/bin/env node
// Runs the conformance probes against the real CLI installed on this machine. Costs tokens,
// so it is not part of `npm test` or CI. See tests/conformance/README.md.
//   npm run conformance -- --harness claude|codex [--only C4,C9] [--model m] [--effort e] [--bin path] [--out dir] [--keep] [--record-protected]
import fs from 'node:fs';
import path from 'node:path';
import {
  parseArgs,
  makeCtx,
  runProbe,
  writeResults,
  summaryTable,
  snapshotProtected,
  changedProtected,
  protectedFailure,
  REPO,
} from './lib/common.mjs';
import { requireRelease, insideVirtualMachine } from '../../scripts/release-suites.cjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

let opts;
try {
  opts = parseArgs(process.argv.slice(2));
} catch (e) {
  console.error(String(e.message));
  console.error(
    'usage: npm run conformance -- --harness claude|codex [--only C1,C3] [--model m] [--effort e] [--bin path] [--out dir] [--keep]',
  );
  process.exit(2);
}

try {
  requireRelease('The conformance suite', 'drives the real Claude Code and Codex CLIs on this computer and spends tokens on your login');
} catch (e) {
  console.error(String(e.message));
  process.exit(2);
}

if (opts.recordProtected && !insideVirtualMachine()) {
  console.error('--record-protected runs only inside the benchmark VM: on a real computer the protected files are your own');
  process.exit(2);
}

const kind = opts.harness;
const lib = await import(`./lib/${kind}.mjs`);
const found = lib.findBinary(opts.bin);
if (!found?.version) {
  console.error(`no ${kind} CLI found${opts.bin ? ` at ${opts.bin}` : ''}; pass --bin`);
  process.exit(2);
}
opts.binPath = found.path;
opts.cliVersion = found.version;

const dir = path.join(HERE, kind);
const ids = fs
  .readdirSync(dir)
  .filter((f) => /^[CX]\d+\.mjs$/.test(f))
  .map((f) => f.slice(0, -4))
  .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
const unknown = (opts.only ?? []).filter((id) => !ids.includes(id));
if (unknown.length) {
  console.error(`unknown check ids for ${kind}: ${unknown.join(', ')} (have ${ids.join(', ')})`);
  process.exit(2);
}
const selected = opts.only ? ids.filter((id) => opts.only.includes(id)) : ids;

const tag = `${kind}@${opts.cliVersion}`;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logDir = path.join(REPO, 'conformance/logs', tag, runId);
console.log(`${tag} (${found.path}) model=${opts.model} effort=${opts.effort} checks=${selected.join(',')}`);
console.log(`logs: ${path.relative(REPO, logDir)}`);

let before = snapshotProtected();
const results = [];
for (const id of selected) {
  const mod = await import(path.join(dir, `${id}.mjs`));
  process.stdout.write(`${id} ${mod.title} ... `);
  const ctx = makeCtx({ kind, mod, opts, logDir });
  let r = await runProbe(mod, ctx);
  const changed = changedProtected(before);
  if (changed.length && opts.recordProtected) {
    // the VM's own config: the write fails this check, and the next check starts from the files as they are now
    r = protectedFailure(r, changed);
    before = snapshotProtected();
  }
  console.log(`${r.verdict} (${r.seconds}s)`);
  results.push(r);
  if (changed.length && !opts.recordProtected) {
    console.error(`\nSTOP: protected config changed during ${id}: ${changed.join(', ')}`);
    results.push({ id, title: 'safety', verdict: 'error', observed: { protectedChanged: changed }, evidence: [] });
    break;
  }
}

const header = { kind, cli: opts.cliVersion, bin: path.basename(found.path), ...(lib.sdkVersion ? { sdk: lib.sdkVersion } : {}) };
const file = path.join(opts.out, `${tag}.json`);
writeResults(
  file,
  header,
  results.filter((r) => r.title !== 'safety'),
);
console.log('\n' + summaryTable(results));
console.log(`\nresults: ${path.relative(process.cwd(), file)}`);
process.exit(results.some((r) => r.verdict !== 'pass' && r.verdict !== 'skip') ? 1 : 0);
