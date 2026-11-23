// The real cloud acceptance run (S9): the dry checks first (nothing is launched if one fails), then one machine at Oracle Cloud through the app's launcher, the cells on it, and, whatever happened, its deletion and a read of the compartment that proves it is empty.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exitCode, formatReport } from '../report.mjs';
import { cloudSteps } from './cloudSteps.mjs';
import { drySteps } from './dry.mjs';
import { LIMITS } from './limits.mjs';
import { tearDown } from './teardown.mjs';
import { launcherFor } from './ssh.mjs';

/** What this run cannot show, in every cloud report. */
export const CLOUD_NOT_VERIFIED = Object.freeze([
  'NOT COVERED: boot from a released Host bundle. The machine boots a stock Ubuntu image with a throwaway SSH key injected at launch (deleted at teardown), and the Host is installed over SSH with the app’s own installer, as host-accept A3 does',
  'The Host’s dial-out through MoPilot’s relay: the app’s relay boot needs the signed-in account’s token, so this run joins the machine over SSH with a stand-in boot (the launcher, adapter, wake and installer are the app’s own)',
  'Real Claude Code and Codex turns on the machine (no credential is lent without a sign-in on it)',
  'The app’s own window and the phone: the run speaks to the Host’s socket over SSH',
  'Any provider, region or shape other than the one named in the header',
]);

/** @param {number | undefined} ms */
const sec = (ms) => (ms === undefined || Number.isNaN(ms) ? 'not reached' : `${(ms / 1000).toFixed(1)} s`);

/** The timings the plan asks for, from the moments the run kept. @param {Record<string, number>} t @param {number} teardownMs */
export function timingsText(t, teardownMs) {
  const rows = [
    ['create→running', t.running - t.create],
    ['running→SSH answers', t.ssh - t.running],
    ['SSH answers→Host answering (install)', t.hostAnswered - t.ssh],
    ['stop→provider shows STOPPED', t.stop],
    ['wake→Host answering', t.wakeHost],
    ['wake→first frame of the turn', t.wakeFrame],
    ['terminate→compartment empty', teardownMs],
  ];
  return [
    '',
    '#### Timings',
    '',
    '| Interval | Time |',
    '| --- | --- |',
    ...rows.map(([name, ms]) => `| ${name} | ${sec(/** @type {number} */ (ms))} |`),
  ].join('\n');
}

/**
 * @param {object} p
 * @param {any} p.config @param {(text: string) => string} p.sign @param {any} p.call @param {ReturnType<typeof import('./readers.mjs').createReaders>} p.readers
 * @param {import('./deps.mjs').CloudDeps} p.deps @param {{ out: (text: string) => unknown, root: string, deps: () => any }} p.io
 * @param {(o: { steps: any[], ctx: any }) => Promise<any[]>} p.runSteps
 */
export async function realRun({ config, sign, call, readers, deps, io, runSteps }) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-accept-cloud-'));
  const target = `oci ${config.region} (${LIMITS.size})`;
  try {
    const dry = { root: io.root, cloud: { config, readers, look: null } };
    const pre = await runSteps({ steps: drySteps(), ctx: dry });
    if (pre.some((r) => r.status === 'FAIL')) {
      io.out(`${formatReport({ target, rows: pre, notVerified: CLOUD_NOT_VERIFIED })}\nNothing was launched: a check above failed.`);
      return 1;
    }
    const { keyFile, pub } = deps.keygen(outDir);
    /** The run's own state: what the steps, the boot and the teardown share. */
    const cloud = {
      config,
      sign,
      call,
      readers,
      deps,
      pollMs: deps.pollMs,
      ads: /** @type {any} */ (dry.cloud.look).ads,
      addr: { ip: '' },
      keyFile,
      pub,
      t: /** @type {Record<string, number>} */ ({}),
      made: null,
      launchesFile: path.join(outDir, 'launches.json'),
    };
    const ctx = {
      m: deps.makeChannel(launcherFor(cloud.addr, keyFile)),
      deps: io.deps(),
      root: io.root,
      outDir,
      target: '',
      nonce: path.basename(outDir).slice(-6),
      state: /** @type {Record<string, any>} */ ({}),
      opts: { waitPauseMin: 0, harness: '', appRepo: '', awayMin: 0, runs: 1, stopDelayMs: 0 },
      cloud,
    };
    /** @type {Promise<{ ok: boolean, ms: number, detail: string }> | null} */
    let teardown = null;
    // one teardown, whoever asks first: the end of the run or a Ctrl-C
    const down = () => (teardown ??= tearDown(cloud));
    const onSignal = () => void down().then(() => deps.exit(130));
    deps.signals.once('SIGINT', onSignal);
    deps.signals.once('SIGTERM', onSignal);
    /** @type {any[]} */
    let rows = [];
    try {
      rows = await runSteps({ steps: cloudSteps(deps.hostStep), ctx });
    } catch (error) {
      rows = [{ id: 'C0', title: 'The run itself', status: 'FAIL', ms: 0, detail: /** @type {Error} */ (error).message }];
    } finally {
      deps.signals.off('SIGINT', onSignal);
      deps.signals.off('SIGTERM', onSignal);
    }
    const gone = await down();
    rows.push({
      id: 'C6',
      title: 'M4/S9 Teardown: the machine and its disk are deleted and the compartment is empty',
      status: gone.ok ? 'PASS' : 'FAIL',
      ms: gone.ms,
      detail: gone.detail,
    });
    io.out(
      `${formatReport({ target, rows: [...pre, ...rows], platform: ctx.state.platform, notVerified: CLOUD_NOT_VERIFIED })}${timingsText(cloud.t, gone.ms)}`,
    );
    return exitCode([...pre, ...rows]);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}
