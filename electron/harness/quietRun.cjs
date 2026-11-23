// An update nobody watches (Update all): the command with stdin closed and no colours, its output kept as a run's,
// ended after a timeout. Started through spawnArgs, so a Windows .cmd shim and macOS's disclaim launcher work.
const { clock } = require('../platform/ports/clock.cjs');
const { proc: childProcess } = require('../platform/ports/proc.cjs');
const { spawnArgs, spawnGroup, retireGroup, processCompletion, ensureRetirementMonitor } = require('../platform/winbin.cjs');
const { userError } = require('../../shared/userError.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** How long a quiet update may take: a download, or Homebrew updating itself first. */
const QUIET_TIMEOUT_MS = 10 * 60_000;

/** What a quiet update runs with on top of the login shell's environment: nothing asks, nothing colours. */
const QUIET_ENV = { NONINTERACTIVE: '1', HOMEBREW_NO_ENV_HINTS: '1', NO_COLOR: '1', CI: '1' };

/**
 * @param {string[]} argv
 * @param {{ cwd: string, env: Record<string, string>, timeoutMs?: number }} o
 * @param {{ onData: (d: string) => void, onExit: (e: { exitCode: number | null }) => void, onStopping?: () => void }} on
 * @param {{ spawn?: typeof childProcess.spawn, kill?: (p: any) => unknown, args?: typeof spawnArgs }} [io]
 * @returns {{ kill: () => void }}
 */
function spawnQuiet(argv, o, on, { spawn = childProcess.spawn, kill = retireGroup, args = spawnArgs } = {}) {
  if (kill === retireGroup) ensureRetirementMonitor();
  const child = spawnGroup(
    spawn,
    argv[0],
    argv.slice(1),
    {
      cwd: o.cwd,
      env: { ...o.env, ...QUIET_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      managed: true,
    },
    args,
  );
  const limit = o.timeoutMs ?? QUIET_TIMEOUT_MS;
  let stopped = false;
  let failed = false;
  const completion = processCompletion({
    retire: () => kill(child),
    onComplete: (code) => on.onExit({ exitCode: stopped || failed ? null : code }),
    onError: (error) => {
      noteIgnored('verify package process cleanup', error);
      on.onData(`\r\n[process cleanup failed: ${userError(error)}]\r\n`);
    },
  });
  const stop = () => {
    stopped = true;
    on.onStopping?.();
    completion.request();
  };
  const timer = clock.setTimeout(() => {
    on.onData(`\r\n[stopping after ${Math.round(limit / 60_000)} minutes]\r\n`);
    stop();
  }, limit);
  child.stdout?.on('data', (/** @type {Buffer} */ d) => on.onData(String(d)));
  child.stderr?.on('data', (/** @type {Buffer} */ d) => on.onData(String(d)));
  child.on('error', (/** @type {Error} */ e) => {
    noteIgnored('start a package command', e);
    on.onData(`\r\n${userError(e)}\r\n`);
    failed = true;
  });
  child.on('exit', () => completion.request());
  child.on('close', (/** @type {number | null} */ exitCode) => {
    clock.clearTimeout(timer);
    completion.close(exitCode);
  });
  return { kill: stop };
}

module.exports = { spawnQuiet, QUIET_ENV, QUIET_TIMEOUT_MS };
