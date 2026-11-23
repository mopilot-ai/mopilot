// OAuth and app-access consent (#1619): which controls the page agent and Your Chrome's reader call a grant on a consent
// page (electron/capabilities/browser/consent.cjs), across identity providers, with cookie banners and ordinary pages
// left alone, and the sensitive action siteRisk.cjs names from it, which Full access does not cover. happy-dom pages;
// the page agent and the reader are real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { pageAgent } = require('../electron/capabilities/browser/pageAgent.cjs');
const { ELEMENT_INTENT } = require('../electron/capabilities/browser/chromeIntent.cjs');
const { consentUrl, grantName, consentDetail } = require('../electron/capabilities/browser/consent.cjs');
const { sensitiveAction, sensitiveByName, fullAccessCovers } = require('../electron/capabilities/browser/siteRisk.cjs');

/** A happy-dom page at `url` with `html`, as the document the page agent reads, for the duration of `run`. */
function onPage(url: string, html: string, run: (read: Record<string, (id: string) => any>) => void, title = '') {
  const win = new Window({ url });
  const G: any = globalThis;
  const saved = { document: G.document, getComputedStyle: G.getComputedStyle };
  win.document.title = title;
  win.document.body.innerHTML = html;
  G.document = win.document;
  G.getComputedStyle = (el: any) => win.getComputedStyle(el);
  try {
    const agent = pageAgent();
    const chrome = new win.Function(`return (${ELEMENT_INTENT})`)();
    const el = (id: string) => win.document.getElementById(id);
    run({
      iab: (id: string) => agent.call('intent', { ref: agent.refFor(el(id)).ref }).value,
      chrome: (id: string) => chrome(el(id)),
    });
  } finally {
    Object.assign(G, saved);
    win.close();
  }
}

const SCOPES = '<ul><li>See your email address</li><li>Read your repositories</li></ul>';
const BUTTONS = `<button id="allow">Allow</button><button id="cancel">Cancel</button>`;

test('a grant control on a consent page is consent, across identity providers, in the page agent and in Your Chrome, with the app and the scopes the page lists', () => {
  const pages: [string, string, string, string, string][] = [
    // url, heading, the grant button, its name, the app the card names
    [
      'https://accounts.google.com/signin/oauth/consent?client_id=1.apps.googleusercontent.com',
      'Acme wants to access your Google Account',
      'allow',
      'Allow',
      'Acme',
    ],
    ['https://github.com/login/oauth/authorize?client_id=Iv1', 'Authorize Acme', 'go', 'Authorize acme-org', 'Acme'],
    ['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x', 'Permissions requested', 'go', 'Accept', ''],
    [
      'https://slack.com/oauth/v2/authorize?client_id=1',
      'Acme is requesting permission to access the Team workspace',
      'allow',
      'Allow',
      'Acme',
    ],
    [
      'https://dev-1.okta.com/oauth2/default/v1/authorize?client_id=1&response_type=code',
      'Acme would like to',
      'go',
      'Allow Access',
      'Acme',
    ],
    ['https://appleid.apple.com/auth/authorize?client_id=com.acme', 'Sign in to Acme', 'go', 'Continue', 'Acme'],
    ['https://github.com/apps/acme/installations/new', 'Install Acme', 'go', 'Install & Authorize', 'Acme'],
    ['https://tenant.auth0.com/u/consent?state=s', 'Authorize App', 'go', 'Accept', 'App'],
    // a single-page app whose address no longer says so: its heading does
    ['https://app.example.test/connect', 'Acme wants access to your account', 'go', 'Approve', 'Acme'],
  ];
  for (const [url, heading, id, name, app] of pages)
    onPage(url, `<main><h1>${heading}</h1><form>${SCOPES}<button id="go">${name}</button>${BUTTONS}</form></main>`, (read) => {
      for (const [reader, r] of Object.entries(read)) {
        const consent = r(id)?.consent;
        assert.ok(consent, `${reader}: ${url}`);
        assert.equal(consent.app, app, `${reader}: ${url}`);
        assert.deepEqual([...consent.scopes], ['See your email address', 'Read your repositories'], `${reader}: ${url}`);
        assert.equal(r('cancel').consent, null, `${reader}: Cancel on ${url}`);
      }
    });
  // the app may be in the title, or only in the button's name
  onPage(
    'https://accounts.google.com/o/oauth2/v2/auth/consent?client_id=1',
    '<button id="c">Continue</button>',
    (read) => {
      assert.equal(read.iab('c').consent.app, 'Acme');
      assert.deepEqual([...read.iab('c').consent.scopes], []);
    },
    'Sign in – Google Accounts to continue to Acme',
  );
  onPage('https://idp.example.test/oauth/authorize?redirect_uri=x', '<p>Grant</p><button id="c">Authorize Acme</button>', (read) => {
    assert.equal(read.chrome('c').consent.app, 'Acme');
  });
});

test('a cookie banner, an ordinary page and a non-grant control are not consent', () => {
  // a cookie banner's Allow on an ordinary page and on a consent page
  for (const url of ['https://news.test/', 'https://accounts.google.com/signin/oauth/consent?client_id=1'])
    onPage(
      url,
      `<h1>Acme wants to access your account</h1><div id="onetrust-banner-sdk"><p>We use cookies</p><button id="b">Allow</button></div><div class="cookie-notice"><button id="c">Accept</button></div>`,
      (read) => {
        for (const r of Object.values(read)) for (const id of ['b', 'c']) assert.equal(r(id).consent, null, `${url} ${id}`);
      },
    );
  // Google's cookie page and an ordinary page's Allow (a newsletter, notifications) are no consent page
  onPage('https://consent.google.com/ml?continue=x', '<button id="a">Accept all</button><button id="b">Allow</button>', (read) => {
    for (const r of Object.values(read)) for (const id of ['a', 'b']) assert.equal(r(id).consent, null, id);
  });
  onPage('https://news.test/settings', '<h1>Notifications</h1><button id="b">Allow</button><a href="/x" id="l">Continue</a>', (read) => {
    for (const r of Object.values(read)) for (const id of ['b', 'l']) assert.equal(r(id).consent, null, id);
  });
  // an ordinary heading that says who will see something, and markup from a component library's cmp-* classes
  onPage('https://docs.test/d/1', '<h2>Anyone with the link will be able to view</h2><button id="s">Share</button>', (read) => {
    for (const r of Object.values(read)) assert.equal(r('s').consent, null);
  });
  onPage(
    'https://github.com/login/oauth/authorize?client_id=1',
    '<div class="cmp-container"><button id="a">Authorize Acme</button></div>',
    (read) => {
      for (const r of Object.values(read)) assert.equal(r('a').consent?.app, 'Acme');
    },
  );
  // a text field on a consent page is no button
  onPage('https://github.com/login/oauth/authorize?client_id=1', '<input id="t" aria-label="Allow">', (read) => {
    for (const r of Object.values(read)) assert.equal(r('t').consent, null);
  });
});

test('the consent address and grant name tests', () => {
  for (const url of [
    'https://www.facebook.com/v18.0/dialog/oauth?client_id=1',
    'https://discord.com/oauth2/authorize?client_id=1',
    'https://github.com/apps/x/installations/select_target',
    'https://login.microsoftonline.com/tenant/oauth2/authorize',
  ])
    assert.equal(consentUrl(url), true, url);
  for (const url of [
    'https://shop.test/oauth/callback',
    'https://shop.test/consent',
    'https://github.com/settings',
    'ftp://x.test/oauth?client_id=1',
    'bad',
  ])
    assert.equal(consentUrl(url), false, url);
  for (const name of ['Allow', 'Authorize Acme', 'Accept and continue', 'Continue as Ada', 'Yes, allow', 'Link accounts', 'Connect GitHub'])
    assert.equal(grantName(name), true, name);
  for (const name of ['Accept all', 'Allow all cookies', 'Cancel', 'Deny', "Don't allow", '', 'Allow'.repeat(20)])
    assert.equal(grantName(name), false, name);
  assert.equal(consentDetail({ app: '', scopes: [] }, 'Allow'), 'Allow');
  assert.equal(consentDetail({ app: 'Acme', scopes: ['a', 'b'] }, 'Allow'), 'Acme: a; b');
  // an answer that crossed a process boundary may lack its scopes
  assert.equal(consentDetail({ app: 'Acme' }, 'Allow'), 'Acme');
});

test('a click or Enter on a consent control is the oauth_consent sensitive action, which Full access does not cover; by name it needs a consent page', () => {
  const intent = { tag: 'button', role: 'button', name: 'Allow', button: true, consent: { app: 'Acme', scopes: ['Read your email'] } };
  for (const action of [{ kind: 'click' }, { kind: 'key', keys: 'Enter' }]) {
    const s = sensitiveAction(intent, action);
    assert.deepEqual(s, { kind: 'oauth_consent', verb: 'grant Acme access to your account', detail: 'Acme: Read your email' });
    assert.equal(fullAccessCovers(s), false);
  }
  // with no app found the card says "an app"; a button that is no grant stays what its name says
  const unnamed = sensitiveAction({ ...intent, name: undefined, consent: { app: '', scopes: [] } }, { kind: 'click' });
  assert.deepEqual([unnamed.verb, unnamed.detail], ['grant an app access to your account', '']);
  assert.equal(sensitiveAction({ ...intent, name: 'Allow', consent: null }, { kind: 'click' }), null);
  // Your Chrome's fallback by the agent's element name, when the page can't be read
  assert.equal(sensitiveByName('Authorize Acme', 'https://github.com/login/oauth/authorize?client_id=1').kind, 'oauth_consent');
  assert.equal(sensitiveByName('Authorize Acme', 'https://news.test/'), null);
  assert.equal(sensitiveByName('Delete repo', 'https://github.com/login/oauth/authorize?client_id=1').kind, 'delete');
});
