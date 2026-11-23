// The control matrix (docs/control-plane/matrix.md), group J: granting a third-party app access to the user's account
// (an OAuth consent's "Allow" or "Authorize") is the user's decision (#1619). A click or Enter an agent aims at a
// recognized consent control asks on MoPilot's card, naming the app and the scopes, in Full access too, on every
// executor: browser_* for Claude Code, Codex, a chat that switched harness and an ACP session, the Codex Browser plugin's
// iab backend (a native thread's cua.* clicks arrive there as CDP input) and Your Chrome. A cookie banner's "Allow" runs
// as before. BrowserTabs, the browser tools, IabBackend, the Your Chrome check, OriginGrants and the Registry are real;
// pages, CDP and Chrome are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drive } from './support/browser-host-kit.ts';
import { acpSession } from './support/control-matrix-kit.ts';
import { checkout, harnesses, plugin, yourChrome } from './support/sensitive-frames-kit.ts';

export const GUARDS = ['electron/', 'shared/'];

/** GitHub's "Authorize Acme" button, as the page agent reports it on the consent page (consent.cjs). */
const AUTHORIZE = {
  tag: 'button',
  type: '',
  role: 'button',
  name: 'Authorize acme-org',
  button: true,
  submits: true,
  editable: false,
  form: { secrets: 0, newPassword: false, payment: false, submit: 'Authorize acme-org' },
  consent: { app: 'Acme', scopes: ['Read your repositories', 'See your email address'] },
};
/** A cookie banner's "Allow" on the same kind of page: no consent. */
const COOKIE_ALLOW = { tag: 'button', type: '', role: 'button', name: 'Allow', button: true, editable: false, consent: null };

const text = (r: any) => (r?.content ?? []).map((c: any) => c.text ?? '').join('\n');

test("CM-J34: in Full access, a click on an OAuth consent control asks on the card naming the app and the scopes for Claude Code, Codex, a chat that switched and ACP; a cookie banner's Allow runs with no card", async (t) => {
  const k = checkout(t, 'full');
  k.answers[''] = AUTHORIZE;
  const via = await harnesses(k.w);
  const acp = await acpSession(k.w, { chatId: 'c' });
  via.ACP = (name: string, args: any) => acp.call(name, args);
  for (const [harness, call] of Object.entries(via)) {
    const before = k.cards.length;
    const r = await drive(t, call('browser_computer', { action: 'left_click', coordinate: [40, 60] }));
    assert.ok(!r.isError, `${harness}: ${text(r)}`);
    assert.equal(k.cards.length, before + 1, harness);
    const card = k.cards.at(-1);
    assert.equal(card.sensitive.kind, 'oauth_consent', harness);
    assert.equal(card.sensitive.verb, 'grant Acme access to your account', harness);
    assert.match(card.summary, /Acme: Read your repositories; See your email address/, harness);
  }
  // the card was allowed each time, so each click reached the page
  assert.equal(k.clicks().length, Object.keys(via).length);
  k.answers[''] = COOKIE_ALLOW;
  const cards = k.cards.length;
  await drive(t, via.Codex('browser_computer', { action: 'left_click', coordinate: [40, 60] }));
  assert.equal(k.cards.length, cards, 'a cookie banner asks nothing in Full access');
});

test("CM-J35: the Codex Browser plugin's mouse press and Enter on a consent control (a native thread's cua click) ask on the card in Full access", async () => {
  const p = plugin('full');
  p.answers[''] = AUTHORIZE;
  await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 });
  await p.cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
  assert.deepEqual(
    p.cards.map((c: any) => [c.sensitive.kind, c.sensitive.verb]),
    [
      ['oauth_consent', 'grant Acme access to your account'],
      ['oauth_consent', 'grant Acme access to your account'],
    ],
  );
  p.answers[''] = COOKIE_ALLOW;
  await p.cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 60, button: 'left', clickCount: 1 });
  assert.equal(p.cards.length, 2);
});

test("CM-J36: Your Chrome's browser_click on a consent control asks in Full access, also by the agent's element name when the page can't be read", async () => {
  const snap = '- button "Authorize acme-org" [ref=e2]';
  const read = await yourChrome('full', 'browser_click', { target: 'e2', element: 'Authorize acme-org' }, () => AUTHORIZE, snap);
  assert.deepEqual(
    read.cards.map((c: any) => c.sensitive.kind),
    ['oauth_consent'],
  );
  // the reader answers nothing: the snapshot's page address is a consent page and the agent's name a grant, so it asks
  const github = 'https://github.com/login/oauth/authorize?client_id=Iv1';
  const unread = await yourChrome(
    'full',
    'browser_click',
    { target: 'e2', element: 'Authorize acme-org' },
    () => ({ none: true }),
    snap,
    github,
  );
  assert.deepEqual(
    unread.cards.map((c: any) => c.sensitive.kind),
    ['oauth_consent'],
  );
  const cookie = await yourChrome('full', 'browser_click', { target: 'e2', element: 'Allow' }, () => COOKIE_ALLOW, snap);
  assert.equal(cookie.cards.length, 0);
  // on the consent page itself, the reader's "no consent" (a cookie banner's Allow) wins over the agent's element name
  const banner = await yourChrome('full', 'browser_click', { target: 'e2', element: 'Allow' }, () => COOKIE_ALLOW, snap, github);
  assert.equal(banner.cards.length, 0);
});
