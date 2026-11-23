// A unit test file that finished its tests but keeps running fails with what is still open, instead of stalling the run.
//
// node --test waits for each file's process to exit. A timer, socket or child process a teardown left referenced
// keeps it alive after its last test, and the whole run (main-unit-tests, #1759) waits forever with every test
// green. After the file's tests, an unreferenced timer is armed: a file that exits normally never sees it; one still
// running GRACE_MS later prints its open resources and its file, and exits 1 so the run names the file as failed.
import { after } from 'node:test';
import { processLabel } from './rss-watchdog.ts';

/** How long a file may keep running after its last test, unless UNIT_TEST_EXIT_GRACE_MS sets another positive number. */
export const DEFAULT_GRACE_MS = 15_000;

export function exitGraceMs(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.UNIT_TEST_EXIT_GRACE_MS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_MS;
}

/** What is still open, counted by kind ("Timeout ×2, TCPSocketWrap"). Read when the watchdog's own timer has fired, so it is not among them. */
export function openResources(kinds: string[]): string {
  const counts = new Map<string, number>();
  for (const k of kinds) counts.set(k, (counts.get(k) ?? 0) + 1);
  return [...counts].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ') || 'nothing node reports';
}

interface Deps {
  ms?: number;
  resources?: () => string[];
  write?: (text: string) => void;
  exit?: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => unknown };
  what?: string;
}

/** Arms the unreferenced timer that fails a file still running `ms` after its last test. */
export function armExitWatchdog({
  ms = exitGraceMs(),
  resources = () => process.getActiveResourcesInfo(),
  write = (text) => process.stderr.write(text),
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  what = processLabel(process.argv, process.cwd()),
}: Deps = {}) {
  const timer = setTimer(() => {
    // this timer has fired, so it is no longer among the resources
    write(
      `\n[exit-watchdog] ${what} finished its tests but was still running ${ms / 1000}s later. Still open: ` +
        `${openResources(resources())}. Close it in the test's teardown (#1759).\n`,
    );
    exit(1);
  }, ms);
  timer.unref?.();
  return timer;
}

/**
 * In a node --test file process, arms the watchdog once the file's tests are done; anywhere else, nothing. A script a
 * test starts inherits NODE_TEST_CONTEXT too, so the process must also be running a test file.
 */
export function startExitWatchdog(
  env: Record<string, string | undefined> = process.env,
  main: string | undefined = process.argv[1],
  hook: (fn: () => void) => void = after,
) {
  if (!env.NODE_TEST_CONTEXT || !/\.test\.[cm]?[jt]sx?$/.test(String(main))) return false;
  hook(() => {
    armExitWatchdog();
  });
  return true;
}
