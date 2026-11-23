// A CLI's version, read without running it where possible and run at most once per binary otherwise. An npm CLI's
// version is its package.json's (the file its links lead into, or the package a Windows npm shim names). Anything else
// runs `<bin> --version` with stdin closed, remembered by the binary's realpath, size and mtime: an answer for 24 hours,
// a failure until the binary changes. Repeated runs of an unsigned or quarantined binary bring up a macOS malware alert
// each time, and some CLIs update themselves when asked their version. A version manager's shim (volta, mise, asdf)
// stays the same file when the tool behind it changes, so its answer is kept for 10 minutes either way.
'use strict';
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { spawnArgs } = require('./winbin.cjs');
const { noteIgnored } = require('../ignored.cjs');

const SUCCESS_TTL_MS = 24 * 60 * 60_000;
const SHIM_TTL_MS = 10 * 60_000;
const TIMEOUT_MS = 8000;
/** Shim files are small scripts; anything larger is a program and is not read as text. */
const SHIM_MAX_BYTES = 64 * 1024;

/** The file `bin`'s links lead to; `bin` itself when it can't be resolved. */
function realOf(bin) {
  try {
    return fs.realpathSync(bin);
  } catch (error) {
    noteIgnored('resolve a CLI path', error, ['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES']);
    return bin;
  }
}

/** The `version` of a package.json; null when it is unreadable or has none. */
function packageVersion(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))?.version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch (error) {
    noteIgnored('read a CLI package version', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return null;
  }
}

/** The version of the npm package the file `real` is in (…/node_modules/@openai/codex/bin/codex.js); null when none. */
function npmVersion(real) {
  for (let d = path.dirname(real), up = path.dirname(d); up !== d; d = up, up = path.dirname(d)) {
    const base = path.basename(up);
    if (base === 'node_modules' || (base.startsWith('@') && path.basename(path.dirname(up)) === 'node_modules'))
      return packageVersion(path.join(d, 'package.json'));
  }
  return null;
}

/**
 * The version of the npm package a shim at `real` starts (npm on Windows writes codex.cmd beside node_modules, naming
 * %dp0%\node_modules\@openai\codex\bin\codex.js, not a link into it); null when `real` is no such shim.
 */
function shimVersion(real) {
  let text;
  try {
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > SHIM_MAX_BYTES) return null;
    text = fs.readFileSync(real, 'utf8').replace(/\\/g, '/');
  } catch (error) {
    noteIgnored('read a CLI shim', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return null;
  }
  const m = /\/node_modules\/((?:@[^/\s"'%$]+\/)?[^/\s"'%$]+)\//.exec(text);
  return m ? packageVersion(path.join(path.dirname(real), 'node_modules', ...m[1].split('/'), 'package.json')) : null;
}

/** The version `bin`'s files say without running it (npm package or shim); null when they say none. Never spawns. */
function fileVersion(bin) {
  if (!bin) return null;
  const real = realOf(bin);
  return npmVersion(real) ?? shimVersion(real);
}

/** The path and file identity: changes when a binary is replaced, even if the installer preserves its mtime. */
function stampOf(real) {
  try {
    const st = fs.statSync(real, { bigint: true });
    return `${real}|${st.ino}|${st.size}|${st.ctimeNs}|${st.mtimeNs}`;
  } catch (error) {
    noteIgnored('look at a CLI binary', error, ['ENOENT', 'ENOTDIR', 'EACCES']);
    return null;
  }
}

/** A version manager's shim, which runs whichever tool version is selected (it stays the same file when that changes). */
const isShim = (bin, real) => /(^|[\\/])(volta-shim|mise|asdf)(\.exe)?$/.test(real) || path.basename(path.dirname(bin)) === 'shims';

/** The first version number in what a CLI printed ("codex-cli 0.162.0-alpha.2", "2.1.295 (Claude Code)"); null when none. */
const parseVersion = (out) => /\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/.exec(String(out ?? ''))?.[0] ?? null;

/**
 * Run `<bin> --version` once: stdin closed, NO_COLOR, and Cline's self-update off. A CLI that prints a version and exits
 * non-zero has still said it. Never rejects.
 * @returns {Promise<{ version: string | null, timedOut: boolean }>}
 */
function ask(bin, { env = process.env, timeoutMs = TIMEOUT_MS, parse = parseVersion } = {}) {
  return new Promise((resolve) => {
    const opts = {
      timeout: timeoutMs,
      killSignal: /** @type {const} */ ('SIGKILL'),
      env: { ...env, NO_COLOR: '1', CLINE_NO_AUTO_UPDATE: '1' },
    };
    try {
      const child = execFile(...spawnArgs(bin, ['--version'], opts), (error, stdout, stderr) => {
        const version = parse(String(stdout ?? '')) ?? parse(String(stderr ?? ''));
        if (error && !version) noteIgnored(`read the version of ${bin}`, error);
        // not kept: cut off by the timeout, or not started at all (its interpreter missing, say), which may change
        // without the binary changing; output past maxBuffer also kills it, and that answer is kept
        const transient =
          !!error && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (!!error.killed || typeof error.code === 'string');
        !!error && ((error.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') || typeof error.code === 'string');
        resolve({ version, timedOut: !version && transient });
      });
      // a CLI that would ask something reads end of input instead of waiting for the timeout
      child?.stdin?.end();
    } catch (error) {
      noteIgnored(`run ${bin} --version`, error);
      resolve({ version: null, timedOut: false });
    }
  });
}

/** @typedef {{ at: number, version: string | null, pending?: Promise<string | null> }} Entry */
/** @type {Map<string, Entry>} by stampOf */
const memo = new Map();

/**
 * `bin`'s version: its package.json's, else what `--version` printed, remembered per binary (see the header). Concurrent
 * asks for one binary share one run; a run that timed out is not remembered. Never rejects; null when it says none.
 * @param {string} bin
 * @param {{ env?: Record<string, string | undefined>, timeoutMs?: number, parse?: (out: string) => string | null, now?: () => number }} [o]
 * @returns {Promise<string | null>}
 */
async function toolVersion(bin, o = {}) {
  const now = o.now ?? Date.now;
  const real = realOf(bin);
  const fromFile = npmVersion(real) ?? shimVersion(real);
  if (fromFile) return fromFile;
  const stamp = stampOf(real);
  // a binary that can't be told apart from its next version is asked, and nothing is remembered
  if (!stamp) return (await ask(bin, o)).version;
  const hit = memo.get(stamp);
  if (hit?.pending) return hit.pending;
  const ttl = isShim(bin, real) ? SHIM_TTL_MS : hit?.version ? SUCCESS_TTL_MS : Number.POSITIVE_INFINITY;
  if (hit && now() - hit.at < ttl) return hit.version;
  /** @type {Entry} */
  const entry = { at: now(), version: null };
  entry.pending = ask(bin, o).then((r) => {
    // forgotten meanwhile (an install or update): the answer is for a binary that may no longer be there
    if (memo.get(stamp) !== entry) return r.version;
    if (r.timedOut) memo.delete(stamp);
    else memo.set(stamp, { at: now(), version: r.version });
    return r.version;
  });
  memo.set(stamp, entry);
  return entry.pending;
}

/** Ask `bin` again next time (after an install or update; with no `bin`, every binary). */
function forgetVersion(bin) {
  if (!bin) return memo.clear();
  const prefix = `${realOf(bin)}|`;
  for (const k of [...memo.keys()]) if (k.startsWith(prefix)) memo.delete(k);
}

module.exports = {
  toolVersion,
  fileVersion,
  forgetVersion,
  parseVersion,
  npmVersion,
  shimVersion,
  isShim,
  stampOf,
  SUCCESS_TTL_MS,
  SHIM_TTL_MS,
};
