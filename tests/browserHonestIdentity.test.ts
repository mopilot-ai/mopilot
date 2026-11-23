// The in-app browser's honest identity (#4651): the embedded Chrome's own user agent, with no Electron or app token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { honestUserAgent, applyHonestIdentity } = require('../electron/capabilities/browser/honestIdentity.cjs');
const { BrowserWindows } = require('../electron/capabilities/browser/windows.cjs');
const { browserWorld } = require('./helpers/browser.cjs');

const DEFAULT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MoPilot/0.3.0 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36';
const HONEST = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.130 Safari/537.36';

test('drops the Electron token and the app token, and nothing else', () => {
  assert.equal(honestUserAgent(DEFAULT), HONEST);
  assert.equal(honestUserAgent(HONEST), HONEST);
  // a longer app token chain and an app name with a dash and dots go too; Chrome and Safari stay
  assert.equal(honestUserAgent(DEFAULT.replace('MoPilot/0.3.0', 'My-App.x/1.2 Extra/9')), HONEST);
});

test('keeps the real Chrome version of this build, the same every time', () => {
  // under Electron these are the build's own; plain node has no Chromium, so a fixed pair stands in
  const versions = { chrome: process.versions.chrome ?? '152.0.7977.130', electron: process.versions.electron ?? '44.7.0' };
  const real = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) MoPilot/1.0.0 Chrome/${versions.chrome} Electron/${versions.electron} Safari/537.36`;
  const honest = honestUserAgent(real);
  assert.equal(/Chrome\/(\d+)/.exec(honest)?.[1], versions.chrome.split('.')[0]);
  assert.equal(honest, real.replace(/ MoPilot\/\S+/, '').replace(/ Electron\/\S+/, ''));
  assert.equal(honestUserAgent(real), honest);
});

test('sets the session (with the OS languages) and the page once, and leaves honest ones alone', () => {
  const calls: unknown[][] = [];
  const wc = {
    getUserAgent: () => DEFAULT,
    setUserAgent: (...a: unknown[]) => calls.push(['page', ...a]),
    session: {
      getUserAgent: () => DEFAULT,
      setUserAgent: (...a: unknown[]) => calls.push(['session', ...a]),
      getAcceptLanguages: () => 'en-US,en',
    },
  };
  // a Dutch OS asks sites for Dutch, though the package has no Dutch Chromium locale (scripts/chromium-locales.mjs)
  assert.equal(
    applyHonestIdentity(wc, () => ['nl-NL', 'en-US']),
    HONEST,
  );
  assert.deepEqual(calls, [
    ['session', HONEST, 'nl-NL,en-US'],
    ['page', HONEST],
  ]);
  const plain = {
    getUserAgent: () => HONEST,
    setUserAgent: () => assert.fail('already honest'),
    session: { getUserAgent: () => HONEST, setUserAgent: () => assert.fail('already honest') },
  };
  assert.equal(
    applyHonestIdentity(plain, () => assert.fail('the session is already set')),
    HONEST,
  );
  // no OS languages: the session keeps its own, and one without a languages getter still takes the user agent
  applyHonestIdentity(wc, () => []);
  assert.deepEqual(calls[2], ['session', HONEST, 'en-US,en']);
  const bare = { ...wc, session: { getUserAgent: () => DEFAULT, setUserAgent: (...a: string[]) => void calls.push(['bare', ...a]) } };
  applyHonestIdentity(bare, () => []);
  assert.deepEqual(calls.slice(-2), [
    ['bare', HONEST, undefined],
    ['page', HONEST],
  ]);
});

test('a pane page registered with the browser asks sites for the OS languages main hands it, and none keeps the session’s', () => {
  for (const [languages, expected] of [
    [['ja-JP', 'en-US'], 'ja-JP,en-US'],
    [undefined, 'en-US'],
  ] as const) {
    const w = browserWorld();
    const calls: unknown[][] = [];
    Object.assign(w.session, {
      getUserAgent: () => DEFAULT,
      setUserAgent: (...a: unknown[]) => calls.push(a),
      getAcceptLanguages: () => 'en-US',
    });
    Object.assign(w.root, { getUserAgent: () => HONEST, setUserAgent: () => assert.fail('the page is already honest') });
    new BrowserWindows({ ...w, ...(languages && { systemLanguages: () => [...languages] }) }).register(w.root);
    assert.deepEqual(calls, [[HONEST, expected]]);
  }
  // called with no languages, the session keeps its own
  const calls: unknown[][] = [];
  applyHonestIdentity({
    getUserAgent: () => HONEST,
    setUserAgent: () => {},
    session: { getUserAgent: () => DEFAULT, setUserAgent: (...a: unknown[]) => void calls.push(a), getAcceptLanguages: () => 'fr' },
  });
  assert.deepEqual(calls, [[HONEST, 'fr']]);
});

test('leaves a page that cannot report its identity alone', () => {
  assert.equal(applyHonestIdentity({}), null);
  assert.equal(applyHonestIdentity({ getUserAgent: () => DEFAULT }), null);
});
