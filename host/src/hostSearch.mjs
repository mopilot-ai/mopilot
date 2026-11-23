// File search in a chat's folder on the Host, for the @ popup (#4103…): the folder's files by name, from ripgrep when the machine has it and from git otherwise. The query never reaches a command: the listing is asked for with fixed arguments and filtered here, so no query can become an option. Every run has a timeout and a bound on what it prints, no run goes through a shell, the folder must lie inside the Host's roots by its real path, and the answer is capped.
import { spawn } from 'node:child_process';
import { HostRefusal } from './hostFs.mjs';
import { runGit } from './hostGit.mjs';

/** One listing; a hung disk or a huge tree answers with what it had, marked cut. */
const RUN_MS = 10_000;
const MAX_BYTES = 8_000_000;
/** The most paths one listing is read for: past it the answer says it is cut. */
const MAX_FILES = 200_000;

/** The ripgrep listing of `cwd`: files (hidden ones too, not `.git`), ignore files honoured, no config, NUL-separated. Resolves like runGit: `{ ok, stdout, spawnFailed, cut }`. @param {string} cwd @param {string} [bin] @param {number} [timeout] */
export function runRipgrep(cwd, bin = 'rg', timeout = RUN_MS) {
  return new Promise((resolve) => {
    const args = ['--files', '--no-config', '--hidden', '--null', '--glob', '!.git'];
    const child = spawn(bin, args, {
      cwd,
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|HOME)$/.test(k))),
      timeout,
      windowsHide: true,
    });
    let stdout = '';
    let cut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => {
      // what arrives after the bound (a child that outlives the kill) is dropped
      if (cut) return;
      stdout += d;
      if (stdout.length > MAX_BYTES) {
        cut = true;
        stdout = stdout.slice(0, MAX_BYTES);
        child.kill();
      }
    });
    child.stderr.on('data', () => undefined);
    child.on('error', () => resolve({ ok: false, stdout, spawnFailed: true }));
    // a run the timeout ended has a signal and no exit code: it is timed out, not "no ripgrep here"
    child.on('close', (code, signal) =>
      resolve({ ok: (code === 0 || code === 1) && !cut, stdout, spawnFailed: false, ...(cut ? { cut } : { timedOut: signal !== null }) }),
    );
  });
}

/** How well `path` matches `query` (lower case, already trimmed): 0 is no match. A name that starts with it beats one that holds it, a path that holds it beats letters spread over it. @param {string} path @param {string} query */
export function scoreOf(path, query) {
  if (!query) return 1;
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  if (name.startsWith(query)) return 4;
  if (name.includes(query)) return 3;
  if (lower.includes(query)) return 2;
  let at = 0;
  for (const ch of query) {
    at = lower.indexOf(ch, at) + 1;
    if (at === 0) return 0;
  }
  return 1;
}

/**
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, run?: typeof runGit, rg?: typeof runRipgrep }} o
 */
export function createHostSearch({ hostFs, run = runGit, rg = runRipgrep }) {
  /** The files of the folder, relative to it, and whether the list is cut. @param {string} dir */
  async function listing(dir) {
    const found = /** @type {any} */ (await rg(dir));
    if (found.timedOut) throw new HostRefusal('read_timed_out', 'The machine took too long to list that folder.');
    if (!found.spawnFailed && (found.ok || found.cut)) return { names: found.stdout.split('\0'), cut: !!found.cut };
    // no ripgrep here: git lists what it tracks and what it would add, only under this folder
    const tracked = /** @type {any} */ (
      await run(['--no-optional-locks', 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--'], {
        cwd: dir,
        timeout: RUN_MS,
        maxBytes: MAX_BYTES,
      })
    );
    if (tracked.signal) throw new HostRefusal('read_timed_out', 'The machine took too long to list that folder.');
    if (tracked.ok || tracked.cut) return { names: tracked.stdout.split('\0'), cut: !!tracked.cut };
    return { names: [], cut: false };
  }

  /**
   * The files in `path` whose names match `query`, best first, at most `limit`, paths relative to the folder. A folder outside the roots is refused; one nothing can list answers no files.
   * @param {{ path: string, query: string, limit: number }} q
   * @returns {Promise<{ files: string[], truncated: boolean }>}
   */
  async function search({ path: p, query, limit }) {
    const dir = await hostFs.requireDirectory(p);
    const { names, cut } = await listing(dir);
    const q = query.trim().toLowerCase();
    /** @type {{ path: string, score: number }[]} */
    const hits = [];
    let seen = 0;
    for (const name of names) {
      if (!name) continue;
      if (++seen > MAX_FILES) return rank(hits, limit, true);
      const score = scoreOf(name, q);
      if (score > 0) hits.push({ path: name, score });
    }
    return rank(hits, limit, cut);
  }

  return { search };
}

/** @param {{ path: string, score: number }[]} hits @param {number} limit @param {boolean} cut */
function rank(hits, limit, cut) {
  hits.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return { files: hits.slice(0, limit).map((h) => h.path), truncated: cut || hits.length > limit };
}
