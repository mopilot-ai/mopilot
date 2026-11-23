// Control-matrix cases for the address a hand-off to the user's Chrome reopens (group M): the page's query is kept,
// so a page addressed by it reopens right (edge2 crash), and everything that may carry a credential is dropped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isSecretParam, mayNameSecret, restartUrl } from '../shared/browser.mjs';

export const GUARDS = ['electron/capabilities/browser/', 'shared/'];

const require = createRequire(import.meta.url);
const { browserWorld } = require('./helpers/browser.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { redactUrl } = require('../electron/capabilities/browser/hostUtil.cjs');

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';

test("CM-M17: a hand-off to Chrome keeps the page's query and fragment as written, dropping only what may carry a credential", () => {
  // kept, byte for byte: what addresses the page (the edge suite's run tag, a search, ids, anchors, SPA routes)
  for (const url of [
    'https://localhost:8791/s/crash?run=edge2-7',
    'https://shop.test/search?q=red+shoes&page=2',
    'https://app.test/item?id=42&tab=details',
    'https://docs.test/guide?v=3#install',
    'https://app.test/#/orders?id=9',
    'https://blog.test/post?author=ann&keyword=auth',
    'https://shop.test/cart?promo_code=SAVE10&country_code=US&sort_key=price&errorCode=4',
    'https://video.test/watch?v=abc&t=42',
    'https://a.test/x#section-2',
  ])
    assert.equal(restartUrl([url]), url, url);
  // dropped by name alone, case-insensitively and in any word style; the rest of the query stays as written
  for (const name of [
    'id_token',
    'access_token',
    'refresh_token',
    'TOKEN',
    'nonce',
    'session',
    'sessionId',
    'PHPSESSID',
    'jsessionid',
    'sig',
    'X-Amz-Signature',
    'X-Amz-Credential',
    'authToken',
    'authkey',
    'oauth_token',
    'oauth_verifier',
    'apiKey',
    'api_key',
    'Key-Pair-Id',
    'access_code',
    'password',
    'passcode',
    'mfa',
    'client_secret',
    'otp',
    'SAMLart',
    'SAMLRelayState',
    'wresult',
    'verification_code',
    'auth_ticket',
    'magic',
  ]) {
    assert.equal(isSecretParam(name), true, name);
    // a parameter only a sign-in callback carries reopens the site's root (below); every other one is just dropped
    const callback = ['id_token', 'oauth_verifier', 'SAMLart', 'wresult'].includes(name);
    assert.equal(
      restartUrl([`https://app.test/item?id=42&${name}=1&tab=a+b%20c`]),
      callback ? 'https://app.test/' : 'https://app.test/item?id=42&tab=a+b%20c',
      name,
    );
  }
  // ambiguous names are plain data unless the value looks like a credential (a long opaque or Base64 string, a JWT)
  for (const query of [
    'state=CA&city=Austin',
    'pin=94107',
    'pass=day-pass',
    'ticket=4521',
    'confirmation=ABC123',
    'code=SUMMER10',
    'key=sort',
    'sid=2',
    'verify=email',
    'auth=1',
    'tok=a&tkn=b',
    'reset=1&invite=friend&activation=no&confirm=yes&verification=sent',
    'state=new-york-city-area',
    'state=new+york+city+area',
    'key=created_at_desc_order',
    'code=10:30',
    'sid=1a:2',
    'auth=12:00',
    'key=a:',
    'pass=:b',
    'sid=a:b:c',
    'ticket=a/b:c',
    'auth=user+name:pw',
    'state=user:pass',
    't=10:30',
  ])
    assert.equal(restartUrl([`https://app.test/x?${query}`]), `https://app.test/x?${query}`, query);
  for (const query of [
    'ticket=ST-1856339-aA5Yuvrxzpv8Tau1cYQ7',
    'reset=8f14e45fceea167a5a36dedd4bea2543',
    'invite=Zm9vYmFyYmF6cXV4MTIzNDU2',
    'invite=Zm9vYmFy%2BYmF6cXV4%2FMTIzNDU2%3D',
    'invite=q8Zr+Kd3/Lm9Wx2+Pv7Tn4Ya==',
    'sid=s%3AwL9x3kQ2zJ7vN1mP8rT5yB4cD6fG0hK.Xy2%2FAbc',
    'key=AKIA1234:secretvalue12345',
    'ticket=ST-1-abc',
    'auth=user:pass',
    'pass=a:b',
    'key=k1:s',
    'tok=x:y',
    'tkn=u:p',
    'sid=1a:b2',
    'ticket=t:9x',
    'code=me:pw',
    `confirm=${JWT}`,
    'access_token=x',
    'jsessionid=1',
  ])
    assert.equal(restartUrl([`https://app.test/x?id=1&${query}`]), 'https://app.test/x?id=1', query);
  assert.equal(isSecretParam('state', 'CA'), false);
  assert.equal(isSecretParam('state', 'CA', true), true, 'in an OAuth exchange every ambiguous name is a credential');
  // an OAuth exchange inside a value or a fragment: its ambiguous parameters go, whatever their values
  assert.equal(restartUrl(['https://app.test/x?id=1&next=/cb?code=c%26state=xyz']), 'https://app.test/x?id=1');
  assert.equal(restartUrl(['https://app.test/x?id=1&code=4/0AY0e-g7abcdefghijklmnop']), 'https://app.test/x?id=1', 'a slashed code');
  assert.equal(
    restartUrl(['https://app.test/x?id=1&code=/promo/summer-sale-2026']),
    'https://app.test/x?id=1&code=/promo/summer-sale-2026',
    'a path',
  );
  assert.equal(restartUrl(['https://app.test/x?id=1&next=/cb?state=xyz%26client_id=a']), 'https://app.test/x?id=1');
  assert.equal(restartUrl(['https://app.test/x?id=1#code=c&state=s']), 'https://app.test/x?id=1');
  assert.equal(restartUrl(['https://app.test/x?id=1#state=CA']), 'https://app.test/x?id=1#state=CA');
  // logs and listings stay stricter: any name that names a credential on some site is hidden, whatever its value
  assert.equal(mayNameSecret('state'), true);
  assert.equal(mayNameSecret('city'), false);
  assert.equal(
    redactUrl('https://app.test/x?state=CA&pin=94107&ticket=4521&sid=2&city=Austin'),
    'https://app.test/x?state=REDACTED&pin=REDACTED&ticket=REDACTED&sid=REDACTED&city=Austin',
  );
  // a token as a value, whatever its parameter is called: a JWT (or an encrypted one), a magic link's long `t`
  assert.equal(restartUrl([`https://app.test/x?q=1&data=${JWT}`]), 'https://app.test/x?q=1');
  assert.equal(restartUrl(['https://app.test/x?q=1&d=eyJh.eyJi.c.d.e']), 'https://app.test/x?q=1');
  assert.equal(restartUrl(['https://app.test/m?t=Zx81kQ2mP0aL7vB3nR5s']), 'https://app.test/m');
  // an address inside a value that carries one, however it is encoded
  assert.equal(restartUrl(['https://app.test/x?id=1&next=/cb?token=abc']), 'https://app.test/x?id=1');
  assert.equal(restartUrl(['https://app.test/x?id=1&r=https%3A%2F%2Fb.test%2Fcb%3Faccess_token%3Dabc']), 'https://app.test/x?id=1');
  assert.equal(restartUrl(['https://app.test/x?id=1&next=/home?tab=2']), 'https://app.test/x?id=1&next=/home?tab=2');
  assert.equal(restartUrl(['https://app.test/x?next=http://%5B']), 'https://app.test/x?next=http://%5B', 'not an address after all');
  // a `;` piece of a parameter, an encoded name, a path parameter
  assert.equal(restartUrl(['https://app.test/x?id=1;token=abc&q=2']), 'https://app.test/x?q=2');
  assert.equal(restartUrl(['https://app.test/x?%74oken=abc&q=2']), 'https://app.test/x?q=2');
  assert.equal(restartUrl(['https://app.test/p;jsessionid=ABC/q;v=2?x=1']), 'https://app.test/p/q;v=2?x=1');
  // the rest of the query is never re-encoded: other charsets, empty and value-less parameters stay
  assert.equal(restartUrl(['https://a.jp/s?q=%93%FA%96%7B&token=x&&flag&z=a~b*c']), 'https://a.jp/s?q=%93%FA%96%7B&&flag&z=a~b*c');
  // only credentials: no query left at all
  assert.equal(restartUrl(['https://app.test/x?token=a&Signature=b']), 'https://app.test/x');
  // a fragment that carries one goes; the query stays
  assert.equal(restartUrl(['https://app.test/x?q=1#access_token=abc&token_type=bearer']), 'https://app.test/x?q=1');
  assert.equal(restartUrl(['https://app.test/#/cb?id_token=abc']), 'https://app.test/');
  assert.equal(restartUrl(['https://app.test/#?x=1/token=abc']), 'https://app.test/');
  assert.equal(restartUrl(['https://app.test/#a=1&%74oken=x']), 'https://app.test/');
  assert.equal(restartUrl([`https://app.test/x#${JWT}`]), 'https://app.test/x');
  assert.equal(restartUrl(['https://app.test/x#token=%E0%A4%A']), 'https://app.test/x', 'an undecodable value is still read by its name');
  // an OAuth, SAML or WS-Federation callback still reopens the site's root; a lone `state` is kept (a store locator)
  for (const url of [
    'https://app.test/oauth/callback?run=1',
    'https://app.test/login?code=c&state=s',
    'https://app.test/x?SAMLart=a',
    'https://app.test/x?wresult=a&wctx=b',
    'https://app.test/x?oauth_verifier=4&oauth_token=5',
    'https://app.test/x?client_id=a',
  ])
    assert.equal(restartUrl([url]), 'https://app.test/', url);
  assert.equal(restartUrl(['https://stores.test/find?state=CA&city=SF#map']), 'https://stores.test/find?state=CA&city=SF#map');
  assert.equal(restartUrl(['https://app.test/login?code=4/0AY0e-g7abcdefghijklmnop&state=xyz']), 'https://app.test/');
  // an identity provider is still skipped for the task's site
  assert.equal(restartUrl(['https://accounts.google.com/o?id=1', 'https://app.test/x?id=1']), 'https://app.test/x?id=1');
  // the pane's own "Continue in Chrome" (its restart address) follows the same rule
  const w = browserWorld();
  const manager = new BrowserWindows({ ...w });
  manager.register(w.root);
  w.root.url = 'https://localhost:8791/s/crash?run=edge2-7&session=abc';
  assert.equal(manager.restart(w.root.id, w.host), 'https://localhost:8791/s/crash?run=edge2-7');
});
