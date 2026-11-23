// Harness version contract (#1321) × MoPilot 12-Grid Bench (#1381): the MGB smoke tier as a contract suite, one run
// per grid cell of the harness's columns against the scratch instances, each failure re-run once, summarized as items.
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { HARNESSES, newPids, seedUiState } from './contract.mjs';
import { CELLS } from './edge.mjs';

/** The MGB column of each edge cell the contract runs (opencode is the ACP column). */
export const MGB_COLUMN_OF = { claude: 'claude', codex: 'codex', switch: 'switch', opencode: 'acp' };

/**
 * The MGB records of a run as contract items: FAIL and UNSAFE are failing (UNSAFE always, a safety regression is never
 * "known"), UNGRADABLE makes the run incomplete, N/A is neither. An UNSAFE item names its violations.
 * @param {any[]} records
 */
export function summarizeMgb(records) {
  if (!records.length) return { verdict: 'error', why: 'the MGB smoke run wrote no records', items: [] };
  /** @type {import('./contractSuites.mjs').Item[]} */
  const items = records.map((r) => ({
    key: `mgb:${r.column}:${r.task}`,
    suite: 'mgb',
    id: r.task,
    cell: r.column,
    verdict: r.verdict,
    failing: r.verdict === 'FAIL' || r.verdict === 'UNSAFE',
    ...(r.verdict === 'UNGRADABLE' ? { ungradable: true } : {}),
    why: [...(r.why ?? []), ...(r.violations ?? []).map((/** @type {any} */ v) => `violation: ${v.title}`)].slice(0, 8),
    rows: [],
  }));
  return { verdict: items.some((i) => i.failing) ? 'fail' : 'pass', items };
}

/**
 * The MGB arguments for the contract's instances: the harness's columns, each on its instance's port (the switch cell
 * shares the Claude Code instance), the MGB fixtures' port, the results folder and the run name.
 * @param {{ kind: string, portOffset: number, timeoutS: number, skipChrome?: boolean }} opts
 * @param {{ mgbResults: string }} p @param {number} fixturesPort @param {string} run
 * @param {{ tasks?: string[], columns?: string[] }} [only] a re-run of the failed tasks on their columns
 */
export function mgbArgs(opts, p, fixturesPort, run, only = {}) {
  const cells = HARNESSES[opts.kind].cells;
  const columns = only.columns ?? cells.map((c) => /** @type {any} */ (MGB_COLUMN_OF)[c]);
  const ports = cells.map(
    (c) => `${/** @type {any} */ (MGB_COLUMN_OF)[c]}=${Number(/** @type {any} */ (CELLS)[c].port) + opts.portOffset}`,
  );
  return [
    'bench/mgb-run.mjs',
    '--tier',
    'smoke',
    '--columns',
    columns.join(','),
    '--ports',
    ports.join(','),
    '--port',
    String(fixturesPort),
    '--run',
    run,
    '--results',
    p.mgbResults,
    // each MGB task is long: the edge timeout stretched to the bench's own default
    '--timeout',
    String(Math.max(opts.timeoutS, 900)),
    ...(only.tasks ? ['--tasks', only.tasks.join(',')] : []),
    ...(opts.skipChrome ? ['--skip-chrome'] : []),
  ];
}

/**
 * Runs the MGB smoke tier against the version under test: its own fixture server (a fresh grader token), the scratch
 * instances seeded like the edge suite's, every failure re-run once (the second verdict counts, both are kept).
 * @param {{ kind: string, root: string, portOffset: number, fixturesPort: number, timeoutS: number, skipChrome?: boolean, keep?: boolean }} opts
 * @param {{ bin: string, instances: { port: string, userData: string }[], mgbResults: string, chromeProfile: string }} p
 * @param {any} d the contract runner's dependencies (bench/drivers/contract.mjs)
 */
export async function mgbSuite(opts, p, d) {
  const cells = HARNESSES[opts.kind].cells;
  if (!cells.length) return { verdict: 'skip', why: 'the bench has no column for this harness yet', items: [] };
  const name = `${opts.kind.replace(':', '-')}-mgb`;
  const fixturesPort = opts.fixturesPort + 10;
  const token = randomBytes(18).toString('base64url');
  /** @type {{ stop: () => Promise<void> }[]} */
  const handles = [];
  // as the edge suite: every Chrome running now is someone else's, one that appears during the run is quit at the end
  const chromes = d.chromePids();
  try {
    handles.push(await d.startMgbFixtures({ port: fixturesPort, token }));
    for (const inst of p.instances) {
      d.fs.mkdir(inst.userData);
      d.fs.writeFile(path.join(inst.userData, 'ui-state.json'), JSON.stringify(seedUiState(opts.kind, p.bin)));
      handles.push(await d.startInstance({ ...inst, chromeProfile: p.chromeProfile }));
    }
    const run = (/** @type {string} */ r, /** @type {{ tasks?: string[], columns?: string[] }} */ only = {}) =>
      d.exec(d.node, mgbArgs(opts, p, fixturesPort, r, only), { cwd: opts.root, env: { MGB_TOKEN: token }, timeoutMs: 4 * 3600 * 1000 });
    const records = (/** @type {string} */ r) => {
      const dir = path.join(p.mgbResults, r);
      /** @type {any[]} */
      const out = [];
      // the harness's columns, as the edge suite reads its cells: a column that wrote nothing has no records
      for (const col of cells.map((c) => /** @type {string} */ (/** @type {any} */ (MGB_COLUMN_OF)[c]))) {
        for (const f of safeReaddir(d, path.join(dir, col))) {
          if (!f.endsWith('.json') || f.endsWith('.state.json')) continue;
          try {
            out.push(JSON.parse(d.fs.readFile(path.join(dir, col, f))));
          } catch {
            // half a record (the run was stopped while writing it) is ungradable, not dropped
            out.push({ task: f.replace(/\.json$/, ''), column: col, verdict: 'UNGRADABLE', why: ['unreadable record'] });
          }
        }
      }
      return out;
    };
    await run(name);
    const first = records(name);
    const s1 = summarizeMgb(first);
    const failed = s1.items.filter((i) => i.failing || i.ungradable);
    if (!failed.length) return s1;
    const retry = `${name}-retry`;
    await run(retry, {
      tasks: [...new Set(failed.map((i) => i.id))],
      columns: [...new Set(failed.map((i) => /** @type {string} */ (i.cell)))],
    });
    const again = new Map(records(retry).map((r) => [`${r.column}:${r.task}`, r]));
    const final = first.map((r) => again.get(`${r.column}:${r.task}`) ?? r);
    const s2 = summarizeMgb(final);
    for (const i of s2.items) {
      const before = first.find((r) => `${r.column}:${r.task}` === `${i.cell}:${i.id}`);
      if (again.has(`${i.cell}:${i.id}`)) i.attempts = [before.verdict, i.verdict];
    }
    return s2;
  } finally {
    for (const h of handles.reverse()) await h.stop();
    d.quitPids(newPids(chromes, d.chromePids()));
  }
}

/** A folder's entries, or none when it does not exist. @param {any} d @param {string} dir */
function safeReaddir(d, dir) {
  try {
    return d.fs.readdir(dir);
  } catch {
    return [];
  }
}
