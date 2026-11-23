// Loaded into test runners and test-file processes (--require): exits once the process that started it is gone.
// A coverage or `npm test` run waits for its tests in spawnSync, so a SIGTERM or timeout that ended it left the
// test processes running, still writing raw coverage into a folder no one would clean up.

/** Poll the parent's id and exit when it changes (the parent died and the process was re-parented). */
export function exitWithParent({ ppid = () => process.ppid, exit = process.exit.bind(process), every = setInterval, ms = 1000 } = {}) {
  const parent = ppid();
  const timer = every(() => {
    if (ppid() !== parent) exit(143);
  }, ms);
  timer.unref();
  return timer;
}

exitWithParent();
