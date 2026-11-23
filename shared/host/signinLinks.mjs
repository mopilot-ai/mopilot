// Which sign-in links a client may open for a Host: a link a Host relayed is another machine's output, not trusted input, so only a plain https page on the vendor's own site is opened (the Mac's browser and the phone's alike).
import { GIT_LOGIN, gitDevicePage } from './gitLogin.mjs';

/** The longest link opened. */
export const MAX_URL = 2048;
/** The sites a vendor's sign-in starts on, by harness; a link elsewhere is not opened for these (a Host could point a sign-in at a look-alike page). A harness not listed is limited to https. @type {Record<string, string[]>} */
export const VENDOR_SITES = {
  claude: ['claude.ai', 'claude.com', 'anthropic.com'],
  codex: ['openai.com', 'chatgpt.com'],
};

/** A link a Host relayed, as the page to open: a plain https page, or null. @param {unknown} link */
export function openable(link) {
  if (typeof link !== 'string' || link.length > MAX_URL) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** Whether `href` is on a site the harness's vendor signs in on (the site itself or a subdomain); true for a harness with no listed sites. @param {string} harness @param {string} href */
export function onVendorSite(harness, href) {
  if (harness === GIT_LOGIN) return gitDevicePage(href);
  const sites = Object.hasOwn(VENDOR_SITES, harness) ? VENDOR_SITES[harness] : null;
  if (!sites) return true;
  const host = new URL(href).hostname.toLowerCase();
  return sites.some((site) => host === site || host.endsWith(`.${site}`));
}
