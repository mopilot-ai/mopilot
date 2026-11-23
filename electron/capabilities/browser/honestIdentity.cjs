// The in-app browser's identity: the Chrome it embeds, as a person's Chrome sends it (#4651). Electron's default user agent adds an
// `Electron/x` token and the app's own `<name>/<version>`, which site bot protection reads as "not a browser". Dropping those two tokens
// leaves the embedded Chromium's own string.
//
// The boundary (owner, 2026-11-15: no bypass, the same experience as a person in native Chrome, not blocked at random):
// - Only the two tokens go. The Chrome major version, platform and architecture stay the real ones of this build, so the user agent, the
//   client hints and `navigator` agree (tests/browserHonestIdentity.test.ts, tests/e2e/browser-honest-identity.spec.ts).
// - Nothing rotates per request or per site, and nothing is faked: no plugins, WebGL, canvas, fonts or `navigator.webdriver` patch, and no
//   automation flag a person's browser would not have.
// - No CAPTCHA solving, and no retry that hammers a block page: a block reaches the agent as a result it can read and stop on.

/**
 * The user agent without the Electron token and the app's own token, which sits between `(KHTML, like Gecko)` and `Chrome/`
 * ("... Gecko) MoPilot/0.3.0 Chrome/152.0 Electron/44.7.0 Safari/537.36").
 */
function honestUserAgent(userAgent) {
  return String(userAgent)
    .replace(/\s+Electron\/\S+/g, '')
    .replace(/(\(KHTML, like Gecko\))(?:\s+[^\s/()]+\/\S+)+?(\s+Chrome\/)/, '$1$2');
}

/**
 * Gives a browser page and its session the honest user agent (the session also covers its workers), with the OS's languages as
 * its Accept-Language, as a person's Chrome offers sites by default. Chromium's own default is its interface locale, and a
 * package keeps only the locales MoPilot's interface languages serve (scripts/chromium-locales.mjs): a Dutch OS would otherwise
 * ask every site for English. With no OS languages the session keeps its own.
 * @param {{ getUserAgent(): string, setUserAgent(ua: string): void, session: { getUserAgent(): string, setUserAgent(ua: string, acceptLanguages?: string): void, getAcceptLanguages?(): string } }} wc
 * @param {() => string[]} [languages] the OS's languages, most preferred first (main passes app.getPreferredSystemLanguages)
 * @returns {string | null} the page's user agent, or null when it has none to give
 */
function applyHonestIdentity(wc, languages = () => []) {
  // a page that cannot report its identity (not a real webContents) is left as it is
  if (typeof wc.getUserAgent !== 'function' || typeof wc.session?.getUserAgent !== 'function') return null;
  const { session } = wc;
  const forSession = honestUserAgent(session.getUserAgent());
  if (forSession !== session.getUserAgent()) {
    const system = languages();
    session.setUserAgent(forSession, system.length ? system.join(',') : session.getAcceptLanguages?.());
  }
  const forPage = honestUserAgent(wc.getUserAgent());
  if (forPage !== wc.getUserAgent()) wc.setUserAgent(forPage);
  return forPage;
}

module.exports = { honestUserAgent, applyHonestIdentity };
