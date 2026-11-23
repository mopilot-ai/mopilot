// Superagent S1 GitHub source, polling half: read-only poll of one repo's notifications, emitting normalized events (shape in githubNotifications.cjs) through an injected callback.
// Owner: one source per repo; `start()` begins a generation, `stop()` retires it (clears the timer, aborts the request, and any await that resumes afterwards publishes nothing).
// Read only: the only requests are GET; notifications are never marked read, and whether the person already read one never decides whether we see it (`all=true`, and our own `since` mark).
// Cursor (the `since` mark, etag and last-modified for that window, poll interval) lives in the injected store; the event log is the intake's.
const n = require('./githubNotifications.cjs');
const { userError } = require('../../../shared/userError.mjs');

const MAX_PAGES = 10;
const AUTH_BACKOFF_MS = 5 * 60_000;
const ERROR_BACKOFF_MS = 30_000;

class SourceError extends Error {
  constructor(kind, delayMs, message) {
    super(message);
    this.kind = kind;
    this.delayMs = delayMs;
  }
}

/** Token from the same places the GitHub connector uses: GITHUB_PERSONAL_ACCESS_TOKEN, else `gh auth token`. `exec(file, args, { env })` resolves `{ stdout }`; `childEnv()` is the login-shell environment (platform/env.cjs) so `gh` is found from the Dock. */
function ghTokenReader({ exec, env, childEnv }) {
  return async () => {
    const fromEnv = env.GITHUB_PERSONAL_ACCESS_TOKEN;
    if (fromEnv) return fromEnv;
    const out = await exec('gh', ['auth', 'token'], { env: childEnv() });
    return String(out.stdout ?? '').trim() || null;
  };
}

/**
 * @param {{
 *   repo: string,                       // 'owner/name'
 *   fetch: (url: string, init: any) => Promise<any>, now: () => number,
 *   setTimer: (fn: () => any, ms: number) => unknown, clearTimer: (h: unknown) => void,
 *   getToken: () => Promise<string|null>,
 *   store: { get(key: string): any, set(key: string, value: any): any },
 *   emit: (event: object) => any,
 *   ownLogin?: string,                  // the Superagent's own bot login; its events are dropped
 *   log?: (message: string, error: unknown) => void,
 *   onStatus?: (status: { state: 'ok'|'unchanged'|'limited'|'error', delayMs: number, reason?: string }) => void,
 * }} o
 */
function createGithubSource(o) {
  const cursorKey = `github-notifications:${o.repo}`;
  let generation = 0;
  /** @type {unknown} */
  let timer = null;
  /** @type {AbortController | null} */
  let abort = null;
  let strikes = 0;
  let notBefore = 0; // the earliest the next poll may start: a backoff outlives stop()/start()

  const status = (s) => {
    try {
      o.onStatus?.(s);
    } catch (e) {
      // a status listener never breaks polling
      o.log?.('github source: status listener failed', e);
    }
  };

  async function get(url, headers, gen) {
    let token;
    try {
      token = await o.getToken();
    } catch (e) {
      if (gen !== generation) return null;
      throw new SourceError('auth', AUTH_BACKOFF_MS, userError(e));
    }
    if (gen !== generation) return null;
    if (!token) throw new SourceError('auth', AUTH_BACKOFF_MS, 'No GitHub token');
    let res;
    try {
      res = await o.fetch(url, {
        method: 'GET',
        redirect: 'error', // the token never follows a redirect off api.github.com
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...headers,
        },
        signal: /** @type {AbortController} */ (abort).signal,
      });
    } catch (e) {
      if (gen !== generation) return null;
      throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), String(e?.message ?? e));
    }
    if (gen !== generation) return null;
    if (res.status === 403 || res.status === 429) {
      throw new SourceError('limited', n.rateLimitDelayMs(res.headers, o.now(), strikes + 1), `GitHub ${res.status}`);
    }
    if (res.status === 401) throw new SourceError('auth', AUTH_BACKOFF_MS, 'GitHub rejected the token');
    return res;
  }

  /** JSON of an item request; null when the item is gone (404/410) or the generation ended. */
  async function item(url, gen) {
    if (!n.isApiUrl(url)) return null;
    const res = await get(url, {}, gen);
    if (!res || res.status === 404 || res.status === 410) return null;
    if (!res.ok) throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), `GitHub ${res.status}`);
    const body = await res.json();
    return gen === generation ? body : null;
  }

  /** Every page of a list URL (capped), `[]` when gone. */
  async function list(url, gen) {
    const out = [];
    for (let next = url, page = 0; next && page < MAX_PAGES && n.isApiUrl(next); page++) {
      const res = await get(next, {}, gen);
      if (!res || res.status === 404 || res.status === 410) break;
      if (!res.ok) throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), `GitHub ${res.status}`);
      const body = await res.json();
      if (gen !== generation) return out;
      if (Array.isArray(body)) out.push(...body);
      next = n.nextLink(res.headers);
    }
    return out;
  }

  async function deliver(event, seen) {
    if (!event || seen.has(event.externalId) || n.isOwnActor(event.actor, o.ownLogin)) return;
    seen.add(event.externalId);
    await o.emit(event);
  }

  /** One notification to its events: the issue/PR itself when new, its comments since the window start, plus a PR's review comments. */
  async function expand(note, seen, gen, since) {
    const type = n.subjectType(note?.subject?.type);
    const repo = n.repoOf(note?.repository);
    if (!type || !repo || typeof note.subject.url !== 'string') return;
    const issue = await item(note.subject.url, gen);
    if (gen !== generation) return;
    const subject = n.subjectOf(issue, type);
    if (!subject) return; // deleted or incomplete subject
    // every comment of the thread since the window start, not just the newest one the notification names: several can arrive between two polls
    const comments = await list(n.issueCommentsUrl(note.subject.url, since), gen);
    if (gen !== generation) return;
    // the issue or PR itself, when it opened inside the window or nothing else came back (a state change on an older thread)
    if (!comments.length || n.openedSince(issue, since)) await deliver(n.openedEvent(issue, subject, repo), seen);
    for (const comment of comments) {
      if (gen !== generation) return;
      await deliver(n.commentEvent(comment, subject, repo), seen);
    }
    if (gen !== generation || type !== 'pull_request') return;
    for (const review of await list(n.reviewsUrl(note.subject.url, since), gen)) {
      if (gen !== generation) return;
      await deliver(n.commentEvent(review, subject, repo), seen);
    }
  }

  /** One poll; resolves the delay before the next. A failure leaves the cursor so the same window is read again. */
  async function poll(gen) {
    const cursor = (await o.store.get(cursorKey)) ?? {};
    if (gen !== generation) return null;
    const start = n.windowStart(cursor, o.now());
    // the validators belong to the window they were answered for: a moved window is a different list
    const headers = {};
    if (cursor.etagFor === start) {
      if (cursor.etag) headers['if-none-match'] = cursor.etag;
      if (cursor.lastModified) headers['if-modified-since'] = cursor.lastModified;
    }
    const base = cursor.pollMs ?? n.DEFAULT_POLL_MS;
    const first = await get(n.notificationsUrl(o.repo, start), headers, gen);
    if (!first) return null;
    if (first.status === 304) {
      strikes = 0;
      const pollMs = n.pollIntervalMs(first.headers) ?? base;
      if (pollMs !== cursor.pollMs) await o.store.set(cursorKey, { ...cursor, pollMs });
      if (gen !== generation) return null;
      status({ state: 'unchanged', delayMs: pollMs });
      return pollMs;
    }
    if (!first.ok) throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), `GitHub ${first.status}`);
    const notes = [];
    let truncated = false;
    let res = first;
    for (let page = 0; ; page++) {
      const body = await res.json();
      if (gen !== generation) return null;
      if (Array.isArray(body)) notes.push(...body);
      const next = n.nextLink(res.headers);
      if (!next || !n.isApiUrl(next)) break;
      if (page + 1 >= MAX_PAGES) {
        truncated = true;
        break;
      }
      res = await get(next, {}, gen);
      if (!res) return null;
      if (!res.ok) throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), `GitHub ${res.status}`);
    }
    const seen = new Set();
    let failed = null;
    for (const note of notes) {
      try {
        await expand(note, seen, gen, start);
      } catch (e) {
        if (gen !== generation) return null;
        // a limit or an auth failure ends the poll; one item's failure (a 5xx, a refused emit) must not hide the rest
        if (e instanceof SourceError && e.kind !== 'error') throw e;
        o.log?.(`github source: ${note.subject.url} failed`, e);
        failed = e;
      }
      if (gen !== generation) return null;
    }
    // the cursor stays put when anything was left unread, so the same window is read again (downstream drops repeats)
    if (failed) throw new SourceError('error', n.failureDelayMs(ERROR_BACKOFF_MS, strikes + 1), userError(failed));
    if (truncated) {
      strikes = 0;
      status({ state: 'ok', delayMs: base });
      return base;
    }
    const pollMs = n.pollIntervalMs(first.headers) ?? base;
    await o.store.set(cursorKey, {
      since: n.nextSince(start, notes),
      etag: first.headers.get('etag') ?? undefined,
      lastModified: first.headers.get('last-modified') ?? undefined,
      etagFor: start,
      pollMs,
    });
    if (gen !== generation) return null;
    strikes = 0;
    status({ state: 'ok', delayMs: pollMs });
    return pollMs;
  }

  /** Only ever called with the current generation: start() just made it, and run() returns right after a poll that checked it. */
  function schedule(gen, ms) {
    notBefore = o.now() + ms;
    timer = o.setTimer(() => run(gen), ms);
  }

  async function run(gen) {
    if (gen !== generation) return;
    timer = null;
    let delay;
    try {
      delay = await poll(gen);
    } catch (e) {
      if (gen !== generation) return;
      strikes += 1;
      delay = e instanceof SourceError ? e.delayMs : n.failureDelayMs(ERROR_BACKOFF_MS, strikes);
      status({ state: e?.kind === 'limited' ? 'limited' : 'error', delayMs: delay, reason: userError(e) });
    }
    if (delay !== null && delay !== undefined) schedule(gen, delay);
  }

  return {
    /** Begin polling now; a second start while running is a no-op. */
    start() {
      if (abort) return;
      generation += 1;
      abort = new AbortController();
      strikes = 0;
      schedule(generation, Math.max(0, notBefore - o.now()));
    },
    /** Retire the generation: no timer, no request, no event after this returns. */
    stop() {
      generation += 1;
      if (timer !== null) o.clearTimer(timer);
      timer = null;
      abort?.abort();
      abort = null;
    },
  };
}

module.exports = { createGithubSource, ghTokenReader };
