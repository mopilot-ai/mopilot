// The reader of a managed-policy file (plan W1/W2): the one place a root-owned policy file is read, for the app and for a Host. It keeps the last good generation, applies the strict fallback when a file has never been valid, and tells listeners when the effective generation changes.
import path from 'node:path';
import { managedPolicyPath, parseManagedPolicy, untrustedReason, managedGeneration, STRICT_FALLBACK } from './managedPolicy.mjs';
/** @param {string} message */
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid' });

/**
 * @param {object} o
 * @param {string} [o.file] the policy file; defaults to this platform's path for the product
 * @param {string} [o.platform]
 * @param {'app' | 'host'} [o.product] which product's path is read when `file` is not given
 * @param {Record<string, string | undefined>} [o.env]
 * @param {typeof import('node:fs')} o.fs the file system (tests pass a fake); the caller's: the app's fs port, or node:fs on a Host
 * @param {(m: string) => void} [o.report] a problem worth a log line
 * @param {number} [o.debounceMs] how long a burst of file events is coalesced
 * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
 * @param {(t: unknown) => void} [o.clearTimer]
 */
export function createManagedReader({
  file,
  platform = process.platform,
  fs,
  product = 'app',
  env = process.env,
  report = () => undefined,
  debounceMs = 250,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(/** @type {any} */ (t)),
}) {
  const where = file ?? managedPolicyPath({ platform, product, env });
  /** @type {any} the last document that parsed and was trusted */
  let lastGood = null;
  /** @type {{ state: 'none' | 'valid' | 'fallback', doc: any, generation: string | null, organization: string | null, problem: string | null }} */
  let snapshot = { state: 'none', doc: null, generation: null, organization: null, problem: null };
  /** @type {Set<(s: typeof snapshot) => void>} */
  const listeners = new Set();
  /** @type {unknown} */
  let timer = null;
  /** @type {{ close: () => void } | null} */
  let watcher = null;

  /** Reads the file once and returns what it says; never throws. @returns {{ doc: any } | { problem: string } | { gone: true }} */
  function readFile() {
    let stat;
    try {
      stat = fs.statSync(where);
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') return { gone: true };
      return { problem: 'The managed policy file could not be read.' };
    }
    const untrusted = untrustedReason(stat, platform);
    if (untrusted) return { problem: untrusted };
    try {
      return { doc: parseManagedPolicy(JSON.parse(String(fs.readFileSync(where, 'utf8'))), invalid) };
    } catch (error) {
      return { problem: `The managed policy file is not valid: ${/** @type {Error} */ (error).message}` };
    }
  }

  /** Reads the file now and swaps the snapshot; listeners hear only a change of generation or problem. */
  function reload() {
    const read = readFile();
    /** @type {typeof snapshot} */
    let next;
    if ('gone' in read) {
      lastGood = null;
      next = { state: 'none', doc: null, generation: null, organization: null, problem: null };
    } else if ('doc' in read) {
      lastGood = read.doc;
      next = {
        state: 'valid',
        doc: read.doc,
        generation: managedGeneration(read.doc),
        organization: read.doc.organization ?? null,
        problem: null,
      };
    } else if (lastGood) {
      next = {
        state: 'valid',
        doc: lastGood,
        generation: managedGeneration(lastGood),
        organization: lastGood.organization ?? null,
        problem: read.problem,
      };
    } else {
      next = {
        state: 'fallback',
        doc: STRICT_FALLBACK,
        generation: managedGeneration(STRICT_FALLBACK),
        organization: null,
        problem: read.problem,
      };
    }
    const changed = next.generation !== snapshot.generation || next.problem !== snapshot.problem;
    snapshot = next;
    if (next.problem) report(`managed policy: ${next.problem}`);
    if (changed) for (const l of [...listeners]) l(snapshot);
    return snapshot;
  }

  reload();

  return {
    /** The policy every decision point reads: `state` is `none` (a person), `valid`, or `fallback` (a file that never parsed). `problem` is shown to the user. */
    effectivePolicy: () => snapshot,
    reload,
    /** Calls `fn` after the effective generation or problem changes; returns the way to stop. @param {(s: typeof snapshot) => void} fn */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** Watches the file's folder; a burst of events becomes one read. A folder that does not exist is not watched (no policy can appear there without a restart of the watch). */
    watch() {
      if (watcher) return;
      try {
        watcher = /** @type {any} */ (
          fs.watch(path.dirname(where), { persistent: false }, () => {
            if (timer) clearTimer(timer);
            timer = setTimer(() => {
              timer = null;
              reload();
            }, debounceMs);
          })
        );
      } catch {
        watcher = null;
      }
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
      watcher?.close();
      watcher = null;
    },
  };
}
