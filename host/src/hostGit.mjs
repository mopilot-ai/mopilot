// Clone and worktree on the Host (design/host/index.html, package 2.7): a clone lands in its final place only when whole, and a repeated request returns the first one's outcome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CarryRefusal, applyCarry, dropCarry, planCarry, pushCarry } from '../../shared/host/codeCarry.mjs';
import { inspectRepo, repoKey } from '../../shared/host/codeTransfer.mjs';
import { readSidebarOrigin } from '../../shared/sidebarRepository.mjs';
import { HostRefusal } from './hostFs.mjs';
import { INDETERMINATE } from './ledger.mjs';

/**
 * What every git the Host runs is told, so a repository (or the machine's system config) cannot make it run code or reach a transport it was not asked to: a bare repository found
 * in a folder is not entered unless named, no hook, fsmonitor or `ext::` helper runs, and only https, ssh and local paths are fetched from.
 */
export const GIT_HARDENING = Object.freeze([
  ['safe.bareRepository', 'explicit'],
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['protocol.allow', 'never'],
  ['protocol.https.allow', 'always'],
  ['protocol.ssh.allow', 'always'],
  ['protocol.file.allow', 'user'],
]);

/** The arguments of a git command with the hardening in front. @param {string[]} args */
export const hardenedArgs = (args) => [...GIT_HARDENING.flatMap(([k, v]) => ['-c', `${k}=${v}`]), ...args];

/** The environment of a git command: the Host's, less what redirects git to another repository or helper, plus the caller's and the hardening. @param {Record<string, string | undefined>} base @param {Record<string, string> | undefined} extra */
export function gitEnv(base, extra) {
  const env = { ...base };
  for (const name of Object.keys(env))
    if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|EXTERNAL_DIFF|CONFIG.*|ALLOW_PROTOCOL)$/.test(name)) delete env[name];
  // the machine's system config is skipped unless a caller (the sign-in reading, which must see what an agent's git sees) says otherwise
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    // Read-only callers can close every transport. Other overrides cannot widen the Host's allowlist.
    GIT_ALLOW_PROTOCOL: extra?.GIT_ALLOW_PROTOCOL === '' ? '' : 'https:ssh:file',
  };
}

/** Runs git without a shell and never prompts (not at a terminal, not in a helper's window); resolves `{ ok, stdout, stderr, signal, spawnFailed, code }` and hands each progress line to `onLine`. `input` is written to its standard input. */
export function runGit(
  /** @type {string[]} */ args,
  /** @type {{ cwd?: string, onLine?: (line: string) => void, timeout?: number, env?: Record<string, string>, input?: string, maxBytes?: number }} */ {
    cwd,
    onLine,
    timeout,
    env,
    input,
    maxBytes,
  } = {},
) {
  return new Promise((resolve) => {
    const child = spawn('git', hardenedArgs(args), { cwd, env: gitEnv(process.env, env), windowsHide: true, timeout });
    let stdout = '';
    let stderr = '';
    let cut = false;
    child.stdout.setEncoding('utf8').on('data', (d) => {
      // what the pipe still holds after the cut (a large chunk on Linux) is dropped, so the answer never grows past it
      if (cut) return;
      stdout += d;
      // a read that grows past its bound is stopped, not buffered: the caller says the answer is cut
      if (maxBytes !== undefined && stdout.length > maxBytes) {
        cut = true;
        stdout = stdout.slice(0, maxBytes);
        child.kill();
      }
    });
    // git redraws its progress with \r, so lines end at either
    child.stderr.setEncoding('utf8').on('data', (d) => {
      stderr += d;
      for (const line of String(d).split(/[\r\n]+/)) if (line && onLine) onLine(line);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
    child.on('error', (e) => resolve({ ok: false, stdout, stderr: stderr || e.message, signal: null, spawnFailed: true, code: null }));
    // a run stopped for printing past its bound is cut, not killed by a timeout: it carries no signal
    child.on('close', (code, signal) =>
      resolve({
        ok: code === 0 && !cut,
        stdout: cut ? stdout.slice(0, maxBytes) : stdout,
        stderr,
        signal: cut ? null : signal,
        spawnFailed: false,
        code,
        ...(cut ? { cut } : {}),
      }),
    );
  });
}

/** A progress line such as `Receiving objects:  45% (9/20)` as `{ phase, percent }`, or null. */
export function progressOf(/** @type {string} */ line) {
  const m = /^(?:remote: )?([A-Za-z ]+):\s+(\d{1,3})%/.exec(line);
  return m ? { phase: m[1].trim(), percent: Number(m[2]) } : null;
}

/** A branch name as one folder name; `%` is escaped too, so two branches never share a folder. */
export const folderOf = (/** @type {string} */ branch) => branch.replace(/[^\w.-]/g, (c) => `%${c.codePointAt(0)?.toString(16)}`);

/** A read of a folder that takes longer than this is given up, so a hung disk cannot hold a request forever. */
const INSPECT_MS = 15_000;
/** A push or fetch of the carried changes. */
const CARRY_MS = 120_000;

/**
 * The git options and environment that lend one clone a sign-in for the address's own host and no other: the helper is cleared, then a helper scoped to `https://<host>` reads the user name and secret from the
 * child's environment. So the secret is never in the address, `.git/config`, a credential store or the argument list, and a redirect to another host gets nothing.
 * @param {string} url an https address @param {{ username: string, password: string }} c
 */
export function credentialLoan(url, c) {
  const { protocol, host } = new URL(url);
  const helper = '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$MOPILOT_GIT_USER" "$MOPILOT_GIT_SECRET"; }; f';
  return {
    config: ['credential.helper=', `credential.${protocol}//${host}.helper=${helper}`],
    env: { MOPILOT_GIT_USER: c.username, MOPILOT_GIT_SECRET: c.password },
  };
}

/** Progress goes nowhere unless the caller listens. */
const noProgress = () => undefined;

/** The ledger file clone and worktree requests are kept in: they belong to no chat, so they share one pseudo chat id. */
export const DIRS_LEDGER_ID = 'host:dirs';

/**
 * @param {{ hostFs: ReturnType<typeof import('./hostFs.mjs').createHostFs>, run?: typeof runGit, onProgress?: (key: string, p: { phase: string, percent: number }) => void, ledger?: Pick<ReturnType<typeof import('./ledger.mjs').createLedger>, 'once'> }} o `ledger`: where clone and worktree keys are kept across restarts (without one, in memory only)
 */
export function createHostGit({ hostFs, run = runGit, onProgress = noProgress, ledger }) {
  /** @type {Map<string, Promise<any>>} requests by key: a repeat shares the first one's outcome, success or refusal */
  const seen = new Map();

  /** One outcome per key; a retry of a refused key needs a new key. */
  const once = (/** @type {string} */ key, /** @type {() => Promise<any>} */ work) => {
    let p = seen.get(key);
    if (!p) seen.set(key, (p = work()));
    return p;
  };

  /**
   * One outcome per key for a clone or a worktree. With a ledger the key outlives a restart: a finished request returns its stored folder, a refused one its refusal, and one the Host died in the middle of is reported as such (the folder may or may not exist: the app asks again under a new key, which finds it or makes it).
   * @param {'git.clone' | 'git.worktree'} method @param {string} key @param {() => Promise<any>} work
   */
  async function keyed(method, key, work) {
    if (!ledger) return once(`${method}:${key}`, work);
    let r;
    try {
      r = await ledger.once({ chatId: DIRS_LEDGER_ID, key, method }, work);
    } catch (e) {
      // a stored refusal comes back as a plain error with its code; the wire carries only the Host's own refusals' codes
      const code = /** @type {any} */ (e)?.code;
      throw e instanceof HostRefusal || typeof code !== 'string'
        ? e
        : new HostRefusal(/** @type {any} */ (code), /** @type {Error} */ (e).message);
    }
    if (r.result === INDETERMINATE) throw new HostRefusal('request_interrupted', 'The host restarted during this request. Try again.');
    return r.result;
  }

  /** Where a new folder `dest` goes: its parent must be a real folder inside the roots, and the folder itself must not be a path trick. */
  async function placeOf(/** @type {unknown} */ dest) {
    if (typeof dest !== 'string') throw new HostRefusal('invalid_path', 'Pick a folder by its full path.');
    const name = path.basename(dest);
    if (!name || name === '.' || name === '..') throw new HostRefusal('invalid_path', 'Pick a name for the new folder.');
    return path.join(await hostFs.requireDirectory(path.dirname(dest)), name);
  }

  const exists = (/** @type {string} */ p) =>
    fs.promises.stat(p).then(
      () => true,
      () => false,
    );

  /**
   * @param {{ key: string, url: string, dest: string, branch?: string, credential?: { username: string, password: string } }} q `credential`: a sign-in lent to this clone for the address's host (credentialLoan); `branch` is the branch to check out (the remote's default when absent)
   * @param {(key: string, p: { phase: string, percent: number }) => void} [listen] told this request's progress too, as the caller's connection (a repeat of a running key shares the first request's outcome, not its listener)
   */
  function clone({ key, url, dest, branch, credential }, listen = noProgress) {
    return keyed('git.clone', key, async () => {
      const target = await placeOf(dest);
      if (branch !== undefined && (branch.startsWith('-') || !(await run(['check-ref-format', '--branch', branch])).ok))
        throw new HostRefusal('invalid_path', 'That is not a branch name.');
      if (await exists(target)) {
        // the same repository by name, whichever way its address is written; on the asked branch when one was asked for
        const origin = await run(['remote', 'get-url', 'origin'], { cwd: target });
        const head = branch === undefined ? null : await run(['symbolic-ref', '--short', '-q', 'HEAD'], { cwd: target });
        const sameRepo = origin.ok && repoKey(origin.stdout) !== null && repoKey(origin.stdout) === repoKey(url);
        if (sameRepo && (head === null || (head.ok && head.stdout.trim() === branch))) return { path: target, existed: true };
        throw new HostRefusal('invalid_path', 'A different folder is already there.');
      }
      // clone beside the target and move it into place when whole, so a failed clone leaves nothing the picker would list
      const partial = path.join(path.dirname(target), `.${path.basename(target)}.clone-${key}`);
      const loan = credential ? credentialLoan(url, credential) : null;
      const r = await run(
        [
          ...(loan ? loan.config.flatMap((c) => ['-c', c]) : []),
          'clone',
          '--progress',
          ...(branch === undefined ? [] : [`--branch=${branch}`]),
          '--',
          url,
          partial,
        ],
        {
          ...(loan ? { env: loan.env } : {}),
          onLine: (line) => {
            const p = progressOf(line);
            if (!p) return;
            for (const tell of [onProgress, listen])
              try {
                tell(key, p);
              } catch {
                // a listener that fails must not stop the clone
              }
          },
        },
      );
      if (!r.ok) {
        await fs.promises.rm(partial, { recursive: true, force: true });
        const said = r.stderr.trim().split('\n').pop() || 'The clone failed.';
        // git does not echo a helper's answer, but nothing that reaches the ledger or the wire may carry it by any path
        throw new HostRefusal('clone_failed', credential ? said.split(credential.password).join('***') : said);
      }
      try {
        await fs.promises.rename(partial, target);
      } catch {
        await fs.promises.rm(partial, { recursive: true, force: true });
        throw new HostRefusal('clone_failed', 'The folder appeared while cloning.');
      }
      return { path: target, existed: false };
    });
  }

  /** The commit a worktree's new branch starts from: the repository's own branch `from`, else origin's copy of it. */
  async function startOf(/** @type {string} */ root, /** @type {string} */ from) {
    for (const ref of [`refs/heads/${from}`, `refs/remotes/origin/${from}`])
      if ((await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root })).ok) return ref;
    throw new HostRefusal('worktree_failed', `There is no branch ${from} in this repository.`);
  }

  /**
   * @param {{ key: string, repo: string, branch: string, from?: string }} q `from`: the branch a new branch starts from (this machine's copy of it, else origin's), HEAD when absent; an existing `branch` is checked out as it is
   */
  function worktree({ key, repo, branch, from }) {
    return keyed('git.worktree', key, async () => {
      const root = await hostFs.requireDirectory(repo);
      await hostFs.resolve(path.dirname(root)); // the worktree goes beside the repo, which must stay inside the roots
      if (!(await run(['check-ref-format', '--branch', branch])).ok) throw new HostRefusal('invalid_path', 'That is not a branch name.');
      const target = path.join(path.dirname(root), `${path.basename(root)}.worktrees`, folderOf(branch));
      if (await exists(target)) {
        const head = await run(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target });
        if (head.ok && head.stdout.trim() === branch) return { path: target, existed: true };
        throw new HostRefusal('invalid_path', 'A different folder is already there.');
      }
      const known = (await run(['rev-parse', '--verify', `refs/heads/${branch}`], { cwd: root })).ok;
      const start = known || from === undefined ? null : await startOf(root, from);
      const r = await run(
        known ? ['worktree', 'add', target, branch] : ['worktree', 'add', '-b', branch, target, ...(start ? [start] : [])],
        {
          cwd: root,
        },
      );
      if (!r.ok) throw new HostRefusal('worktree_failed', r.stderr.trim().split('\n').pop() || 'The worktree could not be made.');
      return { path: target, existed: false };
    });
  }

  /**
   * What the folder `path` holds, for the app to compare with the source's repository. Read only. Not bound to the roots: a chat may run outside them (as `send` allows), and a paired client can already run an agent anywhere.
   * @param {{ path: string }} q
   */
  async function inspect({ path: p }) {
    const dir = await hostFs.existingDirectory(p);
    return inspectRepo((args) => run(args, { cwd: dir, timeout: INSPECT_MS }));
  }

  /** @param {{ path: string }} q */
  async function sidebarOrigin({ path: p }) {
    const dir = await hostFs.existingDirectory(p);
    const origin = await readSidebarOrigin((args) => run(args, { cwd: dir, timeout: INSPECT_MS }));
    return { sidebar: true, origin };
  }

  /** A carry's failure as the Host's own refusal, which the wire carries with its code. */
  const asRefusal = (/** @type {unknown} */ e) => (e instanceof CarryRefusal ? new HostRefusal(e.code, e.message) : e);
  const runIn =
    (/** @type {string} */ cwd) =>
    (/** @type {string[]} */ args, /** @type {{ env?: Record<string, string> }} */ o = {}) =>
      run(args, { cwd, env: o.env, timeout: CARRY_MS });

  /**
   * On the source: its uncommitted changes as a temporary branch on its remote (shared/host/codeCarry.mjs). The folder is the chat's own, so it is not bound to the roots.
   * @param {{ key: string, path: string, untracked?: string[], unpushed?: number }} q `untracked` is the list of new files the user confirmed; `unpushed` how many unpushed commits they agreed to publish
   */
  function carryPush({ key, path: p, untracked = [], unpushed = 0 }) {
    return once(`carry:push:${key}`, async () => {
      const dir = await hostFs.existingDirectory(p);
      try {
        return await pushCarry(runIn(dir), {
          key,
          untracked,
          unpushed,
          tmpIndex: (gitDir) => path.join(gitDir, `mopilot-carry-${key.replace(/[^\w.-]/g, '-')}.index`),
          removeIndex: (file) => fs.promises.rm(file, { force: true }),
        });
      } catch (e) {
        throw asRefusal(e);
      }
    });
  }

  /**
   * On the target: the temporary branch applied as uncommitted changes in a clean checkout of the same branch. The folder was picked in the picker, so it is bound to the roots.
   * @param {{ key: string, path: string, branch: string, commit: string, parent: string, sourceBranch?: string | null }} q
   */
  function carryApply({ key, path: p, branch, commit, parent, sourceBranch = null }) {
    return once(`carry:apply:${key}`, async () => {
      const dir = await hostFs.requireDirectory(p);
      try {
        return await applyCarry(runIn(dir), { branch, commit, parent, sourceBranch });
      } catch (e) {
        throw asRefusal(e);
      }
    });
  }

  /** What a carry of the folder `path` would send, for the user to confirm first. Read only. @param {{ path: string }} q */
  async function carryPlan({ path: p }) {
    try {
      return await planCarry(runIn(await hostFs.existingDirectory(p)));
    } catch (e) {
      throw asRefusal(e);
    }
  }

  /** Deletes the temporary branch from the remote of the folder `path` (either side); best effort. @param {{ path: string, branch: string }} q */
  async function carryDrop({ path: p, branch }) {
    return dropCarry(runIn(await hostFs.existingDirectory(p)), { branch });
  }

  return { clone, worktree, inspect, sidebarOrigin, carryPush, carryPlan, carryApply, carryDrop };
}
