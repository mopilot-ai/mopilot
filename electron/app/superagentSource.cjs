// The real GitHub source for the Superagent watcher: builds electron/superagent/sources/github.cjs for the chosen repo with the app's own ports (global fetch, the `gh auth token` token reader, timers) and keeps its poll cursor in the Superagent database.
// GET only, and the token goes to api.github.com only (both enforced by the source). The watcher's bot login is passed as `ownLogin`, so the Superagent's own posts are never read as requests. Nothing here posts, runs or writes to GitHub.
const { execFile } = require('node:child_process');
const { createGithubSource, ghTokenReader } = require('../superagent/sources/github.cjs');
const { childEnv } = require('../platform/env.cjs');
const { loadConfig } = require('../superagent/gate/config.cjs');

const GH_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 60_000;

/** Runs `gh` (or any file) and resolves `{ stdout }`; it never waits longer than ten seconds, so a stuck `gh` cannot hold a poll. */
const defaultExec = (file, args, opts) =>
  new Promise((resolve, reject) =>
    execFile(file, args, { ...opts, timeout: GH_TIMEOUT_MS, windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout }),
    ),
  );

const defaultTimer = (fn, ms) => {
  const h = setTimeout(fn, ms);
  h.unref?.();
  return h;
};

/**
 * @param {object} o
 * @param {() => any} o.getStore the open Superagent store (the poll cursor lives in its settings), or null
 * @param {() => number} o.now
 * @param {(status: { state: string, delayMs: number, reason?: string }) => void} o.onStatus the source's health, for the page
 * @param {(message: string, error: unknown) => void} o.log
 * @param {{ fetch?: typeof fetch, exec?: Function, env?: Record<string, string | undefined>, childEnv?: () => Record<string, string>,
 *           setTimer?: (fn: () => void, ms: number) => unknown, clearTimer?: (h: unknown) => void, createGithubSource?: typeof createGithubSource }} [o.deps] for tests
 * @returns {(o: { repo: string, emit: (event: unknown) => unknown }) => { start: () => void, stop: () => void }}
 */
function githubSourceFactory({ getStore, now, onStatus, log, deps = {} }) {
  const read = ghTokenReader({ exec: deps.exec ?? defaultExec, env: deps.env ?? process.env, childEnv: deps.childEnv ?? childEnv });
  /** @type {{ at: number, promise: Promise<string | null> } | null} */
  let cached = null;
  /**
   * The token, asked for once a minute at most (the source asks for it on every request, and each ask can run `gh`), and
   * shared by requests that ask together. A missing token, or a `gh` that is absent or fails, is `null`, which the source
   * words as "No GitHub token"; it is not kept, so the next poll asks again.
   */
  const getToken = () => {
    if (cached && now() - cached.at < TOKEN_TTL_MS) return cached.promise;
    const promise = read().catch((error) => {
      log('github source: could not read a GitHub token', error);
      return null;
    });
    cached = { at: now(), promise };
    void promise.then((token) => {
      if (!token && cached?.promise === promise) cached = null;
    });
    return promise;
  };
  const create = deps.createGithubSource ?? createGithubSource;
  // the cursor survives a restart, so the same window is not read again; with no store open there is nothing to keep it in
  const cursor = {
    get: (key) => getStore()?.watch.settings.get(`cursor:${key}`),
    set: (key, value) => getStore()?.watch.settings.set(`cursor:${key}`, value),
  };
  return ({ repo, emit }) =>
    create({
      repo,
      fetch: deps.fetch ?? globalThis.fetch,
      now,
      setTimer: deps.setTimer ?? defaultTimer,
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(/** @type {any} */ (h))),
      getToken,
      store: cursor,
      emit,
      ownLogin: loadConfig(getStore()).botLogin,
      log,
      onStatus,
    });
}

module.exports = { githubSourceFactory, defaultExec };
