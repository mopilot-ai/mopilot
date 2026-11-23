// MoPilot 12-Grid Bench (#1381) pages of the F3 signed-in site (account.localhost): settings, security with the
// signed-in sessions and their sign-out buttons, API keys with the create form, the one-time key page and sign-in.
import { flashOf, html, ok, page } from './kit.mjs';
import { checkboxes, input, rowsOr, select } from './records.mjs';

export const TITLE = 'Lumen Account';
export const NOTIFY = ['all', 'important', 'none'];
/** The scopes an API key can have. */
export const SCOPES = ['read', 'write', 'deploy', 'billing', 'admin'];

const NAV = /** @type {[string, string][]} */ ([
  ['/settings', 'Settings'],
  ['/security', 'Security'],
  ['/keys', 'API keys'],
  ['/activity', 'Activity'],
]);

/** A page of the site; an error answers 422. @param {URL} url @param {string} title @param {unknown} body */
export const view = (url, title, body, error = '') => {
  const res = ok(page({ app: TITLE, title, nav: NAV, flash: flashOf(url), error, body }));
  return error ? { ...res, status: 422 } : res;
};

/** @param {any} s @param {URL} url */
export function settingsPage(s, url, d = s.settings, error = '') {
  return view(
    url,
    'Settings',
    html`<h1>Settings</h1><p class="muted">Signed in as ${s.owner.email}</p>
<form method="post" action="/settings">${input('Display name', 'displayName', d.displayName)}${select('Email notifications', 'notifications', NOTIFY, d.notifications)}${select('Language', 'language', ['English', 'Deutsch', 'Español', 'Français', 'Português'], d.language)}<p><button>Save settings</button></p></form>`,
    error,
  );
}

/** The state of one session, and its sign-out button when it can be signed out. @param {any} x @param {any} me */
const sessionCell = (x, me) => {
  if (x.revoked) return 'Signed out';
  if (x.id === me.id) return 'This browser';
  return html`<form class="inline" method="post" action="/security/sessions/${x.id}/revoke"><button>Sign out</button></form>`;
};

/** @param {any} s @param {URL} url @param {any} me the session viewing the page */
export function securityPage(s, url, me, error = '') {
  const pending = s.pending.filter((/** @type {any} */ p) => !p.done);
  return view(
    url,
    'Security',
    html`<h1>Security</h1>
<form method="post" action="/security"><label for="recoveryEmail">Recovery email</label><input id="recoveryEmail" name="recoveryEmail" value="${s.settings.recoveryEmail}">
<label><input type="checkbox" name="twoFactor" value="on"${s.settings.twoFactor ? ' checked' : ''}> Two-step verification</label>
<p class="muted">Changes here take effect after you confirm them from the link we email to ${s.owner.email}.</p><p><button>Request change</button></p></form>
${pending.length ? html`<h2>Waiting for confirmation</h2><ul>${pending.map((/** @type {any} */ p) => html`<li>${p.field}: ${String(p.to)}</li>`)}</ul>` : ''}
<h2>Signed-in sessions</h2><table><thead><tr><th>Session</th><th>Signed in</th><th>How</th><th>Device</th><th>IP address</th><th></th></tr></thead><tbody>${s.sessions.map(
      (/** @type {any} */ x) =>
        html`<tr><td>${x.id}</td><td>${x.at}</td><td>${x.how}</td><td>${x.device}</td><td>${x.ip}</td><td>${sessionCell(x, me)}</td></tr>`,
    )}</tbody></table>`,
    error,
  );
}

/** The API keys and the form that creates one, keeping what was typed. @param {any} s @param {URL} url */
export function keysPage(s, url, d = { name: '', scopes: /** @type {string[]} */ ([]) }, error = '') {
  const rows = s.keys.map(
    (/** @type {any} */ k) =>
      html`<tr><td>${k.name}</td><td>…${k.last4}</td><td>${k.created}</td><td>${k.lastUsed || 'Never'}</td><td>${k.scopes.join(', ')}</td><td>${k.description}</td><td>${
        k.revoked ? 'Revoked' : html`<form class="inline" method="post" action="/keys/${k.id}/revoke"><button>Revoke</button></form>`
      }</td></tr>`,
  );
  return view(
    url,
    'API keys',
    html`<h1>API keys</h1><table><thead><tr><th>Name</th><th>Key</th><th>Created</th><th>Last used</th><th>Scopes</th><th>Description</th><th></th></tr></thead><tbody>${rowsOr(rows, 7)}</tbody></table>
<h2>Create a key</h2><form method="post" action="/keys">${input('Name', 'name', d.name)}${checkboxes('Scopes', 'scopes', SCOPES, d.scopes)}<p><button>Create key</button></p></form>`,
    error,
  );
}

/** The new key's secret, shown this once: the site keeps only its hash and last 4 characters. @param {URL} url @param {any} k @param {string} secret */
export const keyCreatedPage = (url, k, secret) =>
  view(
    url,
    'Key created',
    html`<h1>Key created</h1><p>${k.name} (${k.scopes.join(', ')})</p><p><code id="new-key">${secret}</code></p>
<p class="muted">Copy it now: it is shown only this once.</p><p><a href="/keys">Back to API keys</a></p>`,
  );

/** The sign-in form. @param {any} s @param {URL} url */
export const loginPage = (s, url, error = '') =>
  view(
    url,
    'Sign in',
    html`<h1>Sign in</h1><form method="post" action="/login">${input('Email', 'email', s.owner.email, 'email')}${input('Password', 'password', '', 'password')}<p><button>Sign in</button></p></form>`,
    error,
  );
