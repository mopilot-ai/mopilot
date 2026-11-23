// The uninstall survey (#1986 PR 6), as Claude in Chrome sets one: Chrome opens it when the user removes the extension, with the version, so the reason reaches MoPilot's team.

/** The survey: a Google Form owned by admin@mopilot.ai, open to anyone with the link, collecting no email. */
export const SURVEY_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSdRfOfFB0O756gnXpopyqYIp1GFmRya5gD_ceMKWQtJiVTLpA/viewform';

/** Tells Chrome which page to open on uninstall; false when there is no survey. A failure is logged, not thrown. */
export function setSurvey(/** @type {any} */ chrome, /** @type {(what: string, error: unknown) => void} */ log, url = SURVEY_URL) {
  if (!url) return false;
  // a malformed address fails here, logged: it never stops the service worker's start
  Promise.resolve()
    .then(() => {
      const page = new URL(url);
      page.searchParams.set('v', chrome.runtime.getManifest().version);
      return chrome.runtime.setUninstallURL(page.href);
    })
    .catch((error) => log('set the uninstall survey', error));
  return true;
}
