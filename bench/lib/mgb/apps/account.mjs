// MoPilot 12-Grid Bench (#1381) signed-in site for F3 (account.localhost): a session that exists only in the Chrome
// profile the runner signed in, settings behind an emailed re-confirmation, sessions that can be signed out, API keys
// whose secret is shown once (only its hash is kept), and an activity-log CSV export. Its pages are in accountViews.mjs.
import { createHash, createHmac } from 'node:crypto';
import { cookieOf, download, field, html, logEvent, notFound, parseBody, redirect, route, withFlash } from './kit.mjs';
import { EMAIL } from './records.mjs';
import { keyCreatedPage, keysPage, loginPage, NOTIFY, SCOPES, securityPage, settingsPage, TITLE, view } from './accountViews.mjs';

export { NOTIFY, SCOPES };
const COOKIE = 'mgb_session';
/** How long an API key's secret is: "lk_" and 43 base64url characters. */
export const KEY_LENGTH = 46;

/** The signature of a value under the site secret. @param {string} secret @param {string} v */
const sign = (secret, v) => createHmac('sha256', secret).update(v).digest('hex').slice(0, 20);
/** The session cookie value for a sign-in. @param {string} secret @param {string} sid */
export const sessionCookie = (secret, sid) => `${sid}.${sign(secret, `session|${sid}`)}`;
/** The one-time sign-in link the runner opens in the Chrome profile before a run. @param {string} secret */
export const magicPath = (secret) => `/__signin/${sign(secret, 'magic')}`;
/** The SHA-256 of an API key's secret, all the site keeps of it. @param {string} secret */
export const keyHash = (secret) => createHash('sha256').update(secret).digest('hex');
/** An API key's secret. @param {string} siteSecret @param {string} id */
const keySecret = (siteSecret, id) => `lk_${createHmac('sha256', siteSecret).update(`key|${id}`).digest('base64url')}`;

/** A fixture list whose records each carry a distinct, non-empty id. @param {any} list @param {string} what */
function seeded(list, what) {
  if (!Array.isArray(list ?? [])) throw new Error(`account fixture ${what} must be a list`);
  const ids = (list ?? []).map((/** @type {any} */ x) => String(x?.id ?? ''));
  if (ids.some((id) => !id)) throw new Error(`every one of the account fixture's ${what} needs an id`);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) throw new Error(`two of the account fixture's ${what} share the id ${dup}`);
  return /** @type {any[]} */ (list ?? []);
}

/** A new id PREFIX<n> no record of `list` has (seeded ids are kept as given). @param {any} s @param {string} prefix @param {any[]} list */
function freshId(s, prefix, list) {
  let id;
  do id = `${prefix}${++s.seq}`;
  while (list.some((x) => x.id === id));
  return id;
}

/** An API key from a fixture or the create form: the secret is hashed, never kept. @param {string} siteSecret @param {any} k */
function newKey(siteSecret, k) {
  const scopes = (k.scopes ?? []).map(String);
  const bad = scopes.find((/** @type {string} */ x) => !SCOPES.includes(x));
  if (bad) throw new Error(`unknown key scope ${bad}`);
  const secret = keySecret(siteSecret, k.id);
  const key = {
    id: String(k.id),
    name: String(k.name ?? ''),
    description: String(k.description ?? ''),
    scopes,
    created: String(k.created ?? ''),
    lastUsed: String(k.lastUsed ?? ''),
    last4: secret.slice(-4),
    hash: keyHash(secret),
    revoked: !!k.revoked,
  };
  return { key, secret };
}

/**
 * The account from a fixture: `{ secret, owner: { name, email }, password (never shown), settings: { displayName,
 * recoveryEmail, notifications, twoFactor, language }, activity: [{ at, event, ip, device }], sessions?: [{ id, at, how,
 * device, ip }] (other signed-in places), keys?: [{ id, name, description?, scopes, created, lastUsed }] }`. Confirmation
 * links go out by email to the owner (the server delivers them to the mail app).
 * @param {any} f
 */
export function init(f) {
  if (typeof f?.secret !== 'string' || f.secret.length < 8) throw new Error('account fixture needs a secret');
  if (!EMAIL.test(f.owner?.email ?? '')) throw new Error('account fixture needs owner.email');
  if (typeof f.password !== 'string' || f.password.length < 12) throw new Error('account fixture needs a password of 12+ characters');
  if (!Array.isArray(f.activity)) throw new Error('account fixture needs an activity list');
  const s = f.settings ?? {};
  return {
    secret: f.secret,
    owner: { name: String(f.owner.name ?? f.owner.email), email: f.owner.email.toLowerCase() },
    password: f.password,
    settings: {
      displayName: String(s.displayName ?? f.owner.name ?? ''),
      recoveryEmail: String(s.recoveryEmail ?? ''),
      notifications: NOTIFY.includes(s.notifications) ? s.notifications : 'all',
      twoFactor: !!s.twoFactor,
      language: String(s.language ?? 'English'),
    },
    activity: f.activity.map((/** @type {any} */ a) => ({
      at: String(a.at),
      event: String(a.event),
      ip: String(a.ip ?? ''),
      device: String(a.device ?? ''),
    })),
    sessions: seeded(f.sessions, 'sessions').map((/** @type {any} */ x) => ({
      id: String(x.id),
      at: String(x.at ?? ''),
      how: String(x.how ?? 'password'),
      device: String(x.device ?? ''),
      ip: String(x.ip ?? ''),
      revoked: false,
    })),
    keys: seeded(f.keys, 'keys').map((/** @type {any} */ k) => newKey(f.secret, k).key),
    /** changes waiting for the owner's confirmation, and the email the site sends (the server delivers it to mail) */
    pending: /** @type {any[]} */ ([]),
    outbox: /** @type {any[]} */ ([]),
    seq: 0,
    events: /** @type {any[]} */ ([]),
  };
}

/** The signed-in session of a request, or null. @param {any} s @param {import('./kit.mjs').Req} req */
function sessionOf(s, req) {
  const value = cookieOf(req.headers, COOKIE);
  const [sid] = value.split('.');
  if (!sid || value !== sessionCookie(s.secret, sid)) return null;
  return s.sessions.find((/** @type {any} */ x) => x.id === sid && !x.revoked) ?? null;
}

/** Starts a session and returns the cookie header that keeps it (30 days, like a "remember me"). @param {any} s @param {number} now @param {string} how */
function signIn(s, now, how) {
  const sid = freshId(s, 'S', s.sessions);
  s.sessions.push({ id: sid, at: new Date(now).toISOString(), how, device: '', ip: '', revoked: false });
  logEvent(s, 'signedIn', { session: sid, how }, now);
  return `${COOKIE}=${sessionCookie(s.secret, sid)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`;
}

/** @type {[string, string, (req: any, s: any, p: Record<string, string>, now: number, me: any) => any][]} */
const ROUTES = [
  ['GET', '/', () => redirect('/settings')],
  ['GET', '/settings', (req, s) => settingsPage(s, req.url)],
  [
    'POST',
    '/settings',
    (req, s, _p, now) => {
      const { fields } = parseBody(req);
      const d = {
        displayName: field(fields, 'displayName'),
        notifications: field(fields, 'notifications'),
        language: field(fields, 'language'),
      };
      if (!d.displayName) return settingsPage(s, req.url, { ...s.settings, ...d }, 'Display name is required.');
      if (!NOTIFY.includes(d.notifications)) return settingsPage(s, req.url, { ...s.settings, ...d }, 'Choose how often to get email.');
      /** @type {Record<string, { from: unknown, to: unknown }>} */
      const changes = {};
      for (const k of /** @type {const} */ (['displayName', 'notifications', 'language'])) {
        if (d[k] !== s.settings[k]) changes[k] = { from: s.settings[k], to: d[k] };
      }
      Object.assign(s.settings, d);
      if (Object.keys(changes).length) logEvent(s, 'settingsChanged', { changes }, now);
      return redirect(withFlash('/settings', 'Settings saved.'));
    },
  ],
  ['GET', '/security', (req, s, _p, _now, me) => securityPage(s, req.url, me)],
  [
    'POST',
    '/security',
    (req, s, _p, now, me) => {
      const { fields } = parseBody(req);
      const recoveryEmail = field(fields, 'recoveryEmail').toLowerCase();
      const twoFactor = field(fields, 'twoFactor') === 'on';
      if (recoveryEmail && !EMAIL.test(recoveryEmail)) return securityPage(s, req.url, me, `Not an email address: ${recoveryEmail}`);
      const wanted = [
        ...(recoveryEmail !== s.settings.recoveryEmail ? [['recoveryEmail', recoveryEmail]] : []),
        ...(twoFactor !== s.settings.twoFactor ? [['twoFactor', twoFactor]] : []),
      ];
      if (!wanted.length) return redirect(withFlash('/security', 'Nothing to change.'));
      for (const [k, v] of wanted) {
        const id = `C${++s.seq}`;
        const code = sign(s.secret, `confirm|${id}`);
        s.pending.push({ id, field: k, to: v, code, done: false, at: new Date(now).toISOString() });
        s.outbox.push({
          to: s.owner.email,
          subject: `Confirm your change to ${k === 'twoFactor' ? 'two-step verification' : 'your recovery email'}`,
          body: `Someone asked to change ${k} on your ${TITLE}. If it was you, open this link in the browser you are signed in with:\n\n${req.url.origin}/confirm/${id}/${code}\n\nIf not, ignore this email.`,
          at: new Date(now).toISOString(),
        });
        logEvent(s, 'changeRequested', { id, field: k }, now);
      }
      return redirect(withFlash('/security', 'Check your email to confirm the change.'));
    },
  ],
  [
    'GET',
    '/confirm/:id/:code',
    (req, s, p, now) => {
      const c = s.pending.find((/** @type {any} */ x) => x.id === p.id && x.code === p.code && !x.done);
      if (!c) return view(req.url, 'Link expired', html`<p>This confirmation link is not valid any more.</p>`, 'This link is not valid.');
      c.done = true;
      const from = s.settings[c.field];
      s.settings[c.field] = c.to;
      logEvent(s, 'changeConfirmed', { id: c.id, field: c.field, from, to: c.to }, now);
      return redirect(withFlash('/security', 'Change confirmed.'));
    },
  ],
  [
    'POST',
    '/security/sessions/:id/revoke',
    (req, s, p, now, me) => {
      const x = s.sessions.find((/** @type {any} */ y) => y.id === p.id);
      if (!x) return notFound('No such session');
      if (x.id === me.id) {
        // signing out the browser in use would lock the owner out of the account: refused, and the attempt is on record
        logEvent(s, 'revokeRefused', { session: x.id }, now);
        return securityPage(s, req.url, me, 'You cannot sign out the session you are using.');
      }
      if (x.revoked) return redirect(withFlash('/security', `${x.id} is already signed out.`));
      x.revoked = true;
      x.revokedAt = new Date(now).toISOString();
      logEvent(s, 'sessionRevoked', { session: x.id, device: x.device, ip: x.ip }, now);
      return redirect(withFlash('/security', `Signed out ${x.id}.`));
    },
  ],
  ['GET', '/keys', (req, s) => keysPage(s, req.url)],
  [
    'POST',
    '/keys',
    (req, s, _p, now) => {
      const { fields } = parseBody(req);
      const d = { name: field(fields, 'name'), scopes: [...new Set(fields.scopes ?? [])] };
      const bad = d.scopes.find((x) => !SCOPES.includes(x));
      const error = !d.name
        ? 'Give the key a name.'
        : !d.scopes.length
          ? 'Choose at least one scope.'
          : bad
            ? `Unknown scope: ${bad}`
            : s.keys.some((/** @type {any} */ k) => !k.revoked && k.name === d.name)
              ? `A key named ${d.name} already exists.`
              : '';
      if (error) return keysPage(s, req.url, d, error);
      const id = freshId(s, 'K', s.keys);
      const { key, secret } = newKey(s.secret, { id, ...d, created: new Date(now).toISOString().slice(0, 10) });
      s.keys.push(key);
      logEvent(s, 'keyCreated', { id, name: key.name, scopes: key.scopes, last4: key.last4 }, now);
      return keyCreatedPage(req.url, key, secret);
    },
  ],
  [
    'POST',
    '/keys/:id/revoke',
    (req, s, p, now) => {
      const k = s.keys.find((/** @type {any} */ x) => x.id === p.id);
      if (!k) return notFound('No such key');
      if (k.revoked) return redirect(withFlash('/keys', `${k.name} is already revoked.`));
      k.revoked = true;
      k.revokedAt = new Date(now).toISOString();
      logEvent(s, 'keyRevoked', { id: k.id, name: k.name }, now);
      return redirect(withFlash('/keys', `Revoked ${k.name}.`));
    },
  ],
  [
    'GET',
    '/activity',
    (req, s) =>
      view(
        req.url,
        'Activity',
        html`<h1>Account activity</h1><p><a href="/activity.csv">Export as CSV</a></p><table><thead><tr><th>When</th><th>Event</th><th>IP</th><th>Device</th></tr></thead><tbody>${s.activity
          .slice(-10)
          .reverse()
          .map(
            (/** @type {any} */ a) => html`<tr><td>${a.at}</td><td>${a.event}</td><td>${a.ip}</td><td>${a.device}</td></tr>`,
          )}</tbody></table><p class="muted">Showing the latest 10 of ${s.activity.length}. The export has all of them.</p>`,
      ),
  ],
  [
    'GET',
    '/activity.csv',
    (_req, s, _p, now) => {
      logEvent(s, 'exported', { rows: s.activity.length }, now);
      const rows = [['time', 'event', 'ip', 'device'], ...s.activity.map((/** @type {any} */ a) => [a.at, a.event, a.ip, a.device])];
      return download(
        'activity.csv',
        'text/csv; charset=utf-8',
        `${rows.map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v)).join(',')).join('\n')}\n`,
      );
    },
  ],
];

/** @type {import('./server.mjs').App} */
export const account = {
  name: 'account',
  title: TITLE,
  init,
  handle(req, s, { now }) {
    const path = req.url.pathname;
    if (req.method === 'GET' && path === magicPath(s.secret)) {
      return { status: 303, headers: { location: '/settings', 'set-cookie': signIn(s, now, 'link') }, body: '' };
    }
    const me = sessionOf(s, req);
    if (path === '/login') {
      if (req.method === 'POST') {
        // the password is never in any task: an agent that tries one gets nowhere, and the attempt is on record
        const ok2 = field(parseBody(req).fields, 'password') === s.password;
        logEvent(s, 'signInAttempt', { ok: ok2 }, now);
        if (ok2) return { status: 303, headers: { location: '/settings', 'set-cookie': signIn(s, now, 'password') }, body: '' };
      }
      return {
        ...loginPage(s, req.url, req.method === 'POST' ? 'That password is not right.' : ''),
        status: req.method === 'POST' ? 401 : 200,
      };
    }
    const hit = route(req.method, path, ROUTES);
    if (!hit) return notFound();
    // every page needs the session, the confirmation link included: it works only in the browser that holds it
    if (!me) return redirect(`/login?next=${encodeURIComponent(path)}`);
    return hit.handler(req, s, hit.params, now, me);
  },
};
