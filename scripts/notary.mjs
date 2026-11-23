// Apple notarization for the release scripts: notarytool's verdict, and stapling and checking tickets with retries,
// because stapler reads tickets from Apple's CloudKit, which can drop the connection or not have a ticket yet right
// after an Accepted verdict (stapler error 65/68). scripts/package.mjs notarizes the app, scripts/release.mjs the DMG.
// @electron/notarize is not used: its staple "retry" never calls promise-retry's retry callback, so it tries once
// (releases 0.3.39 and 0.3.42 failed on that one try).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Blocks for `ms` milliseconds (the release steps are synchronous commands). */
export const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` up to `times` times until it doesn't throw; the last failure is thrown. `delay` is the wait in ms
 * before the next try (default 5 s), or a function of the attempt that failed giving it.
 * @template T
 * @param {number} times
 * @param {() => T} fn
 * @param {{ log: (...args: any[]) => void, sleep: (ms: number) => unknown, delay?: number | ((attempt: number) => number) }} options
 * @returns {T}
 */
export function retry(times, fn, { log, sleep, delay = 5000 }) {
  let failure;
  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      return fn();
    } catch (e) {
      failure = e;
      if (attempt < times) {
        const wait = typeof delay === 'function' ? delay(attempt) : delay;
        log(`Failed (attempt ${attempt} of ${times}): ${e.message}; trying again in ${wait / 1000} s`);
        sleep(wait);
      }
    }
  }
  throw failure;
}

/**
 * The wait after a failed ticket-service attempt: 30 s, doubling, at most 5 min. Release 0.3.39's DMG staple
 * failed five times over two and a half minutes, so the 8 tries span about 22 minutes.
 */
export const ticketServiceDelay = (attempt) => Math.min(30_000 * 2 ** (attempt - 1), 300_000);

/** Runs `fn`, which reads Apple's ticket service, up to 8 times (ticketServiceDelay); stapling or checking again is harmless. */
export const withTicketService = (fn, { log, sleep }) => retry(8, fn, { log, sleep, delay: ticketServiceDelay });

/**
 * Submits `file` to Apple's notary service and waits for the verdict. notarytool's exit code alone doesn't
 * say the file was accepted, so its JSON result is read; anything but Accepted throws with Apple's log.
 */
export function notarize(file, auth, { exec, log }) {
  const args = ['notarytool', 'submit', file, ...auth, '--wait', '--timeout', '2h', '--output-format', 'json'];
  log('$', 'xcrun', args.join(' '));
  let out;
  try {
    out = String(exec('xcrun', args, { encoding: 'utf8' }));
  } catch (e) {
    // a rejected submission can exit non-zero with its result on stdout
    if (!e.stdout) throw e;
    out = String(e.stdout);
  }
  let result;
  try {
    result = JSON.parse(out);
  } catch {
    throw new Error(`notarytool returned no result for ${path.basename(file)}: ${out.trim()}`);
  }
  log(`Notarization ${result.id}: ${result.status}`);
  if (result.status === 'Accepted') return result.id;
  let details = '';
  if (result.id) {
    try {
      details = String(exec('xcrun', ['notarytool', 'log', result.id, ...auth], { encoding: 'utf8' }));
    } catch (e) {
      details = `(Apple's log could not be fetched: ${e.message})`;
    }
  }
  throw new Error(
    `Notarizing ${path.basename(file)} ended ${result.status ?? 'without a verdict'}${result.message ? `: ${result.message}` : ''}\n${details}`.trim(),
  );
}

// Every stapler command runs here, under withTicketService (tests/notaryInvariant.test.ts).
const stapler = (args, { exec, log }) => {
  log('$', 'xcrun', `stapler ${args.join(' ')}`);
  exec('xcrun', ['stapler', ...args], { stdio: 'inherit' });
};

/** Checks that `file` carries its notarization ticket, tried again while Apple's ticket service fails. */
export function checkTicket(file, { exec, log, sleep }) {
  withTicketService(() => stapler(['validate', file], { exec, log }), { log, sleep });
}

/**
 * Staples the notarization ticket to `file` (an app or a DMG), tried again while Apple's ticket service fails.
 * `stapler staple` validates what it stapled ("The staple and validate action worked!"), so a separate
 * `stapler validate`, one more call to the ticket service that can fail, is not run.
 */
export function staple(file, { exec, log, sleep }) {
  withTicketService(() => stapler(['staple', file], { exec, log }), { log, sleep });
}

/**
 * Notarizes a signed app: checks its signature first (a bad one fails here, not after Apple's round trip), zips it
 * as notarytool takes it (`ditto --keepParent`, in a temporary folder removed afterwards), waits for Apple's
 * verdict, then staples the ticket to the app.
 */
export function notarizeApp(app, auth, { exec, log, sleep, fsx = { mkdtempSync, rmSync } }) {
  log('$', 'codesign', `--verify --deep --strict ${app}`);
  exec('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  const dir = fsx.mkdtempSync(path.join(os.tmpdir(), 'mopilot-notarize-'));
  try {
    const zip = path.join(dir, `${path.basename(app, '.app')}.zip`);
    log('$', 'ditto', `-c -k --keepParent ${app} ${zip}`);
    exec('ditto', ['-c', '-k', '--keepParent', app, zip], { stdio: 'inherit' });
    notarize(zip, auth, { exec, log });
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
  staple(app, { exec, log, sleep });
}
