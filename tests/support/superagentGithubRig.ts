// Shared fake GitHub, clock, timers and store for the Superagent GitHub source tests.
import assert from 'node:assert/strict';
import src from '../../electron/superagent/sources/github.cjs';

export const API = 'https://api.github.com';
// the rig's clock is 10_000 ms, so a first poll looks back one hour from there
export const SINCE0 = '1969-12-31T23:00:10Z';
export const notesUrl = (since: string) => `${API}/repos/o/r/notifications?all=true&per_page=50&since=${encodeURIComponent(since)}`;
export const NOTES = notesUrl(SINCE0);
/** The issue comments of thread `n` for a first poll's window (a PR's are listed under its issue number). */
export const commentsUrl = (n: number) => `${API}/repos/o/r/issues/${n}/comments?per_page=100&since=${encodeURIComponent(SINCE0)}`;
export type Res = { status?: number; headers?: Record<string, string>; body?: any };
export const repository = { node_id: 'R_1', full_name: 'o/r' };
export const user = (login = 'alice', type = 'User') => ({ login, id: 5, type });
export const note = (n: number, extra: any = {}, subject: any = {}) => ({
  repository,
  last_read_at: '2026-01-01T00:00:00Z',
  subject: { type: 'Issue', url: `${API}/repos/o/r/issues/${n}`, latest_comment_url: null, ...subject },
  ...extra,
});
export const issueBody = (n: number) => ({
  node_id: `I_${n}`,
  number: n,
  html_url: `https://github.com/o/r/issues/${n}`,
  created_at: '2026-01-02T00:00:00Z',
  body: `issue ${n}`,
  user: user(),
});
export const commentBody = (id: string, login = 'alice', type = 'User', url = `${API}/repos/o/r/issues/comments/1`) => ({
  node_id: id,
  created_at: '2026-01-03T00:00:00Z',
  body: `c ${id}`,
  url,
  user: user(login, type),
});

export function rig(
  opts: {
    ownLogin?: string;
    token?: string | null;
    cursor?: any;
    emitFails?: (e: any) => boolean;
    getToken?: () => Promise<string | null>;
  } = {},
) {
  const routes = new Map<string, Res | (() => Res | Promise<Res>)>();
  /** Handlers for every URL under a prefix, given the query: a fake that answers as the real API does, not with what the test hopes to see. */
  const served: { prefix: string; fn: (params: URLSearchParams, url: string) => Res }[] = [];
  const calls: { url: string; headers: any; method: string }[] = [];
  const events: any[] = [];
  const statuses: any[] = [];
  const logs: string[] = [];
  const timers: { fn: () => any; ms: number; id: number }[] = [];
  const cleared: number[] = [];
  const stored = new Map<string, any>();
  if (opts.cursor) stored.set('github-notifications:o/r', opts.cursor);
  let next = 0;
  const fetch = async (url: string, init: any) => {
    calls.push({ url, headers: init.headers, method: init.method });
    const handler = served.find((s) => url.startsWith(s.prefix));
    // a thread nobody commented on lists no comments (a test that wants some routes or serves them)
    const none: Res | undefined = /\/issues\/\d+\/comments\?/.test(url) ? { body: [] } : undefined;
    const r = routes.get(url) ?? (handler ? () => handler.fn(new URL(url).searchParams, url) : undefined) ?? none;
    if (!r) throw new Error(`unrouted ${url}`);
    const v = typeof r === 'function' ? await r() : r;
    if (init.signal.aborted) throw new Error('aborted');
    const headers = Object.fromEntries(Object.entries(v.headers ?? {}).map(([k, x]) => [k.toLowerCase(), x]));
    const status = v.status ?? 200;
    return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => headers[k] ?? null }, json: async () => v.body };
  };
  const source = src.createGithubSource({
    repo: 'o/r',
    fetch,
    now: () => 10_000,
    setTimer: (fn: () => any, ms: number) => (timers.push({ fn, ms, id: ++next }), next),
    clearTimer: (id: any) => {
      cleared.push(id);
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    getToken: opts.getToken ?? (async () => (opts.token === undefined ? 'tok' : opts.token)),
    store: { get: (k: string) => stored.get(k), set: (k: string, v: any) => void stored.set(k, v) },
    emit: (e: any) => {
      if (opts.emitFails?.(e)) throw new Error('intake refused');
      events.push(e);
    },
    ownLogin: opts.ownLogin,
    onStatus: (s: any) => void statuses.push(s),
    log: opts.emitFails ? (m: string) => void logs.push(m) : undefined,
  });
  /** Fire the pending timer and wait for that poll to finish. */
  const fire = async () => {
    const t = timers.pop();
    assert.ok(t, 'a timer is pending');
    await t.fn();
    return t;
  };
  /** Answer every URL under `prefix` with `fn(query)`. */
  const serve = (prefix: string, fn: (params: URLSearchParams, url: string) => Res) => void served.push({ prefix, fn });
  return { serve, routes, calls, events, statuses, logs, timers, cleared, stored, source, fire };
}

/**
 * GitHub's notification list as the real API serves it: only UNREAD notifications unless `all=true`, and only those
 * updated after `since`. A fake that returned "whatever is new" hid that a read notification is invisible by default.
 */
export function notificationsApi(list: any[]) {
  return (params: URLSearchParams): Res => {
    const since = params.get('since');
    const body = list
      .filter((n) => params.get('all') === 'true' || n.unread)
      .filter((n) => !since || Date.parse(n.updated_at) > Date.parse(since));
    return { headers: { etag: `e-${body.length}` }, body };
  };
}
