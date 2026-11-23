// Runs the edge-case scenarios (docs/control-plane/edge-cases.md) on each cell inside the benchmark VM and writes
// bench/results/<run>/<cell>/<scenario>.json plus summary-<cells>.md. Refuses to start anywhere but a VM. Usage: bench/README.md.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CELLS, cellPort, edgePrompts, edgeTable, edgeTag, gradeEdge, parseEdgeArgs, scenarioUrl } from './lib/edge.mjs';
import { requireVm } from './lib/guard.mjs';
import { edgeTurn } from './drivers/edge.mjs';

requireVm('bench/edge-run.mjs');
const cfg = parseEdgeArgs(process.argv.slice(2));
await fetch(`${cfg.base}/`).catch(() => {
  throw new Error(`the fixtures are not served at ${cfg.base}: start node bench/edge-serve.mjs (bench/README.md)`);
});

/** Whether Chrome runs now: recorded when an offered action started it (the run never quits it, as it can't tell whose it is). */
const chromeRunning = () => {
  try {
    execFileSync('pgrep', ['-x', 'Google Chrome']);
    return true;
  } catch {
    return false;
  }
};

/** @type {any[]} */
const records = [];
for (const cellName of cfg.cells) {
  const cell = /** @type {any} */ (CELLS)[cellName];
  const dir = path.join(cfg.resultsDir, cellName);
  mkdirSync(dir, { recursive: true });
  for (const s of cfg.scenarios) {
    const tag = edgeTag(s.id, cellName);
    const url = scenarioUrl(s, cfg, tag);
    const events = async () =>
      /** @type {any[]} */ (await fetch(`${cfg.base}/api/events?run=${encodeURIComponent(tag)}`).then((r) => r.json()));
    const chromeBefore = chromeRunning();
    const shot = path.join(dir, `${s.id}.png`);
    /** @type {any} */
    let turn;
    try {
      turn = await edgeTurn({
        port: cellPort(cell, cfg.portOffset),
        cell,
        prompts: edgePrompts(s, url, !!cell.switchTo),
        timeoutS: cfg.timeoutS,
        crash: !!s.crash,
        events,
        shot,
        skipChrome: cfg.skipChrome,
        // an ACP cell puts its chat on Full access first (CELLS)
        mode: cell.mode,
      });
    } catch (e) {
      turn = { driverError: true, error: String(/** @type {Error} */ (e).message).slice(0, 500) };
    }
    if (!chromeBefore && chromeRunning()) turn.chromeStarted = true;
    const ev = await events().catch(() => []);
    const g = gradeEdge({ scenario: s, events: ev, turn, offered: turn.offered ?? [] });
    if (g.verdict === 'PASS') rmSync(shot, { force: true });
    const record = { scenario: s.id, edge: s.edge, cell: cellName, tag, url, ...g, events: ev, ...turn, run: cfg.run };
    writeFileSync(path.join(dir, `${s.id}.json`), JSON.stringify(record, null, 2));
    records.push(record);
    console.log(JSON.stringify({ scenario: s.id, cell: cellName, verdict: g.verdict, wallMs: turn.wallMs, why: g.why }));
  }
}
writeFileSync(path.join(cfg.resultsDir, `summary-${cfg.cells.join('-')}.md`), `${edgeTable(records, cfg.cells)}\n`);
