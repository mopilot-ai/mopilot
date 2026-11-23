// MoPilot 12-Grid Bench (#1381) fixture server logic: routes `<app>.localhost` hosts to the seeded apps (one origin
// each), and serves the runner's token-guarded endpoints that load a task's fixtures and read every app's state.
import { createHash } from 'node:crypto';
import { cookieOf, header, json, notFound, ok, page, html } from './kit.mjs';

/**
 * A fixture app: `init(fixture)` builds its state from a task's fixture (the state always has `seq` and `events`),
 * `handle(req, state, ctx)` serves one request and may change the state.
 * @typedef {{ name: string, title: string, init: (fixture: any) => any,
 *   handle: (req: import('./kit.mjs').Req, state: any, ctx: { now: number }) => import('./kit.mjs').Res }} App
 */

/** The header the runner sends with its token: the agent never sees it, so it can neither read nor reset the state. */
export const TOKEN_HEADER = 'x-mgb-token';

/**
 * The cookie that marks the user's own Chrome. The runner opens `/__mgb/mark` in the bench Chrome profile on every app
 * host before a run, and a request carrying the mark is that Chrome's. A user agent cannot tell it apart: ChatGPT's
 * built-in browser sends Chrome's exact user agent and client hints.
 */
export const CHROME_COOKIE = 'mgb_chrome';
/** The mark for a token: derived from it, so the agent, who never sees the token, cannot make one. @param {string} token */
export const chromeMark = (token) => createHash('sha256').update(`chrome:${token}`).digest('hex').slice(0, 32);

/**
 * The server's store: the apps it serves, the runner's token and each loaded app's state.
 * @param {App[]} apps @param {string} token
 */
export function createStore(apps, token) {
  if (!token || token.length < 16) throw new Error('the grader token must be at least 16 characters');
  const byName = Object.fromEntries(apps.map((a) => [a.name, a]));
  if (Object.keys(byName).length !== apps.length) throw new Error('two apps share a name');
  return {
    token,
    mark: chromeMark(token),
    apps: byName,
    /** @type {Record<string, any>} */ states: {},
    /** the app hosts the user's Chrome has carried the mark to since the server started */
    marked: /** @type {Set<string>} */ (new Set()),
  };
}

/** The app a host names: "mail.localhost:8820" → "mail"; null for a bare host. @param {string} host */
export function appOfHost(host) {
  const m = /^([a-z0-9-]+)\.localhost(?::\d+)?$/i.exec(host.trim());
  return m ? m[1].toLowerCase() : null;
}

/**
 * Serves one request.
 * - `/__mgb/load` (POST, JSON `{ apps: { name: fixture } }`): replaces those apps' state from a task's fixtures.
 * - `/__mgb/state` (GET): every loaded app's state. Both need the runner's token; without it they do not exist (404).
 * - `/__mgb/marks` (GET, token): the app hosts the user's Chrome carries the mark on.
 * - `/__mgb/mark?k=<mark>&next=<app,app>` (GET, opened in that Chrome, no token): sets the mark cookie on this host,
 *   then goes on to the next app's host; a wrong mark is a 404.
 * - Anything else goes to the app the host names; an app with no fixture loaded answers 503.
 * @param {ReturnType<typeof createStore>} store @param {import('./kit.mjs').Req} req @param {number} now
 * @returns {import('./kit.mjs').Res}
 */
export function dispatch(store, req, now) {
  if (req.url.pathname === '/__mgb/mark' && req.method === 'GET') return markChrome(store, req);
  if (req.url.pathname.startsWith('/__mgb/')) {
    if (header(req.headers, TOKEN_HEADER) !== store.token) return notFound();
    if (req.url.pathname === '/__mgb/state' && req.method === 'GET') return json(store.states);
    if (req.url.pathname === '/__mgb/marks' && req.method === 'GET') return json({ hosts: [...store.marked].sort() });
    if (req.url.pathname === '/__mgb/load' && req.method === 'POST') {
      let body;
      try {
        body = JSON.parse(Buffer.from(req.body, 'latin1').toString('utf8'));
      } catch {
        return json({ error: 'body is not JSON' }, 400);
      }
      const fixtures = body?.apps;
      if (!fixtures || typeof fixtures !== 'object' || Array.isArray(fixtures))
        return json({ error: 'expected { apps: { name: fixture } }' }, 400);
      const unknown = Object.keys(fixtures).filter((n) => !store.apps[n]);
      if (unknown.length) return json({ error: `unknown apps: ${unknown.join(', ')}` }, 400);
      // all or nothing: a fixture that fails to load leaves every app as it was
      /** @type {Record<string, any>} */
      const next = {};
      for (const [n, f] of Object.entries(fixtures)) {
        try {
          next[n] = store.apps[n].init(f);
        } catch (e) {
          return json({ error: `fixture for ${n} failed: ${String(/** @type {any} */ (e)?.message ?? e)}` }, 400);
        }
      }
      Object.assign(store.states, next);
      return json({ loaded: Object.keys(next) });
    }
    return notFound();
  }
  const name = appOfHost(header(req.headers, 'host'));
  if (!name || !store.apps[name]) {
    const list = Object.values(store.apps);
    return {
      ...ok(
        page({ app: 'Fixtures', title: 'Apps', body: html`<ul>${list.map((a) => html`<li>${a.title} (${a.name}.localhost)</li>`)}</ul>` }),
      ),
      status: name ? 404 : 200,
    };
  }
  const state = store.states[name];
  if (!state)
    return {
      ...ok(page({ app: store.apps[name].title, title: 'Not ready', body: html`<p>This site is not set up yet.</p>` })),
      status: 503,
    };
  const seen = state.events.length;
  const res = store.apps[name].handle(req, state, { now });
  // every change says whether a browser made it: a script (curl, fetch from a shell) going around the browser is
  // visible to the grader, so a task cannot be passed without using the surface it tests
  const ua = header(req.headers, 'user-agent');
  const via = viaOf(ua, header(req.headers, 'sec-fetch-mode'));
  const browser = via === 'script' ? null : browserOf(cookieOf(req.headers, CHROME_COOKIE), store.mark);
  for (const e of state.events.slice(seen)) Object.assign(e, browser ? { via, browser } : { via });
  deliver(store.states, name, store.apps[name].title, now);
  return res;
}

/**
 * Email an app sends (its `outbox`: a confirmation link, a receipt) lands in the mail app's inbox when mail is loaded,
 * from no-reply@<app>.localhost, as it would reach the user's real mailbox. Delivered mail is moved to `delivered`.
 * The fixture server and the oracles' driver (tasks/drive.mjs) both call it after each request.
 * @param {Record<string, any>} states every loaded app's state @param {string} name the app that handled the request
 * @param {string} title its title @param {number} now
 */
export function deliver(states, name, title, now) {
  const mail = states.mail;
  const state = states[name];
  if (!mail || !state?.outbox?.length) return;
  for (const m of state.outbox.splice(0)) {
    mail.messages.push({
      id: `MSG-${name}-${++mail.seq}`,
      folder: 'inbox',
      from: { name: title, email: `no-reply@${name}.localhost` },
      to: [m.to],
      cc: [],
      subject: m.subject,
      body: m.body,
      date: new Date(now).toISOString(),
      read: false,
      labels: [],
      attachments: [],
    });
    (state.delivered ??= []).push(m);
  }
}

/**
 * Which browser made a change: "chrome" for the user's own Chrome, which carries the mark the runner set, and
 * "app-browser" for any other browser: MoPilot's in-app browser, Claude Desktop's or ChatGPT's built-in one.
 * Browser-use tasks need the user's Chrome.
 * @param {string} cookie the request's mark cookie @param {string} mark the store's mark
 */
export const browserOf = (cookie, mark) => (cookie && cookie === mark ? 'chrome' : 'app-browser');

/**
 * `/__mgb/mark`: puts the mark cookie on this app's host (a year, never read by a page) and goes on to the next app's
 * host, so one tab carries it to every app; the last stop says so.
 * @param {ReturnType<typeof createStore>} store @param {import('./kit.mjs').Req} req
 * @returns {import('./kit.mjs').Res}
 */
function markChrome(store, req) {
  if (req.url.searchParams.get('k') !== store.mark) return notFound();
  const host = header(req.headers, 'host');
  const name = appOfHost(host);
  if (name) store.marked.add(name);
  const cookie = `${CHROME_COOKIE}=${store.mark}; Max-Age=31536000; Path=/; SameSite=Lax; HttpOnly`;
  const [next, ...rest] = (req.url.searchParams.get('next') ?? '').split(',').filter((n) => store.apps[n]);
  if (next) {
    const port = /:(\d+)$/.exec(host)?.[1];
    const query = `k=${store.mark}${rest.length ? `&next=${rest.join(',')}` : ''}`;
    return {
      status: 303,
      headers: { location: `http://${next}.localhost${port ? `:${port}` : ''}/__mgb/mark?${query}`, 'set-cookie': cookie },
      body: '',
    };
  }
  return ok(page({ app: 'Fixtures', title: 'Chrome marked', body: html`<p>This Chrome is marked for the bench.</p>` }), {
    'set-cookie': cookie,
  });
}

/**
 * How a change was made: "browser" for a page loaded or a form submitted in a browser (a browser's user agent, and a
 * navigation, or no fetch metadata from an older engine), "page-script" for a fetch run inside a page (the browser
 * marks it cors, same-origin or no-cors), and "script" for anything else (curl, a shell, Node).
 * @param {string} ua @param {string} [mode] the Sec-Fetch-Mode header
 */
export function viaOf(ua, mode = '') {
  if (!/\bMozilla\/5\.0\b.*\b(?:Chrome|Electron|Safari|Firefox)\//.test(ua)) return 'script';
  return !mode || mode === 'navigate' ? 'browser' : 'page-script';
}
