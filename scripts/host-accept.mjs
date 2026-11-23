// The Host's real-machine acceptance run (docs/unit-coverage.md, release evidence): installs the Host on a machine with the app's own installer, pairs, runs a chat on the repo's fake ACP agent, kills the Host mid-turn, updates it, uninstalls it, and prints a PASS/FAIL table with timings.
//   node scripts/host-accept.mjs --vm mopilot-work          a Tart VM, through scripts/vm-exec.sh (hold the VM's lock: VMLOCK_VM=<vm> ~/bench/runner/vmlock.sh)
//   node scripts/host-accept.mjs --ssh user@host [--ssh-arg -p --ssh-arg 2222]   any machine over ssh
//   --milestone M1|M2|M4|M5|M6 runs the Remote Run scenarios of that milestone (design/remote-run/plan.md) after the install and pairing; --wait-pause <minutes> waits out the card clock in M1/S1; --harness claude|codex runs M1/S1 on that real harness (cheapest model, low effort, scratch repo; skipped when signed out) instead of the fake agent.
//   --app-repo <path> --away <minutes> (with --milestone M5) runs S11 with a real app: a checkout of this branch on the machine (npm ci done) where tests/e2e/host-local-quit.spec.ts starts a dev build with host.local on, quits it and kills it mid-turn, and opens it again after <minutes> (default 20 seconds; the plan says 5).
//   --matrix runs the Host side of the Remote Run acceptance matrix (design/remote-run/plan.md, Acceptance bar): the journey on each harness that can run here (fake; claude and codex when signed in), six chats at once, and a p50/p95 timings table; --runs <n> (default 5) sets the timing runs.
//   --cell <harness>/<J>[,…] runs only those cells of the matrix (e.g. codex/J5, multi/six, timings) after the setup; --stop-delay <ms> makes J5 wait that long after the turn's first frame before it stops (out of the turn's starting window); --trace <dir> writes, for each failing step, a JSON-lines file of every wire frame with its time, the journal of the chats it touched and the Host's log lines for them.
//   --milestone M4 --cloud oci --secrets <dir> [--dry] makes one Always Free machine at Oracle Cloud through the app's cloud launcher and runs S9 on it; --dry makes only GET calls and prints what the real run would do (the directory holds config.json and the key, read only to sign).
//   --keep leaves the Host installed afterwards; --only A3,A4 runs those steps (A1 to A3 always run first); --out report.md writes the table too.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createChannel, sshLauncher, vmLauncher } from './host-accept/channel.mjs';
import { hostPhoneCheck } from './host-phone-check.mjs';
import { exitCode, formatReport } from './host-accept/report.mjs';
import { STEPS, cleanup, removeTestAgent, session } from './host-accept/steps.mjs';
import { MILESTONES, isMilestone, milestoneSteps } from './host-accept/milestones/index.mjs';
import { createTrace, traceSummary } from './host-accept/trace.mjs';
import { MATRIX_CELLS, finishMatrix, matrixSteps } from './host-accept/matrix/index.mjs';
import { removePolicyFile } from './host-accept/milestones/policyFile.mjs';
import { cloudRun } from './host-accept/cloud/index.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A relative module a file loads: a static `from`, a bare `import '…'`, a dynamic `import()` or a CommonJS `require()`. */
const RELATIVE_LOAD = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;

/**
 * The files of the fake ACP agent: its own and every relative module it loads (ESM or CommonJS), as paths under the repository.
 * @param {string} entry @param {string} root
 */
export function fixtureClosure(entry, root = ROOT) {
  /** @type {Set<string>} */
  const seen = new Set();
  const visit = (/** @type {string} */ rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    for (const m of text.matchAll(RELATIVE_LOAD)) visit(path.relative(root, path.resolve(root, path.dirname(rel), m[1])));
  };
  visit(entry);
  return [...seen];
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const o = {
    vm: '',
    ssh: '',
    sshArgs: /** @type {string[]} */ ([]),
    keep: false,
    only: /** @type {string[]} */ ([]),
    out: '',
    milestone: '',
    waitPauseMin: 0,
    harness: '',
    appRepo: '',
    awayMin: 0,
    matrix: false,
    runs: 5,
    cell: /** @type {string[]} */ ([]),
    trace: '',
    stopDelayMs: 0,
    cloud: '',
    secrets: '',
    dry: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--keep') o.keep = true;
    else if (a === '--vm') o.vm = argv[++i];
    else if (a === '--ssh') o.ssh = argv[++i];
    else if (a === '--ssh-arg') o.sshArgs.push(argv[++i]);
    else if (a === '--only') o.only = argv[++i].split(',');
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--milestone') o.milestone = argv[++i];
    else if (a === '--matrix') o.matrix = true;
    else if (a === '--cell') o.cell = argv[++i].split(',');
    else if (a === '--stop-delay') o.stopDelayMs = Number(argv[++i]);
    else if (a === '--trace') o.trace = argv[++i];
    else if (a === '--runs') o.runs = Number(argv[++i]);
    else if (a === '--harness') o.harness = argv[++i];
    else if (a === '--wait-pause') o.waitPauseMin = Number(argv[++i]);
    else if (a === '--app-repo') o.appRepo = argv[++i];
    else if (a === '--cloud') o.cloud = argv[++i];
    else if (a === '--secrets') o.secrets = argv[++i];
    else if (a === '--dry') o.dry = true;
    else if (a === '--away') o.awayMin = Number(argv[++i]);
    else throw new Error(`Unknown option ${a}`);
  }
  if (o.milestone && !isMilestone(o.milestone)) throw new Error(`--milestone takes one of ${Object.keys(MILESTONES).join(', ')}.`);
  if (o.harness && !['claude', 'codex'].includes(o.harness)) throw new Error('--harness takes claude or codex.');
  if (o.harness && o.milestone !== 'M1') throw new Error('--harness belongs to --milestone M1.');
  if ((o.appRepo || o.awayMin) && o.milestone !== 'M5') throw new Error('--app-repo and --away belong to --milestone M5.');
  if (o.appRepo && !/^[A-Za-z0-9_./~-]+$/.test(o.appRepo)) throw new Error('--app-repo takes a plain path of a checkout on the machine.');
  if (!Number.isFinite(o.awayMin) || o.awayMin < 0) throw new Error('--away takes a number of minutes.');
  if (!Number.isInteger(o.runs) || o.runs < 1) throw new Error('--runs takes a whole number of runs, 1 or more.');
  if (!Number.isFinite(o.stopDelayMs) || o.stopDelayMs < 0) throw new Error('--stop-delay takes a number of milliseconds.');
  if (o.stopDelayMs && !o.matrix) throw new Error('--stop-delay belongs to --matrix.');
  if (o.cell.length && !o.matrix) throw new Error('--cell belongs to --matrix.');
  const unknown = o.cell.filter((c) => !MATRIX_CELLS.includes(c));
  if (unknown.length) throw new Error(`--cell takes ${MATRIX_CELLS.join(', ')} (got ${unknown.join(', ')}).`);
  if (o.matrix && (o.milestone || o.only.length)) throw new Error('--matrix is a run of its own: not with --milestone or --only.');
  if (!Number.isFinite(o.waitPauseMin) || o.waitPauseMin < 0) throw new Error('--wait-pause takes a number of minutes.');
  if (o.cloud) {
    if (o.cloud !== 'oci') throw new Error('--cloud takes oci.');
    if (o.milestone !== 'M4') throw new Error('--cloud belongs to --milestone M4.');
    if (!o.secrets) throw new Error('--cloud takes --secrets <dir>: the directory with config.json and the key.');
    if (o.vm || o.ssh || o.matrix || o.only.length || o.keep)
      throw new Error('--cloud makes its own machine: not with --vm, --ssh, --matrix, --only or --keep.');
    return o;
  }
  if (o.secrets || o.dry) throw new Error('--secrets and --dry belong to --cloud.');
  if (Boolean(o.vm) === Boolean(o.ssh)) throw new Error('Name the machine with exactly one of --vm <mopilot-*> or --ssh <destination>.');
  return o;
}

/**
 * Run the steps in order and time each. A fatal step that fails ends the run (the rest are skipped); `only` limits the run to those steps and the fatal ones before them.
 * A step that returns `{ skip }` is reported as SKIP with that text (a gap the run cannot close), not as a pass.
 * @param {object} o
 * @param {typeof STEPS} o.steps @param {any} o.ctx @param {string[]} [o.only] @param {() => number} [o.now]
 */
export async function runSteps({ steps, ctx, only = [], now = Date.now }) {
  /** @type {import('./host-accept/report.mjs').Row[]} */
  const rows = [];
  let stopped = false;
  for (const step of steps) {
    if (only.length && !only.includes(step.id) && !step.fatal) continue;
    if (stopped) {
      rows.push({ id: step.id, title: step.title, status: 'SKIP', ms: 0, detail: 'an earlier required step failed' });
      continue;
    }
    const started = now();
    ctx.trace?.begin(step.id);
    try {
      const result = await step.run(ctx);
      const skipped = typeof result === 'object' && result !== null;
      rows.push({
        id: step.id,
        title: step.title,
        status: skipped ? 'SKIP' : 'PASS',
        ms: now() - started,
        detail: skipped ? result.skip : result,
      });
    } catch (e) {
      const message = /** @type {Error} */ (e).message;
      const note = ctx.trace ? await ctx.trace.finish(ctx, message, { session }) : '';
      rows.push({ id: step.id, title: step.title, status: 'FAIL', ms: now() - started, detail: `${message}${note}` });
      stopped = Boolean(step.fatal);
    }
  }
  return rows;
}

/** The acceptance run's client key is a throwaway in its own output folder: sealed only because loadIdentity never keeps one unsealed. */
export const throwawayKeySafe = {
  isEncryptionAvailable: () => true,
  encryptString: (/** @type {string} */ s) => Buffer.from(s),
  decryptString: (/** @type {Buffer} */ b) => b.toString(),
};

/** The app's own pieces the steps use, and the files they read. */
export function realDeps() {
  const { buildBundle } = require('../electron/host/bundle.cjs');
  const { createInstaller } = require('../electron/host/install.cjs');
  const { loadIdentity, pairWith, authenticate } = require('../electron/host/pairingClient.cjs');
  return {
    buildBundle,
    createInstaller,
    loadIdentity,
    keySafe: throwawayKeySafe,
    pairWith,
    authenticate,
    helloParams: () => require('../shared/host/schema.mjs').helloParams(),
    phoneCheck: hostPhoneCheck,
    readFile: (/** @type {string} */ file) => fs.readFileSync(file),
    agentFiles: () =>
      fixtureClosure('tests/fixtures/fake-acp-agent.mjs').map((rel) => ({ rel, data: fs.readFileSync(path.join(ROOT, rel)) })),
  };
}

/** How the machine named on the command line is reached. @param {ReturnType<typeof parseArgs>} o */
export function channelFor(o) {
  return createChannel({ launcher: o.vm ? vmLauncher(o.vm, path.join(ROOT, 'scripts/vm-exec.sh')) : sshLauncher(o.ssh, o.sshArgs) });
}

/**
 * @param {string[]} argv
 * @param {{ out: (text: string) => unknown, deps: () => ReturnType<typeof realDeps>, channelFor: typeof channelFor, cloud?: Partial<import('./host-accept/cloud/deps.mjs').CloudDeps> }} io everything the run touches, so a test can bring a stand-in machine
 */
export async function main(argv, io) {
  const o = parseArgs(argv);
  if (o.cloud) {
    const out = (/** @type {string} */ text) => (io.out(text), o.out ? fs.writeFileSync(o.out, text) : undefined);
    return cloudRun(o, { ...io, out, root: ROOT }, runSteps);
  }
  const target = o.vm || o.ssh;
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-'));
  const ctx = {
    m: io.channelFor(o),
    deps: io.deps(),
    root: ROOT,
    outDir,
    target,
    nonce: path.basename(outDir).slice(-6),
    state: {},
    opts: {
      waitPauseMin: o.waitPauseMin,
      harness: o.harness,
      appRepo: o.appRepo,
      awayMin: o.awayMin,
      runs: o.runs,
      stopDelayMs: o.stopDelayMs,
    },
    trace: o.trace ? createTrace({ dir: path.resolve(o.trace) }) : undefined,
  };
  const rows = await runSteps({
    steps: o.matrix ? matrixSteps(o.cell) : o.milestone ? milestoneSteps(/** @type {keyof typeof MILESTONES} */ (o.milestone)) : STEPS,
    ctx,
    only: o.only,
  });
  // the policy file of M6 is the machine's, not the Host's: it goes whatever the steps did
  await removePolicyFile(ctx);
  const matrixEnd = await finishMatrix(ctx);
  // a kept Host keeps nothing of the run's own: its test agent goes either way
  if (!o.keep) await cleanup(ctx);
  else await removeTestAgent(ctx, { restartHost: true });
  const report = `${formatReport({ target, rows, platform: ctx.state.platform })}${matrixEnd}${traceSummary(ctx)}`;
  io.out(report);
  if (o.out) fs.writeFileSync(o.out, report);
  fs.rmSync(outDir, { recursive: true, force: true });
  return exitCode(rows);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), { out: (text) => process.stdout.write(`${text}\n`), deps: realDeps, channelFor }).then(
    (code) => (process.exitCode = code),
    (e) => {
      process.stderr.write(`host-accept: ${e.message}\n`);
      process.exitCode = 2;
    },
  );
}
